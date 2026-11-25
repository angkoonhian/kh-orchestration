// Officers: the checks a repository names in `.claude/kh-orchestration/officers.json`
// (decision 6), and the running of them (decision 10). Nothing here runs a shell.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MAX_GLOBS, isValidGlob, matchesGlob, readOfficers } from './extension.mjs';
import { OFFICERS, officersText, officersUnreadableMessage, readFailedMessage } from './ko-digest.mjs';
import { listEntries } from './ko-git.mjs';

export const DEFAULT_TIMEOUT_SECONDS = 600;
export const MAX_TIMEOUT_SECONDS = 3600;
export const MAX_OUTPUT_CHARACTERS = 4000;

export const invalidOfficersMessage = (reason) => `${OFFICERS} is not usable: ${reason}.`;
export const duplicateIdMessage = (id) => invalidOfficersMessage(`two officers have the id ${id}`);
export const startFailedMessage = (command) => `${command} could not be started.`;
export const signalMessage = (signal) => `The officer was ended by the signal ${signal}.`;

const TOP_KEYS = ['schema', 'baseBranch', 'protected', 'officers'];
const OFFICER_KEYS = ['id', 'rule', 'argv', 'appliesTo', 'timeoutSeconds', 'options'];
const REQUIRED_OFFICER_KEYS = ['id', 'rule', 'argv', 'appliesTo'];
const hasExactlyKeys = (value, allowed, required) => Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The reason one officer is unusable, or null. The id, the argv and the globs of `appliesTo` as strings
// were checked by `readOfficers` (extension.mjs) only for what the digest needs; this is the rest.
function officerProblem(officer) {
  if (!isPlainObject(officer) || !hasExactlyKeys(officer, OFFICER_KEYS, REQUIRED_OFFICER_KEYS)) {
    return `officer ${officer?.id} has a key other than id, rule, argv, appliesTo, timeoutSeconds and options`;
  }
  const { id, rule, appliesTo, timeoutSeconds, options } = officer;
  if (rule !== null && typeof rule !== 'string') return `officer ${id}: rule must be a string or null`;
  if (!Array.isArray(appliesTo) || appliesTo.length === 0 || appliesTo.length > MAX_GLOBS
    || !appliesTo.every((glob) => typeof glob === 'string' && isValidGlob(glob))) {
    return `officer ${id}: appliesTo must be a non-empty list of valid globs`;
  }
  if ('timeoutSeconds' in officer && !(Number.isInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= MAX_TIMEOUT_SECONDS)) {
    return `officer ${id}: timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}`;
  }
  if ('options' in officer && !isPlainObject(options)) return `officer ${id}: options must be an object`;
  return null;
}

/**
 * The officers file of a tree as `{ baseBranch, officers }` (each officer with
 * `timeoutSeconds` and `options` filled in) or `{ problem }` (fixed text). The
 * bytes come from the tree through the digest's verified read, never from the
 * working directory. The shape the digest needs is checked by `readOfficers`;
 * this adds the base branch, the exact key sets and each officer's fields.
 */
export function officersOfTree(root, tree) {
  let loaded;
  try {
    loaded = officersText(root, tree, listEntries(root, tree));
  } catch (error) {
    return { problem: readFailedMessage(error.message) };
  }
  if (loaded.problem !== undefined) return loaded;
  if (readOfficers(loaded.text) === null) return { problem: officersUnreadableMessage };
  const parsed = JSON.parse(loaded.text);
  if (!hasExactlyKeys(parsed, TOP_KEYS, TOP_KEYS)) return { problem: invalidOfficersMessage('it has a key other than schema, baseBranch, protected and officers') };
  if (typeof parsed.baseBranch !== 'string' || parsed.baseBranch === '') return { problem: invalidOfficersMessage('baseBranch must be a non-empty string') };
  const ids = new Set();
  for (const officer of parsed.officers) {
    const reason = officerProblem(officer);
    if (reason !== null) return { problem: invalidOfficersMessage(reason) };
    if (ids.has(officer.id)) return { problem: duplicateIdMessage(officer.id) };
    ids.add(officer.id);
  }
  return {
    baseBranch: parsed.baseBranch,
    officers: parsed.officers.map((officer) => ({ timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, options: {}, ...officer })),
  };
}

const INHERITED_GIT_VARIABLES = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];
const KILL_GRACE_MS = 1000;
// Four bytes is the most one character takes, so this many bytes always hold the characters kept.
const CAPTURE_BYTES = MAX_OUTPUT_CHARACTERS * 4;

// Output kept from one stream: the first CAPTURE_BYTES bytes. The rest is read and dropped so the
// officer is never blocked on a full pipe, and memory stays bounded however much it prints.
function capture(stream) {
  const chunks = [];
  let kept = 0;
  stream.on('data', (chunk) => {
    if (kept < CAPTURE_BYTES) {
      const part = chunk.subarray(0, CAPTURE_BYTES - kept);
      chunks.push(part);
      kept += part.length;
    }
  });
  return () => Buffer.concat(chunks);
}

// Leniently decoded (an invalid byte becomes U+FFFD), cut at the character limit without splitting a surrogate pair.
function textOf(stdout, stderr) {
  const text = Buffer.concat([stdout, stderr]).toString('utf8');
  const cut = text.slice(0, MAX_OUTPUT_CHARACTERS);
  return cut.isWellFormed() ? cut : cut.slice(0, -1);
}

// Starts the officer as the leader of its own process group, so a timeout reaches its descendants.
function runOne(root, officer, env) {
  const [command, ...args] = officer.argv;
  const started = performance.now();
  return new Promise((resolve) => {
    const finish = (result, exitCode, output) => resolve({
      id: officer.id, rule: officer.rule, result, exitCode, seconds: Math.round(performance.now() - started) / 1000, output,
    });
    const child = spawn(command, args, { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = capture(child.stdout);
    const stderr = capture(child.stderr);
    const output = () => textOf(stdout(), stderr());
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // the group is already gone
      }
    };
    let timedOut = false;
    let hardKill;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      hardKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, officer.timeoutSeconds * 1000);
    child.on('error', () => {
      clearTimeout(timer);
      finish('error', null, startFailedMessage(command));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      if (timedOut) {
        killGroup('SIGKILL');
        finish('timeout', null, output());
      } else if (signal !== null) {
        finish('error', null, signalMessage(signal));
      } else {
        finish(code === 0 ? 'pass' : 'fail', code, output());
      }
    });
  });
}

const skipped = (officer) => ({ id: officer.id, rule: officer.rule, result: 'skipped', exitCode: null, seconds: 0, output: '' });

/**
 * Runs the officers one at a time, in order, every one even after a failure, and
 * returns `[{ id, rule, result, exitCode, seconds, output }]`. `result` is
 * `pass` (exit 0), `fail`, `timeout`, `error` (not startable, or ended by a
 * signal that is not ours) or `skipped` (no path in `changed` matches any
 * `appliesTo` glob; the officer is not started). The officers come from
 * `officersOfTree`. `changed` is written once to a fresh file outside the
 * repository, named by `KO_CHANGED_FILE` (NUL-separated), and removed afterwards.
 */
export async function runOfficers(root, { officers, base, tree, changed }) {
  const directory = mkdtempSync(join(tmpdir(), 'ko-changed-'));
  try {
    const changedFile = join(directory, 'changed');
    writeFileSync(changedFile, changed.join('\0'));
    const inherited = { ...process.env };
    for (const name of INHERITED_GIT_VARIABLES) delete inherited[name];
    const results = [];
    for (const officer of officers) {
      if (!changed.some((path) => officer.appliesTo.some((glob) => matchesGlob(glob, path)))) {
        results.push(skipped(officer));
        continue;
      }
      const env = { ...inherited, KO_OPTIONS: JSON.stringify(officer.options), KO_BASE: base, KO_TREE: tree, KO_CHANGED_FILE: changedFile };
      results.push(await runOne(root, officer, env));
    }
    return results;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
