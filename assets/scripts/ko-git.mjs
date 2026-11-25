// Git access shared by every kh-orchestration script. Commands run without a
// shell and never wait on a prompt or a pager.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const SPAWN_FAILED = 'git could not be started.';
export const OUTPUT_TOO_LARGE = 'git produced more output than can be read.';
export const notBlobMessage = (path) => `${path} is in the tree but is not a file.`;
export const gitFailedMessage = (what) => `git failed to ${what}.`;

const NO_BASE = 'none';
const SPAWN_FAILED_STATUS = 127;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function exec(root, argv, { input, readOnly, binary } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' };
  if (readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  const result = spawnSync('git', argv, {
    cwd: root,
    env,
    input,
    encoding: binary ? 'buffer' : 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error || result.status === null) {
    const stderr = result.error?.code === 'ENOBUFS' ? OUTPUT_TOO_LARGE : SPAWN_FAILED;
    return { status: SPAWN_FAILED_STATUS, stdout: binary ? Buffer.alloc(0) : '', stderr };
  }
  return { status: result.status, stdout: result.stdout, stderr: binary ? result.stderr.toString('utf8') : result.stderr };
}

// Never throws. Every call except indexTree is read-only.
export function git(root, argv, { input } = {}) {
  return exec(root, argv, { input, readOnly: true });
}

function mustSucceed(result, what) {
  if (result.status !== 0) throw new Error(gitFailedMessage(what));
  return result.stdout;
}

// Strips only the newline git ends a line with; a path may end in whitespace.
const oneLine = (text) => text.replace(/\n$/, '');
const nulSeparated = (text) => text.split('\0').filter((entry) => entry !== '');

export function repoRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.status === 0 ? oneLine(result.stdout) : null;
}

export function commonDir(root) {
  const out = mustSucceed(git(root, ['rev-parse', '--git-common-dir']), 'locate the git directory');
  return realpathSync(resolve(root, oneLine(out)));
}

// Writes tree objects for the index, so it is the one call that is not read-only.
export function indexTree(root) {
  return oneLine(mustSucceed(exec(root, ['write-tree']), 'write the index tree'));
}

// A ref that is absent is not a ref that is damaged: git show-ref --verify
// exits 1 for the first and 128 for the second.
function refExists(root, ref) {
  const result = git(root, ['show-ref', '--verify', '-q', ref]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(gitFailedMessage('read a branch'));
}

// The commit HEAD names, or null when HEAD is unborn: a symbolic ref to a
// branch that does not exist. A HEAD that cannot be read is an error.
function headCommit(root) {
  const commit = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (commit.status === 0) return oneLine(commit.stdout);
  const symbolic = git(root, ['symbolic-ref', '-q', 'HEAD']);
  if (symbolic.status === 0 && !refExists(root, oneLine(symbolic.stdout))) return null;
  throw new Error(gitFailedMessage('read HEAD'));
}

export function headTree(root) {
  if (headCommit(root) === null) return null;
  return oneLine(mustSucceed(git(root, ['rev-parse', '--verify', 'HEAD^{tree}']), 'read HEAD'));
}

export function currentBranch(root) {
  const result = git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return result.status === 0 ? oneLine(result.stdout) : null;
}

export function baseOf(root, baseBranch) {
  const head = headCommit(root);
  if (head === null) return NO_BASE;
  if (currentBranch(root) === baseBranch) return head;
  const baseRef = `refs/heads/${baseBranch}`;
  if (!refExists(root, baseRef)) return head;
  mustSucceed(git(root, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`]), 'resolve the base branch');
  const mergeBase = git(root, ['merge-base', 'HEAD', baseRef]);
  return mergeBase.status === 0 ? oneLine(mergeBase.stdout) : NO_BASE;
}

export function changedPaths(root, base, tree) {
  const argv = base === NO_BASE
    ? ['ls-tree', '-r', '-z', '--name-only', tree]
    : ['diff', '--name-only', '-z', '--no-renames', base, tree];
  return nulSeparated(mustSucceed(git(root, argv), 'list the changed paths'));
}

export function tidy(root) {
  const unstaged = nulSeparated(mustSucceed(git(root, ['diff', '--name-only', '-z']), 'list the unstaged changes'));
  const untracked = nulSeparated(
    mustSucceed(git(root, ['ls-files', '-z', '--others', '--exclude-standard']), 'list the untracked files'),
  );
  return { tidy: unstaged.length === 0 && untracked.length === 0, unstaged, untracked };
}

// null only when the path is not in the tree. Any failure to find out, and any
// entry that is not a file, is an error: a caller must never read it as absent.
export function readBlob(root, tree, path) {
  const entry = mustSucceed(git(root, ['ls-tree', '-z', tree, '--', path]), 'read the file');
  if (entry === '') return null;
  if (entry.split(' ')[1] !== 'blob') throw new Error(notBlobMessage(path));
  const result = exec(root, ['cat-file', 'blob', `${tree}:${path}`], { readOnly: true, binary: true });
  return mustSucceed(result, 'read the file');
}

export function listTree(root, tree, prefix) {
  const argv = ['ls-tree', '-r', '-z', '--name-only', tree];
  if (prefix !== '') argv.push('--', prefix);
  return nulSeparated(mustSucceed(git(root, argv), 'list the tree'));
}
