// The command line (Task 7): each command of ko.mjs as people and agents run it, the installed,
// stamped copy in a fixture repository, spawned with the session variables removed except in the
// tests about them. Every refusal's exact text is asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KH_HARNESS_DIR, KIT_VERSION, installGate, testEnv } from './test-repo.mjs';
import { lfSha256 } from '../../assets/scripts/verify-contract-1.mjs';
import { commit, gitIn, head, installed, ko, owner, stage } from './gate-fixture.mjs';
import { TEXT, USAGE, repairCommand } from '../../assets/scripts/ko-cli.mjs';
import { COMMANDS, shellWord } from '../../assets/scripts/extension.mjs';
import { REASONS } from '../../assets/scripts/ko-gate.mjs';
import { digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { baseOf, headBaseOf, indexTree } from '../../assets/scripts/ko-git.mjs';
import { binPreflightMessage, corruptMessage, ownerCommand, readAccepted, readApprovals, readProposals, stateDir, writeInflight, writeState } from '../../assets/scripts/ko-state.mjs';
import { readVerdict } from '../../assets/scripts/ko-verdict.mjs';

const refusalText = (reason, next) => `kh-orchestration: ${reason}\nNext: ${next}\n`;
const usageText = (reason) => `kh-orchestration: ${reason}\n${USAGE}`;
const lines = (text) => text.split('\n').filter((line) => line !== '');
const OWNER_COMMANDS = [['approve'], ['propose'], ['waive', 'V8', '--reason', 'r'], ['exempt', 'old', '--reason', 'r'], ['off'], ['on']];
const KO = COMMANDS.status.slice(0, -' status'.length);
// An agent's command as ko.mjs prints it: the working copy's ko.mjs by its absolute path, quoted for a shell.
const agent = (root, words) => `node ${shellWord(join(root, '.claude/kh-orchestration/scripts/ko.mjs'))} ${words}`;
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

const approveAnswer = (root, extra = {}) => owner(root, ['approve'], { input: 'approve\n', ...extra });
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
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.untidy(paths), `git -C ${shellWord(repo.root)} add -- <each path meant to be committed>, then ${agent(repo.root, 'run')}`)]);
  assert.equal(
    TEXT.untidy(['a', 'b']),
    'The working tree differs from the index, so the officers would not run on the tree a commit would hold. Stage the files meant to be committed, and add the others (a .claude/settings.local.json, say) to .gitignore: a, b.',
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
  assert.deepEqual(out.slice(2), [TEXT.agentChanges([]), TEXT.passingUnapproved(digest), `Next: ${ownerCommand(repo.root, 'approve')}`]);
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
  assert.deepEqual(out.slice(13), [TEXT.agentChanges([]), TEXT.failing(['loud']), `Next: ${agent(repo.root, 'run')}`]);
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
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.cannotRun(problem), agent(repo.root, 'status'))]);
  assert.equal(existsSync(join(stateDir(repo.root), 'verdicts')), false);
});

test('run with no officers says so and passes; a state file that cannot be read after the verdict is written is fixed text, exit 1', () => {
  const repo = installed({ officers: `${JSON.stringify({ schema: 1, baseBranch: 'main', protected: [], officers: [] })}\n` });
  writeFileSync(join(stateDir(repo.root), 'approvals.json'), '{"digests": [');
  const result = ko(repo.root, ['run']);
  assert.deepEqual(lines(result.stdout).slice(1), [TEXT.noOfficers, TEXT.agentChanges([])]);
  assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.failed(corruptMessage('approvals.json')), agent(repo.root, 'status'))]);
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
  assert.deepEqual([unchecked.status, unchecked.stderr], [1, refusalText(TEXT.untidy(['.claude/scripts/harness-log.mjs']), `git -C ${shellWord(repo.root)} add -- <each path meant to be committed>, then ${agent(repo.root, 'run')}`)]);
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
      const result = owner(repo.root, args, { env: { ...testEnv(), [variable]: variable === 'CLAUDECODE' ? '1' : 'abc' }, input: 'approve\n' });
      assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.ownerOnly(args[0], variable), `${ownerCommand(repo.root, args[0])}, in the owner's own terminal`)], `${variable} ${args.join(' ')}`);
    }
  }
  assert.deepEqual(stateSnapshot(repo.root), before);
  assert.equal(
    TEXT.ownerOnly('approve', 'CLAUDECODE'),
    'ko.mjs approve is the owner\'s to run in their own terminal, outside Claude Code: CLAUDECODE is set here, so this is a Claude Code session. Nothing was changed.',
  );
  const empty = owner(repo.root, ['off'], { env: { ...testEnv(), CLAUDECODE: '' } });
  assert.equal(empty.status, 1, 'set to the empty string is still set');
});

test('approve shows the covered files, reads the word approve, records the index tree\'s digest with its tree, refreshes bin/ and closes this worktree\'s proposal only', () => {
  const repo = installed();
  const side = repo.addWorktree('side');
  writeState(repo.root, 'proposals.json', { worktrees: [realpathSync(side), realpathSync(repo.root)] });
  writeFileSync(join(stateDir(repo.root), 'bin', 'stale.mjs'), 'from an older kit\n');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  writeInflight(repo.root, dead, { tree: indexTree(repo.root), base: 'none' });
  writeInflight(repo.root, String(process.pid), { tree: indexTree(repo.root), base: 'none' });
  const tree = indexTree(repo.root);
  const digest = digestOfTree(repo.root, tree);
  const result = approveAnswer(repo.root);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout.split('\n');
  assert.deepEqual(out.slice(0, 2), [TEXT.approveHeader(tree, digest.digest, 'main'), TEXT.coveredFiles(digest.paths.length)]);
  assert.deepEqual(out.slice(2, 2 + digest.paths.length), digest.paths.map((path) => `  ${path}`));
  assert.deepEqual(out.slice(2 + digest.paths.length), [TEXT.noEarlierApproval, TEXT.prompt, TEXT.approved(digest.digest, tree), `Next: ${TEXT.approvedNext(agent(repo.root, 'run'))}`, '']);
  const [record] = readApprovals(repo.root);
  assert.deepEqual({ ...record, approvedAt: 'x' }, { digest: digest.digest, tree, approvedAt: 'x', branch: 'main' });
  assert.deepEqual(readProposals(repo.root), [realpathSync(side)]);
  assert.deepEqual(readdirSync(stateDir(repo.root)).filter((name) => name.startsWith('inflight-')), [`inflight-${process.pid}.json`], 'stale in-flight records are removed, a live one kept');
  const bin = join(stateDir(repo.root), 'bin');
  const scripts = join(repo.root, '.claude/kh-orchestration/scripts');
  assert.deepEqual(readdirSync(bin).sort(), readdirSync(scripts).sort(), 'the stale script is gone');
  for (const name of readdirSync(scripts)) assert.equal(readFileSync(join(bin, name), 'utf8'), readFileSync(join(scripts, name), 'utf8'));
  assert.equal(TEXT.approvedNext('x'), 'x, then git commit');

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
    const result = owner(repo.root, ['approve'], options);
    assert.deepEqual([result.status, result.stderr], [1, refusalText(reason, ownerCommand(repo.root, 'approve'))], JSON.stringify(options));
    assert.ok(result.stdout.endsWith(`${TEXT.prompt}\n`));
  }
  assert.deepEqual(stateSnapshot(repo.root), before);
  assert.equal(TEXT.notApproved, 'Nothing was approved: the answer was not the word approve.');
  const crlf = owner(repo.root, ['approve'], { input: 'approve\r\n' });
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
  assert.ok(result.stdout.includes(`${TEXT.baselineBranch(earlier, approvedAt, 'main')}\n`));
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
  assert.ok(result.stdout.includes(`${TEXT.earlierTreeGone(gone, 'main')}\n`));
});

test('approve refuses a staged tree whose protected files cannot be digested, naming the problem', () => {
  const repo = installed();
  repo.write('docs/harness/RULES.md', '# Rules\n\n## R1 — one\n\n## R1 — two\n');
  stage(repo);
  const problem = digestOfTree(repo.root, indexTree(repo.root)).problem;
  const result = owner(repo.root, ['approve'], { input: 'approve\n' });
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.approveUndigestable(problem), agent(repo.root, 'status'))]);
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
  const first = owner(repo.root, ['propose']);
  assert.deepEqual([first.status, first.stdout], [0, `${TEXT.proposed(realpathSync(repo.root))}\nNext: ${ownerCommand(repo.root, 'approve')}\n`]);
  assert.deepEqual(readProposals(repo.root), [realpathSync(repo.root)]);
  const second = owner(repo.root, ['propose'], { cwd: join(repo.root, 'tools') });
  assert.deepEqual([second.status, second.stdout], [0, `${TEXT.alreadyProposed(realpathSync(repo.root))}\nNext: ${ownerCommand(repo.root, 'approve')}\n`]);
  assert.equal(owner(repo.root, ['propose'], { cwd: side }).status, 0);
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
  const result = owner(repo.root, ['waive', 'V8', '--reason', 'docs\u001b[2J follow\nnext week']);
  assert.equal(result.status, 0, result.stderr);
  const [waiver] = JSON.parse(readFileSync(join(stateDir(repo.root), 'waivers.json'), 'utf8')).waivers;
  assert.deepEqual({ ...waiver, at: 'x' }, { rule: 'V8', branch: 'main', reason: 'docs[2J follownext week', at: 'x' });
  assert.equal(result.stdout, `${TEXT.waived('V8', 'main')}\n${TEXT.waivers('main', [waiver])}\nNext: ${agent(repo.root, 'run')}\n`);
  assert.equal(owner(repo.root, ['waive', 'V8', '--reason=later']).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir(repo.root), 'waivers.json'), 'utf8')).waivers.map((entry) => entry.reason), ['later']);

  assert.equal(gitIn(repo.root, ['checkout', '-q', '--detach']).status, 0);
  const detached = owner(repo.root, ['waive', 'V8', '--reason', 'r']);
  assert.deepEqual([detached.status, detached.stderr], [1, refusalText(TEXT.waiveDetached, 'git switch <branch>')]);
});

test('exempt needs a branch name git accepts and a reason; unexempt is not owner-only and ends the exemption', () => {
  const repo = installed();
  for (const name of ['a..b', '@{-1}', 'x.lock', 'HEAD~1']) {
    const result = owner(repo.root, ['exempt', name, '--reason', 'r']);
    assert.deepEqual([result.status, result.stderr], [2, usageText(TEXT.badBranch(name))], name);
  }
  assert.equal(ko(repo.root, ['exempt', 'old/feature']).stderr, usageText(TEXT.reasonMissing('exempt')));
  const result = owner(repo.root, ['exempt', 'old/feature', '--reason', 'predates the install']);
  assert.equal(result.status, 0, result.stderr);
  const branches = JSON.parse(readFileSync(join(stateDir(repo.root), 'exemptions.json'), 'utf8')).branches;
  assert.deepEqual(branches.map((entry) => [entry.name, entry.reason]), [['old/feature', 'predates the install']]);
  assert.equal(result.stdout, `${TEXT.exempted('old/feature')}\n${TEXT.exemptions(branches)}\nNext: ${agent(repo.root, 'unexempt old/feature')}\n`);
  const ended = ko(repo.root, ['unexempt', 'old/feature'], { env: { ...testEnv(), CLAUDECODE: '1' } });
  assert.deepEqual([ended.status, ended.stdout], [0, `${TEXT.unexempted('old/feature')}\n${TEXT.exemptions([])}\n`]);
  const none = ko(repo.root, ['unexempt', 'old/feature']);
  assert.deepEqual([none.status, none.stdout], [0, `${TEXT.notExempt('old/feature')}\n${TEXT.exemptions([])}\n`]);
});

test('off creates the switch and says no commit is checked until on; on removes it', () => {
  const repo = installed();
  const off = owner(repo.root, ['off']);
  const onCommand = ownerCommand(repo.root, 'on');
  assert.deepEqual([off.status, off.stdout], [0, `${TEXT.off(onCommand)}\nNext: ${onCommand}\n`]);
  assert.ok(existsSync(join(stateDir(repo.root), 'off')));
  assert.equal(TEXT.off(onCommand), `kh-orchestration is switched off for this repository: no commit is checked until it is switched on with ${onCommand}.`);
  assert.equal(commit(repo.root).status, 0, 'with the switch off a commit goes through unchecked');
  const on = owner(repo.root, ['on']);
  assert.deepEqual([on.status, on.stdout], [0, `${TEXT.on}\nNext: ${agent(repo.root, 'status')}\n`]);
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

test('status --json of a fresh install: the brief\'s fields and the rest, nothing approved, no record of HEAD\'s commit passing the gate', () => {
  const repo = installed();
  const status = statusJson(repo.root);
  const tree = indexTree(repo.root);
  const digest = digestOfTree(repo.root, tree).digest;
  assert.deepEqual(Object.keys(status), [
    'off', 'branch', 'base', 'tree', 'digestApproved', 'verdict', 'openForProposals', 'exemptions', 'waivers',
    'headTree', 'headBase', 'headAccepted', 'headVerdict', 'install', 'contract', 'liveFiles', 'digest', 'inflight', 'bin', 'hooks', 'hooksPath', 'git', 'problems',
  ]);
  assert.deepEqual(
    [status.off, status.branch, status.base, status.tree, status.digestApproved, status.verdict, status.openForProposals, status.exemptions, status.waivers],
    [false, 'main', head(repo.root), tree, false, 'none', false, [], []],
  );
  // The fixture's first commit predates the install: its tree has no officers file, so no base.
  assert.deepEqual([status.headTree, status.headBase, status.headAccepted, status.headVerdict], [gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim(), null, false, 'none']);
  assert.deepEqual([status.install, status.contract, status.liveFiles, status.digest], [{ present: true, problem: null }, { ok: true, problems: [] }, { equal: true, reason: null, next: null }, digest]);
  assert.deepEqual(status.inflight, { live: [], stale: [] });
  assert.deepEqual(status.hooks.map((hook) => [hook.name, hook.present, hook.ours, hook.matches, hook.executable, hook.envExists, hook.node, hook.nodeExists]), [
    ['pre-commit', true, true, true, true, true, process.execPath, true], ['pre-merge-commit', true, true, true, true, true, process.execPath, true],
    ['reference-transaction', true, true, true, true, true, process.execPath, true],
  ]);
  assert.deepEqual(status.bin, { present: true, gate: true, baseline: { kind: 'working', tree: null }, differs: [], missing: [], extra: [] });
  assert.equal(status.hooksPath, null);
  assert.equal(status.git.supported, true);
  assert.deepEqual(status.problems, [
    { text: TEXT.unapproved(digest), next: ownerCommand(repo.root, 'approve') },
    { text: TEXT.headNoRecord(status.headTree, null), next: agent(repo.root, 'verify-branch') },
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
  assert.deepEqual([status.digestApproved, status.headAccepted, status.headVerdict, status.headBase, status.problems], [true, true, 'passing', readAccepted(repo.root, head(repo.root)).base, []]);
  assert.deepEqual(status.bin.baseline, { kind: 'approved', tree: status.headTree });
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
  writeInflight(repo.root, dead, { tree: indexTree(repo.root), base: 'none' });
  writeInflight(repo.root, String(process.pid), { tree: indexTree(repo.root), base: 'none' });
  const status = statusJson(repo.root);
  assert.deepEqual([status.off, status.openForProposals, status.exemptions, status.waivers.map((entry) => entry.rule)], [true, true, exemptions, ['V8']]);
  assert.deepEqual(status.inflight, { live: [String(process.pid)], stale: [dead] });
  assert.deepEqual(status.problems.slice(0, 1), [{ text: TEXT.offProblem(ownerCommand(repo.root, 'on')), next: ownerCommand(repo.root, 'on') }]);
  assert.ok(status.problems.some((problem) => problem.text === TEXT.staleInflight([dead])));
  assert.ok(existsSync(join(stateDir(repo.root), `inflight-${dead}.json`)), 'status removes nothing');
});

test('status reports each hook that is missing, not ours, not executable, or names an env or Node that no longer exists', () => {
  const repo = installed();
  const hooks = join(repo.root, '.git', 'hooks');
  rmSync(join(hooks, 'reference-transaction'));
  chmodSync(join(hooks, 'pre-commit'), 0o644);
  writeFileSync(join(hooks, 'pre-merge-commit'), '#!/bin/sh\nexit 0\n');
  const apply = `ask the owner to run, in their own terminal outside Claude Code: node <kh-orchestration>/scripts/apply.mjs ${repo.root} --yes`;
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
    text: TEXT.hookProgramGone(name, 'Node', '/nonexistent/node'), next: `ask the owner to run, in their own terminal outside Claude Code: node <kh-orchestration>/scripts/apply.mjs ${moved.root} --yes`,
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

test('status reports a missing pre-commit hook, and one of ours whose text is not exactly what this kit writes for the paths it names', () => {
  const repo = installed();
  const hooks = join(repo.root, '.git', 'hooks');
  rmSync(join(hooks, 'pre-commit'));
  const ours = readFileSync(join(hooks, 'pre-merge-commit'), 'utf8').split('\n');
  writeFileSync(join(hooks, 'pre-merge-commit'), `${ours.slice(0, 2).join('\n')}\nexit 0\n`);
  const race = readFileSync(join(hooks, 'reference-transaction'), 'utf8');
  writeFileSync(join(hooks, 'reference-transaction'), race.replace("case $out in 'kh-orchestration: allowed') exit 0 ;; esac", 'exit 0'));
  const apply = `ask the owner to run, in their own terminal outside Claude Code: node <kh-orchestration>/scripts/apply.mjs ${repo.root} --yes`;
  const status = statusJson(repo.root);
  assert.deepEqual(hookProblemsOf(status), [
    { text: TEXT.hookMissing('pre-commit', join(hooks, 'pre-commit')), next: apply },
    { text: TEXT.hookDiffers('pre-merge-commit', join(hooks, 'pre-merge-commit')), next: apply },
    { text: TEXT.hookDiffers('reference-transaction', join(hooks, 'reference-transaction')), next: apply },
  ]);
  assert.deepEqual(status.hooks.map((hook) => [hook.ours, hook.matches]), [[false, false], [true, false], [true, false]]);
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
  assert.deepEqual(status.liveFiles, { equal: false, reason: REASONS.liveUntracked('.claude/scripts/extra.mjs'), next: 'git add -- .claude/scripts/extra.mjs' });
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
  assert.deepEqual(lines(failing.stdout).slice(-2), [TEXT.notVerified(REASONS.noVerdict(tree, base)), `Next: ${agent(repo.root, 'verify-branch')}`], 'run judges the index against another base, so verify-branch is the next step');
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
  assert.equal(owner(repo.root, ['waive', 'V8', '--reason', 'docs follow']).status, 0);
  assert.equal(owner(repo.root, ['exempt', 'feature', '--reason', 'trial']).status, 0);
  rmSync(join(repo.root, '.git', 'hooks', 'reference-transaction'));
  const result = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(result.status, 0, result.stdout);
  const out = lines(result.stdout);
  const exemption = JSON.parse(readFileSync(join(stateDir(repo.root), 'exemptions.json'), 'utf8')).branches[0];
  const waiver = JSON.parse(readFileSync(join(stateDir(repo.root), 'waivers.json'), 'utf8')).waivers[0];
  assert.deepEqual(out.slice(2), [
    TEXT.exemption('feature', exemption), TEXT.waivers('feature', [waiver]), TEXT.agentChanges([{ id: 'R1', change: 'reworded' }]), TEXT.headRecorded, TEXT.noRaceHook, TEXT.verified,
  ]);
  assert.equal(TEXT.agentChanges([{ id: 'R1' }]), 'Rules marked approval: agent reworded since the base: R1.');
});

test('verify-branch is not passed by the off switch or an exemption: they decide nothing about whether HEAD\'s tree passed', () => {
  const repo = installed();
  assert.equal(owner(repo.root, ['off']).status, 0);
  assert.equal(owner(repo.root, ['exempt', 'main', '--reason', 'r']).status, 0);
  const result = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(result.status, 1);
  assert.equal(lines(result.stdout).at(-2), TEXT.notVerified(REASONS.noInstall(REASONS.officersAbsent)), 'the initial commit holds no install');
});

test('verify-branch without --no-run refuses an untidy tree or staged changes, saying to commit or stash', () => {
  const repo = featureBranch();
  repo.write('loose.txt', 'x\n');
  const untidy = ko(repo.root, ['verify-branch']);
  assert.deepEqual([untidy.status, untidy.stderr], [1, refusalText(TEXT.untidyHead(['loose.txt']), `git stash -u && ${agent(repo.root, 'verify-branch')}`)]);
  stage(repo);
  const staged = ko(repo.root, ['verify-branch']);
  assert.deepEqual([staged.status, staged.stderr], [1, refusalText(TEXT.stagedChanges, `git stash && ${agent(repo.root, 'verify-branch')}`)]);
});

test('verify-branch on an unborn HEAD has nothing to verify', () => {
  const repo = installed();
  assert.equal(gitIn(repo.root, ['checkout', '-q', '--orphan', 'fresh']).status, 0);
  const result = ko(repo.root, ['verify-branch', '--no-run']);
  assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.noHead, agent(repo.root, 'run'))]);
});

// ---- after Task 7's review ----

test('I1: the owner check reads the process environment; main given an empty env still refuses in a session, from either copy', () => {
  const repo = installed();
  for (const script of [join(repo.root, '.claude/kh-orchestration/scripts/ko-cli.mjs'), join(stateDir(repo.root), 'bin', 'ko-cli.mjs')]) {
    const code = `const m = await import(${JSON.stringify(pathToFileURL(script).href)}); process.exitCode = await m.main(['off'], { env: {} });`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repo.root, env: { ...testEnv(), CLAUDECODE: '1' }, encoding: 'utf8' });
    assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.ownerOnly('off', 'CLAUDECODE'), `${ownerCommand(repo.root, 'off')}, in the owner's own terminal`)], script);
    assert.equal(existsSync(join(stateDir(repo.root), 'off')), false);
  }
});

test('I1: an owner command run from the working copy refuses, naming the approved copy with its words; nothing changes', () => {
  const repo = installed();
  const before = stateSnapshot(repo.root);
  for (const args of [...OWNER_COMMANDS, ['exempt', 'old feature', '--reason', 'it\'s old']]) {
    const result = ko(repo.root, args, { input: 'approve\n' });
    const next = ownerCommand(repo.root, args.map(shellWord).join(' '));
    assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', refusalText(TEXT.notFromBin(args[0]), next)], args.join(' '));
  }
  assert.deepEqual(stateSnapshot(repo.root), before);
  assert.equal(
    TEXT.notFromBin('approve'),
    'ko.mjs approve acts only from this repository\'s approved copy, the ko.mjs in its shared state\'s bin/ named below; this is another copy, whose scripts nobody approved here. Nothing was changed.',
  );
  assert.equal(owner(repo.root, ['off']).status, 0, 'from bin/ it acts');
});

// A change staged, the officers run, and a commit through the hooks.
function gated(repo, message, file) {
  if (file !== undefined) repo.write(file, `${message}\n`);
  stage(repo);
  assert.equal(ko(repo.root, ['run']).status, 0, message);
  const committed = gitIn(repo.root, ['commit', '-q', '-m', message]);
  assert.equal(committed.status, 0, committed.stderr);
}
// What status and verify-branch --no-run say of HEAD's commit.
function assertAccepted(repo, label) {
  const status = statusJson(repo.root);
  assert.deepEqual([status.headAccepted, status.headVerdict], [true, 'passing'], `${label}: ${JSON.stringify(status.problems)}`);
  assert.equal(status.headBase, readAccepted(repo.root, gitIn(repo.root, ['rev-parse', 'HEAD']).stdout.trim()).base, label);
  const verified = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(verified.status, 0, `${label}: ${verified.stdout}`);
  assert.ok(lines(verified.stdout).includes(TEXT.headRecorded), label);
}

test('I2: a merge of main concluded on a feature branch, an amend on main, and a branch main was fast-forwarded to are each found accepted', () => {
  const repo = installed();
  assert.equal(approveAnswer(repo.root).status, 0);
  gated(repo, 'install');
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'feature']).status, 0);
  gated(repo, 'f1', 'f1.txt');
  assert.equal(gitIn(repo.root, ['switch', '-q', 'main']).status, 0);
  gated(repo, 'm2', 'm2.txt');
  assert.equal(gitIn(repo.root, ['switch', '-q', 'feature']).status, 0);
  assert.equal(gitIn(repo.root, ['merge', '-q', '--no-commit', 'main']).status, 0);
  assert.equal(ko(repo.root, ['run']).status, 0);
  assert.equal(gitIn(repo.root, ['commit', '-q', '--no-edit']).status, 0);
  assert.notEqual(headBaseOf(repo.root, 'main'), readAccepted(repo.root, head(repo.root)).base, 'the computed base is not the one the gate used');
  assertAccepted(repo, 'merge of main concluded on feature');

  assert.equal(gitIn(repo.root, ['switch', '-q', 'main']).status, 0);
  repo.write('m3.txt', 'm3\n');
  stage(repo);
  assert.equal(ko(repo.root, ['run']).status, 0);
  assert.equal(gitIn(repo.root, ['commit', '-q', '--amend', '--no-edit']).status, 0);
  assertAccepted(repo, 'amend on main');

  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'am']).status, 0);
  gated(repo, 'a1', 'a1.txt');
  assert.equal(gitIn(repo.root, ['switch', '-q', 'main']).status, 0);
  assert.equal(gitIn(repo.root, ['merge', '-q', '--ff-only', 'am']).status, 0);
  assertAccepted(repo, 'main fast-forwarded to am');
  assert.equal(gitIn(repo.root, ['switch', '-q', 'am']).status, 0);
  assertAccepted(repo, 'am after main was fast-forwarded to it');
});

test('I2: a commit git never hooked has no record: status and verify-branch say so, judging it against the computed base, never asserting it bypassed the gate', () => {
  const repo = installed();
  runApproveCommit(repo, 'install');
  repo.write('b.txt', 'b\n');
  stage(repo);
  assert.equal(gitIn(repo.root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'unhooked']).status, 0);
  const tree = gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const base = headBaseOf(repo.root, 'main');
  const status = statusJson(repo.root);
  assert.deepEqual([status.headAccepted, status.headBase, status.headVerdict], [false, base, 'none']);
  assert.ok(status.problems.some((problem) => problem.text === TEXT.headNoRecord(tree, base) && problem.next === agent(repo.root, 'verify-branch')));
  assert.equal(
    TEXT.headNoRecord('a'.repeat(40), 'b'.repeat(40)),
    'There is no record of HEAD\'s commit passing the gate and no passing verdict for its tree (aaaaaaaaaaaa) against its base (bbbbbbbbbbbb): it predates the install, or git never ran the hooks for it (a rebase, a cherry-pick or the like). Run verify-branch before merging.',
  );
  assert.equal(JSON.stringify(status).includes('committed without'), false);
  const verified = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(verified.status, 1);
  assert.ok(lines(verified.stdout).includes(TEXT.headNotRecorded));
  assert.equal(lines(verified.stdout).at(-2), TEXT.notVerified(REASONS.noVerdict(tree, base)));
});

test('I3: status reports a bin/ file that differs from the last approved tree, one too many, a missing gate.mjs and a missing bin/, naming the baseline and apply as the repair', () => {
  const repo = installed();
  assert.equal(approveAnswer(repo.root).status, 0);
  const tree = indexTree(repo.root);
  const bin = join(stateDir(repo.root), 'bin');
  const binProblems = (status) => status.problems.filter((problem) => problem.text.includes('bin/'));
  assert.deepEqual(binProblems(statusJson(repo.root)), []);
  writeFileSync(join(bin, 'ko-gate.mjs'), `${readFileSync(join(bin, 'ko-gate.mjs'), 'utf8')}// changed\n`);
  writeFileSync(join(bin, 'stray.mjs'), 'export {};\n');
  const approve = `ask the owner to run, in their own terminal outside Claude Code: node <kh-orchestration>/scripts/apply.mjs ${repo.root} --yes`;
  const changed = statusJson(repo.root);
  assert.deepEqual(changed.bin, { present: true, gate: true, baseline: { kind: 'approved', tree }, differs: ['ko-gate.mjs'], missing: [], extra: ['stray.mjs'] });
  assert.deepEqual(binProblems(changed), [{ text: TEXT.binDiffers(bin, TEXT.binBaselineApproved(tree), ['ko-gate.mjs', 'stray.mjs']), next: approve }]);
  rmSync(join(bin, 'gate.mjs'));
  assert.deepEqual(binProblems(statusJson(repo.root))[0], { text: TEXT.binNoGate(bin), next: approve });
  rmSync(bin, { recursive: true });
  const gone = statusJson(repo.root);
  assert.deepEqual([gone.bin.present, binProblems(gone)], [false, [{ text: TEXT.binMissing(bin), next: approve }]]);
});

test('I3: before any approval bin/ is compared with the working copy\'s installed scripts, and status says so', () => {
  const repo = installed();
  const script = join(repo.root, '.claude/kh-orchestration/scripts/ko-git.mjs');
  writeFileSync(script, `${readFileSync(script, 'utf8')}// unstaged\n`);
  const bin = join(stateDir(repo.root), 'bin');
  const status = statusJson(repo.root);
  assert.deepEqual(status.bin, { present: true, gate: true, baseline: { kind: 'working', tree: null }, differs: ['ko-git.mjs'], missing: [], extra: [] });
  assert.ok(status.problems.some((problem) => problem.text === TEXT.binDiffers(bin, TEXT.binBaselineWorking, ['ko-git.mjs'])));
});

test('I4: approve on a new branch diffs against the approved tree whose digest is the merge base\'s, and says which baseline it used', () => {
  const repo = installed();
  assert.equal(approveAnswer(repo.root).status, 0);
  const approvedTree = indexTree(repo.root);
  const at = readApprovals(repo.root)[0].approvedAt;
  gated(repo, 'install');
  const fork = head(repo.root);
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'feature']).status, 0);
  repo.write('tools/check.mjs', `${readFileSync(join(repo.root, 'tools/check.mjs'), 'utf8')}// on the feature branch\n`);
  stage(repo);
  const result = approveAnswer(repo.root, { input: 'no\n' });
  assert.ok(result.stdout.includes(`${TEXT.baselineMergeBase(approvedTree, at, fork, 'feature')}\n`), result.stdout);
  assert.ok(result.stdout.includes('+// on the feature branch'));
});

test('I4: approve falls back to the most recent approved tree of any branch, and lists files newly covered though unchanged', () => {
  const repo = installed();
  repo.write('docs/x.txt', 'unchanged doc\n');
  stage(repo);
  assert.equal(approveAnswer(repo.root).status, 0);
  const approvedTree = indexTree(repo.root);
  const at = readApprovals(repo.root)[0].approvedAt;
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'other']).status, 0);
  const officers = JSON.parse(readFileSync(join(repo.root, '.claude/kh-orchestration/officers.json'), 'utf8'));
  repo.write('.claude/kh-orchestration/officers.json', `${JSON.stringify({ ...officers, protected: ['docs/x.txt'] }, null, 2)}\n`);
  stage(repo);
  const result = approveAnswer(repo.root, { input: 'no\n' });
  assert.ok(result.stdout.includes(`${TEXT.baselineAny(approvedTree, at, 'main', 'other')}\n`), result.stdout);
  assert.ok(result.stdout.includes(`${TEXT.newlyCovered(['docs/x.txt'])}\n`));
  assert.ok(result.stdout.includes('+  "protected": ['), 'the officers file\'s own change is in the diff');
  assert.equal(TEXT.newlyCovered(['a', 'b']), 'Newly covered, their content unchanged since that tree: a, b.');
});

test('approving a digest again moves its record to the end, with this tree: the last record is what bin/ holds', () => {
  const repo = installed();
  assert.equal(approveAnswer(repo.root).status, 0);
  const first = readApprovals(repo.root)[0];
  const original = readFileSync(join(repo.root, 'tools/check.mjs'), 'utf8');
  repo.write('tools/check.mjs', `${original}// second\n`);
  stage(repo);
  assert.equal(approveAnswer(repo.root).status, 0);
  repo.write('tools/check.mjs', original);
  stage(repo);
  assert.equal(approveAnswer(repo.root).status, 0);
  const records = readApprovals(repo.root);
  assert.deepEqual(records.map((record) => record.digest), [records[0].digest, first.digest]);
  assert.equal(records.at(-1).tree, indexTree(repo.root));
  assert.deepEqual(statusJson(repo.root).bin.differs, []);
});

test('M1: status and verify-branch --no-run execute nothing from the repository: checkContract1 alone', () => {
  const repo = installed();
  runApproveCommit(repo, 'install');
  const marker = join(repo.root, '..', 'dispatcher-ran');
  const dispatcher = join(repo.root, '.claude/scripts/dispatch-pre-tool.mjs');
  const text = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'x');\n`;
  writeFileSync(dispatcher, text);
  const contractPath = join(repo.root, '.claude/kh-harness/contract.json');
  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  contract.files['.claude/scripts/dispatch-pre-tool.mjs'] = lfSha256(Buffer.from(text));
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  assert.equal(statusJson(repo.root).contract.ok, true, 'the files agree with each other');
  ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(existsSync(marker), false);
});

test('M3: names are shown with invisible characters made visible; exempt refuses refs/heads/ forms and @', () => {
  const repo = installed();
  const result = owner(repo.root, ['exempt', '\u202emain', '--reason', 'r']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lines(result.stdout)[0], 'The branch \\u{202e}main is exempt: the commit gate lets its commits through unchecked.');
  for (const name of ['refs/heads/main', '@']) {
    const refused = owner(repo.root, ['exempt', name, '--reason', 'r']);
    assert.deepEqual([refused.status, refused.stderr], [2, usageText(TEXT.badBranch(name))], name);
  }
});

test('M4: a verdict file that exists but is not a usable record is reported as damaged, naming it, not as none', () => {
  const repo = installed();
  assert.equal(ko(repo.root, ['run']).status, 0);
  const name = `verdicts/${indexTree(repo.root)}-${baseOf(repo.root, 'main')}.json`;
  writeFileSync(join(stateDir(repo.root), name), '{"schema": 2}\n');
  const status = statusJson(repo.root);
  assert.equal(status.verdict, 'damaged');
  assert.ok(status.problems.some((problem) => problem.text === TEXT.verdictDamaged(name) && problem.next === agent(repo.root, 'run')));
});

test('M5: status lists an exemption of the current branch and a failing verdict for the staged tree among its problems', () => {
  const repo = installed();
  repo.write('fail.txt', 'x\n');
  stage(repo);
  assert.equal(ko(repo.root, ['run']).status, 1);
  assert.equal(owner(repo.root, ['exempt', 'main', '--reason', 'trial']).status, 0);
  const status = statusJson(repo.root);
  assert.equal(status.verdict, 'failing');
  assert.ok(status.problems.some((problem) => problem.text === TEXT.indexFailing(['check']) && problem.next === agent(repo.root, 'run')));
  assert.ok(status.problems.some((problem) => problem.text === TEXT.exemptHere('main', 'trial') && problem.next === agent(repo.root, 'unexempt main')));
});

test('a run killed while its officers run leaves no verdict', async () => {
  const repo = installed({
    officers: `${JSON.stringify({ schema: 1, baseBranch: 'main', protected: [], officers: [{ id: 'slow', rule: null, argv: ['node', 'tools/slow.mjs'], appliesTo: ['**'] }] })}\n`,
  });
  const ready = join(repo.root, '..', 'slow-ready');
  repo.write('tools/slow.mjs', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(ready)}, String(process.pid));\nsetTimeout(() => {}, 30000);\n`);
  stage(repo);
  const child = spawn(process.execPath, [join(repo.root, '.claude/kh-orchestration/scripts/ko.mjs'), 'run'], { cwd: repo.root, env: testEnv(), stdio: 'ignore' });
  while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 20));
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  try {
    process.kill(-Number(readFileSync(ready, 'utf8')), 'SIGKILL');
  } catch {
    // the officer's group is gone
  }
  assert.equal(existsSync(join(stateDir(repo.root), 'verdicts')), false);
});

test('status says when the staged tree\'s verdict records other protected files, and when an accepted HEAD\'s verdict is gone', () => {
  const repo = installed();
  runApproveCommit(repo, 'install');
  const headTreeId = gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const accepted = readAccepted(repo.root, head(repo.root));
  rmSync(join(stateDir(repo.root), `verdicts/${headTreeId}-${accepted.base}.json`));
  const gone = statusJson(repo.root);
  assert.deepEqual([gone.headAccepted, gone.headVerdict], [true, 'none']);
  assert.ok(gone.problems.some((problem) => problem.text === TEXT.headAcceptedUnverdicted(headTreeId, accepted.base)));

  repo.write('b.txt', 'b\n');
  stage(repo);
  assert.equal(ko(repo.root, ['run']).status, 0);
  const name = `verdicts/${indexTree(repo.root)}-${baseOf(repo.root, 'main')}.json`;
  const verdict = JSON.parse(readFileSync(join(stateDir(repo.root), name), 'utf8'));
  writeFileSync(join(stateDir(repo.root), name), JSON.stringify({ ...verdict, digest: 'f'.repeat(64) }));
  const stale = statusJson(repo.root);
  assert.equal(stale.verdict, 'failing');
  assert.ok(stale.problems.some((problem) => problem.text === TEXT.indexStale && problem.next === agent(repo.root, 'run')));
});

// ---- after Task 7's second review ----

test('approve refuses a staged ko-cli.mjs that does not parse, and a tree without ko-gate.mjs, with bin/ and the approvals as they were; a good tree still approves', () => {
  const repo = installed();
  runApproveCommit(repo, 'install');
  assert.equal(owner(repo.root, ['propose']).status, 0);
  const cli = join(repo.root, '.claude/kh-orchestration/scripts/ko-cli.mjs');
  const text = readFileSync(cli, 'utf8');
  const bin = () => Object.fromEntries(readdirSync(join(stateDir(repo.root), 'bin')).map((name) => [name, readFileSync(join(stateDir(repo.root), 'bin', name), 'utf8')]));
  const before = [bin(), readApprovals(repo.root)];
  for (const [script, breakIt] of [
    ['ko-cli.mjs', () => writeFileSync(cli, text.replace('export async function main(argv) {', 'export async function main(argv) { syntax error here'))],
    ['ko-gate.mjs', () => rmSync(join(repo.root, '.claude/kh-orchestration/scripts/ko-gate.mjs'))],
  ]) {
    breakIt();
    stage(repo);
    const refused = approveAnswer(repo.root);
    assert.equal(refused.status, 1, script);
    assert.equal(refused.stderr, refusalText(binPreflightMessage(script), ownerCommand(repo.root, 'approve')), script);
    assert.deepEqual([bin(), readApprovals(repo.root)], before, script);
    assert.equal(owner(repo.root, ['status']).status, 0, `${script}: the owner's commands still work`);
    assert.equal(gitIn(repo.root, ['checkout', '-q', 'HEAD', '--', '.claude/kh-orchestration/scripts']).status, 0);
  }
  writeFileSync(cli, text.replace("noCommand: 'No command was given.'", "noCommand: 'No command was given (edited).'"));
  stage(repo);
  assert.equal(approveAnswer(repo.root).status, 0, 'a good change still approves');
  assert.ok(bin()['ko-cli.mjs'].includes('(edited)'));
});

test('ko.mjs that cannot start tells the approved copy from the working copy, and both texts and status name the one repair command', () => {
  const repo = installed();
  rmSync(join(stateDir(repo.root), 'bin', 'ko-cli.mjs'));
  const result = owner(repo.root, ['status']);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, '', `kh-orchestration: ko.mjs could not start: the approved copy in <git-common-dir>/kh-orchestration/bin/ is missing a script, or one is damaged or of another version.\nNext: ${repairCommand('<repository>')}\n`]);
  for (const entry of ['ko.mjs', 'gate.mjs']) {
    assert.ok(readFileSync(join(repo.root, '.claude/kh-orchestration/scripts', entry), 'utf8').includes(`Next: ${repairCommand('<repository>')}\\n`), entry);
  }
  assert.equal(repairCommand(shellWord(repo.root)), `ask the owner to run, in their own terminal outside Claude Code: node <kh-orchestration>/scripts/apply.mjs ${repo.root} --yes`);
});

test('every ko.mjs command a refusal or report prints works where the person is: a subdirectory of a linked worktree whose path holds spaces', () => {
  const repo = installed();
  runApproveCommit(repo, 'install');
  const side = join(repo.root, '..', 'a worktree with spaces');
  assert.equal(gitIn(repo.root, ['worktree', 'add', '-q', '-b', 'side', side]).status, 0);
  const deep = join(side, 'docs', 'deep');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, 'n.txt'), 'n\n');
  const fromDeep = (args) => ko(side, args, { cwd: deep });
  const untidy = fromDeep(['run']);
  const next = untidy.stderr.split('\n')[1].slice('Next: '.length);
  assert.equal(next, `git -C ${shellWord(side)} add -- <each path meant to be committed>, then ${agent(side, 'run')}`);
  // The person stages the listed file meant to be committed, then runs the officers.
  const followed = spawnSync('sh', ['-c', next.replace('<each path meant to be committed>', 'docs/deep/n.txt').replace(', then ', ' && ')], { cwd: deep, env: testEnv(), encoding: 'utf8' });
  assert.equal(followed.status, 0, followed.stderr);
  const approved = owner(repo.root, ['approve'], { cwd: deep, input: 'approve\n' });
  assert.equal(approved.status, 0, approved.stderr);
  const approvedNext = lines(approved.stdout).at(-1).slice('Next: '.length);
  assert.equal(approvedNext, TEXT.approvedNext(agent(side, 'run')));
  const run = spawnSync('sh', ['-c', approvedNext.replace(/, then git commit$/, '')], { cwd: deep, env: testEnv(), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(lines(run.stdout).at(-1), 'Next: git commit');
});

test('verify-branch --no-run on the base branch for a HEAD with no record names verify-branch, which then passes', () => {
  const repo = installed();
  runApproveCommit(repo, 'install');
  repo.write('b.txt', 'b\n');
  stage(repo);
  assert.equal(gitIn(repo.root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'unhooked']).status, 0);
  const failing = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(failing.status, 1);
  assert.equal(lines(failing.stdout).at(-1), `Next: ${agent(repo.root, 'verify-branch')}`);
  assert.equal(ko(repo.root, ['verify-branch']).status, 0);
});

test('an owner command run from another repository\'s approved copy refuses truthfully, naming this repository\'s', () => {
  const repo = installed();
  const other = installed();
  const result = spawnSync(process.execPath, [join(stateDir(other.root), 'bin', 'ko.mjs'), 'off'], { cwd: repo.root, env: testEnv(), encoding: 'utf8' });
  assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.notFromBin('off'), ownerCommand(repo.root, 'off'))]);
  assert.equal(
    TEXT.notFromBin('off'),
    'ko.mjs off acts only from this repository\'s approved copy, the ko.mjs in its shared state\'s bin/ named below; this is another copy, whose scripts nobody approved here. Nothing was changed.',
  );
});

test('a next line whose words hold invisible characters is not printed for pasting: the words are shown visibly, with what to type', () => {
  const repo = installed();
  const result = ko(repo.root, ['exempt', '\u202emain', '--reason', 'r']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.includes('\u202e'), false);
  assert.equal(result.stderr, refusalText(TEXT.notFromBin('exempt'), TEXT.typeIt(ownerCommand(repo.root, 'exempt \\u{202e}main --reason r'))));
  assert.equal(
    TEXT.typeIt('node x exempt \\u{202e}main'),
    'node x exempt \\u{202e}main (type it yourself, writing each \\u{…} as the character it names: a terminal does not show them, so a pasted line could differ from what you read)',
  );
});

test('on a detached HEAD verify-branch and approve say "a detached HEAD", never "this branch"', () => {
  const repo = installed();
  runApproveCommit(repo, 'install');
  assert.equal(gitIn(repo.root, ['switch', '-q', '--detach']).status, 0);
  assert.equal(approveAnswer(repo.root).status, 0);
  const again = approveAnswer(repo.root, { input: 'no\n' });
  assert.equal(again.stdout.includes('this branch'), false, again.stdout);
  const verified = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(verified.stdout.includes('this branch'), false, verified.stdout);
  assert.ok(lines(verified.stdout)[0].includes('a detached HEAD'));
});

// The approved tree stays reachable (after Task 9's re-review): approve pins it under
// refs/kh-orchestration/approved/<digest>, through the installed hooks (the reference-transaction
// hook lets an update of a process with no in-flight record through), so git prune keeps it.
test('approve pins the approved tree with a ref that git prune keeps, and refuses before recording anything when the ref cannot be written', () => {
  const repo = installed();
  const tree = indexTree(repo.root);
  const digest = digestOfTree(repo.root, tree).digest;
  assert.equal(approveAnswer(repo.root).status, 0);
  const ref = `refs/kh-orchestration/approved/${digest}`;
  assert.equal(gitIn(repo.root, ['rev-parse', '--verify', ref]).stdout.trim(), tree);
  assert.equal(gitIn(repo.root, ['cat-file', '-t', ref]).stdout.trim(), 'tree');
  assert.equal(gitIn(repo.root, ['reflog', 'expire', '--expire=now', '--all']).status, 0);
  assert.equal(gitIn(repo.root, ['prune', '--expire=now']).status, 0);
  assert.equal(gitIn(repo.root, ['cat-file', '-t', tree]).stdout.trim(), 'tree', 'the approved tree survives a prune');

  // A ref that cannot be written: a file where refs/kh-orchestration/approved must be a directory.
  const other = installed();
  rmSync(join(other.root, '.git', 'refs', 'kh-orchestration'), { recursive: true, force: true });
  writeFileSync(join(other.root, '.git', 'refs', 'kh-orchestration'), 'not a directory\n');
  const refused = approveAnswer(other.root);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.startsWith(`kh-orchestration: ${TEXT.pinFailed}\n`), refused.stderr);
  // The pin comes after bin/'s refresh (after Task 9's second re-review): nothing is approved.
  assert.equal(existsSync(join(stateDir(other.root), 'approvals.json')), false, 'nothing is recorded');
  assert.equal(TEXT.pinFailed, 'The approved tree could not be pinned with a ref under refs/kh-orchestration/approved/, so it could be pruned later and nothing is approved (bin/ already holds its scripts; the gate refuses them until approved). Check that the git directory can be written, then approve again.');
});

// A ref names only what was approved (after Task 9's second re-review): pinned after bin/ was
// refreshed, and taken out again when the approval cannot then be recorded.
test('an approval refused at the pre-flight, or one whose record cannot be written, leaves no approved/ ref', () => {
  const repo = installed();
  const refs = (root) => gitIn(root, ['for-each-ref', '--format=%(refname)', 'refs/kh-orchestration/']).stdout;
  const cli = join(repo.root, '.claude/kh-orchestration/scripts/ko-cli.mjs');
  const good = readFileSync(cli, 'utf8');
  writeFileSync(cli, `${good}\nthis is not javascript(\n`);
  stage(repo);
  assert.equal(approveAnswer(repo.root).status, 1);
  assert.equal(refs(repo.root), '', 'refused at the pre-flight');
  writeFileSync(cli, good);
  stage(repo);

  // approvals.json cannot be replaced: a directory stands where it goes.
  mkdirSync(join(stateDir(repo.root), 'approvals.json'), { recursive: true });
  assert.notEqual(approveAnswer(repo.root).status, 0);
  assert.equal(refs(repo.root), '', 'the record could not be written');
  rmSync(join(stateDir(repo.root), 'approvals.json'), { recursive: true });
  assert.equal(approveAnswer(repo.root).status, 0);
  const digest = digestOfTree(repo.root, indexTree(repo.root)).digest;
  assert.equal(refs(repo.root), `refs/kh-orchestration/approved/${digest}\n`);

  // Approving the same digest again and failing to record it keeps the earlier pin.
  const approvals = readFileSync(join(stateDir(repo.root), 'approvals.json'));
  rmSync(join(stateDir(repo.root), 'approvals.json'));
  mkdirSync(join(stateDir(repo.root), 'approvals.json'));
  assert.notEqual(approveAnswer(repo.root).status, 0);
  assert.equal(refs(repo.root), `refs/kh-orchestration/approved/${digest}\n`, 'a pin that was there stays');
  rmSync(join(stateDir(repo.root), 'approvals.json'), { recursive: true });
  writeFileSync(join(stateDir(repo.root), 'approvals.json'), approvals);
});

// ---- after the whole-branch review ----

// An officers file of `[id, argv]` pairs, each applying to every path.
const officersOf = (pairs) => `${JSON.stringify({
  schema: 1, baseBranch: 'main', protected: [], officers: pairs.map(([id, argv]) => ({ id, rule: null, argv, appliesTo: ['**'] })),
})}\n`;
// An officer that rewrites src/a.js as an autofixing lint would.
const FIXER = "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/a.js', 'GOOD\\n');\n";
const treeChangedNext = (root) => `git -C ${shellWord(root)} add -- <each changed path that is wanted>, then ${agent(root, 'run')}`;

test('C1: an officer that rewrites a staged file records no verdict: run exits 1 naming the file, and the commit is refused', () => {
  const repo = installed({ officers: officersOf([['lint', ['node', 'tools/fix.mjs']]]) });
  repo.write('tools/fix.mjs', FIXER);
  repo.write('src/a.js', 'BAD\n');
  stage(repo);
  const tree = indexTree(repo.root);
  const base = baseOf(repo.root, 'main');
  const result = ko(repo.root, ['run']);
  assert.deepEqual([result.status, result.stderr], [1, refusalText(TEXT.treeChanged(['src/a.js']), treeChangedNext(repo.root))]);
  assert.equal(lines(result.stdout)[0], TEXT.runHeader(tree, base));
  assert.match(lines(result.stdout)[1], /^ {2}lint {2}pass {2}/);
  assert.equal(readVerdict(repo.root, tree, base), null, 'no verdict, passing or not');
  assert.equal(existsSync(join(stateDir(repo.root), 'journal.jsonl')), false, 'nothing is journaled for a run that records no verdict');
  assert.equal(
    TEXT.treeChanged(['src/a.js']),
    'The working tree changed while the officers ran, so no verdict is recorded: they did not pass on the tree a commit would hold (an officer that fixes files, a lint --fix say, does this, and so does one that writes a file git does not ignore). Stage what they changed if it is wanted, add a file they write to .gitignore, restore the rest, then run the officers again. Changed: src/a.js.',
  );
  assert.equal(approveAnswer(repo.root).status, 0);
  const committed = commit(repo.root);
  assert.equal(committed.status, 1, 'the gate finds no verdict');
  assert.ok(committed.stderr.includes(REASONS.noVerdict(tree, base)), committed.stderr);
});

test('C1: an officer that writes an untracked file, or stages a change itself, records no verdict and names the path', () => {
  const writer = installed({ officers: officersOf([['cache', ['node', 'tools/cache.mjs']]]) });
  writer.write('tools/cache.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync('cache.txt', 'x\\n');\n");
  stage(writer);
  const written = ko(writer.root, ['run']);
  assert.deepEqual([written.status, written.stderr], [1, refusalText(TEXT.treeChanged(['cache.txt']), treeChangedNext(writer.root))]);
  assert.equal(readVerdict(writer.root, indexTree(writer.root), baseOf(writer.root, 'main')), null);

  const stager = installed({ officers: officersOf([['lint', ['node', 'tools/fix-add.mjs']]]) });
  stager.write('tools/fix-add.mjs', `${FIXER}import { spawnSync } from 'node:child_process';\nspawnSync('git', ['add', 'src/a.js']);\n`);
  stager.write('src/a.js', 'BAD\n');
  stage(stager);
  const judged = indexTree(stager.root);
  const staged = ko(stager.root, ['run']);
  assert.deepEqual([staged.status, staged.stderr], [1, refusalText(TEXT.treeChanged(['src/a.js']), treeChangedNext(stager.root))]);
  assert.notEqual(indexTree(stager.root), judged, 'the officer staged its fix: the working tree is tidy, the index is not the tree judged');
  assert.equal(readVerdict(stager.root, judged, baseOf(stager.root, 'main')), null);
});

test('C1: an officer that leaves the tree alone still passes; one that changes a file and puts it back is not detected (a stated limit)', () => {
  const quiet = installed({ officers: officersOf([['check', ['node', 'tools/check.mjs']]]) });
  assert.equal(ko(quiet.root, ['run']).status, 0);
  assert.notEqual(readVerdict(quiet.root, indexTree(quiet.root), baseOf(quiet.root, 'main')), null);

  const restorer = installed({ officers: officersOf([['lint', ['node', 'tools/flip.mjs']]]) });
  restorer.write('tools/flip.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync('src/a.js', 'GOOD\\n');\nwriteFileSync('src/a.js', 'BAD\\n');\n");
  restorer.write('src/a.js', 'BAD\n');
  stage(restorer);
  const result = ko(restorer.root, ['run']);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(readVerdict(restorer.root, indexTree(restorer.root), baseOf(restorer.root, 'main')), null, 'what the officers saw in between is not known');
});

test('C1: verify-branch whose officer rewrites a file of HEAD\'s tree records no verdict and fails, naming the file', () => {
  const repo = installed({ officers: officersOf([['lint', ['node', 'tools/fix.mjs']]]) });
  repo.write('tools/fix.mjs', FIXER);
  repo.write('src/a.js', 'BAD\n');
  stage(repo);
  // Committed with git's hooks off: a commit git never ran the gate for, as verify-branch is for.
  assert.equal(gitIn(repo.root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'unchecked']).status, 0);
  const tree = gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const base = headBaseOf(repo.root, 'main');
  const result = ko(repo.root, ['verify-branch']);
  assert.deepEqual([result.status, result.stderr], [1, refusalText(
    TEXT.treeChangedHead(['src/a.js']),
    `git -C ${shellWord(repo.root)} add -- <each changed path that is wanted> && git -C ${shellWord(repo.root)} commit, then ${agent(repo.root, 'verify-branch')}`,
  )]);
  assert.equal(readVerdict(repo.root, tree, base), null);
  assert.equal(
    TEXT.treeChangedHead(['src/a.js']),
    'The working tree changed while the officers ran, so no verdict is recorded: they did not pass on HEAD\'s tree as it is (an officer that fixes files, a lint --fix say, does this, and so does one that writes a file git does not ignore). Commit what they changed if it is wanted, add a file they write to .gitignore, discard the rest, then verify again. Changed: src/a.js.',
  );
});
