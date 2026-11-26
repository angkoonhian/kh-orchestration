// Test-only fixture for the installer's in-process tests (install.test.mjs, install-kill.test.mjs):
// real repositories with kh-harness installed and committed, listings to compare runs, an older
// kit's install, and a kill after the nth write. Installed code must never import this file.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_VERSION, installKhHarness, isolateProcessEnv, makeRepo, testEnv } from './test-repo.mjs';
import { EXTENSIONS_PATH, SCRIPTS_DIR, SCRIPT_NAMES, applyPlan, plan, shippedScripts } from './install.mjs';
import { MANIFEST_PATH, readManifest } from './manifest.mjs';
import { lfSha256 } from '../../assets/scripts/verify-contract-1.mjs';
import { stateDir } from '../../assets/scripts/ko-state.mjs';

isolateProcessEnv();
// The in-process calls run git with this process's environment: no user or system configuration.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
// kh-harness's hook, when a test runs it, logs into this run's directories.
const hookDirs = realpathSync(mkdtempSync(join(tmpdir(), 'ko-install-hook-')));
process.env.KH_DATA_DIR = join(hookDirs, 'data');
process.env.HK_MARKER_DIR = join(hookDirs, 'markers');
export const repos = [];
export const scratch = [hookDirs];
after(() => {
  for (const repo of repos) repo.cleanup();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// A repository with kh-harness installed and committed, as an owner has it before installing kh-orchestration.
export function fresh({ baseBranch = 'main', files = {} } = {}) {
  const repo = makeRepo({ baseBranch, files });
  repos.push(repo);
  installKhHarness(repo.root);
  repo.commitAll('kh-harness');
  return repo;
}
export const hooksDir = (root) => join(root, '.git', 'hooks');
export const read = (root, path) => readFileSync(join(root, path), 'utf8');
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const entryOf = () => {
  const bytes = shippedScripts().find((script) => script.name === 'extension.mjs').bytes;
  return { id: 'kh-orchestration', version: KIT_VERSION, module: `${SCRIPTS_DIR}/extension.mjs`, sha256: lfSha256(bytes), onFailure: 'block' };
};

// Everything under `dir` and its bytes, so a run can be shown to have written nothing.
export function listing(dir) {
  if (!existsSync(dir)) return {};
  const walk = (relative) => readdirSync(join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) return [[`${path}/`, ''], ...walk(path)];
    const stat = lstatSync(join(dir, path));
    return [[path, `${(stat.mode & 0o777).toString(8)} ${entry.isSymbolicLink() ? 'link' : sha256(readFileSync(join(dir, path)))}`]];
  });
  return Object.fromEntries(walk(''));
}
export const everything = (root) => ({ tree: listing(root), common: listing(join(root, '.git')) });
export const porcelain = (root) => spawnSync('git', ['status', '--porcelain', '-uall'], { cwd: root, env: testEnv(), encoding: 'utf8' }).stdout;

// Leaves an install as another kit (`version`, by default an older 0.0.9) would have: every
// script stamped with that version and other bytes and recorded as written so, and the extension
// entry naming that module, changed in the extensions file where it stands.
export function ageInstall(root, version = '0.0.9') {
  const manifest = readManifest(root).manifest;
  for (const name of SCRIPT_NAMES) {
    const path = join(root, SCRIPTS_DIR, name);
    const older = readFileSync(path, 'utf8').replace(`kh-orchestration ${KIT_VERSION}.`, `kh-orchestration ${version}.`);
    writeFileSync(path, `${older}// ${version}\n`);
    manifest.files.find((file) => file.path === `${SCRIPTS_DIR}/${name}`).sha256 = sha256(readFileSync(path));
  }
  const oldEntry = { ...entryOf(), version, sha256: lfSha256(readFileSync(join(root, SCRIPTS_DIR, 'extension.mjs'))) };
  const extensions = join(root, EXTENSIONS_PATH);
  writeFileSync(extensions, readFileSync(extensions, 'utf8').replace(entryOf().sha256, oldEntry.sha256).replace(new RegExp(`("version":\\s*)"${KIT_VERSION.replaceAll('.', '\\.')}"`), `$1"${version}"`));
  manifest.extensionEntry.sha256 = oldEntry.sha256;
  manifest.kitVersion = version;
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  return oldEntry;
}

// What an install leaves, the manifest's installation time aside, to compare two runs.
export function installState(root) {
  const { installedAt, ...manifest } = readManifest(root).manifest;
  const tree = listing(join(root, '.claude/kh-orchestration'));
  return { tree, extensions: read(root, EXTENSIONS_PATH), manifest, hooks: listing(hooksDir(root)), bin: listing(join(stateDir(root), 'bin')), attributes: read(root, '.gitattributes') };
}

// A run of apply stopped right after its nth write (`onWrite` throws and nothing after it runs, as
// when the process is killed); without `count`, the number of writes a whole run makes.
const KILLED = 'killed here';
export function killedAfter(root, count) {
  let writes = 0;
  const onWrite = () => {
    writes += 1;
    if (writes === count) throw new Error(KILLED);
  };
  if (count === undefined) {
    applyPlan(root, plan(root), { onWrite });
    return writes;
  }
  assert.throws(() => applyPlan(root, plan(root), { onWrite }), { message: KILLED });
  return count;
}

// A copy of the repository at `root` (its .git inside it), in a new scratch directory.
export function copyOf(root) {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'ko-killed-')));
  scratch.push(container);
  cpSync(root, join(container, 'repo'), { recursive: true, verbatimSymlinks: true });
  return join(container, 'repo');
}

// Whether kh-harness's real PreToolUse hook in `root` lets a harmless Read through: an install left
// half-way must never lock the session out of every tool call.
export function harnessAllowsRead(root) {
  const input = JSON.stringify({ session_id: 'ko-test', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(root, 'README.md') }, tool_use_id: 'ko-test' });
  const result = spawnSync(process.execPath, [join(root, '.claude/scripts/dispatch-pre-tool.mjs')], { cwd: root, input, encoding: 'utf8', env: { ...testEnv(), KH_DATA_DIR: process.env.KH_DATA_DIR, HK_MARKER_DIR: process.env.HK_MARKER_DIR, CLAUDE_PROJECT_DIR: root } });
  return result.status === 0 && !result.stdout.includes('"permissionDecision":"deny"');
}
