// Approvals are ordered (after the whole-branch review): a tree's digest counts only when it is
// approved AND equals its base's digest, or was approved later than the base's digest, or the base
// imposes no order (none, from before the install). Each case through the real commands and hooks:
// the gate, status and verify-branch must agree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OFFICERS_PATH, gitIn, installed, ko, owner, stage } from './gate-fixture.mjs';
import { TEXT } from '../../assets/scripts/ko-cli.mjs';
import { REASONS } from '../../assets/scripts/ko-gate.mjs';
import { digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { indexTree } from '../../assets/scripts/ko-git.mjs';
import { ownerCommand, readApprovals } from '../../assets/scripts/ko-state.mjs';

const officers = (list, globs = []) => `${JSON.stringify({
  schema: 1, baseBranch: 'main', protected: globs, officers: list.map(([id, script]) => ({ id, rule: null, argv: ['node', script], appliesTo: ['**'] })),
}, null, 2)}\n`;
const STRICT = "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('bad.txt') ? 1 : 0);\n";
const lines = (text) => text.split('\n').filter((line) => line !== '');

const run = (repo) => {
  const result = ko(repo.root, ['run']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return lines(result.stdout);
};
const approve = (repo) => {
  const result = owner(repo.root, ['approve'], { input: 'approve\n' });
  assert.equal(result.status, 0, result.stderr);
  return lines(result.stdout);
};
const landed = (repo, message) => {
  const result = gitIn(repo.root, ['commit', '-q', '-m', message]);
  assert.equal(result.status, 0, result.stderr);
};
const stagedDigest = (repo) => digestOfTree(repo.root, indexTree(repo.root)).digest;
const status = (repo) => JSON.parse(ko(repo.root, ['status', '--json']).stdout);
const problemTexts = (repo) => status(repo).problems.map((problem) => problem.text);
const gateRefusal = (repo, reason) => `kh-orchestration: ${reason}\nNext: ${ownerCommand(repo.root, 'approve')}\n`;
// The gate, status and verify-branch --no-run after a commit landed: nothing to say about the approval.
function agreeLanded(repo) {
  const verified = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(verified.status, 0, verified.stdout);
  assert.equal(status(repo).digestApproved, true);
}
const switchTo = (repo, ...argv) => assert.equal(gitIn(repo.root, ['switch', '-q', ...argv]).status, 0);

test('C2: an older approved officers file restored by checkout is refused by the gate, status and verify-branch, and lands once the owner approves it again', () => {
  const repo = installed();
  run(repo);
  approve(repo);
  landed(repo, 'install');
  repo.write(OFFICERS_PATH, officers([['check', 'tools/check.mjs'], ['strict', 'tools/strict.mjs']]));
  repo.write('tools/strict.mjs', STRICT);
  stage(repo);
  run(repo);
  approve(repo);
  landed(repo, 'a strict officer');
  const strictDigest = digestOfTree(repo.root, gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim()).digest;

  // The reviewer's way round: the officers file of one commit back, and a file strict fails.
  assert.equal(gitIn(repo.root, ['checkout', 'HEAD~1', '--', OFFICERS_PATH]).status, 0);
  repo.write('bad.txt', 'strict fails on this\n');
  stage(repo);
  const older = stagedDigest(repo);
  assert.deepEqual(readApprovals(repo.root).map((entry) => entry.digest).indexOf(older), 0, 'the restored digest is the first one approved');
  assert.deepEqual(run(repo).slice(-2), [TEXT.passingOlder(older), `Next: ${ownerCommand(repo.root, 'approve')}`]);
  assert.equal(status(repo).digestApproved, false);
  assert.ok(problemTexts(repo).includes(TEXT.olderApproval(older)));
  const refused = gitIn(repo.root, ['commit', '-q', '-m', 'restore the old checks']);
  assert.equal(refused.status, 1);
  assert.ok(refused.stderr.startsWith(gateRefusal(repo, REASONS.olderApproval(older))), refused.stderr);

  // Committed with git's hooks off, verify-branch says the same.
  assert.equal(gitIn(repo.root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'unhooked']).status, 0);
  const verified = ko(repo.root, ['verify-branch', '--no-run']);
  assert.equal(verified.status, 1);
  assert.ok(lines(verified.stdout).includes(TEXT.notVerified(REASONS.olderApproval(older))), verified.stdout);
  assert.equal(gitIn(repo.root, ['reset', '-q', '--soft', 'HEAD~1']).status, 0);

  // approve says what it is approving, records a new approval at the end, and the commit lands.
  const before = readApprovals(repo.root).length;
  assert.ok(approve(repo).includes(TEXT.approvesOlder(older, strictDigest)));
  assert.deepEqual(readApprovals(repo.root).slice(before).map((entry) => entry.digest), [older], 'a new record, the earlier one kept');
  assert.equal(readApprovals(repo.root).filter((entry) => entry.digest === older).length, 2);
  landed(repo, 'the old checks, approved again');
  agreeLanded(repo);
  assert.equal(problemTexts(repo).includes(TEXT.olderApproval(older)), false);

  assert.equal(
    REASONS.olderApproval('0123456789abcdef'),
    'The protected files of this tree (digest 0123456789ab) are an earlier approved version than its base\'s: the owner approved them before the base\'s, so going back to them needs the owner\'s approval again. The owner reviews and approves them in their own terminal.',
  );
  assert.equal(TEXT.olderApproval('0123456789abcdef'), 'The protected files of the staged tree (digest 0123456789ab) are an earlier approved version than the base\'s: the owner must approve again.');
});

test('C2: a branch whose protected files equal its base\'s needs no approval, nor one approved after its base\'s; a base from before the install, or none, imposes no order', () => {
  const repo = installed();
  run(repo);
  approve(repo);
  const installDigest = stagedDigest(repo);
  // Another digest approved after this one, then the install staged again: the base (the commit
  // from before the install) has no digest, so the order of the two does not count.
  repo.write(OFFICERS_PATH, officers([['other', 'tools/check.mjs']]));
  stage(repo);
  run(repo);
  approve(repo);
  repo.write(OFFICERS_PATH, officers([['check', 'tools/check.mjs']]));
  stage(repo);
  assert.equal(stagedDigest(repo), installDigest);
  run(repo);
  landed(repo, 'install');
  agreeLanded(repo);

  switchTo(repo, '-c', 'unchanged');
  repo.write('f.txt', 'feature\n');
  stage(repo);
  assert.equal(run(repo).at(-1), 'Next: git commit', 'equal to the base\'s digest: nothing to approve');
  landed(repo, 'feature');
  agreeLanded(repo);

  switchTo(repo, 'main');
  switchTo(repo, '-c', 'later');
  repo.write(OFFICERS_PATH, officers([['check', 'tools/check.mjs'], ['again', 'tools/check.mjs']]));
  stage(repo);
  run(repo);
  approve(repo);
  landed(repo, 'approved after its base');
  agreeLanded(repo);

  // Base none: an unborn branch.
  assert.equal(gitIn(repo.root, ['checkout', '-q', '--orphan', 'fresh']).status, 0);
  run(repo);
  landed(repo, 'a root commit');
  agreeLanded(repo);
});

test('C2: two branches approved one after the other merge in turn; the second needs approval only when its merge result is new', () => {
  const repo = installed({ officers: officers([['check', 'tools/check.mjs']], ['conf/**']) });
  repo.write('conf/x.txt', 'x0\n');
  repo.write('conf/y.txt', 'y0\n');
  stage(repo);
  run(repo);
  approve(repo);
  landed(repo, 'install');
  for (const [branch, path, text] of [['x', 'conf/x.txt', 'x1\n'], ['y', 'conf/y.txt', 'y1\n'], ['z', 'notes.txt', 'unprotected\n']]) {
    switchTo(repo, '-c', branch, 'main');
    repo.write(path, text);
    stage(repo);
    run(repo);
    if (branch !== 'z') approve(repo);
    landed(repo, branch);
  }
  switchTo(repo, 'main');
  const merge = (branch) => {
    const merged = gitIn(repo.root, ['merge', '-q', '--no-ff', '--no-commit', branch]);
    assert.equal(merged.status, 0, merged.stderr);
  };
  merge('x');
  assert.equal(run(repo).at(-1), 'Next: git commit', 'x was approved after main\'s digest');
  landed(repo, 'merge x');
  agreeLanded(repo);

  merge('y');
  const both = stagedDigest(repo);
  assert.deepEqual(run(repo).slice(-2), [TEXT.passingUnapproved(both), `Next: ${ownerCommand(repo.root, 'approve')}`], 'x and y together are a digest never approved');
  const refused = gitIn(repo.root, ['commit', '-q', '-m', 'merge y']);
  assert.ok(refused.stderr.startsWith(gateRefusal(repo, REASONS.unapproved(both))), refused.stderr);
  approve(repo);
  landed(repo, 'merge y');
  agreeLanded(repo);

  merge('z');
  assert.equal(run(repo).at(-1), 'Next: git commit', 'z leaves the protected files as main has them');
  landed(repo, 'merge z');
  agreeLanded(repo);
});

test('C2: a merge conflict in a protected file resolved by taking the side approved earlier is refused until approved again', () => {
  const repo = installed({ officers: officers([['check', 'tools/check.mjs']], ['conf/**']) });
  repo.write('conf/x.txt', 'x0\n');
  stage(repo);
  run(repo);
  approve(repo);
  landed(repo, 'install');
  switchTo(repo, '-c', 'side');
  repo.write('conf/x.txt', 'side\n');
  stage(repo);
  run(repo);
  approve(repo);
  landed(repo, 'side');
  switchTo(repo, 'main');
  repo.write('conf/x.txt', 'main\n');
  stage(repo);
  run(repo);
  approve(repo);
  landed(repo, 'main moves on');

  assert.equal(gitIn(repo.root, ['merge', '-q', '--no-ff', '--no-commit', 'side']).status, 1, 'a conflict');
  assert.equal(gitIn(repo.root, ['checkout', '--theirs', '--', 'conf/x.txt']).status, 0);
  stage(repo);
  const taken = stagedDigest(repo);
  assert.deepEqual(run(repo).slice(-2), [TEXT.passingOlder(taken), `Next: ${ownerCommand(repo.root, 'approve')}`]);
  assert.ok(problemTexts(repo).includes(TEXT.olderApproval(taken)));
  const refused = gitIn(repo.root, ['commit', '-q', '-m', 'merge side']);
  assert.ok(refused.stderr.startsWith(gateRefusal(repo, REASONS.olderApproval(taken))), refused.stderr);
  approve(repo);
  landed(repo, 'merge side');
  agreeLanded(repo);
});
