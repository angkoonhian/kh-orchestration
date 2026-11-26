// The shared state directory: <git-common-dir>/kh-orchestration/, the same
// directory from every linked worktree.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { shellWord } from './extension.mjs';
import { hashesTo, objectMismatchMessage } from './ko-digest.mjs';
import { commonDir, listEntries, readBlobs } from './ko-git.mjs';

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
export const invalidCommitMessage = 'An accepted record is named by a full hexadecimal commit id.';
export const invalidPidMessage = 'An in-flight record is named by the process id of a git command: digits only, without a leading zero.';
export const binIncompleteMessage = 'The tree holds no .claude/kh-orchestration/scripts/gate.mjs or ko.mjs, so bin/ is not refreshed from it: the hooks or the owner\'s commands would find nothing to run. Stage the install\'s scripts first.';
export const binPreflightMessage = (script) => `The staged tree's .claude/kh-orchestration/scripts/${script} does not load (a syntax error, a missing file, or a script it imports that is missing or damaged), so bin/ is not refreshed from it and nothing is approved: the hooks and the owner's commands would stop working. Fix it in the working copy, stage it, and approve again.`;
export const binEntryMessage = (path) => `${path} is not a regular file in the tree, so bin/ is not refreshed from it.`;
export const shapeMessage = (name) =>
  `The shared state file ${name} is not of the shape kh-orchestration writes. Restore it from a backup or ask the owner to remove it; nothing proceeds on a state file that cannot be read.`;

// approvals.json is `{ digests: [{ digest, tree, approvedAt, branch }] }`: each digest the owner
// approved (64 lower-case hexadecimal digits), the tree approve read it from (a full object id; a
// record written before approve kept it has no `tree` key and is still valid), when (an ISO time),
// and the branch it was approved on (null on a detached HEAD). Absent, nothing is approved. Read
// through readApprovals. `approve` diffs against the last record of its branch that has a tree.
// waivers.json is `{ waivers: [{ rule, branch, reason, at }] }`: an officer's rule (a rule id as
// RULES.md writes one) the owner waived on a branch, by exact name, why (non-empty) and when.
// Absent, nothing is waived. Read through readWaivers; `run` passes a branch's waivers to the
// officers as KO_WAIVERS.
// exemptions.json is `{ branches: [{ name, reason, at }] }`: the branches, by exact name, the gate
// lets through without an install, why (non-empty) and when. Absent, no branch is exempt. Read
// through readExemptions.
// inflight-<pid>.json is `{ tree, base }`: the tree the gate allowed for the git commit or git
// merge process <pid>, and the base it judged it against (decision 18, further amended). The reference-transaction hook refuses that
// process's branch update unless its commit holds this tree. Written by the gate on an allow of
// the index, removed by the gate once it has judged that process's branch or HEAD update; a record
// whose process is gone is stale (removeStaleInflight).
// accepted/<commit>.json is `{ tree, base }`: a commit the reference-transaction check let onto a
// branch or HEAD, with the tree and base the gate judged (after Task 7's review). status and
// verify-branch look HEAD's commit up here before they compute a base.
// off is a file whose presence is the owner's switch (isOff); its content means nothing.
// proposals.json is `{ worktrees: [<absolute real path of a worktree root>...] }`, the worktrees
// open for proposals. The hook extension reads it itself (it cannot import this file): absent,
// unreadable or of another shape, no worktree is open. ko.mjs reads it through readProposals.
// bin/ is the copy of the approved tree's scripts the hooks run (decision 5), replaced whole by
// refreshBin.
// The files are read, changed and written with no lock: two owner commands at once may lose one
// update. Only the owner writes them, one command at a time in practice.
const STATE_NAMES = new Set(['approvals.json', 'waivers.json', 'exemptions.json', 'proposals.json']);
// `verdicts/<tree>-<base>.json`: the one sub-path a state name may have (decision 5).
const OBJECT_ID = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
const VERDICT_NAME = new RegExp(`^verdicts/${OBJECT_ID}-(?:${OBJECT_ID}|none)\\.json$`);
const INFLIGHT_NAME = /^inflight-[1-9][0-9]{0,9}\.json$/;
const ACCEPTED_NAME = new RegExp(`^accepted/${OBJECT_ID}\\.json$`);
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
  if (!STATE_NAMES.has(name) && !VERDICT_NAME.test(name) && !INFLIGHT_NAME.test(name) && !ACCEPTED_NAME.test(name)) throw new StateError(unknownNameMessage(name));
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

// Removes a temporary file after a failed write; what cannot be removed (its directory is not
// one) was never written, so the write's own error is the one reported.
function removeTemporary(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // nothing was written there
  }
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
    removeTemporary(temporary);
    throw new StateError(writeFailedMessage(name));
  }
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isText = (value) => typeof value === 'string' && value !== '';
const DIGEST = /^[0-9a-f]{64}$/;
const TREE_ID = new RegExp(`^${OBJECT_ID}$`);
// A rule id as the registry reads one (ko-registry.mjs), at most 64 characters.
export const RULE_ID = /^[A-Za-z][\w.-]{0,63}$/;

// The list a state file of the shape `{ <key>: [entry...] }` holds; [] when the file is absent. Any
// other shape throws: a damaged record must never read as an empty one.
function readList(root, name, key, entryHasShape) {
  const value = readState(root, name, { [key]: [] });
  if (!hasExactKeys(value, [key]) || !Array.isArray(value[key]) || !value[key].every(entryHasShape)) throw new StateError(shapeMessage(name));
  return value[key];
}

const approvalHasShape = (entry) => (hasExactKeys(entry, ['digest', 'approvedAt', 'branch']) || hasExactKeys(entry, ['digest', 'tree', 'approvedAt', 'branch']))
  && typeof entry.digest === 'string' && DIGEST.test(entry.digest) && (!Object.hasOwn(entry, 'tree') || (typeof entry.tree === 'string' && TREE_ID.test(entry.tree)))
  && isText(entry.approvedAt) && (entry.branch === null || isText(entry.branch));
const exemptionHasShape = (entry) => hasExactKeys(entry, ['name', 'reason', 'at']) && isText(entry.name) && isText(entry.reason) && isText(entry.at);

const waiverHasShape = (entry) => hasExactKeys(entry, ['rule', 'branch', 'reason', 'at'])
  && typeof entry.rule === 'string' && RULE_ID.test(entry.rule) && isText(entry.branch) && isText(entry.reason) && isText(entry.at);
const proposalHasShape = (entry) => isText(entry) && isAbsolute(entry);

// The approvals, `[{ digest, tree?, approvedAt, branch }]`. Throws a StateError for a file that cannot be read or is of another shape.
export const readApprovals = (root) => readList(root, 'approvals.json', 'digests', approvalHasShape);

// The exemptions, `[{ name, reason, at }]`. Throws a StateError for a file that cannot be read or is of another shape.
export const readExemptions = (root) => readList(root, 'exemptions.json', 'branches', exemptionHasShape);

// The waivers of every branch, `[{ rule, branch, reason, at }]`. Throws a StateError for a file that cannot be read or is of another shape.
export const readWaivers = (root) => readList(root, 'waivers.json', 'waivers', waiverHasShape);

// The worktrees open for proposals, as absolute paths. Throws a StateError for a file that cannot be read or is of another shape.
export const readProposals = (root) => readList(root, 'proposals.json', 'worktrees', proposalHasShape);

function inflightName(pid) {
  if (typeof pid !== 'string' || !PID.test(pid)) throw new StateError(invalidPidMessage);
  return `inflight-${pid}.json`;
}

// `{ tree, base }` as the gate judged them: a full tree id, and a full commit id or `none`.
const judgedHasShape = (value) => hasExactKeys(value, ['tree', 'base'])
  && typeof value.tree === 'string' && TREE_ID.test(value.tree) && typeof value.base === 'string' && (value.base === 'none' || TREE_ID.test(value.base));

function writeJudged(root, name, judged) {
  if (!judgedHasShape(judged)) throw new StateError(shapeMessage(name));
  writeState(root, name, { tree: judged.tree, base: judged.base });
}

function readJudged(root, name) {
  const value = readState(root, name, null);
  if (value === null) return null;
  if (!judgedHasShape(value)) throw new StateError(shapeMessage(name));
  return value;
}

// Records the tree and base the gate allowed for git process `pid`. Throws a StateError when it cannot.
export const writeInflight = (root, pid, judged) => writeJudged(root, inflightName(pid), judged);

// `{ tree, base }` recorded for git process `pid`, or null when there is no record. Any other shape throws.
export const readInflight = (root, pid) => readJudged(root, inflightName(pid));

function acceptedName(commit) {
  if (typeof commit !== 'string' || !TREE_ID.test(commit)) throw new StateError(invalidCommitMessage);
  return `accepted/${commit}.json`;
}

// Records that the gate let `commit` onto a branch or HEAD, judged as `{ tree, base }`. Throws a StateError when it cannot.
export const writeAccepted = (root, commit, judged) => writeJudged(root, acceptedName(commit), judged);

// `{ tree, base }` the gate recorded for `commit`, or null when it recorded nothing. Any other shape throws.
export const readAccepted = (root, commit) => readJudged(root, acceptedName(commit));

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
 * Every in-flight record, `[{ pid, live }]` in name order: the git process id it is named by and
 * whether that process still exists. Only names of the in-flight form are listed; nothing is
 * changed. Throws a StateError when the state directory exists and cannot be read.
 */
export function listInflight(root) {
  let names;
  try {
    names = readdirSync(stateDir(root));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new StateError(stateUnreadableMessage);
  }
  return names.filter((entry) => INFLIGHT_NAME.test(entry)).sort().map((name) => {
    const pid = name.slice('inflight-'.length, -'.json'.length);
    return { pid, live: alive(pid) };
  });
}

/**
 * Removes every in-flight record whose process no longer exists and returns their process ids.
 * Only names of the in-flight form are touched. A pid that was reused by a later process keeps
 * its record until that process ends; the gate replaces a record for its own process.
 */
export function removeStaleInflight(root) {
  const stale = listInflight(root).filter((record) => !record.live).map((record) => record.pid);
  for (const pid of stale) removeInflight(root, pid);
  return stale;
}

export function isOff(root) {
  return existsSync(join(stateDir(root), OFF_FILE));
}

// The owner's switch: off is a file, made by temporary file and rename; on removes it. Both are idempotent.
export function switchOff(root) {
  const target = join(stateDir(root), OFF_FILE);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temporary, '');
    renameSync(temporary, target);
  } catch {
    removeTemporary(temporary);
    throw new StateError(writeFailedMessage(OFF_FILE));
  }
}

export function switchOn(root) {
  try {
    rmSync(join(stateDir(root), OFF_FILE), { force: true });
  } catch {
    throw new StateError(writeFailedMessage(OFF_FILE));
  }
}

// The owner's command `words` (`approve`, `exempt x --reason "<why>"`), run with the approved copy
// of ko.mjs in bin/: the owner's commands act only from there (after Task 7's review), so an
// unstaged edit to the working copy never runs with the owner's authority.
export const ownerCommand = (root, words) => `node ${shellWord(join(stateDir(root), BIN, 'ko.mjs'))} ${words}`;

const SCRIPTS_DIR = '.claude/kh-orchestration/scripts/';
const BIN = 'bin';
// What a refresh that ended early (a kill) can leave beside bin/; removed at the next refresh.
const BIN_LEFTOVER = /^bin\.[0-9]+\.[0-9a-f-]+\.(?:tmp|old)$/;
// git file modes of a regular file; a link (120000) or a submodule (160000) is not one.
export const FILE_MODES = ['100644', '100755'];

// The entries bin/ is made of from `tree`: every `.mjs` directly in the installed scripts folder.
// status compares bin/ with the same selection.
export const binEntriesOf = (root, tree) => listEntries(root, tree)
  .filter((entry) => entry.path.startsWith(SCRIPTS_DIR) && entry.path.endsWith('.mjs') && !entry.path.slice(SCRIPTS_DIR.length).includes('/'));

// The pre-flight's one child: it imports every module of the new copy but the two entries (which
// would run), in name order, and reports the first that does not load by name (for a missing file,
// the missing file's); then it prints the refusal the new copy's own gate gives an unknown hook
// name, built from that copy's texts, so a reworded text never fails a good copy.
const PREFLIGHT = `const { basename, join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const [dir, ...names] = process.argv.slice(1);
const load = (name) => import(pathToFileURL(join(dir, name)).href);
for (const name of names) {
  try {
    await load(name);
  } catch (error) {
    const missing = /Cannot find module '([^']+)'/.exec(String(error?.message))?.[1];
    process.stdout.write(JSON.stringify({ failed: missing === undefined ? name : basename(missing) }));
    process.exit(1);
  }
}
const gate = await load('ko-gate.mjs');
const extension = await load('extension.mjs');
process.stdout.write(JSON.stringify({ gateText: 'kh-orchestration: ' + gate.REASONS.couldNotDecide(gate.REASONS.notAHook) + '\\nNext: ' + extension.COMMANDS.status + '\\n' }));`;
const ENTRIES = ['gate.mjs', 'ko.mjs'];
const PREFLIGHT_TIMEOUT_MS = 30_000;

// Whether the copy in `dir` loads, before it becomes bin/ (after Task 7's second review): an
// approved script that does not parse, or a missing sibling, would otherwise stop the hooks and the
// owner's commands at once, with approve itself among them. Each check runs this process's Node, in
// `dir`, with an empty environment. Throws a StateError of failedMessage(<the script>) on the first
// failure.
function preflight(dir, names, failedMessage) {
  const run = (argv) => spawnSync(process.execPath, argv, { cwd: dir, env: {}, encoding: 'utf8', timeout: PREFLIGHT_TIMEOUT_MS });
  const loaded = run(['--input-type=module', '-e', PREFLIGHT, dir, ...names.filter((name) => !ENTRIES.includes(name))]);
  let report;
  try {
    report = JSON.parse(loaded.stdout);
  } catch {
    report = {};
  }
  if (loaded.status !== 0 || typeof report.gateText !== 'string') throw new StateError(failedMessage(report.failed ?? 'ko-gate.mjs'));
  const help = run([join(dir, 'ko.mjs'), '--help']);
  if (help.status !== 0 || !help.stdout.startsWith('usage: ') || help.stderr !== '') throw new StateError(failedMessage('ko.mjs'));
  const gate = run([join(dir, 'gate.mjs'), 'not-a-hook', '1']);
  if (gate.status !== 1 || gate.stdout !== '' || gate.stderr !== report.gateText) throw new StateError(failedMessage('gate.mjs'));
}

/**
 * Replaces <state>/bin/ with the scripts of `tree` (decision 19): every `.mjs` file directly in
 * `.claude/kh-orchestration/scripts/`, each read from the object store and verified against its
 * object id, written as replaceBin writes. A tree without gate.mjs or ko.mjs, an entry that is not
 * a regular file, a blob that does not hash to its id, or a copy that does not load leaves bin/ as
 * it was and throws a StateError; a failed read throws what ko-git throws. Called by `approve`.
 */
export const refreshBin = (root, tree) => replaceBin(root, treeScripts(root, tree), binPreflightMessage);

/**
 * The scripts bin/ is made of from `tree`, `[{ name, bytes }]`, each read from the object store and
 * verified against its object id. Throws a StateError for a tree without gate.mjs or ko.mjs, an
 * entry that is not a regular file, or a blob that does not hash to its id; a failed read throws
 * what ko-git throws. refreshBin, and apply (Task 9) to check an approved copy before writing.
 */
export function treeScripts(root, tree) {
  const scripts = binEntriesOf(root, tree);
  if (!ENTRIES.every((name) => scripts.some((entry) => entry.path === `${SCRIPTS_DIR}${name}`))) throw new StateError(binIncompleteMessage);
  const notFile = scripts.find((entry) => entry.type !== 'blob' || !FILE_MODES.includes(entry.mode));
  if (notFile !== undefined) throw new StateError(binEntryMessage(notFile.path));
  const blobs = readBlobs(root, scripts.map((entry) => entry.oid));
  const mismatch = scripts.find((entry) => !hashesTo(entry.oid, blobs.get(entry.oid)));
  if (mismatch !== undefined) throw new StateError(objectMismatchMessage(mismatch.path));
  return scripts.map((entry) => ({ name: entry.path.slice(SCRIPTS_DIR.length), bytes: blobs.get(entry.oid) }));
}

/**
 * Whether `files` (`[{ name, bytes }]`) load as a bin/ would: the same pre-flight, run on a copy in
 * a temporary directory outside the repository, which is removed. Throws a StateError of
 * failedMessage(<the script>) when they do not. apply (Task 9) checks an approved copy with it in
 * its dry run, so a copy that would fail is refused before anything is written.
 */
export function checkLoads(files, failedMessage) {
  const dir = mkdtempSync(join(tmpdir(), 'ko-bin-check-'));
  try {
    for (const file of files) writeFileSync(join(dir, file.name), file.bytes);
    preflight(dir, files.map((file) => file.name).sort(), failedMessage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Replaces <state>/bin/ with `files`, `[{ name, bytes }]`, which must hold gate.mjs and ko.mjs.
 * The new directory is written beside bin/ in full and checked to load (preflight), then renamed
 * into place, so a hook never finds a bin/ holding some files of one copy and some of another, nor
 * one that cannot start: it finds the old bin/, the new one, or (for the instant between the two
 * renames, or after a kill there) none, which the hooks refuse on. A copy that does not load leaves
 * bin/ as it was and throws a StateError of failedMessage(<the script>); one that cannot be
 * written, a StateError of writeFailedMessage. Called by refreshBin, and by apply (Task 9) with the
 * plugin's own scripts, which so get the same check.
 */
export function replaceBin(root, files, failedMessage) {
  const dir = stateDir(root);
  const bin = join(dir, BIN);
  const stem = join(dir, `${BIN}.${process.pid}.${randomUUID()}`);
  const fresh = `${stem}.tmp`;
  const old = `${stem}.old`;
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir).filter((entry) => BIN_LEFTOVER.test(entry))) rmSync(join(dir, name), { recursive: true, force: true });
    mkdirSync(fresh);
    for (const file of files) writeFileSync(join(fresh, file.name), file.bytes);
  } catch {
    rmSync(fresh, { recursive: true, force: true });
    throw new StateError(writeFailedMessage(BIN));
  }
  try {
    preflight(fresh, files.map((file) => file.name).sort(), failedMessage);
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  try {
    try {
      renameSync(bin, old);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    renameSync(fresh, bin);
  } catch {
    if (!existsSync(bin) && existsSync(old)) renameSync(old, bin);
    rmSync(fresh, { recursive: true, force: true });
    throw new StateError(writeFailedMessage(BIN));
  }
  rmSync(old, { recursive: true, force: true });
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
