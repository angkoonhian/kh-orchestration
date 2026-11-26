// apply --yes killed after each of its writes (Task 9 and its review): on a fresh install and on an
// upgrade from an older kit's install. After every kill, kh-harness's real hook still lets a
// harmless tool call through, a fresh apply completes the install, and uninstall --state, run on a
// copy of the same killed state, leaves the repository as it was before the install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyPlan, applyUninstall, plan, uninstallPlan } from './install.mjs';
import { ageInstall, copyOf, fresh, harnessAllowsRead, hooksDir, installState, killedAfter, listing, porcelain } from './install-fixture.mjs';

// Kills a run after each write of what `prepare` leaves in a fresh repository, and checks each killed state.
function killEach(prepare) {
  const base = fresh();
  const before = { tree: porcelain(base.root), hooks: listing(hooksDir(base.root)) };
  prepare(base.root);
  const expected = copyOf(base.root);
  const total = killedAfter(expected, undefined);
  assert.ok(total > 20, `a whole run makes ${total} writes`);
  const finished = installState(expected);
  for (let count = 1; count <= total; count += 1) {
    const repo = copyOf(base.root);
    killedAfter(repo, count);
    const other = copyOf(repo);
    assert.ok(harnessAllowsRead(repo), `after write ${count}: kh-harness lets a Read through`);

    const completed = plan(repo);
    assert.deepEqual([completed.refusals, completed.conflicts], [[], []], `after write ${count}`);
    assert.equal(applyPlan(repo, completed).refusal, null, `after write ${count}`);
    assert.deepEqual(plan(repo).actions, [], `after write ${count}: apply completed it`);
    assert.deepEqual(installState(repo), finished, `after write ${count}`);

    const uninstalled = uninstallPlan(other, { state: true });
    assert.deepEqual([uninstalled.refusals, uninstalled.kept], [[], []], `after write ${count}`);
    applyUninstall(other, uninstalled);
    assert.equal(porcelain(other), before.tree, `after write ${count}: uninstall leaves the tree as it was`);
    assert.deepEqual(listing(hooksDir(other)), before.hooks, `after write ${count}`);
    assert.equal(existsSync(join(other, '.git', 'kh-orchestration')), false, `after write ${count}`);
    rmSync(join(repo, '..'), { recursive: true, force: true });
    rmSync(join(other, '..'), { recursive: true, force: true });
  }
}

test('a kill after each write of a fresh apply --yes leaves a state that apply completes and that uninstall --state cleans', () => {
  killEach(() => {});
});

test('a kill after each write of an upgrade from an older kit never makes kh-harness block a tool call, and apply completes it and uninstall cleans it (after Task 9\'s review)', () => {
  killEach((root) => {
    assert.equal(applyPlan(root, plan(root)).refusal, null);
    ageInstall(root);
    assert.ok(harnessAllowsRead(root), 'fixture: the older install lets a Read through');
  });
});
