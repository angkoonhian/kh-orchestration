// apply, detect and uninstall as the owner runs them (Task 9): the three commands spawned from the
// plugin on real repositories with a real kh-harness install, and the commit gate they install
// exercised through real git. The installer's logic case by case is install.test.mjs's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_VERSION, installKhHarness, isolateProcessEnv, makeRepo, testEnv } from './test-repo.mjs';
import { EXTENSIONS_PATH, OFFICERS_PATH, PLUGIN_DIR, SCRIPTS_DIR, TEXT, applyCommand, envPath, plan, planLines, uninstallPlan } from './install.mjs';
import { MANIFEST_PATH } from './manifest.mjs';
import { HOOK_NAMES, hookLine, hookText } from '../../assets/scripts/ko-hooks.mjs';
import { checkContract1, probeContract1 } from '../../assets/scripts/verify-contract-1.mjs';
import { PROBE_PAYLOAD, ownEntry } from '../../assets/scripts/ko-contract.mjs';
import { REASONS } from '../../assets/scripts/ko-gate.mjs';
import { digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { indexTree } from '../../assets/scripts/ko-git.mjs';
import { stateDir } from '../../assets/scripts/ko-state.mjs';

isolateProcessEnv();
// The in-process calls run git with this process's environment: no user or system configuration.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const hookDirs = realpathSync(mkdtempSync(join(tmpdir(), 'ko-lifecycle-hook-')));
process.env.KH_DATA_DIR = join(hookDirs, 'data');
process.env.HK_MARKER_DIR = join(hookDirs, 'markers');
const repos = [];
const scratch = [hookDirs];
after(() => {
  for (const repo of repos) repo.cleanup();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const REFUSED_LINE = 'kh-orchestration: the commit gate did not allow this commit.\n';
const command = (name) => join(PLUGIN_DIR, 'scripts', `${name}.mjs`);
const env = () => ({ ...testEnv(), KH_DATA_DIR: process.env.KH_DATA_DIR, HK_MARKER_DIR: process.env.HK_MARKER_DIR });
const run = (name, args, options = {}) => spawnSync(process.execPath, [command(name), ...args], { env: env(), encoding: 'utf8', ...options });
// A command line printed for a person, run as a shell runs it.
const shell = (line, options = {}) => spawnSync('/bin/sh', ['-c', line], { env: env(), encoding: 'utf8', ...options });
const git = (root, ...argv) => spawnSync('git', argv, { cwd: root, env: env(), encoding: 'utf8' });

// A repository with kh-harness installed and committed, as an owner has it before installing kh-orchestration.
function fresh({ files = { 'package.json': `${JSON.stringify({ scripts: { test: 'node -e 0' } })}\n` } } = {}) {
  const repo = makeRepo({ files });
  repos.push(repo);
  installKhHarness(repo.root);
  repo.commitAll('kh-harness');
  return repo;
}
// The same repository copied to a path holding spaces.
function withSpaces(repo) {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'ko lifecycle ')));
  scratch.push(container);
  const root = join(container, 'my repo');
  cpSync(repo.root, root, { recursive: true, verbatimSymlinks: true });
  return root;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
function listing(dir) {
  if (!existsSync(dir)) return {};
  const walk = (relative) => readdirSync(join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) return [[`${path}/`, ''], ...walk(path)];
    const stat = lstatSync(join(dir, path));
    return [[path, `${(stat.mode & 0o777).toString(8)} ${entry.isSymbolicLink() ? 'link' : sha256(readFileSync(join(dir, path)))}`]];
  });
  return Object.fromEntries(walk(''));
}
const porcelain = (root) => git(root, 'status', '--porcelain', '-uall').stdout;
const statusJson = (root) => JSON.parse(spawnSync(process.execPath, [join(root, SCRIPTS_DIR, 'ko.mjs'), 'status', '--json'], { cwd: root, env: env(), encoding: 'utf8' }).stdout);
const lines = (text) => text.split('\n').filter((line) => line !== '');

// The owner's steps exactly as apply --yes printed them (decision 5): stage, approve from bin/
// with the word on standard input, run the officers, commit.
function ownerSteps(stdout) {
  const step = (number) => stdout.split('\n').find((line) => line.startsWith(`${number}. `)).replace(/^\d\. [^:]+: /, '');
  return { stage: step(2), approve: step(3), run: step(4), commit: step(5) };
}
function followSteps(root, stdout) {
  const steps = ownerSteps(stdout);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ko-owner-')));
  scratch.push(outside);
  assert.equal(shell(steps.stage, { cwd: outside }).status, 0);
  const approved = shell(steps.approve, { cwd: outside, input: 'approve\n' });
  assert.equal(approved.status, 0, approved.stderr);
  const ran = shell(steps.run, { cwd: outside });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const before = git(root, 'rev-parse', 'HEAD').stdout;
  const committed = shell(`${steps.commit} -q -m install`, { cwd: outside });
  assert.equal(committed.status, 0, committed.stderr);
  assert.notEqual(git(root, 'rev-parse', 'HEAD').stdout, before, 'the commit landed');
}

test('the commands print their usage and refuse what they do not take, with exit 2', () => {
  for (const [name, flags] of [['apply', '<repository> [--yes]'], ['detect', '<repository> [--json]'], ['uninstall', '<repository> [--yes] [--state]']]) {
    const usage = `usage: node ${command(name)} ${flags}\n`;
    assert.deepEqual([run(name, ['--help']).status, run(name, ['--help']).stdout], [0, usage]);
    assert.deepEqual([run(name, []).status, run(name, []).stderr], [2, `kh-orchestration: ${TEXT.missingRepository}\n${usage}`]);
    assert.deepEqual([run(name, ['.', '--force']).status, run(name, ['.', '--force']).stderr], [2, `kh-orchestration: ${TEXT.unexpectedArgument('--force')}\n${usage}`]);
    assert.deepEqual([run(name, ['a', 'b']).status, run(name, ['a', 'b']).stderr], [2, `kh-orchestration: ${TEXT.unexpectedArgument('b')}\n${usage}`]);
  }
});

test('apply refuses outside a repository and before kh-harness, with exit 1 and fixed text', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ko-nowhere-')));
  scratch.push(dir);
  assert.deepEqual([run('apply', [dir]).status, run('apply', [dir]).stderr], [1, `kh-orchestration: ${TEXT.notARepository(dir)}\nNext: git -C ${dir} init\n`]);
  const bare = makeRepo();
  repos.push(bare);
  const refused = run('apply', [bare.root, '--yes']);
  assert.deepEqual([refused.status, refused.stdout, refused.stderr], [1, '', `kh-orchestration: ${TEXT.noContract}\nNext: node <kh-harness>/scripts/apply.mjs ${bare.root} --yes\n`]);
});

test('the dry run prints every action and writes nothing, in the tree, the hooks folder or the shared state', () => {
  const repo = fresh();
  const before = { tree: listing(repo.root) };
  const dry = run('apply', [repo.root]);
  assert.equal(dry.status, 0, dry.stderr);
  const planned = plan(repo.root);
  assert.equal(dry.stdout, `${[...planLines(planned, { dryRun: true }), TEXT.dryRunEnd(applyCommand(repo.root))].join('\n')}\n`);
  assert.deepEqual({ tree: listing(repo.root) }, before);
  assert.equal(existsSync(stateDir(repo.root)), false);
});

test('apply --yes in a path with spaces installs a gate that refuses a real commit, and the owner\'s printed steps land one; a second apply proposes nothing', () => {
  const root = withSpaces(fresh());
  const applied = run('apply', [root, '--yes']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.stderr, '');
  const entry = ownEntry(root);
  assert.deepEqual(checkContract1(root, entry), { problems: [], warnings: [] });
  assert.deepEqual(probeContract1(root, entry, { ...PROBE_PAYLOAD, cwd: root }), { problems: [] });
  for (const name of HOOK_NAMES) assert.equal(readFileSync(join(root, '.git', 'hooks', name), 'utf8'), hookText(name, { env: envPath(), node: process.execPath, version: KIT_VERSION }), name);

  // The printed text: the plan, then the closing steps, then what each officer's digest locks.
  const stdout = lines(applied.stdout);
  assert.ok(stdout.includes(TEXT.installed(root)));
  assert.ok(stdout.includes(TEXT.notApprovedYet));
  const steps = ownerSteps(applied.stdout);
  assert.equal(steps.approve, `cd '${root}' && node '${join(stateDir(root), 'bin', 'ko.mjs')}' approve`);
  assert.equal(steps.run, `cd '${root}' && node '${join(root, SCRIPTS_DIR, 'ko.mjs')}' run`);
  assert.ok(stdout.includes(TEXT.coverageLine({ id: 'test', command: 'npm run test', covered: [], notLocked: [TEXT.packageJsonNotLocked] })));

  // A real commit is refused by the gate: first with the install not in the tree, then unapproved.
  const head = git(root, 'rev-parse', 'HEAD').stdout;
  const early = git(root, 'commit', '-q', '--allow-empty', '-m', 'early');
  assert.equal(early.status, 1);
  assert.ok(early.stderr.startsWith('kh-orchestration: This tree holds no usable kh-orchestration install'), early.stderr);
  assert.ok(early.stderr.endsWith(REFUSED_LINE));
  assert.equal(shell(steps.stage).status, 0);
  const unapproved = git(root, 'commit', '-q', '-m', 'unapproved');
  assert.equal(unapproved.status, 1);
  assert.ok(unapproved.stderr.startsWith(`kh-orchestration: ${REASONS.unapproved(digestOfTree(root, indexTree(root)).digest)}\n`), unapproved.stderr);
  assert.ok(unapproved.stderr.endsWith(REFUSED_LINE));
  assert.equal(git(root, 'rev-parse', 'HEAD').stdout, head);

  followSteps(root, applied.stdout);
  assert.deepEqual(statusJson(root).problems, []);
  const before = { tree: listing(root) };
  const again = run('apply', [root, '--yes']);
  assert.deepEqual([again.status, again.stdout], [0, `${TEXT.nothingToDo(root)}\n`]);
  assert.deepEqual({ tree: listing(root) }, before, 'a second apply writes nothing');
});

test('apply from a linked worktree installs for the repository: the hooks and the state are the common directory\'s, and a commit lands there through the printed steps', () => {
  const repo = fresh();
  const worktree = repo.addWorktree('side');
  const applied = run('apply', [join(worktree, '.claude')]);
  assert.equal(applied.status, 0, applied.stderr);
  const yes = run('apply', [worktree, '--yes']);
  assert.equal(yes.status, 0, yes.stderr);
  for (const name of HOOK_NAMES) assert.ok(existsSync(join(repo.root, '.git', 'hooks', name)), name);
  assert.ok(existsSync(join(repo.root, '.git', 'kh-orchestration', 'bin', 'gate.mjs')));
  assert.ok(existsSync(join(worktree, OFFICERS_PATH)));
  assert.equal(existsSync(join(repo.root, OFFICERS_PATH)), false, 'the main worktree\'s files are its own');
  followSteps(worktree, yes.stdout);
  assert.equal(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD').stdout, 'side\n');
  assert.deepEqual(statusJson(worktree).problems, []);
});

test('apply repairs a missing bin/, a damaged bin/ file and a damaged hook, after which status finds no problem', () => {
  const repo = fresh();
  const applied = run('apply', [repo.root, '--yes']);
  followSteps(repo.root, applied.stdout);
  assert.deepEqual(statusJson(repo.root).problems, []);
  const bin = join(stateDir(repo.root), 'bin');
  const damages = [
    ['bin/ removed', () => rmSync(bin, { recursive: true })],
    ['a bin/ file damaged', () => writeFileSync(join(bin, 'ko-gate.mjs'), 'export const broken = true;\n')],
    ['a hook edited', () => writeFileSync(join(repo.root, '.git', 'hooks', 'pre-commit'), readFileSync(join(repo.root, '.git', 'hooks', 'pre-commit'), 'utf8').replace('exit 1\n', 'exit 0\n'))],
    ['a hook not executable', () => chmodSync(join(repo.root, '.git', 'hooks', 'reference-transaction'), 0o644)],
  ];
  for (const [what, damage] of damages) {
    damage();
    assert.notDeepEqual(statusJson(repo.root).problems, [], what);
    const repaired = run('apply', [repo.root, '--yes']);
    assert.equal(repaired.status, 0, `${what}: ${repaired.stderr}`);
    assert.deepEqual(lines(repaired.stdout).slice(-2), [TEXT.installed(repo.root), TEXT.repaired], what);
    assert.deepEqual(statusJson(repo.root).problems, [], what);
    assert.equal(porcelain(repo.root), '', `${what}: the repair changes nothing in the tree`);
  }
});

test('apply over a hook that is not kh-orchestration\'s writes none of the three, prints the line to add, and says the install is incomplete', () => {
  const repo = fresh();
  const preCommit = join(repo.root, '.git', 'hooks', 'pre-commit');
  writeFileSync(preCommit, '#!/bin/sh\nexit 0\n');
  chmodSync(preCommit, 0o755);
  const applied = run('apply', [repo.root, '--yes']);
  assert.equal(applied.status, 1);
  assert.ok(applied.stdout.includes(TEXT.hookConflict('pre-commit', preCommit, hookLine('pre-commit', { env: envPath(), node: process.execPath }))));
  assert.ok(applied.stdout.endsWith(`${TEXT.incomplete}\n`));
  assert.equal(readFileSync(preCommit, 'utf8'), '#!/bin/sh\nexit 0\n');
  for (const name of ['pre-merge-commit', 'reference-transaction']) assert.equal(existsSync(join(repo.root, '.git', 'hooks', name)), false);
});

test('detect reports no install, a fresh install, and each broken state, and --json carries the same in a stable shape; it writes nothing', () => {
  const repo = fresh();
  const none = run('detect', [repo.root]);
  assert.equal(none.status, 0, none.stderr);
  assert.ok(lines(none.stdout).includes('Install: kh-orchestration is not installed here.'));
  const noneJson = JSON.parse(run('detect', [repo.root, '--json']).stdout);
  assert.deepEqual(Object.keys(noneJson), ['schema', 'root', 'plugin', 'install', 'files', 'officers', 'gitattributes', 'extensionEntry', 'hooks', 'coverage', 'status', 'statusError', 'apply']);
  assert.deepEqual(noneJson.install, { version: null, manifest: { state: 'absent', kitVersion: null, installedAt: null } });
  assert.ok(noneJson.files.every((file) => file.state === 'missing'));
  assert.deepEqual(noneJson.hooks.map((hook) => hook.state), ['missing', 'missing', 'missing']);
  assert.equal(noneJson.apply.actions.length, 21);

  run('apply', [repo.root, '--yes']);
  const before = { tree: listing(repo.root) };
  const fine = JSON.parse(run('detect', [repo.root, '--json']).stdout);
  assert.deepEqual({ tree: listing(repo.root) }, before, 'detect writes nothing');
  assert.deepEqual(Object.keys(fine), Object.keys(noneJson));
  assert.equal(fine.install.version, KIT_VERSION);
  assert.equal(fine.install.manifest.state, 'ok');
  assert.ok(fine.files.every((file) => file.state === 'current'));
  assert.deepEqual(fine.extensionEntry, { state: 'matches', onFailure: 'block', problem: null });
  assert.deepEqual(fine.hooks.map((hook) => hook.state), ['current', 'current', 'current']);
  assert.deepEqual(fine.gitattributes, { line: true });
  assert.deepEqual(fine.coverage, [{ id: 'test', command: 'npm run test', covered: [], notLocked: [TEXT.packageJsonNotLocked] }]);
  assert.deepEqual(fine.apply, { refusals: [], conflicts: [], actions: [], notes: [] });
  // Nothing is staged yet, so the staged tree holds no officers file and has no digest.
  assert.equal(fine.status.digestApproved, null);

  // Broken: bin/ gone, a hook someone else's, a script edited, the manifest damaged.
  rmSync(join(stateDir(repo.root), 'bin'), { recursive: true });
  writeFileSync(join(repo.root, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(repo.root, SCRIPTS_DIR, 'ko-git.mjs'), `${readFileSync(join(repo.root, SCRIPTS_DIR, 'ko-git.mjs'), 'utf8')}// edited\n`);
  const broken = JSON.parse(run('detect', [repo.root, '--json']).stdout);
  assert.equal(broken.files.find((file) => file.path.endsWith('/ko-git.mjs')).state, 'edited');
  assert.deepEqual(broken.hooks.map((hook) => hook.state), ['current', 'not-ours', 'current']);
  assert.ok(broken.status.problems.some((problem) => problem.text === `There is no ${join(stateDir(repo.root), 'bin')}/, so the hooks find no gate and every commit is refused.`));
  assert.deepEqual(broken.apply.conflicts.map((conflict) => conflict.text), [TEXT.scriptEdited(`${SCRIPTS_DIR}/ko-git.mjs`), TEXT.hooksStopped]);
  const brokenText = run('detect', [repo.root]);
  assert.ok(lines(brokenText.stdout).includes(`  ${SCRIPTS_DIR}/ko-git.mjs: changed since kh-orchestration wrote it (stamped ${KIT_VERSION})`));
  assert.ok(lines(brokenText.stdout).includes('  pre-merge-commit: not kh-orchestration\'s'));
  writeFileSync(join(repo.root, MANIFEST_PATH), '{ cut');
  const corrupt = JSON.parse(run('detect', [repo.root, '--json']).stdout);
  assert.equal(corrupt.install.manifest.state, 'corrupt');
  assert.deepEqual(corrupt.apply.refusals, [{ text: TEXT.manifestCorrupt, next: `git -C ${repo.root} checkout -- ${MANIFEST_PATH}` }]);

  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ko-nowhere-')));
  scratch.push(dir);
  assert.deepEqual([run('detect', [dir]).status, run('detect', [dir]).stderr], [1, `kh-orchestration: ${TEXT.notARepository(dir)}\nNext: git -C ${dir} init\n`]);
});

test('uninstall restores the repository exactly, keeps the shared state without --state and says where, and removes it with --state', () => {
  for (const state of [false, true]) {
    const repo = fresh({ files: { 'package.json': '{}\n', '.gitattributes': '*.png binary\n' } });
    const tree = porcelain(repo.root);
    const hooks = listing(join(repo.root, '.git', 'hooks'));
    run('apply', [repo.root, '--yes']);
    const dryBefore = { tree: listing(repo.root) };
    const dry = run('uninstall', [repo.root, ...(state ? ['--state'] : [])]);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual({ tree: listing(repo.root) }, dryBefore, 'the dry run removes nothing');
    const done = run('uninstall', [repo.root, '--yes', ...(state ? ['--state'] : [])]);
    assert.equal(done.status, 0, done.stderr);
    assert.equal(porcelain(repo.root), tree);
    assert.equal(readFileSync(join(repo.root, '.gitattributes'), 'utf8'), '*.png binary\n');
    assert.deepEqual(listing(join(repo.root, '.git', 'hooks')), hooks);
    assert.equal(existsSync(stateDir(repo.root)), !state);
    assert.equal(lines(done.stdout).includes(TEXT.stateRemains(stateDir(repo.root))), !state);
    assert.ok(done.stdout.endsWith(`${TEXT.uninstalled(repo.root)}\n`));
  }
});

test('uninstall keeps what the owner changed and reports it, and refuses --yes inside a Claude Code session', () => {
  const repo = fresh();
  run('apply', [repo.root, '--yes']);
  writeFileSync(join(repo.root, OFFICERS_PATH), '{"schema": 1, "mine": true}\n');
  const hook = join(repo.root, '.git', 'hooks', 'pre-commit');
  writeFileSync(hook, `${readFileSync(hook, 'utf8')}# the owner's line\n`);
  const before = { tree: listing(repo.root) };
  const session = run('uninstall', [repo.root, '--yes'], { env: { ...env(), CLAUDECODE: '1' } });
  assert.deepEqual([session.status, session.stdout, session.stderr], [1, '', `kh-orchestration: ${TEXT.ownerOnly('uninstall', 'CLAUDECODE')}\nNext: ${TEXT.askOwner(TEXT.uninstallCommand(repo.root, false))}\n`]);
  assert.deepEqual({ tree: listing(repo.root) }, before);
  const done = run('uninstall', [repo.root, '--yes']);
  assert.equal(done.status, 0, done.stderr);
  assert.ok(lines(done.stdout).includes(`  - ${TEXT.keptOfficers}`));
  assert.ok(lines(done.stdout).includes(`  - ${TEXT.keptHook(hook)}`));
  assert.equal(readFileSync(join(repo.root, OFFICERS_PATH), 'utf8'), '{"schema": 1, "mine": true}\n');
  assert.ok(readFileSync(hook, 'utf8').endsWith('# the owner\'s line\n'));
  assert.equal(existsSync(join(repo.root, EXTENSIONS_PATH)), false);
  assert.ok(existsSync(join(repo.root, MANIFEST_PATH)), 'the manifest stays, recording what was kept');
  assert.deepEqual(uninstallPlan(repo.root, { state: false }).kept, [TEXT.keptHook(hook), TEXT.keptOfficers]);
});

test('apply --yes refuses inside a Claude Code session before printing or writing anything; the dry run and detect stay open', () => {
  const repo = fresh();
  const before = { tree: listing(repo.root) };
  const session = { env: { ...env(), CLAUDE_CODE_SESSION_ID: 'abc' } };
  const refused = run('apply', [repo.root, '--yes'], session);
  assert.deepEqual([refused.status, refused.stdout, refused.stderr], [1, '', `kh-orchestration: ${TEXT.ownerOnly('apply', 'CLAUDE_CODE_SESSION_ID')}\nNext: ${TEXT.askOwner(applyCommand(repo.root))}\n`]);
  assert.equal(run('apply', [repo.root], session).status, 0);
  assert.equal(run('detect', [repo.root], session).status, 0);
  assert.deepEqual({ tree: listing(repo.root) }, before);
});

test('apply --yes and detect take well under a second', () => {
  const repo = fresh();
  const timed = (fn) => {
    const start = process.hrtime.bigint();
    const result = fn();
    return { result, ms: Number(process.hrtime.bigint() - start) / 1e6 };
  };
  const applied = timed(() => run('apply', [repo.root, '--yes']));
  assert.equal(applied.result.status, 0);
  const detected = timed(() => run('detect', [repo.root]));
  assert.equal(detected.result.status, 0);
  assert.ok(applied.ms < 3000, `apply --yes took ${applied.ms} ms`);
  assert.ok(detected.ms < 3000, `detect took ${detected.ms} ms`);
});
