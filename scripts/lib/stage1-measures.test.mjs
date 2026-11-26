// What stage 1 is measured by (the design's list, Task 12): one test per line, each named with the
// design's words, and each driving only what a person or an agent would run. The fixture helpers
// set the stage (a real repository with kh-harness installed and committed, install-fixture's
// `fresh`); everything of kh-orchestration is then done by its own commands: the plugin's
// apply.mjs and uninstall.mjs, the installed ko.mjs (an agent's commands from the working copy with
// a session's variables set, the owner's from <git-common-dir>/kh-orchestration/bin/ with a clean
// environment and `approve` on standard input), real git commit, rebase and worktree, kh-harness's
// registered PreToolUse entry script run with a tool call on standard input as Claude Code runs it,
// and the plugin's SessionStart hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KH_HARNESS_DIR, testEnv } from './test-repo.mjs';
import { fresh, listing, scratch, sha256 } from './install-fixture.mjs';
import { OFFICERS_PATH, PLUGIN_DIR } from './install.mjs';
import { REASONS } from '../../assets/scripts/ko-gate.mjs';
import { TEXT as KO_TEXT, agentCommand } from '../../assets/scripts/ko-cli.mjs';
import { MESSAGES } from '../../assets/scripts/extension.mjs';
import { INSTALL_PATHS, ownerCommand } from '../../assets/scripts/ko-state.mjs';

// kh-harness's own way of timing a hook (its latency budget tests use it): read from the sibling, never changed.
const { addedLatency } = await import(pathToFileURL(join(KH_HARNESS_DIR, 'scripts', 'lib', 'latency-fixtures.mjs')).href);

// The two lines a hook of this kit prints last when it refuses.
const REFUSED_LINE = 'kh-orchestration: the commit gate did not allow this commit.\nkh-orchestration: for the cause, run kh-orchestration\'s status command (ko.mjs status); if it cannot run, ask the owner to run kh-orchestration\'s apply.\n';
const RULES_PATH = 'docs/harness/RULES.md';
const ENTRY_SCRIPT = '.claude/scripts/dispatch-pre-tool.mjs';
const SESSION_ID = 'ko-stage1-measures';

// The environments: the owner's terminal (no session variables), and a Claude Code session's shell.
// kh-harness's hooks log into this run's directories (install-fixture made them).
const ownerEnv = () => ({ ...testEnv(), KH_DATA_DIR: process.env.KH_DATA_DIR, HK_MARKER_DIR: process.env.HK_MARKER_DIR });
const agentEnv = () => ({ ...ownerEnv(), CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION_ID });

const spawn = (file, argv, { cwd, env, input }) => spawnSync(file, argv, { cwd, env, input, encoding: 'utf8' });
// A command line printed for a person, run as their shell runs it.
const shell = (line, { cwd, env = ownerEnv(), input } = {}) => spawn('/bin/sh', ['-c', line], { cwd, env, input });
const plugin = (name, args, env = ownerEnv()) => spawn(process.execPath, [join(PLUGIN_DIR, 'scripts', `${name}.mjs`), ...args], { cwd: tmpdir(), env });
const git = (root, argv, env = agentEnv()) => spawn('git', argv, { cwd: root, env });
const out = (root, ...argv) => git(root, argv).stdout.replace(/\n$/, '');
const commonDir = (root) => realpathSync(resolve(root, out(root, 'rev-parse', '--git-common-dir')));
// An agent's ko.mjs, the working copy's; the owner's, the approved copy in bin/.
const ko = (root, args) => spawn(process.execPath, [join(root, '.claude/kh-orchestration/scripts/ko.mjs'), ...args], { cwd: root, env: agentEnv() });
const owner = (root, args, { input } = {}) => spawn(process.execPath, [join(commonDir(root), 'kh-orchestration', 'bin', 'ko.mjs'), ...args], { cwd: root, env: ownerEnv(), input });
const approve = (root) => {
  const approved = owner(root, ['approve'], { input: 'approve\n' });
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
};
const status = (root) => JSON.parse(ko(root, ['status', '--json']).stdout);

const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const stage = (root) => assert.equal(git(root, ['add', '-A']).status, 0);
const commit = (root, message = 'work') => git(root, ['commit', '-q', '-m', message]);
// A commit that lands: HEAD moves to a commit of exactly the staged tree.
function lands(root, message) {
  const tree = out(root, 'write-tree');
  const before = out(root, 'rev-parse', 'HEAD');
  const committed = commit(root, message);
  assert.equal(committed.status, 0, committed.stderr);
  assert.notEqual(out(root, 'rev-parse', 'HEAD'), before);
  assert.equal(out(root, 'rev-parse', 'HEAD^{tree}'), tree);
}
// A commit the gate refuses with `reason` and `next`: HEAD does not move.
function refused(root, reason, next) {
  const before = out(root, 'rev-parse', 'HEAD');
  const committed = commit(root);
  assert.equal(committed.status, 1);
  assert.equal(committed.stderr, `kh-orchestration: ${reason}\nNext: ${next}\n${REFUSED_LINE}`);
  assert.equal(out(root, 'rev-parse', 'HEAD'), before);
}
const runPasses = (root) => {
  const ran = ko(root, ['run']);
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  return ran.stdout;
};

// The owner's officer for these measures: fails while src/app.txt holds the word BROKEN.
const CHECK = [
  "import { readFileSync } from 'node:fs';",
  "if (readFileSync('src/app.txt', 'utf8').includes('BROKEN')) {",
  "  console.log('src/app.txt holds the marker BROKEN');",
  '  process.exit(1);',
  '}',
  '',
].join('\n');
const officersText = (extra = {}) => `${JSON.stringify({
  schema: 1, baseBranch: 'main', protected: [], officers: [{ id: 'check', rule: null, argv: ['node', 'tools/check.mjs'], appliesTo: ['**'], ...extra }],
}, null, 2)}\n`;
const RULES = `
## A1 — Keep each log line under one hundred characters
- why: the log viewer cuts longer lines
- enforced-by: review
- approval: agent

## B1 — Every invoice total is the sum of its lines
- why: a total that differs from its lines is a billing error
- enforced-by: review
`;

// A repository as the owner leaves it after installing: kh-harness installed and committed, then
// kh-orchestration's apply --yes; the owner writes the officer and its script and the rules, stages
// everything, approves in their terminal, an agent runs the officers, and the install commit lands.
function installed() {
  const repo = fresh({ files: { 'src/app.txt': 'fine\n' } });
  const { root } = repo;
  const applied = plugin('apply', [root, '--yes']);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  write(root, OFFICERS_PATH, officersText());
  write(root, 'tools/check.mjs', CHECK);
  write(root, RULES_PATH, `${readFileSync(join(root, RULES_PATH), 'utf8')}${RULES}`);
  stage(root);
  approve(root);
  runPasses(root);
  lands(root, 'install kh-orchestration');
  return repo;
}

// A tool call as Claude Code sends kh-harness's registered PreToolUse entry script: the JSON on
// standard input, the project directory in the environment, the session's variables set.
function toolCall(root, tool, input) {
  const payload = { session_id: SESSION_ID, transcript_path: join(root, 'transcript.jsonl'), cwd: root, permission_mode: 'bypassPermissions', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 'ko-measure' };
  const result = spawn(process.execPath, [join(root, ENTRY_SCRIPT)], { cwd: root, env: { ...agentEnv(), CLAUDE_PROJECT_DIR: root }, input: JSON.stringify(payload) });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
const denialOf = (stdout) => (stdout.trim() === '' ? null : JSON.parse(stdout).hookSpecificOutput?.permissionDecisionReason ?? null);
const editOf = (root, path) => toolCall(root, 'Edit', { file_path: join(root, path), old_string: 'a', new_string: 'b' });
const EXTENSION_DENIAL = (message) => `kh-harness extension kh-orchestration: ${message}`;

test('A commit with a failing officer is refused; the same tree after a fix is accepted.', () => {
  const { root } = installed();
  write(root, 'src/app.txt', 'BROKEN\n');
  stage(root);
  const failing = ko(root, ['run']);
  assert.equal(failing.status, 1);
  assert.ok(failing.stdout.includes('    | src/app.txt holds the marker BROKEN\n'), failing.stdout);
  assert.ok(failing.stdout.endsWith(`${KO_TEXT.failing(['check'])}\nNext: ${agentCommand(root, 'run')}\n`), failing.stdout);
  refused(root, REASONS.failing(['check']), agentCommand(root, 'run'));

  write(root, 'src/app.txt', 'fixed\n');
  stage(root);
  const { tree, base } = status(root);
  refused(root, REASONS.noVerdict(tree, base), agentCommand(root, 'run'));
  assert.ok(runPasses(root).endsWith(`${KO_TEXT.passingApproved(tree)}\nNext: git commit\n`));
  lands(root);
});

test('A tree whose protected files differ from every approved digest is refused, even with a passing verdict.', () => {
  const { root } = installed();
  for (const [path, text] of [[OFFICERS_PATH, officersText({ timeoutSeconds: 60 })], ['tools/check.mjs', `${CHECK}// checked by the owner\n`]]) {
    write(root, path, text);
    stage(root);
    const { digest } = status(root);
    const ran = runPasses(root);
    assert.ok(ran.includes(`${KO_TEXT.passingUnapproved(digest)}\n`), ran);
    refused(root, REASONS.unapproved(digest), ownerCommand(root, 'approve'));
    approve(root);
    // The verdict taken before the approval stays valid once its tree's digest is approved.
    lands(root);
  }
});

test('An agent\'s edit to a protected file other than RULES.md is blocked unless the worktree is open for proposals.', () => {
  const repo = installed();
  const { root } = repo;
  const other = repo.addWorktree('other');
  const protectedPaths = [OFFICERS_PATH, 'tools/check.mjs', '.claude/kh-orchestration/scripts/ko.mjs', '.claude/kh-harness/extensions.json', '.claude/scripts/dispatch-pre-tool.mjs', '.claude/settings.json'];
  const blocked = EXTENSION_DENIAL(MESSAGES.protectedEdit);
  for (const where of [root, other]) {
    for (const path of protectedPaths) assert.equal(denialOf(editOf(where, path)), blocked, `${where} ${path}`);
    assert.equal(denialOf(editOf(where, RULES_PATH)), null, where);
    assert.equal(denialOf(editOf(where, 'src/app.txt')), null, where);
  }

  const proposed = owner(root, ['propose']);
  assert.equal(proposed.status, 0, proposed.stderr);
  for (const path of protectedPaths) {
    assert.equal(denialOf(editOf(root, path)), null, path);
    assert.equal(denialOf(editOf(other, path)), blocked, `the other worktree is not open: ${path}`);
  }
  assert.equal(denialOf(editOf(root, '.claude/settings.local.json')), EXTENSION_DENIAL(MESSAGES.localSettingsEdit));
  assert.equal(denialOf(editOf(other, RULES_PATH)), null);

  // The next approve closes the worktree again.
  approve(root);
  assert.equal(denialOf(editOf(root, OFFICERS_PATH)), blocked);
});

test('An agent rewording a rule marked approval: agent can commit; the same edit to any other rule is refused until the owner approves.', () => {
  const { root } = installed();
  assert.equal(git(root, ['switch', '-q', '-c', 'feature']).status, 0);
  const rules = () => readFileSync(join(root, RULES_PATH), 'utf8');
  const agentLine = KO_TEXT.agentChanges([{ id: 'A1' }]);

  // The title and the why of the agent rule: committed without the owner.
  write(root, RULES_PATH, rules().replace('under one hundred characters', 'under eighty characters').replace('the log viewer cuts longer lines', 'the viewer wraps longer lines'));
  stage(root);
  const ran = runPasses(root);
  assert.ok(ran.includes(`${agentLine}\n`), ran);
  assert.ok(ran.endsWith('Next: git commit\n'), ran);
  lands(root);
  const verified = ko(root, ['verify-branch']);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.ok(verified.stdout.includes(`${agentLine}\n`), verified.stdout);
  assert.ok(verified.stdout.endsWith(`${KO_TEXT.verified}\n`), verified.stdout);

  // The same edit to the owner's rule, and a status line added to the agent rule (amended decision
  // 12: only the title and the why, verify and priority values are free), each need the owner.
  const edits = [
    rules().replace('the sum of its lines', 'the sum of its line items').replace('a total that differs from its lines is a billing error', 'a wrong total is a billing error'),
    rules().replace('- approval: agent\n', '- approval: agent\n- status: superseded\n'),
  ];
  for (const text of edits) {
    write(root, RULES_PATH, text);
    stage(root);
    const { digest } = status(root);
    assert.ok(runPasses(root).includes(`${KO_TEXT.passingUnapproved(digest)}\n`));
    refused(root, REASONS.unapproved(digest), ownerCommand(root, 'approve'));
    approve(root);
    lands(root);
  }
});

test('A branch rebuilt by rebase fails verify-branch until the officers pass on its head.', () => {
  const { root } = installed();
  const workOn = (branch, path, text) => {
    assert.equal(git(root, ['switch', '-q', branch]).status, 0);
    write(root, path, text);
    stage(root);
    runPasses(root);
    lands(root);
  };
  const verifyNext = `Next: ${agentCommand(root, 'verify-branch')}\n`;
  assert.equal(git(root, ['branch', 'feature']).status, 0);
  workOn('feature', 'src/feature.txt', 'one\n');
  workOn('main', 'src/main.txt', 'two\n');
  assert.equal(git(root, ['switch', '-q', 'feature']).status, 0);
  assert.equal(ko(root, ['verify-branch', '--no-run']).status, 0, 'the gate accepted the feature head');

  // Rebuilt by rebase: git runs no commit hook, so its new head has no verdict.
  assert.equal(git(root, ['rebase', '-q', 'main']).status, 0);
  const { headTree, headBase } = status(root);
  const unverified = ko(root, ['verify-branch', '--no-run']);
  assert.equal(unverified.status, 1);
  assert.ok(unverified.stdout.includes(`${KO_TEXT.headNotRecorded}\n`), unverified.stdout);
  assert.ok(unverified.stdout.endsWith(`${KO_TEXT.notVerified(REASONS.noVerdict(headTree, headBase))}\n${verifyNext}`), unverified.stdout);
  const verified = ko(root, ['verify-branch']);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.ok(verified.stdout.endsWith(`${KO_TEXT.verified}\n`));

  // A base the gate never saw (a person's --no-verify commit in their own terminal) brings in a
  // failure: the rebuilt head fails verify-branch, with the officers run, until it is fixed.
  assert.equal(git(root, ['switch', '-q', 'main']).status, 0);
  write(root, 'src/app.txt', 'BROKEN\n');
  stage(root);
  assert.equal(git(root, ['commit', '-q', '--no-verify', '-m', 'unchecked'], ownerEnv()).status, 0);
  assert.equal(git(root, ['switch', '-q', 'feature']).status, 0);
  assert.equal(git(root, ['rebase', '-q', 'main']).status, 0);
  assert.equal(ko(root, ['verify-branch', '--no-run']).status, 1);
  const failing = ko(root, ['verify-branch']);
  assert.equal(failing.status, 1);
  assert.ok(failing.stdout.endsWith(`${KO_TEXT.notVerified(REASONS.failing(['check']))}\n${verifyNext}`), failing.stdout);
  workOn('feature', 'src/app.txt', 'fixed\n');
  assert.equal(ko(root, ['verify-branch', '--no-run']).status, 0);
});

// kh-harness's latency budget tests (harness-dispatch.test.mjs, "latency budget: …") time its own
// fixtures and are not parameterised by a repository, so the same measure is taken here, by its own
// function, on the registered entry script of a repository before and after kh-orchestration's
// apply: the fastest of 20 interleaved runs against as many bare node starts.
// Measured 2026-11-26 on the build machine (Node 26.13.1, git 2.56.1), this test alone, three runs:
// the entry script adds 11.8 to 14.7 ms to a bare node start before the install and 21.8 to 22.7 ms
// after it, so the extension (kh-harness's loader and this plugin's module) costs 7 to 11 ms per
// tool call; the medians were 29.8 to 31.1 ms against 37.7 to 39.0 ms. The bound on that
// difference is EXTENSION_BOUND_MS, with room for a loaded machine.
const ADDED_LATENCY_BUDGET_MS = 100; // kh-harness's ADDED_LATENCY_BUDGET_MS, harness-dispatch.test.mjs
const EXTENSION_BOUND_MS = 25;
test('With the hook extension loaded, kh-harness\'s latency budget tests still pass.', () => {
  const { root } = fresh();
  const payload = JSON.stringify({ session_id: SESSION_ID, cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'ko-latency' });
  const env = { ...agentEnv(), CLAUDE_PROJECT_DIR: root };
  const measure = () => addedLatency({
    runHookOnce: () => {
      const result = spawn(process.execPath, [join(root, ENTRY_SCRIPT)], { cwd: root, env, input: payload });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.equal(denialOf(result.stdout), null);
    },
    stdin: payload, env, pairs: 20,
  });
  const before = measure();
  assert.equal(plugin('apply', [root, '--yes']).status, 0);
  assert.ok(existsSync(join(root, '.claude/kh-harness/extensions.json')));
  assert.ok(denialOf(toolCall(root, 'Bash', { command: 'git commit --no-verify -m x' })).startsWith('kh-harness extension kh-orchestration: '), 'the extension runs');
  const after = measure();
  assert.ok(after.added <= ADDED_LATENCY_BUDGET_MS, `${after.summary}; budget ${ADDED_LATENCY_BUDGET_MS} ms`);
  assert.ok(after.added - before.added <= EXTENSION_BOUND_MS, `with the extension: ${after.summary}; without: ${before.summary}; bound ${EXTENSION_BOUND_MS} ms`);
});

// The repository as git and a person see it, without kh-harness's install (set before and kept).
const worktreeFiles = (root) => Object.fromEntries(Object.entries(listing(root)).filter(([path]) => path !== '.git/' && !path.startsWith('.git/')));
const gitSide = (root) => ({
  hooks: listing(join(root, '.git', 'hooks')),
  info: listing(join(root, '.git', 'info')),
  config: readFileSync(join(root, '.git', 'config'), 'utf8'),
  state: existsSync(join(root, '.git', 'kh-orchestration')),
});
const refs = (root) => out(root, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter((line) => line !== '').sort();
const commits = (root) => out(root, 'rev-list', '--all').split('\n').filter((line) => line !== '').sort();

test('Uninstall leaves the repository as it was, including the git hook.', () => {
  const repo = fresh({ files: { 'package.json': `${JSON.stringify({ scripts: { test: 'node -e 0' } })}\n` } });
  const { root } = repo;
  const before = { files: worktreeFiles(root), git: gitSide(root), refs: refs(root), commits: commits(root) };
  assert.equal(before.git.state, false);

  // The whole lifecycle with apply's own officers: install, approve, commits, an exemption, a waiver, a proposal.
  assert.equal(plugin('apply', [root, '--yes']).status, 0);
  stage(root);
  approve(root);
  runPasses(root);
  lands(root, 'install');
  const made = [out(root, 'rev-parse', 'HEAD')];
  assert.equal(owner(root, ['exempt', 'side', '--reason', 'a trial branch']).status, 0);
  assert.equal(git(root, ['switch', '-q', '-c', 'side']).status, 0);
  write(root, 'side.txt', 'side\n');
  stage(root);
  lands(root, 'on the exempt branch');
  made.push(out(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, ['switch', '-q', 'main']).status, 0);
  assert.equal(owner(root, ['waive', 'V8', '--reason', 'the docs follow']).status, 0);
  assert.equal(owner(root, ['propose']).status, 0);
  write(root, 'src/work.txt', 'work\n');
  stage(root);
  runPasses(root);
  lands(root, 'work');
  made.push(out(root, 'rev-parse', 'HEAD'));
  assert.ok(refs(root).some((line) => line.startsWith('refs/kh-orchestration/approved/')));

  const uninstalled = plugin('uninstall', [root, '--yes', '--state']);
  assert.equal(uninstalled.status, 0, uninstalled.stdout + uninstalled.stderr);
  // Gone: the hooks, the shared state, its refs, and every file apply wrote. Kept: the history,
  // with the commits made, and in the working tree what those commits added of the owner's.
  assert.deepEqual(gitSide(root), before.git);
  assert.deepEqual(refs(root), [...before.refs.filter((line) => !line.startsWith('refs/heads/main ')), `refs/heads/main ${made[2]}`, `refs/heads/side ${made[1]}`].sort());
  assert.deepEqual(commits(root), [...before.commits, ...made].sort());
  const files = worktreeFiles(root);
  assert.deepEqual(files, { ...before.files, 'src/': '', 'src/work.txt': files['src/work.txt'] });
  assert.ok(files['src/work.txt'].endsWith(` ${sha256(Buffer.from('work\n'))}`));
  // The committed install is now a deletion in the working tree, which the owner commits with no gate.
  const deleted = out(root, 'diff', '--name-only').split('\n');
  assert.ok(deleted.length > 0 && deleted.every((path) => INSTALL_PATHS.some((install) => path === install || path.startsWith(`${install}/`))), deleted.join(', '));
  assert.equal(git(root, ['commit', '-q', '-a', '-m', 'uninstall kh-orchestration'], ownerEnv()).status, 0);
  assert.equal(out(root, 'status', '--porcelain'), '');
});

test('A fresh session\'s brief says commits are checked and gives a run command that works when pasted; the first refused commit names the next command.', () => {
  const { root } = installed();
  const input = JSON.stringify({ session_id: SESSION_ID, transcript_path: join(root, 'transcript.jsonl'), cwd: root, hook_event_name: 'SessionStart', source: 'startup' });
  const started = spawn(process.execPath, [join(PLUGIN_DIR, 'scripts', 'session-brief.mjs')], { cwd: root, env: { ...agentEnv(), CLAUDE_PROJECT_DIR: root }, input });
  assert.equal(started.status, 0, started.stderr);
  const brief = JSON.parse(started.stdout).hookSpecificOutput.additionalContext;
  assert.match(brief, /^Commits in this repository are checked by kh-orchestration/);
  const command = brief.match(/`([^`]+ run)`/)?.[1];
  assert.ok(command !== undefined, brief);

  // A session that ignored the brief: its first commit is refused, and the next line it names works.
  write(root, 'src/one.txt', 'one\n');
  stage(root);
  const { tree, base } = status(root);
  refused(root, REASONS.noVerdict(tree, base), agentCommand(root, 'run'));
  assert.equal(shell(agentCommand(root, 'run'), { cwd: root, env: agentEnv() }).status, 0);
  lands(root);

  // The brief's own line, pasted, from a subdirectory of the worktree.
  write(root, 'src/two.txt', 'two\n');
  stage(root);
  const pasted = shell(command, { cwd: join(root, 'src'), env: agentEnv() });
  assert.equal(pasted.status, 0, pasted.stdout + pasted.stderr);
  lands(root);
});

// lifecycle.test.mjs follows the printed steps in a path with spaces from the main worktree, and
// from a linked worktree in a plain path; this is the two together, from the dry run's own line on.
test('The owner\'s whole path, following only the printed next lines, lands a commit from a linked worktree in a path with spaces.', () => {
  const repo = fresh();
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'ko measures ')));
  scratch.push(container);
  const root = join(container, 'my repo');
  cpSync(repo.root, root, { recursive: true, verbatimSymlinks: true });
  const worktree = join(container, 'side tree');
  assert.equal(git(root, ['worktree', 'add', '-q', '-b', 'side', worktree], ownerEnv()).status, 0);
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'ko-owner-')));
  scratch.push(elsewhere);

  const dry = plugin('apply', [worktree]);
  assert.equal(dry.status, 0, dry.stderr);
  const yes = shell(dry.stdout.trimEnd().split('\n').at(-1).replace(/^.*outside Claude Code: /, ''), { cwd: elsewhere });
  assert.equal(yes.status, 0, yes.stdout + yes.stderr);
  const step = (number) => yes.stdout.split('\n').find((line) => line.startsWith(`${number}. `)).replace(/^\d\. [^:]+: /, '');
  assert.equal(shell(step(2), { cwd: elsewhere }).status, 0);
  const approved = shell(step(3), { cwd: elsewhere, input: 'approve\n' });
  assert.equal(approved.status, 0, approved.stdout + approved.stderr);
  const ran = shell(step(4), { cwd: elsewhere, env: agentEnv() });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const head = out(worktree, 'rev-parse', 'HEAD');
  const committed = shell(`${step(5)} -q -m 'install kh-orchestration'`, { cwd: elsewhere, env: agentEnv() });
  assert.equal(committed.status, 0, committed.stderr);
  assert.notEqual(out(worktree, 'rev-parse', 'HEAD'), head);
  assert.equal(out(worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), 'side');
  assert.deepEqual(status(worktree).problems, []);
});
