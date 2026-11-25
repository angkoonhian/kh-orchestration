// Test-only fixture for the gate's tests: real repositories with kh-harness, the gate's hooks and
// bin/, and the install in the working tree. Installed code must never import this file.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_VERSION, installGate, installKhHarness, isolateProcessEnv, makeRepo, registerExtension, testEnv } from './test-repo.mjs';
import { digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { baseOf, currentBranch, indexTree } from '../../assets/scripts/ko-git.mjs';
import { writeState } from '../../assets/scripts/ko-state.mjs';
import { produceVerdict, writeVerdict } from '../../assets/scripts/ko-verdict.mjs';

isolateProcessEnv();
// The probe runs kh-harness's real hook: its session log and markers go to this run's directories.
const hookDirs = realpathSync(mkdtempSync(join(tmpdir(), 'ko-gate-hook-')));
process.env.KH_DATA_DIR = join(hookDirs, 'data');
process.env.HK_MARKER_DIR = join(hookDirs, 'markers');

export const repos = [];
after(() => {
  for (const repo of repos) repo.cleanup();
  rmSync(hookDirs, { recursive: true, force: true });
});

export const OFFICERS_PATH = '.claude/kh-orchestration/officers.json';
export const officersFile = (ids = ['check'], baseBranch = 'main') => `${JSON.stringify({
  schema: 1, baseBranch, protected: [], officers: ids.map((id) => ({ id, rule: null, argv: ['node', 'tools/check.mjs'], appliesTo: ['**'] })),
}, null, 2)}\n`;
// The one officer: fails while fail.txt is in the working tree.
export const CHECK = "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('fail.txt') ? 1 : 0);\n";

// A repository with kh-harness, the gate's hooks and bin/, and the install in the working
// tree, everything staged and nothing committed since the initial commit.
export function installed({ baseBranch = 'main', officers = officersFile() } = {}) {
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

export const stage = (repo) => assert.equal(repo.git('add', '-A').status, 0);
export const head = (root) => spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: testEnv(), encoding: 'utf8' }).stdout.trim();
export const headOrNull = (root) => {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', 'HEAD'], { cwd: root, env: testEnv(), encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
};

// What the gate sees for the index of `root`: its tree, its base and its branch.
export function subject(root, baseBranch = 'main') {
  return { tree: indexTree(root), base: baseOf(root, baseBranch), branch: currentBranch(root) };
}

export const approve = (root, digest) => writeState(root, 'approvals.json', { digests: [{ digest, approvedAt: '2026-11-26T00:00:00.000Z', branch: 'main' }] });
export const approveTree = (root, tree) => approve(root, digestOfTree(root, tree).digest);

// Runs the officers on the staged tree, as `run` does, and approves its digest.
export async function runAndApprove(root, baseBranch = 'main') {
  const at = subject(root, baseBranch);
  const produced = await produceVerdict(root, { ...at, waivers: [], kitVersion: KIT_VERSION });
  assert.equal(produced.problem, undefined);
  writeVerdict(root, produced.verdict);
  approve(root, produced.verdict.digest);
  return at;
}

export const gitIn = (root, argv, env = testEnv()) => spawnSync('git', argv, { cwd: root, env, encoding: 'utf8' });
export const commit = (root, ...argv) => gitIn(root, ['commit', '-q', '-m', 'work', ...argv]);
