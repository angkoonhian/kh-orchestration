// kh-orchestration's record of what its installer wrote in a repository (Task 9):
// `.claude/kh-orchestration.manifest.json`, kept beside kh-harness's own manifest and never
// mixed with it. `apply` rewrites it after each of its writes, so a run killed at any point leaves
// a record of what exists; `uninstall` removes only what it records, and the manifest last.
//
// The shape, schema 1:
//   { schema: 1, kitVersion, installedAt,
//     files: [{ path, sha256 }],             each file apply wrote, the SHA-256 of the bytes written
//     patches: [{ file, kind, detail }],     each patch: the .gitattributes line and how it was added
//     extensionEntry: { id, sha256 } | null, the entry in kh-harness's extensions file, by its sha256
//     gitHooks: [{ name, sha256 }],          each git hook written into <git-common-dir>/hooks/
//     stateDir: boolean }                    whether apply made the shared state directory
// A manifest that is not of this shape, or that records a path or a hook apply never writes, is
// refused as corrupt: the file is in the repository, so anyone can edit it, and uninstall must
// never be led to remove a file that is not kh-orchestration's.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { EXTENSION_ID } from '../../assets/scripts/ko-contract.mjs';
import { HOOK_NAMES } from '../../assets/scripts/ko-hooks.mjs';

export const MANIFEST_PATH = '.claude/kh-orchestration.manifest.json';
// What the installer writes, which is all a manifest may record.
export const SCRIPTS_DIR = '.claude/kh-orchestration/scripts';
// Decision 2's files, and ko-cli.mjs and ko-hooks.mjs, added by Task 7.
export const SCRIPT_NAMES = Object.freeze([
  'ko.mjs', 'ko-cli.mjs', 'gate.mjs', 'ko-gate.mjs', 'ko-git.mjs', 'ko-state.mjs', 'ko-registry.mjs', 'ko-digest.mjs', 'ko-officers.mjs', 'ko-verdict.mjs',
  'ko-contract.mjs', 'ko-hooks.mjs', 'extension.mjs', 'verify-contract-1.mjs',
]);
export const OFFICERS_PATH = '.claude/kh-orchestration/officers.json';
export const ATTRIBUTES_FILE = '.gitattributes';
// The gate compares the live .claude files with the tree byte for byte, so git must check them out as they are.
export const ATTRIBUTES_LINE = '.claude/** -text';
// How the line was added: in a file apply created, after the file's final newline, or after a newline apply added.
const PATCH_KINDS = Object.freeze(['create', 'append', 'append-after-newline']);
// The paths a manifest may record, in the order it records them.
export const RECORDED_PATHS = Object.freeze([...SCRIPT_NAMES.map((name) => `${SCRIPTS_DIR}/${name}`), OFFICERS_PATH]);
const KNOWN = {
  paths: RECORDED_PATHS,
  patchFile: ATTRIBUTES_FILE,
  patchKinds: PATCH_KINDS,
  patchDetail: ATTRIBUTES_LINE,
  extensionId: EXTENSION_ID,
  hooks: HOOK_NAMES,
};
const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const KEYS = ['schema', 'kitVersion', 'installedAt', 'files', 'patches', 'extensionEntry', 'gitHooks', 'stateDir'];

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const emptyManifest = (kitVersion) => ({
  schema: 1, kitVersion, installedAt: new Date().toISOString(), files: [], patches: [], extensionEntry: null, gitHooks: [], stateDir: false,
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isHash = (value) => typeof value === 'string' && SHA256.test(value);

// Whether `value` is a manifest this installer writes: a record of anything it does not write is
// not one of its own.
function isManifest(value) {
  const known = KNOWN;
  return hasExactKeys(value, KEYS) && value.schema === 1
    && typeof value.kitVersion === 'string' && typeof value.installedAt === 'string'
    && Array.isArray(value.files) && value.files.every((file) => hasExactKeys(file, ['path', 'sha256']) && known.paths.includes(file.path) && isHash(file.sha256))
    && new Set(value.files.map((file) => file.path)).size === value.files.length
    && Array.isArray(value.patches) && value.patches.length <= 1
    && value.patches.every((patch) => hasExactKeys(patch, ['file', 'kind', 'detail']) && patch.file === known.patchFile && known.patchKinds.includes(patch.kind) && patch.detail === known.patchDetail)
    && (value.extensionEntry === null || (hasExactKeys(value.extensionEntry, ['id', 'sha256']) && value.extensionEntry.id === known.extensionId && isHash(value.extensionEntry.sha256)))
    && Array.isArray(value.gitHooks) && value.gitHooks.every((hook) => hasExactKeys(hook, ['name', 'sha256']) && known.hooks.includes(hook.name) && isHash(hook.sha256))
    && new Set(value.gitHooks.map((hook) => hook.name)).size === value.gitHooks.length
    && typeof value.stateDir === 'boolean';
}

/**
 * The bytes of the regular file at `path`, read through one descriptor that does not follow a
 * link at it, at most `max` bytes: `{ bytes }`, `{ absent: true }` when nothing is there, or
 * `{ unusable: true }` for a link, a directory, a file over `max` or one that cannot be read.
 */
export function readRegular(path, max) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    return error.code === 'ENOENT' ? { absent: true } : { unusable: true };
  }
  if (!stat.isFile()) return { unusable: true };
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > max) return { unusable: true };
    const bytes = Buffer.alloc(opened.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return { bytes: bytes.subarray(0, read), mode: opened.mode & 0o777 };
  } catch {
    return { unusable: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The manifest in `root`: `{ state: 'absent' }`, `{ state: 'corrupt' }` (there, but not one this
 * installer wrote), or `{ state: 'ok', manifest }`.
 */
export function readManifest(root) {
  const file = readRegular(join(root, MANIFEST_PATH), MAX_MANIFEST_BYTES);
  if (file.absent) return { state: 'absent' };
  if (file.unusable) return { state: 'corrupt' };
  let value;
  try {
    value = JSON.parse(file.bytes.toString('utf8'));
  } catch {
    return { state: 'corrupt' };
  }
  return isManifest(value) ? { state: 'ok', manifest: value } : { state: 'corrupt' };
}

// What a write killed between its two steps leaves beside its target; removed by the next write of
// that target, and nothing else is ever named so.
const leftover = (name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.ko-[0-9]+-[0-9a-f-]+\\.tmp$`);

/**
 * Replaces the file at `path` with `bytes`, whole: written to a temporary file beside it, given
 * `mode`, and renamed over it, so a reader, or a run killed at any moment, finds the old file or
 * the new one and never part of one. Never writes through a link: a link at `path` is replaced. The
 * directory must exist. Throws what the file system throws, with the temporary file removed.
 */
export function writeWhole(path, bytes, mode) {
  const dir = dirname(path);
  const name = basename(path);
  const pattern = leftover(name);
  for (const entry of readdirSync(dir)) {
    if (pattern.test(entry)) rmSync(join(dir, entry), { force: true });
  }
  const temporary = join(dir, `${name}.ko-${process.pid}-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: 'wx', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

// The manifest's text: JSON with two-space indentation and one final newline.
const manifestText = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;

export function writeManifest(root, manifest) {
  writeWhole(join(root, MANIFEST_PATH), manifestText(manifest), 0o644);
}
