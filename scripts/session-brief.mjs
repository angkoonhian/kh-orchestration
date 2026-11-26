#!/usr/bin/env node
// The plugin's one hook, run at SessionStart in every session where the plugin is enabled. It gives
// a session in a repository where kh-orchestration is installed on this machine the few facts it
// needs before its first commit is refused: commits are checked, how to run the checks, what only
// the owner does, and what is wrong. It is how the plugin is used without anyone telling a session
// to: enforcement is the git hooks and the hook extension; this is the explanation.
//
// What it runs from the repository, and why. It describes the repository's OWN install, so it reads
// state through `statusOf` and the `agentCommand` helper, imported from ONE file: `ko-cli.mjs` in
// <git-common-dir>/kh-orchestration/bin/, the copy the owner approved on this machine. That
// directory is in the git directory, which a clone never carries, so a repository that merely
// contains an install (any clone of one that commits it) runs nothing from this hook: with no state
// directory the brief is silent, deliberately. The working copy's own `ko-cli.mjs` is never read or
// imported. The git directory comes from the plugin's own `ko-git.mjs`, which runs git with the
// file-system monitor off. `statusOf` takes the working tree's top and reads the working repository
// through the approved scripts; the `run` command it helps print still names the WORKING copy's
// `ko.mjs`. `statusOf` reads files and runs git, and `git write-tree` (it writes tree objects) is
// one of those commands; it does not run the contract probe, and the brief never calls detect,
// apply or the gate. The brief starts no program but git.
//
// A state directory without `bin/` (every commit is then refused), or without `bin/ko-cli.mjs`,
// is said in one fixed sentence, importing nothing.
//
// It is silent wherever there is nothing to say and on every failure: input it cannot read, no
// state directory, a damaged approved script, a `statusOf` that throws or answers in a shape it does
// not know. It always exits 0 and always ends within a bound: no top-level await; a watchdog exits
// 0 silently after 8 seconds; standard input is read asynchronously under that bound; what the
// imported module writes to standard output is held back, and if anything but the brief's own line
// reached it, nothing is printed.
import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { UNSHOWABLE, commonDir, repoRoot } from '../assets/scripts/ko-git.mjs';

const WATCHDOG_MS = 8_000;
// The text is a short paragraph; no state's text reaches this length.
const MAX_TEXT = 600;
const MAX_NAME = 80;

const CHECKED = 'Commits in this repository are checked by kh-orchestration: a commit lands only when the officers passed on exactly the staged tree and the protected files are owner-approved.';
const OWNER_ONLY = 'Owner-only steps (approve, propose, waive, exempt, off, on, and the plugin\'s apply and uninstall --yes) are the owner\'s to run in their own terminal: ask, do not attempt.';
const SHORT_RUN = 'Before committing, run the officers with `node .claude/kh-orchestration/scripts/ko.mjs run` from the repository\'s top directory.';
const OPEN_HERE = 'This worktree is open for proposals: protected files may be edited here.';
const NOT_OPEN_HERE = 'This worktree is not open for proposals: do not edit protected files here.';
const FIX = 'Only the owner can fix this: ask the owner to run the plugin\'s apply.';

const runLine = (command) => `Before committing, run the officers with \`${command}\`.`;
const SWITCHED_OFF = 'kh-orchestration is switched off for this repository by its owner: commits here are not being checked.';
const SCRIPTS_MISSING = `kh-orchestration is installed here, but its approved scripts are missing from the git directory, so commits may be refused. ${FIX}`;
// With no bin/ at all the hooks find no gate, so the refusal is certain.
const BIN_MISSING = `kh-orchestration is installed here, but its approved scripts are missing from the git directory, so every commit here will be refused. ${FIX}`;
const exempt = (branch) => `This branch, ${branch}, is exempt from kh-orchestration: its commits are not being checked.`;
// What a problem does to a commit, each kind verified with a real `git commit` in the tests:
// refused (the gate runs and says no), unchecked (git does not run the gate), or neither known.
const refused = (clause) => `kh-orchestration is installed here, but ${clause}, so every commit here will be refused. ${FIX}`;
const unchecked = (clause) => `kh-orchestration is installed here, but ${clause}, so git does not run the commit gate here and commits are NOT being checked; only the owner can fix this (ask them to run the plugin's apply).`;
const unsure = (clause) => `kh-orchestration is installed here, but ${clause}. ${FIX}`;

/** A name from git as it is shown: every character ko-git's UNSHOWABLE names, TAB and newline
 * included, written as \u{...}, then cut at MAX_NAME characters. */
function shown(text) {
  const visible = String(text).replace(UNSHOWABLE, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  return visible.length > MAX_NAME ? `${visible.slice(0, MAX_NAME)}...` : visible;
}

/** The first thing wrong, in the order `statusOf` reports them, as the sentence to say; null when
 * nothing is. */
function firstProblem(status) {
  if (status.install !== null && !status.install.present) return refused('its install is absent from this branch\'s tree');
  if (status.install !== null && status.install.problem !== null) return refused('the officers file in the staged tree cannot be used');
  if (!status.contract.ok) return refused('kh-harness\'s contract with this plugin does not hold here');
  const { bin } = status;
  if (bin !== null) {
    if (!bin.present) return refused('the installed gate directory bin/ is missing');
    if (!bin.gate) return refused('the installed gate directory bin/ holds no gate');
    if (bin.differs.length + bin.missing.length + bin.extra.length > 0) return unsure('the installed gate directory bin/ differs from the approved scripts');
  }
  for (const hook of status.hooks) {
    const name = shown(hook.name);
    if (!hook.present) return unchecked(`the ${name} git hook is missing`);
    if (hook.misplaced) return unchecked(`the ${name} git hook is not where it runs first`);
    if (!hook.ours && !hook.hosted) return unchecked(`the ${name} git hook is not kh-orchestration's`);
    if (hook.ours && !hook.matches) return unsure(`the ${name} git hook differs from the installed one`);
    if (!hook.executable) return unchecked(`the ${name} git hook is not executable`);
    if ((hook.env !== null && !hook.envExists) || (hook.node !== null && !hook.nodeExists)) return refused(`the ${name} git hook names a program that is gone`);
  }
  if (status.hooksPath !== null) return unchecked(`core.hooksPath is set in the ${shown(status.hooksPath.scope)} git configuration`);
  return null;
}

/** True when `status` has every field the brief reads, in the shape it reads them. */
function isKnownShape(status) {
  const list = (value) => Array.isArray(value);
  const object = (value) => typeof value === 'object' && value !== null;
  return object(status) && typeof status.off === 'boolean' && (status.branch === null || typeof status.branch === 'string')
    && (status.openForProposals === null || typeof status.openForProposals === 'boolean')
    && (status.exemptions === null || (list(status.exemptions) && status.exemptions.every((entry) => object(entry) && typeof entry.name === 'string')))
    && (status.install === null || (object(status.install) && typeof status.install.present === 'boolean'))
    && object(status.contract) && typeof status.contract.ok === 'boolean'
    && (status.bin === null || (object(status.bin) && typeof status.bin.present === 'boolean' && typeof status.bin.gate === 'boolean'
      && list(status.bin.differs) && list(status.bin.missing) && list(status.bin.extra)))
    && list(status.hooks) && status.hooks.every((hook) => object(hook) && typeof hook.name === 'string' && typeof hook.present === 'boolean')
    && (status.hooksPath === null || (object(status.hooksPath) && typeof status.hooksPath.scope === 'string'));
}

/** The brief for `status`, or null when it is not of a shape this reads. `command` is the working
 * copy's `ko.mjs run` line as the install's own helper prints it. */
function briefFor(status, command) {
  if (!isKnownShape(status)) return null;
  if (status.off) return SWITCHED_OFF;
  if (status.exemptions?.some((entry) => entry.name === status.branch)) return exempt(shown(status.branch));
  const problem = firstProblem(status);
  if (problem !== null) return problem;
  // `openForProposals` is null when the proposals file cannot be read: not known to be open.
  const open = status.openForProposals === true ? OPEN_HERE : NOT_OPEN_HERE;
  const full = [CHECKED, runLine(command), OWNER_ONLY, open].join(' ');
  return full.length < MAX_TEXT ? full : [CHECKED, SHORT_RUN, OWNER_ONLY, open].join(' ');
}

/** The kind of the file system entry at `path` (not following a link): the Stats, or null when
 * there is none. */
function entry(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** All of standard input, read asynchronously; the watchdog bounds a stream that never ends. */
function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

/** The text to say, or null for nothing. */
async function brief() {
  // Claude Code gives a SessionStart hook its JSON on standard input: `cwd`, `source`, ...
  const input = JSON.parse(await readInput());
  if (typeof input?.cwd !== 'string' || !isAbsolute(input.cwd)) return null;
  const root = repoRoot(input.cwd);
  if (root === null) return null;
  const state = join(commonDir(root), 'kh-orchestration');
  if (!entry(state)?.isDirectory()) return null;
  if (!entry(join(state, 'bin'))?.isDirectory()) return BIN_MISSING;
  const cli = join(state, 'bin', 'ko-cli.mjs');
  if (!entry(cli)?.isFile()) return SCRIPTS_MISSING;
  const { statusOf, agentCommand } = await import(pathToFileURL(cli).href);
  return briefFor(statusOf(root), agentCommand(root, 'run'));
}

// A watchdog: whatever the imported script or standard input does, the hook ends well inside its
// timeout, silently, with 0. Unref'd, so it never keeps a finished process alive.
setTimeout(() => process.exit(0), WATCHDOG_MS).unref();
// A script that calls process.exit(n) still ends with 0.
process.on('exit', () => {
  process.exitCode = 0;
});
process.stdout.on('error', () => {});
// What the imported script writes to standard output is held back: only the brief's own line is
// printed, last, and only when nothing else was written.
const write = process.stdout.write.bind(process.stdout);
let stray = false;
process.stdout.write = () => {
  stray = true;
  return true;
};
brief()
  .then((text) => {
    if (typeof text !== 'string' || text.length >= MAX_TEXT || stray) return;
    write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`);
  })
  // A SessionStart hook has nothing to block, and a failure here must never stand between the user
  // and their session: say nothing.
  .catch(() => {});
