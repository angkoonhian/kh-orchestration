// The shared state directory: <git-common-dir>/kh-orchestration/, the same
// directory from every linked worktree.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { commonDir } from './ko-git.mjs';

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StateError';
  }
}

export const corruptMessage = (name) =>
  `The shared state file ${name} is unreadable or is not valid JSON. Restore it from a backup or ask the owner to remove it; nothing proceeds on a state file that cannot be read.`;
export const unknownNameMessage = (name) => `"${name}" is not the name of a shared state file.`;
export const invalidValueMessage = (name) => `The value for ${name} cannot be written as JSON.`;
export const invalidVerdictKeyMessage = 'A verdict is named by a full hexadecimal tree id and a full hexadecimal base id or none.';
export const writeFailedMessage = (name) => `The shared state file ${name} could not be written.`;
export const stateUnreadableMessage = 'The shared state directory could not be read; nothing proceeds on state that cannot be read.';
export const invalidPidMessage = 'An in-flight record is named by the process id of a git command: digits only, without a leading zero.';
export const shapeMessage = (name) =>
  `The shared state file ${name} is not of the shape kh-orchestration writes. Restore it from a backup or ask the owner to remove it; nothing proceeds on a state file that cannot be read.`;

// approvals.json is `{ digests: [{ digest, approvedAt, branch }] }`: each digest the owner approved
// (64 lower-case hexadecimal digits), when (an ISO time), and the branch it was approved on (null
// on a detached HEAD). Absent, nothing is approved. Read through readApprovals.
// exemptions.json is `{ branches: [{ name, reason, at }] }`: the branches, by exact name, the gate
// lets through without an install, why (non-empty) and when. Absent, no branch is exempt. Read
// through readExemptions.
// inflight-<pid>.json is `{ tree }`: the tree the gate allowed for the git commit or git merge
// process <pid> (decision 18, further amended). The reference-transaction hook refuses that
// process's branch update unless its commit holds this tree. Written by the gate on an allow,
// removed by the hook once the update is committed or aborted; a record whose process is gone is
// stale (removeStaleInflight).
// off is a file whose presence is the owner's switch (isOff); its content means nothing.
// proposals.json is `{ worktrees: [<absolute real path of a worktree root>...] }`, the worktrees
// open for proposals. The hook extension reads it itself (it cannot import this file): absent,
// unreadable or of another shape, no worktree is open.
const STATE_NAMES = new Set(['approvals.json', 'waivers.json', 'exemptions.json', 'proposals.json']);
// `verdicts/<tree>-<base>.json`: the one sub-path a state name may have (decision 5).
const OBJECT_ID = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const VERDICT_NAME = new RegExp(`^verdicts/${OBJECT_ID}-(?:${OBJECT_ID}|none)\\.json$`);
const INFLIGHT_NAME = /^inflight-[1-9][0-9]{0,9}\.json$/;
const PID = /^[1-9][0-9]{0,9}$/;
const OFF_FILE = 'off';
const JOURNAL_FILE = 'journal.jsonl';

export function stateDir(root) {
  return join(commonDir(root), 'kh-orchestration');
}

// The state name of the verdict for a tree and a base; both become part of a path, so both are checked.
export function verdictName(tree, base) {
  const name = `verdicts/${tree}-${base}.json`;
  if (typeof tree !== 'string' || typeof base !== 'string' || !VERDICT_NAME.test(name)) throw new StateError(invalidVerdictKeyMessage);
  return name;
}

function checkName(name) {
  if (!STATE_NAMES.has(name) && !VERDICT_NAME.test(name) && !INFLIGHT_NAME.test(name)) throw new StateError(unknownNameMessage(name));
}

// An absent file is the fallback; a file that exists but cannot be read or
// parsed is an error, so a damaged record never reads as an empty one.
export function readState(root, name, fallback) {
  checkName(name);
  const path = join(stateDir(root), name);
  let text;
  try {
    // lstat: a symlink, even a dangling one, is something present, not absent.
    if (!lstatSync(path).isFile()) throw new StateError(corruptMessage(name));
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new StateError(corruptMessage(name));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StateError(corruptMessage(name));
  }
}

// The JSON text for a value, or an error when it would not read back as that value.
function serialise(name, value, indent) {
  try {
    const text = JSON.stringify(value, null, indent);
    if (typeof text === 'string') {
      JSON.parse(text);
      return text;
    }
  } catch {
    // falls through to the error below
  }
  throw new StateError(invalidValueMessage(name));
}

export function writeState(root, name, value) {
  checkName(name);
  const text = serialise(name, value, 2);
  const target = join(stateDir(root), name);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temporary, `${text}\n`);
    renameSync(temporary, target);
  } catch {
    rmSync(temporary, { force: true });
    throw new StateError(writeFailedMessage(name));
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isText = (value) => typeof value === 'string' && value !== '';
const DIGEST = /^[0-9a-f]{64}$/;

// The list a state file of the shape `{ <key>: [entry...] }` holds; [] when the file is absent. Any
// other shape throws: a damaged record must never read as an empty one.
function readList(root, name, key, entryHasShape) {
  const value = readState(root, name, { [key]: [] });
  if (!hasExactKeys(value, [key]) || !Array.isArray(value[key]) || !value[key].every(entryHasShape)) throw new StateError(shapeMessage(name));
  return value[key];
}

const approvalHasShape = (entry) => hasExactKeys(entry, ['digest', 'approvedAt', 'branch'])
  && typeof entry.digest === 'string' && DIGEST.test(entry.digest) && isText(entry.approvedAt) && (entry.branch === null || isText(entry.branch));
const exemptionHasShape = (entry) => hasExactKeys(entry, ['name', 'reason', 'at']) && isText(entry.name) && isText(entry.reason) && isText(entry.at);

// The approvals, `[{ digest, approvedAt, branch }]`. Throws a StateError for a file that cannot be read or is of another shape.
export const readApprovals = (root) => readList(root, 'approvals.json', 'digests', approvalHasShape);

// The exemptions, `[{ name, reason, at }]`. Throws a StateError for a file that cannot be read or is of another shape.
export const readExemptions = (root) => readList(root, 'exemptions.json', 'branches', exemptionHasShape);

function inflightName(pid) {
  if (typeof pid !== 'string' || !PID.test(pid)) throw new StateError(invalidPidMessage);
  return `inflight-${pid}.json`;
}
const TREE_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Records the tree the gate allowed for git process `pid`. Throws a StateError when it cannot.
export function writeInflight(root, pid, tree) {
  const name = inflightName(pid);
  if (typeof tree !== 'string' || !TREE_ID.test(tree)) throw new StateError(shapeMessage(name));
  writeState(root, name, { tree });
}

// The tree recorded for git process `pid`, or null when there is no record. Any other shape throws.
export function readInflight(root, pid) {
  const name = inflightName(pid);
  const value = readState(root, name, null);
  if (value === null) return null;
  if (!hasExactKeys(value, ['tree']) || typeof value.tree !== 'string' || !TREE_ID.test(value.tree)) throw new StateError(shapeMessage(name));
  return value.tree;
}

export function removeInflight(root, pid) {
  const name = inflightName(pid);
  try {
    // Whatever is there goes: a file, a symlink (not its target) or a directory.
    rmSync(join(stateDir(root), name), { force: true, recursive: true });
  } catch {
    throw new StateError(writeFailedMessage(name));
  }
}

// Whether process `pid` exists: signal 0 tests without sending. EPERM is a process of another user.
function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Removes every in-flight record whose process no longer exists and returns their process ids.
 * Only names of the in-flight form are touched. A pid that was reused by a later process keeps
 * its record until that process ends; the gate replaces a record for its own process.
 */
export function removeStaleInflight(root) {
  let names;
  try {
    names = readdirSync(stateDir(root));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new StateError(stateUnreadableMessage);
  }
  const removed = [];
  for (const name of names.filter((entry) => INFLIGHT_NAME.test(entry)).sort()) {
    const pid = name.slice('inflight-'.length, -'.json'.length);
    if (alive(pid)) continue;
    removeInflight(root, pid);
    removed.push(pid);
  }
  return removed;
}

export function isOff(root) {
  return existsSync(join(stateDir(root), OFF_FILE));
}

// The only state write that appends rather than replaces.
export function appendJournal(root, entry) {
  const text = serialise(JOURNAL_FILE, entry);
  const dir = stateDir(root);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, JOURNAL_FILE), `${text}\n`);
  } catch {
    throw new StateError(writeFailedMessage(JOURNAL_FILE));
  }
}
