// Opt-in (npm run test:slow): the real index race, a background `git add` during `git commit`, over
// delays across and just beyond the gate's duration. The deterministic racing pre-commit test in
// scripts/lib/gate.test.mjs proves the mechanism; this shows it under real timing. Its assertion
// holds whatever the timing: no run ends with a HEAD whose tree the officers did not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { testEnv } from '../lib/test-repo.mjs';
import { commit, gitIn, installed, runAndApprove } from '../lib/gate-fixture.mjs';

test('the real race: a background git add during git commit never lands a HEAD whose tree has no passing verdict (41 runs)', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'race']).status, 0);
  const judged = new Set([gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim()]);
  for (let step = 0; step <= 40; step += 1) {
    const delay = (step * 0.005).toFixed(3);
    repo.write(`n${step}.txt`, 'ok\n');
    assert.equal(gitIn(repo.root, ['add', `n${step}.txt`]).status, 0);
    repo.write('evil.txt', `evil ${delay}\n`);
    judged.add((await runAndApprove(repo.root)).tree);
    spawnSync('sh', ['-c', `(sleep ${delay}; git add evil.txt 2>/dev/null) & git commit -q -m "n${step}" 2>/dev/null; wait`], { cwd: repo.root, env: testEnv() });
    const landed = gitIn(repo.root, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
    assert.ok(judged.has(landed), `delay ${delay}: HEAD's tree ${landed} has no verdict`);
    gitIn(repo.root, ['rm', '-q', '--cached', '--ignore-unmatch', 'evil.txt']);
  }
});
