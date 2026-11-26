#!/usr/bin/env node
// The plugin's one hook, run at SessionStart in every session where the plugin is enabled. It gives
// a session in a repository that has kh-orchestration installed the few facts it needs before its
// first commit is refused: commits are checked, how to run the checks, what only the owner does.
// It is the only way the plugin is used without anyone telling a session to: enforcement is the
// hooks and the hook extension; this is the explanation.
//
// It describes the repository's OWN install, so it reads state through `statusOf`, imported from
// the repository's installed `.claude/kh-orchestration/scripts/ko-cli.mjs` and from nothing else of
// the repository. That is running repository code under the session's own authority at session
// start, exactly what the session does with `ko.mjs status` anyway; `statusOf` reads files and runs
// git, and does not run the contract probe. Before importing, the install's file must be there and
// be a regular file. The brief never calls detect, apply or the gate.
//
// It is silent wherever there is nothing to say (outside a git repository, where the plugin is not
// installed), and on every failure: a missing or damaged install, a `statusOf` that throws, a
// result of a shape it does not know, input it cannot read. It always exits 0: a session must never
// be disturbed or blocked by it.
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const CLI = '.claude/kh-orchestration/scripts/ko-cli.mjs';
// A bound well under the hook's own timeout of 10 seconds.
const GIT_TIMEOUT_MS = 3_000;
// The text is a short paragraph; no state's text reaches this length.
const MAX_TEXT = 600;
const MAX_NAME = 80;

const CHECKED = 'Commits in this repository are checked by kh-orchestration: a commit lands only when the officers passed on exactly the staged tree and the protected files are owner-approved.';
const OWNER_ONLY = 'Owner-only steps (approve, propose, waive, exempt, off, on, and the plugin\'s apply and uninstall --yes) are the owner\'s to run in their own terminal: ask, do not attempt.';
const SHORT_RUN = 'Before committing, run the officers with `node .claude/kh-orchestration/scripts/ko.mjs run` from the repository\'s top directory.';
const OPEN_HERE = 'This worktree is open for proposals: protected files may be edited here.';
const NOT_OPEN_HERE = 'This worktree is not open for proposals: do not edit protected files here.';
const OWNER_FIXES = 'Only the owner can fix this: ask the owner to run the plugin\'s apply.';

const runLine = (command) => `Before committing, run the officers with \`${command}\`.`;
const switchedOff = 'kh-orchestration is switched off for this repository by its owner: commits here are not being checked.';
const exempt = (branch) => `This branch, ${branch}, is exempt from kh-orchestration: its commits are not being checked.`;
const broken = (problem) => `kh-orchestration is installed here, but ${problem}, so every commit here will be refused. ${OWNER_FIXES}`;
const hooksPathSet = (scope) => `kh-orchestration is installed here, but core.hooksPath is set in the ${scope} git configuration, so git runs none of its hooks and commits are not being checked. Only the owner can fix this.`;

/** A name from git or a file as it is shown: control, format and separator characters written as
 * \u{…}, then cut at MAX_NAME characters. */
function shown(text) {
  const visible = String(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (c) => `\\u{${c.codePointAt(0).toString(16)}}`);
  return visible.length > MAX_NAME ? `${visible.slice(0, MAX_NAME)}...` : visible;
}

/** The first thing that will refuse every commit, in the order `statusOf` reports them, as a clause
 * for a sentence, `{ clause }`; `{ hooksPath }` (the scope) when only that is set; null when there is none. */
function firstProblem(status) {
  if (status.install !== null && !status.install.present) return { clause: 'its install is absent from this branch\'s tree' };
  if (status.install !== null && status.install.problem !== null) return { clause: 'the officers file in the staged tree cannot be used' };
  if (!status.contract.ok) return { clause: `kh-harness contract 1 does not hold (${shown(status.contract.problems[0])})` };
  const { bin } = status;
  if (bin !== null) {
    if (!bin.present) return { clause: 'the installed gate directory bin/ is missing' };
    if (!bin.gate) return { clause: 'the installed gate directory bin/ holds no gate' };
    if (bin.differs.length + bin.missing.length + bin.extra.length > 0) return { clause: 'the installed gate directory bin/ differs from the approved scripts' };
  }
  for (const hook of status.hooks) {
    const name = shown(hook.name);
    if (!hook.present) return { clause: `the ${name} git hook is missing` };
    if (hook.misplaced) return { clause: `the ${name} git hook is not where it runs first` };
    if (!hook.ours && !hook.hosted) return { clause: `the ${name} git hook is not kh-orchestration's` };
    if (hook.ours && !hook.matches) return { clause: `the ${name} git hook differs from the installed one` };
    if (!hook.executable) return { clause: `the ${name} git hook is not executable` };
    if ((hook.env !== null && !hook.envExists) || (hook.node !== null && !hook.nodeExists)) return { clause: `the ${name} git hook names a program that is gone` };
  }
  if (status.hooksPath !== null) return { hooksPath: shown(status.hooksPath.scope) };
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
    && object(status.contract) && typeof status.contract.ok === 'boolean' && list(status.contract.problems)
    && (status.contract.ok || status.contract.problems.length > 0)
    && (status.bin === null || (object(status.bin) && typeof status.bin.present === 'boolean' && typeof status.bin.gate === 'boolean'
      && list(status.bin.differs) && list(status.bin.missing) && list(status.bin.extra)))
    && list(status.hooks) && status.hooks.every((hook) => object(hook) && typeof hook.name === 'string' && typeof hook.present === 'boolean')
    && (status.hooksPath === null || (object(status.hooksPath) && typeof status.hooksPath.scope === 'string'));
}

/** The brief for `status`, or null when it is not of a shape this reads. `command` is the working
 * copy's `ko.mjs run` line as the install's own helper prints it. */
function briefFor(status, command) {
  if (!isKnownShape(status)) return null;
  if (status.off) return switchedOff;
  if (status.exemptions?.some((entry) => entry.name === status.branch)) return exempt(shown(status.branch));
  const problem = firstProblem(status);
  if (problem?.hooksPath !== undefined) return hooksPathSet(problem.hooksPath);
  if (problem !== null) return broken(problem.clause);
  // `openForProposals` is null when the proposals file cannot be read: not known to be open.
  const open = status.openForProposals === true ? OPEN_HERE : NOT_OPEN_HERE;
  const full = [CHECKED, runLine(command), OWNER_ONLY, open].join(' ');
  return full.length < MAX_TEXT ? full : [CHECKED, SHORT_RUN, OWNER_ONLY, open].join(' ');
}

/** The top of the git work tree holding `cwd`, or null when there is none or git cannot say. */
function workTreeTop(cwd) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.status === 0 ? result.stdout.replace(/\n$/, '') : null;
}

async function main() {
  // Claude Code gives a SessionStart hook its JSON on standard input: `cwd`, `source`, ...
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (typeof input?.cwd !== 'string' || !isAbsolute(input.cwd)) return;
  const root = workTreeTop(input.cwd);
  if (root === null) return;
  const cli = join(root, CLI);
  if (!lstatSync(cli).isFile()) return;
  const { statusOf, agentCommand } = await import(pathToFileURL(cli).href);
  const status = statusOf(root);
  const text = briefFor(status, agentCommand(root, 'run'));
  if (text === null || text.length >= MAX_TEXT) return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })}\n`);
}

// A SessionStart hook has nothing to block, and a failure here must never stand between the user
// and their session: say nothing, exit 0.
try {
  await main();
} catch {
  // silent by design
}
process.exitCode = 0;
