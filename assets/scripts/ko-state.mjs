// The shared state directory: <git-common-dir>/kh-orchestration/, the same
// directory from every linked worktree.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

// proposals.json is `{ worktrees: [<absolute real path of a worktree root>...] }`, the worktrees
// open for proposals. The hook extension reads it itself (it cannot import this file): absent,
// unreadable or of another shape, no worktree is open.
const STATE_NAMES = new Set(['approvals.json', 'waivers.json', 'exemptions.json', 'proposals.json']);
// `verdicts/<tree>-<base>.json`: the one sub-path a state name may have (decision 5).
const OBJECT_ID = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const VERDICT_NAME = new RegExp(`^verdicts/${OBJECT_ID}-(?:${OBJECT_ID}|none)\\.json$`);
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
  if (!STATE_NAMES.has(name) && !VERDICT_NAME.test(name)) throw new StateError(unknownNameMessage(name));
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
