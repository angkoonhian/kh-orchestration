// The shared state directory: <git-common-dir>/kh-orchestration/, the same
// directory from every linked worktree.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
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
export const writeFailedMessage = (name) => `The shared state file ${name} could not be written.`;

const STATE_NAMES = new Set(['approvals.json', 'waivers.json', 'exemptions.json', 'proposals.json']);
const OFF_FILE = 'off';
const JOURNAL_FILE = 'journal.jsonl';

export function stateDir(root) {
  return join(commonDir(root), 'kh-orchestration');
}

function checkName(name) {
  if (!STATE_NAMES.has(name)) throw new StateError(unknownNameMessage(name));
}

// An absent file is the fallback; a file that exists but cannot be read or
// parsed is an error, so a damaged record never reads as an empty one.
export function readState(root, name, fallback) {
  checkName(name);
  let text;
  try {
    text = readFileSync(join(stateDir(root), name), 'utf8');
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

export function writeState(root, name, value) {
  checkName(name);
  const dir = stateDir(root);
  const temporary = join(dir, `${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, join(dir, name));
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
  const dir = stateDir(root);
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, JOURNAL_FILE), `${JSON.stringify(entry)}\n`);
  } catch {
    throw new StateError(writeFailedMessage(JOURNAL_FILE));
  }
}
