// The command line (Task 7): each command of ko.mjs as people and agents run it, the installed,
// stamped copy in a fixture repository, spawned with the session variables removed except in the
// tests about them. Every refusal's exact text is asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KH_HARNESS_DIR, KIT_VERSION, installGate, testEnv } from './test-repo.mjs';
import { commit, gitIn, head, installed, ko, stage } from './gate-fixture.mjs';
import { TEXT, USAGE } from '../../assets/scripts/ko-cli.mjs';
import { COMMANDS } from '../../assets/scripts/extension.mjs';
import { REASONS } from '../../assets/scripts/ko-gate.mjs';
import { digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { baseOf, headBaseOf, indexTree } from '../../assets/scripts/ko-git.mjs';
import { corruptMessage, readApprovals, readProposals, stateDir, writeInflight, writeState } from '../../assets/scripts/ko-state.mjs';
import { readVerdict } from '../../assets/scripts/ko-verdict.mjs';

const refusalText = (reason, next) => `kh-orchestration: ${reason}\nNext: ${next}\n`;
const usageText = (reason) => `kh-orchestration: ${reason}\n${USAGE}`;
const lines = (text) => text.split('\n').filter((line) => line !== '');
const OWNER_COMMANDS = [['approve'], ['propose'], ['waive', 'V8', '--reason', 'r'], ['exempt', 'old', '--reason', 'r'], ['off'], ['on']];
const KO = COMMANDS.status.slice(0, -' status'.length);
const FILTER_ORIGIN = 'git config --show-origin --get-regexp \'^filter\\.\'';

// The state directory's names and each file's bytes, to show a refused command changed nothing.
function stateSnapshot(root) {
  const dir = stateDir(root);
  if (!existsSync(dir)) return {};
  const walk = (relative) => readdirSync(join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [[path, readFileSync(join(dir, path), 'utf8')]];
  });
  return Object.fromEntries(walk(''));
}

const approveAnswer = (root, extra = {}) => ko(root, ['approve'], { input: 'approve\n', ...extra });
// `run` then `approve` as the owner does them, then a commit through the hooks.
function runApproveCommit(repo, message = 'work') {
  assert.equal(ko(repo.root, ['run']).status, 0);
  assert.equal(approveAnswer(repo.root).status, 0);
  const committed = gitIn(repo.root, ['commit', '-q', '-m', message]);
  assert.equal(committed.status, 0, committed.stderr);
}

// ---- usage ----

test('--help prints the usage on standard output for any command, an owner command in a session included', () => {
  const repo = installed();
  for (const args of [['--help'], ['run', '--help'], ['approve', '-h']]) {
    const shown = ko(repo.root, args, { env: { ...testEnv(), CLAUDECODE: '1' } });
    assert.deepEqual([shown.status, shown.stdout, shown.stderr], [0, USAGE, ''], args.join(' '));
  }
});

test('a missing or unknown command, an unknown flag, an extra word and a missing operand are usage errors, exit 2', () => {
  const repo = installed();
  for (const [args, reason] of [
    [[], TEXT.noCommand], [['commit'], TEXT.unknownCommand('commit')], [['run', '--json'], TEXT.unexpectedArgument('run', '--json')],
    [['status', 'x'], TEXT.unexpectedArgument('status', 'x')], [['unexempt'], TEXT.missingOperand('unexempt', 'a branch name')],
    [['waive', '--reason', 'r'], TEXT.missingOperand('waive', 'a rule id')],
  ]) {
    const result = ko(repo.root, args);
    assert.deepEqual([result.status, result.stdout, result.stderr], [2, '', usageText(reason)], args.join(' '));
  }
  assert.equal(TEXT.unknownCommand('commit'), 'commit is not a ko.mjs command.');
});

test('outside a git working tree every command refuses with fixed text', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ko-outside-')));
  try {
    const repo = installed();
    const result = ko(repo.root, ['status'], { cwd: outside });
    assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.notARepository, `cd <the repository> && ${KO} status`)]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('ko.mjs whose ko-cli.mjs is missing prints its literal text and no stack trace', () => {
  const repo = installed();
  rmSync(join(repo.root, '.claude/kh-orchestration/scripts/ko-cli.mjs'));
  const result = ko(repo.root, ['status']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', 'kh-orchestration: ko.mjs could not start: a script beside it in .claude/kh-orchestration/scripts/ is missing, damaged or of another version.\nNext: git status -- .claude/kh-orchestration/scripts\n']);
});

// ---- run ----

test('run refuses an untidy tree, naming what to stage, at most ten paths, and records nothing', () => {
  const repo = installed();
  repo.write('a.txt', 'changed, not staged\n');
  for (let index = 0; index < 11; index += 1) repo.write(`new-${String(index).padStart(2, '0')}.txt`, 'x\n');
  const result = ko(repo.root, ['run']);
  const paths = ['a.txt', ...Array.from({ length: 11 }, (_, index) => `new-${String(index).padStart(2, '0')}.txt`)];
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.untidy(paths), `git add -A && ${COMMANDS.run}`)]);
  assert.equal(
    TEXT.untidy(['a', 'b']),
    'The working tree differs from the index, so the officers would not run on the tree a commit would hold. Stage or remove: a, b.',
  );
  assert.ok(TEXT.untidy(paths).endsWith('new-08.txt and 2 more.'));
  assert.equal(existsSync(join(stateDir(repo.root), 'verdicts')), false);
});

test('run writes a verdict for the index tree, appends the journal and reports each officer; passing but unapproved names approve', () => {
  const repo = installed();
  const tree = indexTree(repo.root);
  const base = baseOf(repo.root, 'main');
  const result = ko(repo.root, ['run']);
  assert.equal(result.status, 0, result.stderr);
  const out = lines(result.stdout);
  const digest = digestOfTree(repo.root, tree).digest;
  assert.equal(out[0], TEXT.runHeader(tree, base));
  assert.match(out[1], /^ {2}check {2}pass {2}\d+\.\d s$/);
  assert.deepEqual(out.slice(2), [TEXT.agentChanges([]), TEXT.passingUnapproved(digest), `Next: ${COMMANDS.approve}`]);
  const verdict = readVerdict(repo.root, tree, base);
  assert.deepEqual([verdict.tree, verdict.base, verdict.branch, verdict.digest, verdict.kitVersion, verdict.waivers], [tree, base, 'main', digest, KIT_VERSION, []]);
  const journal = readFileSync(join(stateDir(repo.root), 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(journal.length, 1);
  assert.deepEqual({ ...journal[0], at: 'x', officers: journal[0].officers.map((entry) => entry.id) }, {
    at: 'x', command: 'run', tree, base, branch: 'main', digest, passing: true, officers: ['check'], moreOfficers: 0, agentRuleChanges: [], waivers: [],
  });
  assert.equal(
    TEXT.passingUnapproved(digest),
    `Passing, but the protected files of this tree (digest ${digest.slice(0, 12)}) are not approved, so the commit gate refuses it until the owner approves them in their own terminal.`,
  );

  writeState(repo.root, 'approvals.json', { digests: [{ digest, approvedAt: 'x', branch: 'main' }] });
  const again = lines(ko(repo.root, ['run']).stdout);
  assert.deepEqual(again.slice(-2), [TEXT.passingApproved(tree), 'Next: git commit']);
});

test('run on a failing tree exits 1, names the officers and shows the first lines of each failure\'s output', () => {
  const repo = installed({
    officers: `${JSON.stringify({
      schema: 1, baseBranch: 'main', protected: [], officers: [
        { id: 'check', rule: null, argv: ['node', 'tools/check.mjs'], appliesTo: ['**'] },
        { id: 'loud', rule: 'R9', argv: ['node', 'tools/loud.mjs'], appliesTo: ['**'] },
      ],
    })}\n`,
  });
  repo.write('tools/loud.mjs', "for (let i = 1; i <= 12; i += 1) console.log(`line ${i}\\u001b[31m`);\nprocess.exit(1);\n");
  stage(repo);
  const result = ko(repo.root, ['run']);
  assert.equal(result.status, 1);
  const out = lines(result.stdout);
  assert.match(out[1], /^ {2}check {2}pass {2}/);
  assert.match(out[2], /^ {2}loud {2}fail {2}/);
  assert.deepEqual(out.slice(3, 13), Array.from({ length: 10 }, (_, index) => `    | line ${index + 1}[31m`), 'ten lines, the escape character removed');
  assert.deepEqual(out.slice(13), [TEXT.agentChanges([]), TEXT.failing(['loud']), `Next: ${COMMANDS.run}`]);
  assert.equal(TEXT.failing(['loud']), 'Failing: these officers did not pass: loud. Fix what they report, stage the fix, and run the officers again.');
});

test('run works from a subdirectory and from a linked worktree, against the shared state', () => {
  const repo = installed();
  runApproveCommit(repo);
  mkdirSync(join(repo.root, 'deep', 'er'), { recursive: true });
  repo.write('deep/er/b.txt', 'b\n');
  stage(repo);
  const fromSub = ko(repo.root, ['run'], { cwd: join(repo.root, 'deep', 'er') });
  assert.equal(fromSub.status, 0, fromSub.stderr);
  assert.notEqual(readVerdict(repo.root, indexTree(repo.root), baseOf(repo.root, 'main')), null);

  const side = repo.addWorktree('side');
  writeFileSync(join(side, 'side.txt'), 'side\n');
  assert.equal(gitIn(side, ['add', '-A']).status, 0);
  const fromWorktree = ko(side, ['run'], { cwd: side });
  assert.equal(fromWorktree.status, 0, fromWorktree.stderr);
  assert.equal(lines(fromWorktree.stdout)[0], TEXT.runHeader(indexTree(side), baseOf(side, 'main')));
  assert.notEqual(readVerdict(repo.root, indexTree(side), baseOf(side, 'main')), null, 'the verdict is in the shared state');
});

test('run allows an lfs filter driver and refuses any other, naming it, before reading the working tree', () => {
  const repo = installed();
  assert.equal(gitIn(repo.root, ['config', 'filter.lfs.clean', 'git-lfs clean -- %f']).status, 0);
  assert.equal(gitIn(repo.root, ['config', 'filter.lfs.process', 'git-lfs filter-process']).status, 0);
  assert.equal(ko(repo.root, ['run']).status, 0);
  const marker = join(repo.root, '..', 'filter-ran');
  assert.equal(gitIn(repo.root, ['config', 'filter.evil.clean', `touch ${marker}; cat`]).status, 0);
  writeFileSync(join(repo.root, '.gitattributes'), '* filter=evil\n');
  const result = ko(repo.root, ['run']);
  assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.filterDriver('evil', 'filter.evil.clean'), FILTER_ORIGIN)]);
  assert.equal(existsSync(marker), false, 'the clean filter never ran');
  assert.equal(
    TEXT.filterDriver('evil', 'filter.evil.clean'),
    'The git filter driver evil is configured (filter.evil.clean). A clean filter can make a working tree that differs from the index look tidy, and the officers run on the working tree, so they are not run here. Remove the driver from the configuration file shown below; only lfs is allowed.',
  );
  const smudge = installed();
  assert.equal(gitIn(smudge.root, ['config', 'filter.a.b.smudge', 'cat']).status, 0);
  assert.equal(ko(smudge.root, ['run']).stderr, refusalText(TEXT.filterDriver('a.b', 'filter.a.b.smudge'), FILTER_ORIGIN));
});

const WAIVER_OFFICERS = `${JSON.stringify({
  schema: 1, baseBranch: 'main', protected: [], officers: [{ id: 'v8', rule: 'V8', argv: ['node', 'tools/waivers.mjs'], appliesTo: ['**'] }],
})}\n`;
const WAIVER_SCRIPT = 'process.stdout.write(process.env.KO_WAIVERS);\nprocess.exit(1);\n';

test('run passes this branch\'s waivers, and only them, to the officers as KO_WAIVERS and records them in the verdict', () => {
  const repo = installed({ officers: WAIVER_OFFICERS });
  repo.write('tools/waivers.mjs', WAIVER_SCRIPT);
  stage(repo);
  const waivers = [
    { rule: 'V8', branch: 'main', reason: 'docs follow', at: '2026-11-26T00:00:00.000Z' },
    { rule: 'V11', branch: 'other', reason: 'not this branch', at: '2026-11-26T00:00:00.000Z' },
  ];
  writeState(repo.root, 'waivers.json', { waivers });
  const result = ko(repo.root, ['run']);
  assert.equal(result.status, 1);
  assert.ok(lines(result.stdout).includes('    | [{"rule":"V8","reason":"docs follow"}]'), result.stdout);
  assert.ok(lines(result.stdout).includes(TEXT.waivers('main', [waivers[0]])));
  assert.equal(TEXT.waivers('main', [waivers[0]]), 'Waivers in force on main: V8 (docs follow).');
  assert.deepEqual(readVerdict(repo.root, indexTree(repo.root), baseOf(repo.root, 'main')).waivers, [waivers[0]]);

  assert.equal(gitIn(repo.root, ['checkout', '-q', '--detach']).status, 0);
  const detached = ko(repo.root, ['run']);
  assert.ok(lines(detached.stdout).includes('    | []'), 'a detached HEAD has no waivers');
});

test('run refuses a staged officers file it cannot use, naming the problem, and runs nothing', () => {
  const repo = installed({ officers: '{"schema": 1}\n' });
  const result = ko(repo.root, ['run']);
  const problem = '.claude/kh-orchestration/officers.json is absent from the tree or is not an officers file.';
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.cannotRun(problem), COMMANDS.status)]);
  assert.equal(existsSync(join(stateDir(repo.root), 'verdicts')), false);
});

test('run with no officers says so and passes; a state file that cannot be read after the verdict is written is fixed text, exit 1', () => {
  const repo = installed({ officers: `${JSON.stringify({ schema: 1, baseBranch: 'main', protected: [], officers: [] })}\n` });
  writeFileSync(join(stateDir(repo.root), 'approvals.json'), '{"digests": [');
  const result = ko(repo.root, ['run']);
  assert.deepEqual(lines(result.stdout).slice(1), [TEXT.noOfficers, TEXT.agentChanges([])]);
  assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.failed(corruptMessage('approvals.json')), COMMANDS.status)]);
  assert.notEqual(readVerdict(repo.root, indexTree(repo.root), baseOf(repo.root, 'main')), null);
  assert.equal(TEXT.failed('x.'), 'ko.mjs could not finish: x.');
});

// The session log, as kh-harness writes it: every line of the session's file in this run's data directory.
function sessionEvents(sessionId) {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name === `s-${sessionId}.jsonl`) found.push(...readFileSync(join(dir, entry.name), 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
    }
  };
  walk(process.env.KH_DATA_DIR);
  return found;
}
const logCommand = (root, action) => spawnSync(process.execPath, [join(KH_HARNESS_DIR, 'scripts', 'log.mjs'), root, action], { env: testEnv(), encoding: 'utf8' });

test('in a session with the kh-harness log enabled, run adds one verdict event to that session\'s log', () => {
  const repo = installed();
  const enabled = logCommand(repo.root, 'enable');
  assert.equal(enabled.status, 0, enabled.stderr);
  const result = ko(repo.root, ['run'], { env: { ...testEnv(), CLAUDE_CODE_SESSION_ID: 'ko-test-enabled' } });
  assert.deepEqual([result.status, result.stderr], [0, '']);
  const events = sessionEvents('ko-test-enabled').filter((event) => event.type === 'plugin_event');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].source, events[0].kind, events[0].session_id, events[0].data.passing, events[0].data.branch], ['kh-orchestration', 'verdict', 'ko-test-enabled', true, 'main']);
  assert.deepEqual(events[0].data.officers.map((entry) => [entry.id, entry.result]), [['check', 'pass']]);
});

test('with the log disabled, or the contract not listing the log, run records no event, says nothing of it and succeeds', () => {
  const repo = installed();
  const plain = ko(repo.root, ['run']);
  const inSession = ko(repo.root, ['run'], { env: { ...testEnv(), CLAUDE_CODE_SESSION_ID: 'ko-test-disabled' } });
  assert.deepEqual([inSession.status, inSession.stderr], [0, '']);
  assert.deepEqual(lines(inSession.stdout).map((line) => line.replace(/\d+\.\d s$/, '')), lines(plain.stdout).map((line) => line.replace(/\d+\.\d s$/, '')));
  assert.deepEqual(sessionEvents('ko-test-disabled'), []);

  assert.equal(logCommand(repo.root, 'enable').status, 0);
  writeFileSync(join(repo.root, '.claude/scripts/harness-log.mjs'), 'process.stdout.write("must not be imported");\n');
  const unchecked = ko(repo.root, ['run'], { env: { ...testEnv(), CLAUDE_CODE_SESSION_ID: 'ko-test-unhashed' } });
  assert.deepEqual([unchecked.status, unchecked.stderr], [1, refusalText(TEXT.untidy(['.claude/scripts/harness-log.mjs']), `git add -A && ${COMMANDS.run}`)]);
  stage(repo);
  const staged = ko(repo.root, ['run'], { env: { ...testEnv(), CLAUDE_CODE_SESSION_ID: 'ko-test-unhashed' } });
  assert.equal(staged.status, 0);
  assert.equal(staged.stdout.includes('must not be imported'), false, 'a script whose hash does not match the contract file is never imported');
  assert.deepEqual(sessionEvents('ko-test-unhashed'), []);
});

// ---- the owner's commands ----

test('every owner-only command refuses with fixed text when CLAUDECODE or CLAUDE_CODE_SESSION_ID is set, before anything else', () => {
  const repo = installed();
  const before = stateSnapshot(repo.root);
  for (const variable of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']) {
    for (const args of [...OWNER_COMMANDS, ['waive']]) {
      const result = ko(repo.root, args, { env: { ...testEnv(), [variable]: variable === 'CLAUDECODE' ? '1' : 'abc' }, input: 'approve\n' });
      assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.ownerOnly(args[0], variable), `${KO} ${args[0]}, in the owner's own terminal`)], `${variable} ${args.join(' ')}`);
    }
  }
  assert.deepEqual(stateSnapshot(repo.root), before);
  assert.equal(
    TEXT.ownerOnly('approve', 'CLAUDECODE'),
    'ko.mjs approve is the owner\'s to run in their own terminal, outside Claude Code: CLAUDECODE is set here, so this is a Claude Code session. Nothing was changed.',
  );
  const empty = ko(repo.root, ['off'], { env: { ...testEnv(), CLAUDECODE: '' } });
  assert.equal(empty.status, 1, 'set to the empty string is still set');
});

test('approve shows the covered files, reads the word approve, records the index tree\'s digest with its tree, refreshes bin/ and closes this worktree\'s proposal only', () => {
  const repo = installed();
  const side = repo.addWorktree('side');
  writeState(repo.root, 'proposals.json', { worktrees: [realpathSync(side), realpathSync(repo.root)] });
  writeFileSync(join(stateDir(repo.root), 'bin', 'stale.mjs'), 'from an older kit\n');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeInflight(repo.root, dead, indexTree(repo.root));
  writeInflight(repo.root, String(process.pid), indexTree(repo.root));
  const tree = indexTree(repo.root);
  const digest = digestOfTree(repo.root, tree);
  const result = approveAnswer(repo.root);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.split('\n');
  assert.deepEqual(out.slice(0, 2), [TEXT.approveHeader(tree, digest.digest, 'main'), TEXT.coveredFiles(digest.paths.length)]);
  assert.deepEqual(out.slice(2, 2 + digest.paths.length), digest.paths.map((path) => `  ${path}`));
  assert.deepEqual(out.slice(2 + digest.paths.length), [TEXT.noEarlierApproval, TEXT.prompt, TEXT.approved(digest.digest, tree), `Next: ${TEXT.approvedNext}`, '']);
  const [record] = readApprovals(repo.root);
  assert.deepEqual({ ...record, approvedAt: 'x' }, { digest: digest.digest, tree, approvedAt: 'x', branch: 'main' });
  assert.deepEqual(readProposals(repo.root), [realpathSync(side)]);
  assert.deepEqual(readdirSync(stateDir(repo.root)).filter((name) => name.startsWith('inflight-')), [`inflight-${process.pid}.json`], 'stale in-flight records are removed, a live one kept');
  const bin = join(stateDir(repo.root), 'bin');
  const scripts = join(repo.root, '.claude/kh-orchestration/scripts');
  assert.deepEqual(readdirSync(bin).sort(), readdirSync(scripts).sort(), 'the stale script is gone');
  for (const name of readdirSync(scripts)) assert.equal(readFileSync(join(bin, name), 'utf8'), readFileSync(join(scripts, name), 'utf8'));
  assert.equal(TEXT.approvedNext, `${COMMANDS.run}, then git commit`);

  const again = approveAnswer(repo.root);
  assert.ok(again.stdout.includes(`${TEXT.alreadyApproved}\n`));
  assert.equal(readApprovals(repo.root).length, 1, 'no duplicate digest');
});

test('approve with any other answer, or no answer, records nothing and leaves bin/ alone', () => {
  const repo = installed();
  const before = stateSnapshot(repo.root);
  for (const [options, reason] of [
    [{ input: 'no\n' }, TEXT.notApproved], [{ input: 'approve please\n' }, TEXT.notApproved], [{ input: ' approve\n' }, TEXT.notApproved],
    [{ input: '' }, TEXT.noAnswer], [{ closedStdin: true }, TEXT.noAnswer],
  ]) {
    const result = ko(repo.root, ['approve'], options);
    assert.deepEqual([result.status, result.stderr], [1, refusalText(reason, COMMANDS.approve)], JSON.stringify(options));
    assert.ok(result.stdout.endsWith(`${TEXT.prompt}\n`));
  }
  assert.deepEqual(stateSnapshot(repo.root), before);
  assert.equal(TEXT.notApproved, 'Nothing was approved: the answer was not the word approve.');
  const crlf = ko(repo.root, ['approve'], { input: 'approve\r\n' });
  assert.equal(crlf.status, 0, 'a terminal\'s CR before the newline is not part of the answer');
});

test('approve shows the diff of the covered files against the last approved tree of this branch, tree to tree, with control characters made visible', () => {
  const repo = installed();
  assert.equal(approveAnswer(repo.root).status, 0);
  const earlier = indexTree(repo.root);
  const approvedAt = readApprovals(repo.root)[0].approvedAt;
  repo.write('tools/check.mjs', `${readFileSync(join(repo.root, 'tools/check.mjs'), 'utf8')}// hidden\u001b[8m text\n`);
  repo.write('a.txt', 'an uncovered change\n');
  stage(repo);
  repo.write('tools/check.mjs', 'an unstaged change approve must not show\n');
  const result = approveAnswer(repo.root);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`${TEXT.sinceApproval(earlier, approvedAt)}\n`));
  assert.ok(result.stdout.includes('+// hidden\\u{1b}[8m text'), result.stdout);
  assert.equal(result.stdout.includes('a.txt'), false);
  assert.equal(result.stdout.includes('an unstaged change'), false);
  assert.equal(result.stdout.includes('\u001b'), false);

  const unchanged = approveAnswer(repo.root);
  assert.ok(unchanged.stdout.includes(`${TEXT.noChange}\n`));
});

test('approve says when the tree of the last approval on this branch is no longer in the object store', () => {
  const repo = installed();
  const gone = 'e'.repeat(40);
  writeState(repo.root, 'approvals.json', { digests: [{ digest: 'f'.repeat(64), tree: gone, approvedAt: 'x', branch: 'main' }, { digest: 'd'.repeat(64), tree: gone, approvedAt: 'x', branch: 'other' }] });
  const result = approveAnswer(repo.root);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes(`${TEXT.earlierTreeGone(gone)}\n`));
});

test('approve refuses a staged tree whose protected files cannot be digested, naming the problem', () => {
  const repo = installed();
  repo.write('docs/harness/RULES.md', '# Rules\n\n## R1 — one\n\n## R1 — two\n');
  stage(repo);
  const problem = digestOfTree(repo.root, indexTree(repo.root)).problem;
  const result = ko(repo.root, ['approve'], { input: 'approve\n' });
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.approveUndigestable(problem), COMMANDS.status)]);
  assert.deepEqual(readApprovals(repo.root), []);
});

// The refusal before run and approve and the commit after them are gate.test.mjs's first git test.
test('approve\'s refreshed bin/ is what the next hook runs: a changed gate in the staged tree is the gate of the next commit', () => {
  const repo = installed();
  runApproveCommit(repo);
  const gate = '.claude/kh-orchestration/scripts/ko-gate.mjs';
  repo.write(gate, readFileSync(join(repo.root, gate), 'utf8').replace('No verdict is recorded for this tree', 'The REFRESHED gate finds no verdict for this tree'));
  stage(repo);
  assert.equal(approveAnswer(repo.root).status, 0);
  const next = commit(repo.root);
  assert.notEqual(next.status, 0);
  assert.ok(next.stderr.startsWith('kh-orchestration: The REFRESHED gate finds no verdict for this tree'), next.stderr);
});

test('propose opens only the worktree it is run in, by its real path, and says so again when it is open', () => {
  const repo = installed();
  const side = repo.addWorktree('side');
  const first = ko(repo.root, ['propose']);
  assert.deepEqual([first.status, first.stdout], [0, `${TEXT.proposed(realpathSync(repo.root))}\nNext: ${COMMANDS.approve}\n`]);
  assert.deepEqual(readProposals(repo.root), [realpathSync(repo.root)]);
  const second = ko(repo.root, ['propose'], { cwd: join(repo.root, 'tools') });
  assert.deepEqual([second.status, second.stdout], [0, `${TEXT.alreadyProposed(realpathSync(repo.root))}\nNext: ${COMMANDS.approve}\n`]);
  assert.equal(ko(repo.root, ['propose'], { cwd: side }).status, 0);
  assert.deepEqual(readProposals(repo.root), [realpathSync(repo.root), realpathSync(side)]);
});

test('waive needs a rule id and a reason, applies to the current branch, strips control characters and replaces an earlier waiver of the rule', () => {
  const repo = installed();
  for (const [args, reason] of [
    [['waive', 'V8'], TEXT.reasonMissing('waive')], [['waive', 'V8', '--reason'], TEXT.reasonMissing('waive')],
    [['waive', 'V8', '--reason', '\u0007 ​ '], TEXT.reasonEmpty], [['waive', 'V8', `--reason=${'x'.repeat(501)}`], TEXT.reasonTooLong],
    [['waive', '8V', '--reason', 'r'], TEXT.badRule('8V')], [['waive', 'V8', 'V9', '--reason', 'r'], TEXT.unexpectedArgument('waive', 'V9')],
  ]) {
    const result = ko(repo.root, args);
    assert.deepEqual([result.status, result.stderr], [2, usageText(reason)], args.join(' '));
  }
  assert.equal(TEXT.reasonMissing('waive'), 'waive needs --reason <text>, saying why in a few words.');
  const result = ko(repo.root, ['waive', 'V8', '--reason', 'docs\u001b[2J follow\nnext week']);
  assert.equal(result.status, 0, result.stderr);
  const [waiver] = JSON.parse(readFileSync(join(stateDir(repo.root), 'waivers.json'), 'utf8')).waivers;
  assert.deepEqual({ ...waiver, at: 'x' }, { rule: 'V8', branch: 'main', reason: 'docs[2J follownext week', at: 'x' });
  assert.equal(result.stdout, `${TEXT.waived('V8', 'main')}\n${TEXT.waivers('main', [waiver])}\nNext: ${COMMANDS.run}\n`);
  assert.equal(ko(repo.root, ['waive', 'V8', '--reason=later']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir(repo.root), 'waivers.json'), 'utf8')).waivers.map((entry) => entry.reason), ['later']);

  assert.equal(gitIn(repo.root, ['checkout', '-q', '--detach']).status, 0);
  const detached = ko(repo.root, ['waive', 'V8', '--reason', 'r']);
  assert.deepEqual([detached.status, detached.stderr], [1, refusalText(TEXT.waiveDetached, 'git switch <branch>')]);
});

test('exempt needs a branch name git accepts and a reason; unexempt is not owner-only and ends the exemption', () => {
  const repo = installed();
  for (const name of ['a..b', '@{-1}', 'x.lock', 'HEAD~1']) {
    const result = ko(repo.root, ['exempt', name, '--reason', 'r']);
    assert.deepEqual([result.status, result.stderr], [2, usageText(TEXT.badBranch(name))], name);
  }
  assert.equal(ko(repo.root, ['exempt', 'old/feature']).stderr, usageText(TEXT.reasonMissing('exempt')));
  const result = ko(repo.root, ['exempt', 'old/feature', '--reason', 'predates the install']);
  assert.equal(result.status, 0, result.stderr);
  const branches = JSON.parse(readFileSync(join(stateDir(repo.root), 'exemptions.json'), 'utf8')).branches;
  assert.deepEqual(branches.map((entry) => [entry.name, entry.reason]), [['old/feature', 'predates the install']]);
  assert.equal(result.stdout, `${TEXT.exempted('old/feature')}\n${TEXT.exemptions(branches)}\nNext: ${COMMANDS.unexempt} old/feature\n`);
  const ended = ko(repo.root, ['unexempt', 'old/feature'], { env: { ...testEnv(), CLAUDECODE: '1' } });
  assert.deepEqual([ended.status, ended.stdout], [0, `${TEXT.unexempted('old/feature')}\n${TEXT.exemptions([])}\n`]);
  const none = ko(repo.root, ['unexempt', 'old/feature']);
  assert.deepEqual([none.status, none.stdout], [0, `${TEXT.notExempt('old/feature')}\n${TEXT.exemptions([])}\n`]);
});

test('off creates the switch and says no commit is checked until on; on removes it', () => {
  const repo = installed();
  const off = ko(repo.root, ['off']);
  assert.deepEqual([off.status, off.stdout], [0, `${TEXT.off}\nNext: ${COMMANDS.on}\n`]);
  assert.ok(existsSync(join(stateDir(repo.root), 'off')));
  assert.equal(TEXT.off, `kh-orchestration is switched off for this repository: no commit is checked until it is switched on with ${COMMANDS.on}.`);
  assert.equal(commit(repo.root).status, 0, 'with the switch off a commit goes through unchecked');
  const on = ko(repo.root, ['on']);
  assert.deepEqual([on.status, on.stdout], [0, `${TEXT.on}\nNext: ${COMMANDS.status}\n`]);
  assert.equal(existsSync(join(stateDir(repo.root), 'off')), false);
});

// ---- status ----

const statusJson = (root, options) => {
  const result = ko(root, ['status', '--json'], options);
  assert.deepEqual([result.status, result.stderr], [0, '']);
  return JSON.parse(result.stdout);
};
const problemTexts = (status) => status.problems.map((problem) => problem.text);
const hookProblemsOf = (status) => status.problems.filter((problem) => /^The (?:pre-commit|pre-merge-commit|reference-transaction) hook /.test(problem.text));

test('status --json of a fresh install: the brief\'s fields and the rest, nothing approved, HEAD\'s tree committed without the gate', () => {
  const repo = installed();
  const status = statusJson(repo.root);
  const tree = indexTree(repo.root);
  const digest = digestOfTree(repo.root, tree).digest;
  assert.deepEqual(Object.keys(status), [
    'off', 'branch', 'base', 'tree', 'digestApproved', 'verdict', 'openForProposals', 'exemptions', 'waivers',
    'headTree', 'headBase', 'headVerdict', 'install', 'contract', 'liveFiles', 'digest', 'inflight', 'hooks', 'hooksPath', 'git', 'problems',
  ]);
  assert.deepEqual(
    [status.off, status.branch, status.base, status.tree, status.digestApproved, status.verdict, status.openForProposals, status.exemptions, status.waivers],
    [false, 'main', head(repo.root), tree, false, 'none', false, [], []],
  );
  // The fixture's first commit predates the install: its tree has no officers file, so no base.
  assert.deepEqual([status.headTree, status.headBase, status.headVerdict], [gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), null, 'none']);
  assert.deepEqual([status.install, status.contract, status.liveFiles, status.digest], [{ present: true, problem: null }, { ok: true, problems: [] }, { equal: true, reason: null, next: null }, digest]);
  assert.deepEqual(status.inflight, { live: [], stale: [] });
  assert.deepEqual(status.hooks.map((hook) => [hook.name, hook.present, hook.ours, hook.executable, hook.envExists, hook.node, hook.nodeExists]), [
    ['pre-commit', true, true, true, true, process.execPath, true], ['pre-merge-commit', true, true, true, true, process.execPath, true], ['reference-transaction', true, true, true, true, process.execPath, true],
  ]);
  assert.equal(status.hooksPath, null);
  assert.equal(status.git.supported, true);
  assert.deepEqual(status.problems, [
    { text: TEXT.unapproved(digest), next: COMMANDS.approve },
    { text: TEXT.headUnverdicted(status.headTree, null), next: COMMANDS.verifyBranch },
  ]);
});

test('status after run, approve and a commit: verdicts passing, nothing wrong; the text form says so', () => {
  const repo = installed();
  assert.equal(ko(repo.root, ['run']).status, 0);
  const staged = statusJson(repo.root);
  assert.equal(staged.verdict, 'passing');
  assert.equal(approveAnswer(repo.root).status, 0);
  assert.equal(commit(repo.root).status, 0);
  const status = statusJson(repo.root);
  assert.deepEqual([status.digestApproved, status.headVerdict, status.headBase, status.problems], [true, 'passing', headBaseOf(repo.root, 'main'), []]);
  const text = ko(repo.root, ['status']);
  assert.equal(text.status, 0);
  assert.deepEqual([lines(text.stdout)[0], lines(text.stdout).at(-1)], [TEXT.statusHeader(repo.root), TEXT.noProblems]);
});

test('status reports a corrupt state file as the problem, never throwing, and each other state file the same', () => {
  const repo = installed();
  for (const name of ['approvals.json', 'proposals.json', 'exemptions.json', 'waivers.json']) {
    mkdirSync(stateDir(repo.root), { recursive: true });
    writeFileSync(join(stateDir(repo.root), name), '{"broken": [');
    const status = statusJson(repo.root);
    assert.ok(problemTexts(status).includes(corruptMessage(name)), name);
    const field = { 'approvals.json': 'digestApproved', 'proposals.json': 'openForProposals', 'exemptions.json': 'exemptions', 'waivers.json': 'waivers' }[name];
    assert.equal(status[field], null, name);
    const text = ko(repo.root, ['status']);
    assert.ok(text.stdout.includes(`${TEXT.problemsHeader}\n`) && text.stdout.includes(`  - ${corruptMessage(name)}\n`), name);
    rmSync(join(stateDir(repo.root), name));
  }
});

test('status shows the switch, proposals, exemptions, this branch\'s waivers and in-flight records, live and stale', () => {
  const repo = installed();
  writeFileSync(join(stateDir(repo.root), 'off'), '');
  writeState(repo.root, 'proposals.json', { worktrees: [realpathSync(repo.root)] });
  const exemptions = [{ name: 'old', reason: 'r', at: 'x' }];
  writeState(repo.root, 'exemptions.json', { branches: exemptions });
  writeState(repo.root, 'waivers.json', { waivers: [{ rule: 'V8', branch: 'main', reason: 'r', at: 'x' }, { rule: 'V9', branch: 'other', reason: 'r', at: 'x' }] });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeInflight(repo.root, dead, indexTree(repo.root));
  writeInflight(repo.root, String(process.pid), indexTree(repo.root));
  const status = statusJson(repo.root);
  assert.deepEqual([status.off, status.openForProposals, status.exemptions, status.waivers.map((entry) => entry.rule)], [true, true, exemptions, ['V8']]);
  assert.deepEqual(status.inflight, { live: [String(process.pid)], stale: [dead] });
  assert.deepEqual(status.problems.slice(0, 1), [{ text: TEXT.offProblem, next: COMMANDS.on }]);
  assert.ok(status.problems.some((problem) => problem.text === TEXT.staleInflight([dead])));
  assert.ok(existsSync(join(stateDir(repo.root), `inflight-${dead}.json`)), 'status removes nothing');
});

test('status reports each hook that is missing, not ours, not executable, or names an env or Node that no longer exists', () => {
  const repo = installed();
  const hooks = join(repo.root, '.git', 'hooks');
  rmSync(join(hooks, 'reference-transaction'));
  chmodSync(join(hooks, 'pre-commit'), 0o644);
  writeFileSync(join(hooks, 'pre-merge-commit'), '#!/bin/sh\nexit 0\n');
  const apply = `node <kh-orchestration>/scripts/apply.mjs ${repo.root} --yes`;
  const status = statusJson(repo.root);
  assert.deepEqual(hookProblemsOf(status), [
    { text: TEXT.hookNotExecutable('pre-commit', join(hooks, 'pre-commit')), next: `chmod +x ${join(hooks, 'pre-commit')}` },
    { text: TEXT.hookNotOurs('pre-merge-commit', join(hooks, 'pre-merge-commit')), next: apply },
    { text: TEXT.raceHookMissing(join(hooks, 'reference-transaction')), next: apply },
  ]);

  const moved = installed();
  installGate(moved.root, { node: '/nonexistent/node' });
  const movedStatus = statusJson(moved.root);
  assert.deepEqual(hookProblemsOf(movedStatus), ['pre-commit', 'pre-merge-commit', 'reference-transaction'].map((name) => ({
    text: TEXT.hookProgramGone(name, 'Node', '/nonexistent/node'), next: `node <kh-orchestration>/scripts/apply.mjs ${moved.root} --yes`,
  })));
  assert.equal(TEXT.hookProgramGone('pre-commit', 'Node', '/n'), 'The pre-commit hook starts Node as /n, which no longer exists, so every commit is refused. Run kh-orchestration\'s apply again to record where it is now.');
});

test('status reports the staged tree without an install, with an unusable officers file, and with protected files it cannot digest', () => {
  const repo = installed();
  rmSync(join(repo.root, '.claude/kh-orchestration/officers.json'));
  stage(repo);
  const absent = statusJson(repo.root);
  assert.deepEqual(absent.install, { present: false, problem: REASONS.officersAbsent });
  assert.ok(absent.problems.some((problem) => problem.text === TEXT.noInstall(REASONS.officersAbsent)));
  repo.write('.claude/kh-orchestration/officers.json', `${JSON.stringify({ schema: 1, baseBranch: 'main', protected: [], officers: [], extra: 1 })}\n`);
  stage(repo);
  const unusable = statusJson(repo.root);
  assert.equal(unusable.install.present, true);
  assert.ok(unusable.problems.some((problem) => problem.text === TEXT.installProblem(unusable.install.problem)), JSON.stringify(unusable.problems));
  repo.write('.claude/kh-orchestration/officers.json', `${JSON.stringify({ schema: 1, baseBranch: 'main', protected: [], officers: [] })}\n`);
  repo.write('docs/harness/RULES.md', '# Rules\n\n## R1 — one\n\n## R1 — two\n');
  stage(repo);
  const rules = statusJson(repo.root);
  assert.deepEqual([rules.digest, rules.digestApproved], [null, null]);
  assert.ok(rules.problems.some((problem) => problem.text === TEXT.undigestable(digestOfTree(repo.root, indexTree(repo.root)).problem)));
});

test('status reports a missing pre-commit hook and one of ours that no longer starts env and Node as written', () => {
  const repo = installed();
  const hooks = join(repo.root, '.git', 'hooks');
  rmSync(join(hooks, 'pre-commit'));
  const ours = readFileSync(join(hooks, 'pre-merge-commit'), 'utf8').split('\n');
  writeFileSync(join(hooks, 'pre-merge-commit'), `${ours.slice(0, 2).join('\n')}\nexit 0\n`);
  const apply = `node <kh-orchestration>/scripts/apply.mjs ${repo.root} --yes`;
  assert.deepEqual(hookProblemsOf(statusJson(repo.root)), [
    { text: TEXT.hookMissing('pre-commit', join(hooks, 'pre-commit')), next: apply },
    { text: TEXT.hookUnreadable('pre-merge-commit', join(hooks, 'pre-merge-commit')), next: apply },
  ]);
});

test('status reports a git older than 2.30, and one whose version cannot be read', () => {
  const repo = installed();
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { env: testEnv(), encoding: 'utf8' }).stdout.trim();
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'ko-fake-git-')));
  try {
    for (const [answer, expected] of [['git version 2.29.3', TEXT.oldGit('2.29.3')], ['not a version', TEXT.unknownGit]]) {
      writeFileSync(join(bin, 'git'), `#!/bin/sh\nfor a in "$@"; do [ "$a" = version ] && { echo '${answer}'; exit 0; }; done\nexec '${realGit}' "$@"\n`);
      chmodSync(join(bin, 'git'), 0o755);
      const status = statusJson(repo.root, { env: { ...testEnv(), PATH: `${bin}:${process.env.PATH}` } });
      assert.ok(status.problems.some((problem) => problem.text === expected && problem.next === 'git version'), answer);
      assert.equal(status.git.supported, false);
    }
    assert.equal(TEXT.oldGit('2.29.3'), 'git 2.29.3 is older than 2.30, the oldest git kh-orchestration works with. Install git 2.30 or later.');
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test('status reports a core.hooksPath set in the user\'s global configuration as the gate being off, with the command that removes it', () => {
  const repo = installed();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'ko-home-')));
  try {
    writeFileSync(join(home, '.gitconfig'), '[core]\n\thooksPath = /dev/null\n');
    const env = { ...testEnv(), HOME: home };
    delete env.GIT_CONFIG_GLOBAL;
    const status = statusJson(repo.root, { env });
    assert.deepEqual(status.hooksPath, { scope: 'global', value: '/dev/null' });
    assert.ok(status.problems.some((problem) => problem.text === TEXT.hooksPath('/dev/null', 'global') && problem.next === 'git config --global --unset core.hooksPath'));
    assert.equal(
      TEXT.hooksPath('/dev/null', 'global'),
      'core.hooksPath is set to /dev/null in the global git configuration, so git runs no hook from the repository\'s hooks directory and the commit gate is off for every commit.',
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('status reports a live file that differs and a contract problem', () => {
  const repo = installed();
  repo.write('.claude/scripts/extra.mjs', 'x\n');
  const status = statusJson(repo.root);
  assert.deepEqual(status.liveFiles, { equal: false, reason: REASONS.liveUntracked('.claude/scripts/extra.mjs'), next: 'rm -- .claude/scripts/extra.mjs' });
  rmSync(join(repo.root, '.claude/scripts/extra.mjs'));
  rmSync(join(repo.root, '.claude/kh-harness/extensions.json'));
  const broken = statusJson(repo.root);
  assert.equal(broken.contract.ok, false);
  assert.ok(problemTexts(broken).includes(TEXT.contractProblem(broken.contract.problems[0])));
});

// ---- verify-branch ----

// A repository whose install is committed on main through the gate, then a feature branch with one gated commit.
function featureBranch() {
  const repo = installed();
  runApproveCommit(repo, 'install');
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'feature']).status, 0);
  repo.write('f.txt', 'feature\n');
  stage(repo);
  runApproveCommit(repo, 'feature');
  return repo;
}

test('verify-branch: a branch rebuilt by git rebase fails with --no-run until the officers pass on its head', () => {
  const repo = featureBranch();
  assert.equal(ko(repo.root, ['verify-branch', '--no-run']).status, 0, 'the gated head passes');
  assert.equal(gitIn(repo.root, ['switch', '-q', 'main']).status, 0);
  repo.write('m.txt', 'main moves\n');
  stage(repo);
  runApproveCommit(repo, 'main moves');
  assert.equal(gitIn(repo.root, ['switch', '-q', 'feature']).status, 0);
  const rebased = gitIn(repo.root, ['rebase', '-q', 'main']);
  assert.equal(rebased.status, 0, rebased.stderr);
  const tree = gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const base = headBaseOf(repo.root, 'main');

  const failing = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(failing.status, 1);
  assert.deepEqual(lines(failing.stdout).slice(-2), [TEXT.notVerified(REASONS.noVerdict(tree, base)), `Next: ${COMMANDS.run}`]);
  assert.equal(lines(failing.stdout)[0], TEXT.verifyHeader('feature', tree, base));

  const ran = ko(repo.root, ['verify-branch']);
  assert.equal(ran.status, 0, ran.stdout);
  assert.match(lines(ran.stdout)[1], /^ {2}check {2}pass {2}/);
  assert.equal(lines(ran.stdout).at(-1), TEXT.verified);
  assert.equal(ko(repo.root, ['verify-branch', '--no-run']).status, 0, 'the verdict that run recorded now counts');
});

test('verify-branch lists the exemption, the waivers and every agent rule change since the base, and notes a missing reference-transaction hook', () => {
  const rules = (title) => `# Rules\n\n## R1 — ${title}\n\n- approval: agent\n- enforced-by: review\n\n## R2 — owner rule\n\n- enforced-by: review\n`;
  const repo = installed();
  repo.write('docs/harness/RULES.md', rules('first wording'));
  stage(repo);
  runApproveCommit(repo, 'install');
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'feature']).status, 0);
  repo.write('docs/harness/RULES.md', rules('second wording'));
  stage(repo);
  runApproveCommit(repo, 'reworded');
  assert.equal(ko(repo.root, ['waive', 'V8', '--reason', 'docs follow']).status, 0);
  assert.equal(ko(repo.root, ['exempt', 'feature', '--reason', 'trial']).status, 0);
  rmSync(join(repo.root, '.git', 'hooks', 'reference-transaction'));
  const result = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(result.status, 0, result.stdout);
  const out = lines(result.stdout);
  const exemption = JSON.parse(readFileSync(join(stateDir(repo.root), 'exemptions.json'), 'utf8')).branches[0];
  const waiver = JSON.parse(readFileSync(join(stateDir(repo.root), 'waivers.json'), 'utf8')).waivers[0];
  assert.deepEqual(out.slice(2), [
    TEXT.exemption('feature', exemption), TEXT.waivers('feature', [waiver]), TEXT.agentChanges([{ id: 'R1', change: 'reworded' }]), TEXT.noRaceHook, TEXT.verified,
  ]);
  assert.equal(TEXT.agentChanges([{ id: 'R1' }]), 'Rules marked approval: agent reworded since the base: R1.');
});

test('verify-branch is not passed by the off switch or an exemption: they decide nothing about whether HEAD\'s tree passed', () => {
  const repo = installed();
  assert.equal(ko(repo.root, ['off']).status, 0);
  assert.equal(ko(repo.root, ['exempt', 'main', '--reason', 'r']).status, 0);
  const result = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(result.status, 1);
  assert.equal(lines(result.stdout).at(-2), TEXT.notVerified(REASONS.noInstall(REASONS.officersAbsent)), 'the initial commit holds no install');
});

test('verify-branch without --no-run refuses an untidy tree or staged changes, saying to commit or stash', () => {
  const repo = featureBranch();
  repo.write('loose.txt', 'x\n');
  const untidy = ko(repo.root, ['verify-branch']);
  assert.deepEqual([untidy.status, untidy.stderr], [1, refusalText(TEXT.untidyHead(['loose.txt']), `git stash -u && ${COMMANDS.verifyBranch}`)]);
  stage(repo);
  const staged = ko(repo.root, ['verify-branch']);
  assert.deepEqual([staged.status, staged.stderr], [1, refusalText(TEXT.stagedChanges, `git stash && ${COMMANDS.verifyBranch}`)]);
});

test('verify-branch on an unborn HEAD has nothing to verify', () => {
  const repo = installed();
  assert.equal(gitIn(repo.root, ['checkout', '-q', '--orphan', 'fresh']).status, 0);
  const result = ko(repo.root, ['verify-branch', '--no-run']);
  assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.noHead, COMMANDS.run)]);
});
