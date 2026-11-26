// Git access shared by every kh-orchestration script. Commands run without a
// shell and never wait on a prompt or a pager.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// The characters that can make a terminal show other text than a name or a path from git holds:
// every control (C0, C1, DEL), format (the zero-width and bidi characters among them), line and
// paragraph separator, and U+2065, unassigned in the bidi block. The one definition: the gate's and
// ko.mjs's texts show them as \u{…} (ko-gate's `visible`), and so does the session brief.
export const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u2065]/gu;

export const SPAWN_FAILED = 'git could not be started.';
export const OUTPUT_TOO_LARGE = 'git produced more output than can be read.';
export const notBlobMessage = (path) => `${path} is in the tree but is not a file.`;
export const gitFailedMessage = (what) => `git failed to ${what}.`;

// What every helper here throws: its message is fixed text, so a caller may show it, where a
// fault of any other kind has a message that is not.
export class GitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitError';
  }
}

const NO_BASE = 'none';
const SPAWN_FAILED_STATUS = 127;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function exec(root, argv, { input, readOnly, binary, ownIndex } = {}) {
  // Replace refs are off: a ref in the repository must not change what an object reads as.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_NO_REPLACE_OBJECTS: '1' };
  // The repository's own index, not the one a hook names (a partial commit's temporary index).
  if (ownIndex) delete env.GIT_INDEX_FILE;
  if (readOnly) env.GIT_OPTIONAL_LOCKS = '0';
  // A monitor is a command git runs from configuration made outside the tree; none runs here.
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...argv], {
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
  if (result.status !== 0) throw new GitError(gitFailedMessage(what));
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

// The refs that keep each approved tree reachable (after Task 9's re-review): approve's staged
// tree is often never committed, and git prune would remove it, and bin/'s repair with it.
export const APPROVED_REFS = 'refs/kh-orchestration/';

/**
 * Points refs/kh-orchestration/approved/<digest> at the tree object `tree` (a ref may name a tree),
 * so git prune and gc keep it. `digest` is 64 hexadecimal digits. Throws a GitError when the ref
 * cannot be written. The reference-transaction hook sees it as an update of a process with no
 * in-flight record and lets it through without starting node.
 */
const pinRef = (digest) => {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new GitError(gitFailedMessage('pin the approved tree'));
  return `${APPROVED_REFS}approved/${digest}`;
};
export function pinTree(root, digest, tree) {
  mustSucceed(exec(root, ['update-ref', '--no-deref', '--end-of-options', pinRef(digest), tree]), 'pin the approved tree');
}

// Whether the digest's pin exists already (an earlier approval of it), so a failed approval must leave it.
export const isPinned = (root, digest) => git(root, ['show-ref', '--verify', '-q', pinRef(digest)]).status === 0;

// Takes out the digest's pin. Throws a GitError when it cannot.
export function unpinTree(root, digest) {
  mustSucceed(exec(root, ['update-ref', '-d', '--no-deref', '--end-of-options', pinRef(digest)]), 'remove the pin of an approved tree');
}

// Writes tree objects for the index; with pinTree, the only calls that are not read-only.
export function indexTree(root) {
  return oneLine(mustSucceed(exec(root, ['write-tree']), 'write the index tree'));
}

// A ref that is absent is not a ref that is damaged: git show-ref --verify
// exits 1 for the first and 128 for the second.
function refExists(root, ref) {
  const result = git(root, ['show-ref', '--verify', '-q', ref]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new GitError(gitFailedMessage('read a branch'));
}

// The commit HEAD names, or null when HEAD is unborn: a symbolic ref to a
// branch that does not exist. A HEAD that cannot be read is an error.
export function headCommit(root) {
  const commit = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (commit.status === 0) return oneLine(commit.stdout);
  const symbolic = git(root, ['symbolic-ref', '-q', 'HEAD']);
  if (symbolic.status === 0 && !refExists(root, oneLine(symbolic.stdout))) return null;
  throw new GitError(gitFailedMessage('read HEAD'));
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

// The base HEAD's own tree was judged against when HEAD was committed: decision 7 read one commit
// back. Off the base branch (a detached HEAD included) it is the merge base, as baseOf gives it,
// unless that merge base is HEAD itself, which was then committed on the base branch. In every
// other case (on the base branch, with no base branch, or that one) it is HEAD's first parent, or
// none for a root commit. null when HEAD is unborn. verify-branch and status judge HEAD's tree
// against it.
export function headBaseOf(root, baseBranch) {
  const head = headCommit(root);
  if (head === null) return null;
  if (currentBranch(root) !== baseBranch && refExists(root, `refs/heads/${baseBranch}`)) {
    const base = baseOf(root, baseBranch);
    if (base !== head) return base;
  }
  return headParent(root) ?? NO_BASE;
}

// HEAD's first parent, or null for a root commit. HEAD must name a commit.
export function headParent(root) {
  const parent = git(root, ['rev-parse', '--verify', '-q', 'HEAD^1']);
  if (parent.status === 0) return oneLine(parent.stdout);
  if (parent.status === 1) return null;
  throw new GitError(gitFailedMessage('read HEAD'));
}

// The tree of the commit `base` names, or null for the base `none`. Throws when the commit cannot be read.
export function treeOfCommit(root, base) {
  if (base === NO_BASE) return null;
  return oneLine(mustSucceed(git(root, ['rev-parse', '--verify', '--end-of-options', `${base}^{tree}`]), 'read the base tree'));
}

export function changedPaths(root, base, tree) {
  const argv = base === NO_BASE
    ? ['ls-tree', '-r', '-z', '--name-only', '--end-of-options', tree]
    : ['diff', '--name-only', '-z', '--no-renames', '--end-of-options', base, tree];
  return nulSeparated(mustSucceed(git(root, argv), 'list the changed paths'));
}

export function tidy(root) {
  const unstaged = nulSeparated(mustSucceed(git(root, ['diff', '--name-only', '-z']), 'list the unstaged changes'));
  const untracked = nulSeparated(
    mustSucceed(git(root, ['ls-files', '-z', '--others', '--exclude-standard']), 'list the untracked files'),
  );
  return { tidy: unstaged.length === 0 && untracked.length === 0, unstaged, untracked };
}

// The index entries git does not compare with the working tree (after the whole-branch review), so
// that `tidy` cannot see a difference in them: `{ assumed, skipped }`, the paths flagged
// assume-unchanged (a lower-case tag in git ls-files -v) and skip-worktree (the tag S, or s when
// both are set), in index order. Reads the index only.
export function hiddenEntries(root) {
  const assumed = [];
  const skipped = [];
  for (const entry of nulSeparated(mustSucceed(git(root, ['ls-files', '-v', '-z']), 'read the index'))) {
    const [tag, path] = [entry[0], entry.slice(2)];
    if (tag !== tag.toUpperCase()) assumed.push(path);
    if (tag.toUpperCase() === 'S') skipped.push(path);
  }
  return { assumed, skipped };
}

// The tree of the commit `id` names, or null when `id` names no object or an object that is not a
// commit (a tag is not peeled). `id` must be a full object id; the caller checks that.
export function treeOfCommitId(root, id) {
  const type = git(root, ['cat-file', '-t', '--end-of-options', id]);
  if (type.status !== 0 || oneLine(type.stdout) !== 'commit') return null;
  return oneLine(mustSucceed(git(root, ['rev-parse', '--verify', '--end-of-options', `${id}^{tree}`]), 'read the commit'));
}

// `{ mode, oid }` of `path` in the repository's own index (never a hook's GIT_INDEX_FILE, which
// names a partial commit's temporary index), or null when the index does not hold it. Reads the
// index only. The path is taken literally, not as a pattern.
export function ownIndexEntry(root, path) {
  const result = exec(root, ['--literal-pathspecs', 'ls-files', '-s', '-z', '--', path], { readOnly: true, ownIndex: true });
  const out = mustSucceed(result, 'read the index');
  if (out === '') return null;
  const match = out.match(/^(\d+) ([0-9a-f]+) 0\t/);
  if (!match) throw new GitError(gitFailedMessage('read the index'));
  return { mode: match[1], oid: match[2] };
}

// The bytes of each blob `oids` names, in one `cat-file --batch`, as a Map in the given order.
// Throws when one is missing or is not a blob. The caller verifies the bytes against the id.
export function readBlobs(root, oids) {
  const result = exec(root, ['cat-file', '--batch'], { readOnly: true, binary: true, input: Buffer.from(oids.map((oid) => `${oid}\n`).join('')) });
  const out = mustSucceed(result, 'read the file');
  const blobs = new Map();
  let at = 0;
  for (const oid of oids) {
    const end = out.indexOf(10, at);
    const header = end === -1 ? null : out.subarray(at, end).toString('latin1').match(/^([0-9a-f]+) blob (\d+)$/);
    if (header === null || header[1] !== oid) throw new GitError(gitFailedMessage('read the file'));
    const size = Number(header[2]);
    if (end + 1 + size + 1 > out.length) throw new GitError(gitFailedMessage('read the file'));
    blobs.set(oid, out.subarray(end + 1, end + 1 + size));
    at = end + 1 + size + 1;
  }
  return blobs;
}

// `{ mode, type, oid }` of one path in a tree, or null only when the path is not in it.
export function treeEntry(root, tree, path) {
  const entry = mustSucceed(git(root, ['ls-tree', '-z', '--end-of-options', tree, '--', path]), 'read the file');
  if (entry === '') return null;
  const match = entry.match(/^(\d+) (\w+) ([0-9a-f]+)\t/);
  if (!match) throw new GitError(gitFailedMessage('read the file'));
  return { mode: match[1], type: match[2], oid: match[3] };
}

// null only when the path is not in the tree. Any failure to find out, and any
// entry that is not a file, is an error: a caller must never read it as absent.
export function readBlob(root, tree, path) {
  const entry = treeEntry(root, tree, path);
  if (entry === null) return null;
  if (entry.type !== 'blob') throw new GitError(notBlobMessage(path));
  const result = exec(root, ['cat-file', 'blob', '--end-of-options', `${tree}:${path}`], { readOnly: true, binary: true });
  return mustSucceed(result, 'read the file');
}

// Every entry of a tree, recursively and from its root: `{ mode, type, oid, path }`.
// A symbolic link is a blob of mode 120000 and a submodule a commit of mode 160000;
// neither is followed, so a path under one is not listed.
export function listEntries(root, tree) {
  const out = mustSucceed(git(root, ['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', tree]), 'list the tree');
  return nulSeparated(out).map((line) => {
    const match = line.match(/^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/);
    if (!match) throw new GitError(gitFailedMessage('list the tree'));
    return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
  });
}
