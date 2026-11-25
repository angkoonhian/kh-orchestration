// The commit gate (decision 17): judge's checks one by one, each refusal's exact reason and next
// command, and then the gate as git runs it, through the hooks decision 18 words.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_MODULE, KIT_VERSION, installGate, installKhHarness, isolateProcessEnv, makeRepo, registerExtension, testEnv } from './test-repo.mjs';
import { REASONS, REFRESH_COMMAND, exemptCommand, judge } from '../../assets/scripts/gate.mjs';
import { COMMANDS } from '../../assets/scripts/extension.mjs';
import { digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { baseOf, currentBranch, indexTree } from '../../assets/scripts/ko-git.mjs';
import { corruptMessage, shapeMessage, stateDir, writeState } from '../../assets/scripts/ko-state.mjs';
import { produceVerdict, writeVerdict } from '../../assets/scripts/ko-verdict.mjs';

isolateProcessEnv();
// The probe runs kh-harness's real hook: its session log and markers go to this run's directories.
const hookDirs = realpathSync(mkdtempSync(join(tmpdir(), 'ko-gate-hook-')));
process.env.KH_DATA_DIR = join(hookDirs, 'data');
process.env.HK_MARKER_DIR = join(hookDirs, 'markers');

const repos = [];
after(() => {
  for (const repo of repos) repo.cleanup();
  rmSync(hookDirs, { recursive: true, force: true });
});

const OFFICERS_PATH = '.claude/kh-orchestration/officers.json';
const officersFile = (ids = ['check'], baseBranch = 'main') => `${JSON.stringify({
  schema: 1, baseBranch, protected: [], officers: ids.map((id) => ({ id, rule: null, argv: ['node', 'tools/check.mjs'], appliesTo: ['**'] })),
}, null, 2)}\n`;
// The one officer: fails while fail.txt is in the working tree.
const CHECK = "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('fail.txt') ? 1 : 0);\n";

// A repository with kh-harness, the gate's hooks and bin/, and the install in the working
// tree, everything staged and nothing committed since the initial commit.
function installed({ baseBranch = 'main', officers = officersFile() } = {}) {
  const repo = makeRepo({ baseBranch, files: { 'a.txt': 'x\n' } });
  repos.push(repo);
  installKhHarness(repo.root);
  installGate(repo.root, { inTree: true });
  registerExtension(repo.root);
  repo.write(OFFICERS_PATH, officers);
  repo.write('tools/check.mjs', CHECK);
  stage(repo);
  return repo;
}

const stage = (repo) => assert.equal(repo.git('add', '-A').status, 0);
const head = (root) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: testEnv(), encoding: 'utf8' }).stdout.trim();
const headOrNull = (root) => {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, env: testEnv(), encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

// What the gate sees for the index of `root`: its tree, its base and its branch.
function subject(root, baseBranch = 'main') {
  return { tree: indexTree(root), base: baseOf(root, baseBranch), branch: currentBranch(root) };
}

const approve = (root, digest) => writeState(root, 'approvals.json', { digests: [{ digest, approvedAt: '2026-11-26T00:00:00.000Z', branch: 'main' }] });
const approveTree = (root, tree) => approve(root, digestOfTree(root, tree).digest);

// A verdict written as `run` will write one, with the officers' results given.
function recordVerdict(root, { tree, base, branch }, results, digest = digestOfTree(root, tree).digest) {
  writeVerdict(root, {
    schema: 1, tree, base, branch, digest, officers: results, agentRuleChanges: [], waivers: [],
    startedAt: '2026-11-26T00:00:00.000Z', finishedAt: '2026-11-26T00:00:01.000Z', kitVersion: KIT_VERSION,
  });
}
const result = (id, outcome) => ({ id, rule: null, result: outcome, exitCode: outcome === 'pass' ? 0 : 1, seconds: 0.1, output: '' });

// Runs the officers on the staged tree, as `run` does, and approves its digest.
async function runAndApprove(root, baseBranch = 'main') {
  const at = subject(root, baseBranch);
  const produced = await produceVerdict(root, { ...at, waivers: [], kitVersion: KIT_VERSION });
  assert.equal(produced.problem, undefined);
  writeVerdict(root, produced.verdict);
  approve(root, produced.verdict.digest);
  return at;
}

const refused = (reason, next) => ({ allow: false, reason, next });
const allowed = (reason) => ({ allow: true, reason, next: '' });

// ---- judge, one check of decision 17 at a time (step 2) ----

test('the command table is the one ko.mjs and the extension name', () => {
  assert.deepEqual(COMMANDS, {
    run: 'node .claude/kh-orchestration/scripts/ko.mjs run',
    approve: 'node .claude/kh-orchestration/scripts/ko.mjs approve',
    status: 'node .claude/kh-orchestration/scripts/ko.mjs status',
  });
  assert.equal(REFRESH_COMMAND, COMMANDS.approve, 'the gate\'s one copy, for when the table cannot be loaded');
});

test('1. the off switch allows, saying kh-orchestration is switched off, before anything else is read', () => {
  const repo = installed();
  writeState(repo.root, 'approvals.json', { digests: 'damaged' });
  writeFileSync(join(stateDir(repo.root), 'off'), '');
  assert.equal(REASONS.off, 'kh-orchestration is switched off for this repository, so this commit is not checked.');
  assert.deepEqual(judge(repo.root, subject(repo.root)), allowed(REASONS.off));
});

test('2. an exempt branch is allowed by its exact name, giving the recorded reason; another name and a detached HEAD are not', () => {
  const repo = installed();
  rmSync(join(repo.root, OFFICERS_PATH));
  stage(repo);
  writeState(repo.root, 'exemptions.json', { branches: [{ name: 'main', reason: 'predates the install', at: '2026-11-26T00:00:00.000Z' }] });
  assert.equal(REASONS.exempt('main', 'predates the install'), 'The branch main is exempt from the commit gate (predates the install), so this commit is not checked.');
  assert.deepEqual(judge(repo.root, subject(repo.root)), allowed(REASONS.exempt('main', 'predates the install')));
  writeState(repo.root, 'exemptions.json', { branches: [{ name: 'mai', reason: 'r', at: 'x' }, { name: 'main/x', reason: 'r', at: 'x' }] });
  assert.equal(judge(repo.root, subject(repo.root)).allow, false);
  writeState(repo.root, 'exemptions.json', { branches: [{ name: 'HEAD', reason: 'r', at: 'x' }] });
  assert.equal(judge(repo.root, { ...subject(repo.root), branch: null }).allow, false);
});

test('3. a tree without officers.json is refused as having no install, naming the owner\'s exemption command', () => {
  const repo = installed();
  rmSync(join(repo.root, OFFICERS_PATH));
  stage(repo);
  const at = subject(repo.root);
  const ko = join(stateDir(repo.root), 'bin', 'ko.mjs');
  assert.equal(exemptCommand(repo.root, 'main'), `node ${ko} exempt main --reason "<why>"`);
  assert.deepEqual(judge(repo.root, at), refused(REASONS.noInstall('.claude/kh-orchestration/officers.json is absent from the tree or is not an officers file.'), exemptCommand(repo.root, 'main')));
});

test('3. a tree without the extension, or with a link in its place, is refused as having no install', () => {
  const repo = installed();
  const missing = `${EXTENSION_MODULE} is not a file in this tree.`;
  repo.git('rm', '-q', '--cached', EXTENSION_MODULE);
  assert.deepEqual(judge(repo.root, subject(repo.root)), refused(REASONS.noInstall(missing), exemptCommand(repo.root, 'main')));
  rmSync(join(repo.root, EXTENSION_MODULE));
  symlinkSync('ko.mjs', join(repo.root, EXTENSION_MODULE));
  stage(repo);
  assert.deepEqual(judge(repo.root, subject(repo.root)), refused(REASONS.noInstall(missing), exemptCommand(repo.root, 'main')));
});

test('3. the exemption command quotes a branch name the shell would read otherwise; a detached HEAD is told to switch to a branch', () => {
  const repo = installed();
  const ko = join(stateDir(repo.root), 'bin', 'ko.mjs');
  assert.equal(exemptCommand(repo.root, "it's$x"), `node ${ko} exempt 'it'\\''s$x' --reason "<why>"`);
  rmSync(join(repo.root, OFFICERS_PATH));
  stage(repo);
  const problem = '.claude/kh-orchestration/officers.json is absent from the tree or is not an officers file.';
  assert.deepEqual(judge(repo.root, { ...subject(repo.root), branch: null }), refused(REASONS.noInstallDetached(problem), 'git switch -c <branch>'));
});

test('4. a contract problem in the working directory is refused, naming the first problem', () => {
  const repo = installed();
  writeFileSync(join(repo.root, '.claude/kh-harness/extensions.json'), '[]\n');
  assert.deepEqual(judge(repo.root, subject(repo.root)), refused(
    REASONS.contract('.claude/kh-harness/extensions.json does not list the extension kh-orchestration as expected'), COMMANDS.status,
  ));
  assert.equal(
    REASONS.contract('x is wrong'),
    'kh-harness contract 1 does not hold in this working directory, so the extension that guards the commit gate may not be running: x is wrong. Repair the install outside Claude Code, then commit again.',
  );
});

test('5. an unparseable RULES.md is refused with the digest\'s problem', () => {
  const repo = installed();
  repo.write('docs/harness/RULES.md', '# Rules\n\n## R1 — one\n\n## R1 — again\n');
  stage(repo);
  const at = subject(repo.root);
  const problem = digestOfTree(repo.root, at.tree).problem;
  assert.match(problem, /^docs\/harness\/RULES\.md line 5: /);
  assert.deepEqual(judge(repo.root, at), refused(REASONS.undigestable(problem), COMMANDS.run));
});

test('6. a digest that is not approved is refused with next naming approve', () => {
  const repo = installed();
  const at = subject(repo.root);
  recordVerdict(repo.root, at, [result('check', 'pass')]);
  const { digest } = digestOfTree(repo.root, at.tree);
  writeState(repo.root, 'approvals.json', { digests: [{ digest: 'f'.repeat(64), approvedAt: 'x', branch: 'main' }] });
  assert.deepEqual(judge(repo.root, at), refused(REASONS.unapproved(digest), COMMANDS.approve));
  assert.equal(REASONS.unapproved('0123456789abcdef'), 'The protected files of this tree (digest 0123456789ab) are not approved. The owner reviews and approves them in their own terminal.');
});

test('7. no verdict for this tree and base is refused with next naming run; a verdict for the same tree and another base is not accepted', () => {
  const repo = installed();
  const at = subject(repo.root);
  approveTree(repo.root, at.tree);
  assert.deepEqual(judge(repo.root, at), refused(REASONS.noVerdict(at.tree, at.base), COMMANDS.run));
  recordVerdict(repo.root, { ...at, base: 'none' }, [result('check', 'pass')]);
  assert.deepEqual(judge(repo.root, at), refused(REASONS.noVerdict(at.tree, at.base), COMMANDS.run));
  assert.equal(REASONS.noVerdict('a'.repeat(40), 'none'), 'No verdict is recorded for this tree (aaaaaaaaaaaa) against its base (none). Run the officers on the staged tree.');
});

test('7. a verdict whose recorded digest differs from the tree\'s is not accepted', () => {
  const repo = installed();
  const at = subject(repo.root);
  approveTree(repo.root, at.tree);
  recordVerdict(repo.root, at, [result('check', 'pass')], 'e'.repeat(64));
  assert.deepEqual(judge(repo.root, at), refused(REASONS.digestDiffers, COMMANDS.run));
});

test('7. an approved digest with a failing verdict names the officers that did not pass', () => {
  const repo = installed({ officers: officersFile(['lint', 'types', 'test']) });
  const at = subject(repo.root);
  approveTree(repo.root, at.tree);
  recordVerdict(repo.root, at, [result('lint', 'fail'), result('types', 'pass'), result('test', 'timeout')]);
  assert.deepEqual(judge(repo.root, at), refused(REASONS.failing(['lint', 'test']), COMMANDS.run));
  assert.equal(REASONS.failing(['lint', 'test']), 'These officers did not pass on this tree: lint, test. Fix what they report, stage the fix, and run the officers again.');
});

test('7. at most ten failed officers are named, then how many more', () => {
  const ids = Array.from({ length: 13 }, (_, index) => `o${index + 1}`);
  const repo = installed({ officers: officersFile(ids) });
  const at = subject(repo.root);
  approveTree(repo.root, at.tree);
  recordVerdict(repo.root, at, ids.map((id) => result(id, 'error')));
  assert.deepEqual(judge(repo.root, at), refused(REASONS.failing(ids), COMMANDS.run));
  assert.equal(REASONS.failing(ids), 'These officers did not pass on this tree: o1, o2, o3, o4, o5, o6, o7, o8, o9, o10 and 3 more. Fix what they report, stage the fix, and run the officers again.');
});

test('7. a verdict whose officers are not the tree\'s, though none failed, is not accepted', () => {
  const repo = installed({ officers: officersFile(['lint', 'types']) });
  const at = subject(repo.root);
  approveTree(repo.root, at.tree);
  recordVerdict(repo.root, at, [result('types', 'pass'), result('lint', 'pass')]);
  assert.deepEqual(judge(repo.root, at), refused(REASONS.otherOfficers, COMMANDS.run));
  recordVerdict(repo.root, at, [result('lint', 'pass')]);
  assert.deepEqual(judge(repo.root, at), refused(REASONS.failing(['types']), COMMANDS.run));
});

test('a passing verdict for this tree and base with an approved digest is allowed', () => {
  const repo = installed({ officers: officersFile(['lint', 'types']) });
  const at = subject(repo.root);
  approveTree(repo.root, at.tree);
  recordVerdict(repo.root, at, [result('lint', 'pass'), result('types', 'skipped')]);
  assert.deepEqual(judge(repo.root, at), allowed(REASONS.allowed));
});

test('judge throws the StateError of a damaged approvals or exemptions file, for the caller to refuse on', () => {
  const repo = installed();
  writeState(repo.root, 'exemptions.json', { branches: [{ name: 'main' }] });
  assert.throws(() => judge(repo.root, subject(repo.root)), { name: 'StateError', message: shapeMessage('exemptions.json') });
  writeState(repo.root, 'exemptions.json', { branches: [] });
  writeFileSync(join(stateDir(repo.root), 'approvals.json'), '{');
  assert.throws(() => judge(repo.root, subject(repo.root)), { name: 'StateError', message: corruptMessage('approvals.json') });
});

// ---- the gate as git runs it (step 3) ----

const gitIn = (root, argv, env = testEnv()) => spawnSync('git', argv, { cwd: root, env, encoding: 'utf8' });
const commit = (root, ...argv) => gitIn(root, ['commit', '-q', '-m', 'work', ...argv]);
const refusalText = (reason, next) => `kh-orchestration: ${reason}\nNext: ${next}\n`;

// git did not commit: the command failed and HEAD is where it was.
function assertRefused(root, outcome, before, stderr) {
  assert.notEqual(outcome.status, 0, outcome.stderr);
  assert.equal(headOrNull(root), before);
  if (stderr !== undefined) assert.equal(outcome.stderr, stderr);
}

test('git commit is refused with the gate\'s text, then accepted after a run and an approval', async () => {
  const repo = installed();
  const before = head(repo.root);
  const at = subject(repo.root);
  approveTree(repo.root, at.tree);
  assertRefused(repo.root, commit(repo.root), before, refusalText(REASONS.noVerdict(at.tree, at.base), COMMANDS.run));
  await runAndApprove(repo.root);
  const accepted = commit(repo.root);
  assert.deepEqual([accepted.status, accepted.stderr], [0, '']);
  assert.notEqual(head(repo.root), before);
});

test('pre-merge-commit: a --no-ff merge into an unmoved main is accepted on the feature branch\'s verdict, and refused once main has moved', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  const forkPoint = head(repo.root);

  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'feature']).status, 0);
  repo.write('b.txt', 'feature\n');
  stage(repo);
  const feature = await runAndApprove(repo.root);
  assert.equal(feature.base, forkPoint);
  assert.equal(commit(repo.root).status, 0);

  assert.equal(gitIn(repo.root, ['switch', '-q', 'main']).status, 0);
  const merged = gitIn(repo.root, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
  assert.deepEqual([merged.status, merged.stderr], [0, '']);
  assert.equal(gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), feature.tree);

  assert.equal(gitIn(repo.root, ['reset', '-q', '--hard', forkPoint]).status, 0);
  repo.write('c.txt', 'main moved\n');
  stage(repo);
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  const moved = head(repo.root);
  const refusedMerge = gitIn(repo.root, ['merge', '-q', '--no-ff', '-m', 'merge feature', 'feature']);
  assertRefused(repo.root, refusedMerge, moved);
  const tree = gitIn(repo.root, ['write-tree']).stdout.trim();
  assert.ok(refusedMerge.stderr.includes(refusalText(REASONS.noVerdict(tree, moved), COMMANDS.run)), refusedMerge.stderr);
});

test('Review Focus 1: a corrupt approvals.json or exemptions.json refuses the commit with fixed text', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  const before = head(repo.root);
  writeFileSync(join(stateDir(repo.root), 'approvals.json'), '{"digests": [');
  assertRefused(repo.root, commit(repo.root), before, refusalText(REASONS.couldNotDecide(corruptMessage('approvals.json')), COMMANDS.status));
  await runAndApprove(repo.root);
  writeState(repo.root, 'exemptions.json', { branches: [{ name: 'main', reason: '' }] });
  assertRefused(repo.root, commit(repo.root), before, refusalText(REASONS.couldNotDecide(shapeMessage('exemptions.json')), COMMANDS.status));
});

test('Review Focus 1: a deleted bin/gate.mjs or bin/ko-git.mjs refuses the commit; a missing sibling with fixed text', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  const before = head(repo.root);
  const bin = join(stateDir(repo.root), 'bin');
  rmSync(join(bin, 'ko-git.mjs'));
  assertRefused(repo.root, commit(repo.root), before, refusalText(REASONS.couldNotDecide(REASONS.siblingMissing(bin)), COMMANDS.approve));
  rmSync(join(bin, 'gate.mjs'));
  assertRefused(repo.root, commit(repo.root), before);
});

test('Review Focus 1: node missing from PATH, or a node that exits 1, in the hook\'s environment refuses the commit', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  const before = head(repo.root);
  const tools = join(repo.root, '..', 'path-without-node');
  mkdirSync(tools);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  symlinkSync(realGit, join(tools, 'git'));
  assertRefused(repo.root, gitIn(repo.root, ['commit', '-q', '-m', 'work'], { ...testEnv(), PATH: tools }), before);
  writeFileSync(join(tools, 'node'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(tools, 'node'), 0o755);
  assertRefused(repo.root, gitIn(repo.root, ['commit', '-q', '-m', 'work'], { ...testEnv(), PATH: tools }), before);
  assert.equal(commit(repo.root).status, 0, 'with node on PATH the same commit is accepted');
});

test('the gate refuses when started with no hook name or an unknown one', () => {
  const repo = installed();
  const gate = join(stateDir(repo.root), 'bin', 'gate.mjs');
  for (const argv of [[], ['post-commit'], ['pre-commit', 'extra']]) {
    const outcome = spawnSync(process.execPath, [gate, ...argv], { cwd: repo.root, env: testEnv(), encoding: 'utf8' });
    assert.deepEqual([outcome.status, outcome.stdout, outcome.stderr], [1, '', refusalText(REASONS.couldNotDecide(REASONS.notAHook), COMMANDS.status)], argv.join(' '));
  }
});

test('the gate prints one line for the off switch and for an exemption, and nothing on a plain allow', async () => {
  const repo = installed();
  writeFileSync(join(stateDir(repo.root), 'off'), '');
  const off = commit(repo.root);
  assert.deepEqual([off.status, off.stderr], [0, `kh-orchestration: ${REASONS.off}\n`]);
  rmSync(join(stateDir(repo.root), 'off'));
  writeState(repo.root, 'exemptions.json', { branches: [{ name: 'main', reason: 'old work', at: 'x' }] });
  repo.write('b.txt', 'y\n');
  stage(repo);
  const exempt = commit(repo.root);
  assert.deepEqual([exempt.status, exempt.stderr], [0, `kh-orchestration: ${REASONS.exempt('main', 'old work')}\n`]);
});

test('with no copy of the scripts in the working tree, the gate in bin/ refuses at the install check, and lets an exempt branch through', () => {
  const repo = makeRepo({ files: { 'a.txt': 'x\n' } });
  repos.push(repo);
  installGate(repo.root);
  repo.write('b.txt', 'y\n');
  stage(repo);
  const before = head(repo.root);
  const problem = '.claude/kh-orchestration/officers.json is absent from the tree or is not an officers file.';
  assertRefused(repo.root, commit(repo.root), before, refusalText(REASONS.noInstall(problem), exemptCommand(repo.root, 'main')));
  writeState(repo.root, 'exemptions.json', { branches: [{ name: 'main', reason: 'predates the install', at: 'x' }] });
  const exempt = commit(repo.root);
  assert.deepEqual([exempt.status, exempt.stderr], [0, `kh-orchestration: ${REASONS.exempt('main', 'predates the install')}\n`]);
});

test('Review Focus 2: from a linked worktree the hooks, verdicts and approvals of the shared directory are found', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  const worktree = repo.addWorktree('side');
  writeFileSync(join(worktree, 'b.txt'), 'side\n');
  assert.equal(gitIn(worktree, ['add', 'b.txt']).status, 0);
  const before = head(worktree);
  const at = subject(worktree);
  assertRefused(worktree, commit(worktree), before, refusalText(REASONS.noVerdict(at.tree, at.base), COMMANDS.run));
  await runAndApprove(worktree);
  assert.equal(commit(worktree).status, 0);
  assert.notEqual(head(worktree), before);
});

test('Review Focus 3: the first commit on an unborn HEAD is judged against the base none', async () => {
  const repo = installed();
  assert.equal(gitIn(repo.root, ['checkout', '-q', '--orphan', 'fresh']).status, 0);
  assert.equal(headOrNull(repo.root), null);
  const at = subject(repo.root);
  assert.equal(at.base, 'none');
  approveTree(repo.root, at.tree);
  assertRefused(repo.root, commit(repo.root), null, refusalText(REASONS.noVerdict(at.tree, 'none'), COMMANDS.run));
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  assert.notEqual(headOrNull(repo.root), null);
});

test('Review Focus 3: in a repository with no main the base is HEAD, and a commit is accepted on that verdict', async () => {
  const repo = installed({ baseBranch: 'trunk' });
  const at = subject(repo.root);
  assert.equal(at.base, head(repo.root));
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
});

test('Review Focus 3: a commit directly on the base branch is judged against HEAD', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  repo.write('b.txt', 'on main\n');
  stage(repo);
  const at = subject(repo.root);
  assert.equal(at.base, head(repo.root));
  recordVerdict(repo.root, { ...at, base: gitIn(repo.root, ['rev-parse', 'HEAD~1']).stdout.trim() }, [result('check', 'pass')]);
  const before = head(repo.root);
  assertRefused(repo.root, commit(repo.root), before, refusalText(REASONS.noVerdict(at.tree, at.base), COMMANDS.run));
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
});

test('git commit -a and a partial commit are judged on the tree actually committed, not the index', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  repo.write('a.txt', 'changed a\n');
  repo.write('b.txt', 'new b\n');
  assert.equal(gitIn(repo.root, ['add', 'b.txt']).status, 0);
  await runAndApprove(repo.root);
  let before = head(repo.root);
  assertRefused(repo.root, commit(repo.root, '-a'), before);

  assert.equal(gitIn(repo.root, ['add', 'a.txt']).status, 0);
  const everything = await runAndApprove(repo.root);
  assert.equal(gitIn(repo.root, ['reset', '-q', '--', 'a.txt']).status, 0);
  assert.notEqual(indexTree(repo.root), everything.tree);
  assert.equal(commit(repo.root, '-a').status, 0);
  assert.equal(gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), everything.tree);

  repo.write('a.txt', 'partial a\n');
  repo.write('b.txt', 'staged b\n');
  assert.equal(gitIn(repo.root, ['add', 'b.txt']).status, 0);
  await runAndApprove(repo.root);
  before = head(repo.root);
  assertRefused(repo.root, commit(repo.root, '--', 'a.txt'), before);
  assert.equal(gitIn(repo.root, ['reset', '-q', '--', 'b.txt']).status, 0);
  assert.equal(gitIn(repo.root, ['add', 'a.txt']).status, 0);
  await runAndApprove(repo.root);
  assert.equal(gitIn(repo.root, ['reset', '-q', '--', 'a.txt']).status, 0);
  assert.equal(gitIn(repo.root, ['add', 'b.txt']).status, 0);
  assert.equal(commit(repo.root, '--', 'a.txt').status, 0);
  assert.equal(gitIn(repo.root, ['show', 'HEAD:b.txt']).stdout, 'new b\n');
});

test('an amended commit on a feature branch is accepted for an unchanged tree and refused for a changed one', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'feature']).status, 0);
  repo.write('b.txt', 'feature\n');
  stage(repo);
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  const amended = gitIn(repo.root, ['commit', '-q', '--amend', '-m', 'reworded']);
  assert.deepEqual([amended.status, amended.stderr], [0, '']);
  const before = head(repo.root);
  repo.write('b.txt', 'changed\n');
  stage(repo);
  assertRefused(repo.root, gitIn(repo.root, ['commit', '-q', '--amend', '-m', 'changed']), before);
});

test('a failing verdict refuses the commit naming the officer; the same tree after a fix is accepted', async () => {
  const repo = installed();
  repo.write('fail.txt', 'x\n');
  stage(repo);
  await runAndApprove(repo.root);
  const before = head(repo.root);
  assertRefused(repo.root, commit(repo.root), before, refusalText(REASONS.failing(['check']), COMMANDS.run));
  rmSync(join(repo.root, 'fail.txt'));
  stage(repo);
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
});
