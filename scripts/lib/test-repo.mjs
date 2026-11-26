// Test-only helper: builds real git repositories in temporary directories.
// Installed code must never import this file.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_NAMES, hookText } from '../../assets/scripts/ko-hooks.mjs';
import { ownEntry } from '../../assets/scripts/ko-contract.mjs';
import { KIT_VERSION, envPath, shippedScripts } from './install.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export { KIT_VERSION };

function khHarnessDir() {
  return process.env.KH_HARNESS_DIR || resolve(REPO_ROOT, '..', 'kh-harness');
}

export const KH_HARNESS_DIR = khHarnessDir();

export const siblingAbsentMessage = (dir) =>
  `kh-harness was not found at ${dir}. Check out kh-harness 0.3.0 or later there, or set KH_HARNESS_DIR to its directory.`;

export const spawnFailedMessage = (file) => `${file} could not be started.`;

const DROPPED = /^(GIT_AUTHOR_|GIT_COMMITTER_|GIT_CONFIG_KEY_|GIT_CONFIG_VALUE_)/;
const SCRUBBED = [
  'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
  'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_EDITOR', 'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT',
];

function scrub(env) {
  for (const name of Object.keys(env)) {
    if (DROPPED.test(name)) delete env[name];
  }
  for (const name of SCRUBBED) delete env[name];
  return env;
}

// The environment every test command runs in: no session markers, no identity,
// no injected git configuration, and no prompt. Tests that spawn an installed
// command directly, not through repo.git, pass this as its env.
export function testEnv() {
  return { ...scrub({ ...process.env }), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
}

// Installed modules take the caller's git environment (a hook's GIT_DIR and
// GIT_INDEX_FILE), so a test that calls them in-process clears this process's
// copy first. Call it once at the top of such a test file.
export function isolateProcessEnv() {
  scrub(process.env);
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

export const EXTENSION_MODULE = '.claude/kh-orchestration/scripts/extension.mjs';
const INSTALLED_SCRIPTS = '.claude/kh-orchestration/scripts';

// A script of assets/scripts as apply installs it (the installer's shippedScripts): the stamp line
// of decision 2, then the file.
export function installedScript(name) {
  return shippedScripts().find((script) => script.name === name).bytes.toString('utf8');
}

function gitCommonDir(root) {
  const result = run('git', ['rev-parse', '--git-common-dir'], root);
  if (result.status !== 0) throw new Error(`git rev-parse failed: ${result.stderr}`);
  return realpathSync(resolve(root, result.stdout.replace(/\n$/, '')));
}

// Test-only fixture for the gate's tests, thinner than apply (no manifest, no pre-flight, any
// `node`): the installer's shipped scripts into <common-dir>/kh-orchestration/bin/ (and into the
// working tree's .claude/kh-orchestration/scripts/ with `inTree`), and the three git hooks into
// <common-dir>/hooks/ as ko-hooks.mjs writes them, naming the installer's `env` and `node` by
// absolute path.
export function installGate(root, { inTree = false, node = process.execPath } = {}) {
  const env = envPath();
  const common = gitCommonDir(root);
  const bin = join(common, 'kh-orchestration', 'bin');
  mkdirSync(bin, { recursive: true });
  if (inTree) mkdirSync(join(root, INSTALLED_SCRIPTS), { recursive: true });
  for (const { name, bytes } of shippedScripts()) {
    writeFileSync(join(bin, name), bytes);
    if (inTree) writeFileSync(join(root, INSTALLED_SCRIPTS, name), bytes);
  }
  mkdirSync(join(common, 'hooks'), { recursive: true });
  for (const hook of HOOK_NAMES) {
    const path = join(common, 'hooks', hook);
    writeFileSync(path, hookText(hook, { env, node, version: KIT_VERSION }));
    chmodSync(path, 0o755);
  }
  return { bin };
}

// Installs the stamped extension at EXTENSION_MODULE and registers it, alone, in a kh-harness
// install's extensions file (the entry ko-contract's ownEntry builds), written whole to a
// temporary file in .claude/kh-harness/ and renamed. Returns the entry written.
export function registerExtension(root) {
  const module = join(root, EXTENSION_MODULE);
  mkdirSync(dirname(module), { recursive: true });
  writeFileSync(module, installedScript('extension.mjs'));
  const entry = ownEntry(root);
  const temporary = join(root, '.claude/kh-harness/extensions.json.tmp');
  writeFileSync(temporary, `${JSON.stringify([entry], null, 2)}\n`);
  renameSync(temporary, join(root, '.claude/kh-harness/extensions.json'));
  return entry;
}
