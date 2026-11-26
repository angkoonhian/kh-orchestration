// Opt-in (npm run test:slow): the reviewer's L2 race. While git commit runs, the working copy of
// kh-harness's entry script is swapped for one that drops a marker, then swapped back. The gate's
// probe runs a private copy of the approved tree, so the working copy is never executed by the
// gate, whatever the timing: the marker must never appear (a run may refuse or land).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { testEnv } from '../lib/test-repo.mjs';
import { commit, gitIn, installed, runAndApprove } from '../lib/gate-fixture.mjs';

test('a working entry script swapped in while the gate runs is never executed by it (40 runs)', async () => {
  const repo = installed();
  await runAndApprove(repo.root);
  assert.equal(commit(repo.root).status, 0);
  assert.equal(gitIn(repo.root, ['switch', '-q', '-c', 'swap']).status, 0);
  const dispatcher = join(repo.root, '.claude/scripts/dispatch-pre-tool.mjs');
  const original = readFileSync(dispatcher);
  const marker = join(repo.root, '..', 'swapped-dispatcher-ran');
  const evil = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\n`;
  const put = (bytes) => {
    writeFileSync(`${dispatcher}.swap`, bytes);
    renameSync(`${dispatcher}.swap`, dispatcher);
  };
  for (let run = 0; run < 40; run += 1) {
    repo.write(`s${run}.txt`, 'x\n');
    assert.equal(gitIn(repo.root, ['add', `s${run}.txt`]).status, 0);
    await runAndApprove(repo.root);
    const child = spawn('git', ['commit', '-q', '-m', `s${run}`], { cwd: repo.root, env: testEnv(), stdio: 'ignore' });
    const closed = new Promise((resolve) => child.on('close', resolve));
    await new Promise((resolve) => setTimeout(resolve, 20 + run * 4));
    put(evil);
    await new Promise((resolve) => setTimeout(resolve, 40));
    put(original);
    await closed;
    assert.equal(existsSync(marker), false, `run ${run}: the gate executed the swapped working copy`);
  }
});
