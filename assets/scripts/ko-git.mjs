// Git access shared by every kh-orchestration script. Commands run without a
// shell and never wait on a prompt or a pager.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export const SPAWN_FAILED = 'git could not be started.';
export const gitFailedMessage = (what) => `git failed to ${what}.`;

const NO_BASE = 'none';
const SPAWN_FAILED_STATUS = 127;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

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
    return { status: SPAWN_FAILED_STATUS, stdout: binary ? Buffer.alloc(0) : '', stderr: SPAWN_FAILED };
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

const nulSeparated = (text) => text.split('\0').filter((entry) => entry !== '');

export function repoRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function commonDir(root) {
  const out = mustSucceed(git(root, ['rev-parse', '--git-common-dir']), 'locate the git directory');
  return realpathSync(resolve(root, out.trim()));
}

// Writes tree objects for the index, so it is the one call that is not read-only.
export function indexTree(root) {
  return mustSucceed(exec(root, ['write-tree']), 'write the index tree').trim();
}

export function headTree(root) {
  const result = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}']);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function currentBranch(root) {
  const result = git(root, ['symbolic-ref', '-q', '--short', 'HEAD']);
  return result.status === 0 ? result.stdout.trim() : null;
}

export function baseOf(root, baseBranch) {
  const headCommit = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (headCommit.status !== 0) return NO_BASE;
  const head = headCommit.stdout.trim();
  if (currentBranch(root) === baseBranch) return head;
  const baseRef = `refs/heads/${baseBranch}`;
  if (git(root, ['rev-parse', '--verify', '-q', `${baseRef}^{commit}`]).status !== 0) return head;
  const mergeBase = git(root, ['merge-base', 'HEAD', baseRef]);
  return mergeBase.status === 0 ? mergeBase.stdout.trim() : NO_BASE;
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

export function readBlob(root, tree, path) {
  const result = exec(root, ['cat-file', 'blob', `${tree}:${path}`], { readOnly: true, binary: true });
  return result.status === 0 ? result.stdout : null;
}

export function listTree(root, tree, prefix) {
  const argv = ['ls-tree', '-r', '-z', '--name-only', tree];
  if (prefix !== '') argv.push('--', prefix);
  return nulSeparated(mustSucceed(git(root, argv), 'list the tree'));
}
