// Test-only helper: builds real git repositories in temporary directories.
// Installed code must never import this file.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const KIT_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version;

function khHarnessDir() {
  return process.env.KH_HARNESS_DIR || resolve(REPO_ROOT, '..', 'kh-harness');
}

export const KH_HARNESS_DIR = khHarnessDir();

export const siblingAbsentMessage = (dir) =>
  `kh-harness was not found at ${dir}. Check out kh-harness 0.3.0 or later there, or set KH_HARNESS_DIR to its directory.`;

// A session's shell carries these; a test is not a session unless it says so.
function cleanEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SESSION_ID;
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  return env;
}

function run(file, argv, cwd) {
  const result = spawnSync(file, argv, { cwd, env: cleanEnv(), encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function makeRepo({ baseBranch = 'main', files = {} } = {}) {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'ko-test-')));
  const root = join(container, 'repo');
  mkdirSync(root);
  const git = (...argv) => run('git', argv, root);
  const write = (path, text) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const commitAll = (message) => {
    git('add', '-A');
    const result = git('commit', '-q', '--allow-empty', '-m', message);
    if (result.status !== 0) throw new Error(`git commit failed: ${result.stderr}`);
  };
  const addWorktree = (branch) => {
    const path = join(container, `worktree-${branch.replaceAll('/', '-')}`);
    const result = git('worktree', 'add', '-q', '-b', branch, path);
    if (result.status !== 0) throw new Error(`git worktree add failed: ${result.stderr}`);
    return path;
  };
  const cleanup = () => rmSync(container, { recursive: true, force: true });

  git('init', '-q', '-b', baseBranch);
  git('config', '--local', 'user.name', 'Test Owner');
  git('config', '--local', 'user.email', 'owner@example.invalid');
  git('config', '--local', 'commit.gpgsign', 'false');
  git('config', '--local', '--unset-all', 'core.hooksPath');
  for (const [path, text] of Object.entries(files)) write(path, text);
  commitAll('initial commit');
  return { root, git, write, commitAll, addWorktree, cleanup };
}

// One run converges: a second run reports nothing left to write.
export function installKhHarness(root) {
  const dir = khHarnessDir();
  const script = join(dir, 'scripts', 'apply.mjs');
  if (!existsSync(script)) throw new Error(siblingAbsentMessage(dir));
  const result = run('node', [script, root, '--yes', '--allow-default-branch'], root);
  if (result.status !== 0) throw new Error(`kh-harness apply failed (${result.status}): ${result.stderr}`);
}
