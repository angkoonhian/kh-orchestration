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

export const spawnFailedMessage = (file) => `${file} could not be started.`;

const DROPPED = /^(GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_)/;

// The environment every test command runs in: no session markers, no identity,
// no injected git configuration, and no prompt. Tests that spawn an installed
// command directly, not through repo.git, pass this as its env.
export function testEnv() {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const name of Object.keys(env)) {
    if (DROPPED.test(name)) delete env[name];
  }
  for (const name of [
    'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_EDITOR',
  ]) delete env[name];
  return env;
}

function run(file, argv, cwd) {
  const result = spawnSync(file, argv, { cwd, env: testEnv(), encoding: 'utf8' });
  if (result.error) throw new Error(spawnFailedMessage(file));
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

  try {
    const init = git('init', '-q', '-b', baseBranch);
    if (init.status !== 0) {
      throw new Error(`git init failed: ${init.stderr}`);
    }
    git('config', '--local', 'user.name', 'Test Owner');
    git('config', '--local', 'user.email', 'owner@example.invalid');
    git('config', '--local', 'commit.gpgsign', 'false');
    for (const [path, text] of Object.entries(files)) write(path, text);
    commitAll('initial commit');
  } catch (error) {
    cleanup();
    throw error;
  }
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
