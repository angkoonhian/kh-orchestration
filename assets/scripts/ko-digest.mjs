// The digest: one hash over the files that decide what "passing" means
// (decision 11). It is built from one listing of a tree object, never from the
// working directory or the index, so it is the same from any worktree.
import { createHash } from 'node:crypto';
import { listEntries, notBlobMessage, readBlob } from './ko-git.mjs';
import { parseRegistry, canonicalRegistry, coveredPart } from './ko-registry.mjs';
import { PROTECTED_FILES, PROTECTED_PREFIXES, matchesGlob, readOfficers } from './extension.mjs';

const RULES = 'docs/harness/RULES.md';
export const OFFICERS = '.claude/kh-orchestration/officers.json';
const SYMLINK = '120000';
const GITLINK = '160000';

export const treeNotIdMessage = 'The tree is not a full object id of 40 or 64 hexadecimal digits.';
export const invalidRulesMessage = (line, text) => `${RULES} line ${line}: ${text}`;
export const notUtf8Message = `${RULES} is not valid UTF-8.`;
export const officersUnreadableMessage = `${OFFICERS} is absent from the tree or is not an officers file.`;
export const readFailedMessage = (reason) => `The protected files could not be read: ${reason}`;
export const linkMessage = (path) => `${path} is a symbolic link or a submodule, and a link may not stand at, above or under a protected file.`;
export const globDirectoryMessage = (glob) => `The protected glob ${glob} names a directory and matches no file: write ${glob}/** in ${OFFICERS}.`;
export const objectMismatchMessage = (path) => `The bytes of ${path} do not hash to its object id, so the object is damaged or forged.`;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Whether a string is a full object id: 40 or 64 lower-case hexadecimal digits.
export const isFullObjectId = (text) => OBJECT_ID.test(text);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Throws when the bytes are not valid UTF-8. A byte-order mark is kept, so it is part of the text.
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

// Whether bytes are the blob an object id names: the id is the hash of `blob <length> NUL` and the bytes.
// git does not check a loose object against its name when it reads it.
export function hashesTo(oid, bytes) {
  const hash = createHash(oid.length === 64 ? 'sha256' : 'sha1');
  return hash.update(`blob ${bytes.length}\0`).update(bytes).digest('hex') === oid;
}

class ObjectMismatch extends Error {}

// The bytes of a listed blob, checked against its object id; throws a fixed message when they differ.
function readVerified(root, tree, entry) {
  const bytes = readBlob(root, tree, entry.path);
  if (!hashesTo(entry.oid, bytes)) throw new ObjectMismatch(objectMismatchMessage(entry.path));
  return bytes;
}

// `a/b/c` gives `a`, `a/b` and `a/b/c`.
const ancestorsAndSelf = (path) => path.split('/').map((_, index, segments) => segments.slice(0, index + 1).join('/'));

/**
 * The text of `officers.json` in a tree, read through the verified read, as
 * `{ text }`, or `{ problem }` (fixed text) when the file is absent, is not
 * reached as a plain file (a link at or above it), is not valid UTF-8, or its
 * bytes do not hash to the object id. A read that fails throws, so it is never
 * mistaken for an absent file. `entries` is `listEntries(root, tree)`.
 */
export function officersText(root, tree, entries) {
  const linked = ancestorsAndSelf(OFFICERS).find((path) => entries.some((entry) => entry.path === path && (entry.mode === SYMLINK || entry.mode === GITLINK)));
  if (linked !== undefined) return { problem: linkMessage(linked) };
  const entry = entries.find((candidate) => candidate.path === OFFICERS && candidate.type === 'blob');
  if (entry === undefined) return { problem: officersUnreadableMessage };
  let bytes;
  try {
    bytes = readVerified(root, tree, entry);
  } catch (error) {
    if (error instanceof ObjectMismatch) return { problem: error.message };
    throw error;
  }
  try {
    return { text: decode(bytes) };
  } catch {
    return { problem: officersUnreadableMessage };
  }
}

/**
 * `{ digest, paths }` for a tree, or `{ problem }` (fixed text) when the digest
 * cannot be trusted. `tree` must be a full object id. The canonical text is
 * one line `path NUL mode NUL object-id NEWLINE` for each covered file, sorted by path
 * in plain UTF-16 code-unit order; `docs/harness/RULES.md` contributes the
 * SHA-256 of its canonical registry form in place of its object id. Covered
 * files are the protected files, every file under a protected prefix, every
 * file matching a `protected` glob, and every officer script (an argv element
 * that names a file in the tree). A symlink or submodule at, above or under a
 * covered path is a problem: nothing that decides a check is reached through
 * a link. A failed read is a problem too, never a digest that omits a file.
 */
export function digestOfTree(root, tree) {
  if (!isFullObjectId(tree)) return { problem: treeNotIdMessage };
  try {
    return compute(root, tree);
  } catch (error) {
    return { problem: error instanceof ObjectMismatch ? error.message : readFailedMessage(error.message) };
  }
}

function compute(root, tree) {
  const entries = listEntries(root, tree);
  const files = new Map(entries.filter((entry) => entry.type === 'blob' && entry.mode !== SYMLINK).map((entry) => [entry.path, entry]));
  const linkPaths = new Set(entries.filter((entry) => entry.mode === SYMLINK || entry.mode === GITLINK).map((entry) => entry.path));

  const loaded = officersText(root, tree, entries);
  if (loaded.problem !== undefined) return loaded;
  const officers = readOfficers(loaded.text);
  if (officers === null) return { problem: officersUnreadableMessage };

  const { officerCandidates, protectedGlobs } = officers;
    const underPrefix = (path) => PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
  const matchesProtectedGlob = (path) => protectedGlobs.some((glob) => matchesGlob(glob, path));

  const directories = new Set(entries.flatMap((entry) => ancestorsAndSelf(entry.path).slice(0, -1)));
  for (const path of PROTECTED_FILES) {
    if (directories.has(path)) return { problem: notBlobMessage(path) };
  }
  for (const glob of protectedGlobs) {
    if (!/[*?]/.test(glob) && directories.has(glob)) return { problem: globDirectoryMessage(glob) };
  }

  const reachedThrough = [...PROTECTED_FILES, ...PROTECTED_PREFIXES.map((prefix) => prefix.slice(0, -1)), ...officerCandidates.map((candidate) => candidate.path)];
  const hidden = reachedThrough.flatMap(ancestorsAndSelf).find((path) => linkPaths.has(path));
  if (hidden !== undefined) return { problem: linkMessage(hidden) };
  const covered = [...linkPaths].find((path) => underPrefix(path) || matchesProtectedGlob(path) || protectedGlobs.some((glob) => hidesGlob(path, glob)));
  if (covered !== undefined) return { problem: linkMessage(covered) };

  const scripts = new Set(officerCandidates.map((candidate) => candidate.path));
  const paths = [...files.keys()]
    .filter((path) => PROTECTED_FILES.includes(path) || underPrefix(path) || matchesProtectedGlob(path) || scripts.has(path))
    .sort();
  let canonical = '';
  for (const path of paths) {
    const { mode, oid } = files.get(path);
    let id = oid;
    if (path === RULES) {
      const bytes = readVerified(root, tree, files.get(path));
      let text;
      try {
        text = decode(bytes);
      } catch {
        return { problem: notUtf8Message };
      }
      const parsed = parseRegistry(text);
      if (parsed.problems.length > 0) return { problem: invalidRulesMessage(parsed.problems[0].line, parsed.problems[0].text) };
      id = sha256(canonicalRegistry(parsed));
    }
    canonical += `${path}\0${mode}\0${id}\n`;
  }
  return { digest: sha256(canonical), paths };
}

// Whether a link at `link` stands on a glob's fixed part: equal to, or an ancestor of, the
// directories a glob names before its first `**`, each segment matched by the glob rules.
// Beyond a `**` nothing is fixed, so `**` + `/*.py` is hidden by no link.
function hidesGlob(link, glob) {
  const segments = glob.split('/');
  const firstWild = segments.findIndex((segment) => segment.includes('**'));
  const fixed = firstWild === -1 ? segments : segments.slice(0, firstWild);
  const linkSegments = link.split('/');
  return linkSegments.length <= fixed.length && linkSegments.every((segment, index) => matchesGlob(fixed[index], segment));
}

// The rules of a tree's RULES.md by id; empty when the file is absent.
function rulesOf(root, tree) {
  const entry = listEntries(root, tree).find((candidate) => candidate.path === RULES);
  if (entry === undefined) return new Map();
  if (entry.type !== 'blob' || entry.mode === SYMLINK) throw new Error(notBlobMessage(RULES));
  return new Map(parseRegistry(decode(readVerified(root, tree, entry))).rules.map((rule) => [rule.id, rule]));
}

/**
 * The rules whose only change since `baseTree` is in their free wording: those
 * that are agent rules in both trees, whose block text differs and whose
 * covered part (everything but the free parts) is identical. Anything else
 * that changed, a rule added or removed, an owner rule edited, an agent rule's
 * covered line changed, changes the digest, so it is the owner's to approve
 * and is not listed. No base tree, no changes. A read that fails, or bytes that do not hash to their
 * object id, throws a fixed message, so the caller must refuse on a throw, never treat it as no changes.
 */
export function agentRuleChanges(root, baseTree, tree) {
  if (baseTree === null) return [];
  const before = rulesOf(root, baseTree);
  const changes = [];
  for (const [id, rule] of rulesOf(root, tree)) {
    const earlier = before.get(id);
    if (earlier?.agent && rule.agent && earlier.block !== rule.block && coveredPart(earlier) === coveredPart(rule)) changes.push({ id, change: 'reworded' });
  }
  return changes;
}
