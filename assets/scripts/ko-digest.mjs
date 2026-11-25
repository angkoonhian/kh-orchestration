// The digest: one hash over the files that decide what "passing" means
// (decision 11). It is built from one listing of a tree object, never from the
// working directory or the index, so it is the same from any worktree.
import { createHash } from 'node:crypto';
import { listEntries, notBlobMessage, readBlob } from './ko-git.mjs';
import { parseRegistry, canonicalRegistry, coveredPart } from './ko-registry.mjs';
import { PROTECTED_FILES, PROTECTED_PREFIXES, matchesGlob, readOfficers } from './extension.mjs';

const RULES = 'docs/harness/RULES.md';
const OFFICERS = '.claude/kh-orchestration/officers.json';
const SYMLINK = '120000';
const GITLINK = '160000';

export const treeNotIdMessage = 'The tree is not a full object id of 40 or 64 hexadecimal digits.';
export const invalidRulesMessage = (line, text) => `${RULES} line ${line}: ${text}`;
export const notUtf8Message = `${RULES} is not valid UTF-8.`;
export const officersUnreadableMessage = `${OFFICERS} is absent from the tree or is not an officers file.`;
export const readFailedMessage = (reason) => `The protected files could not be read: ${reason}`;
export const linkMessage = (path) => `${path} is a symbolic link or a submodule, and a link may not stand at, above or under a protected file.`;
export const directoryMessage = (id, element) => `The officer ${id} names the directory ${element}: name the file, or add a glob to "protected" in ${OFFICERS}.`;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Throws when the bytes are not valid UTF-8. A byte-order mark is kept, so it is part of the text.
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

// `a/b/c` gives `a`, `a/b` and `a/b/c`.
const ancestorsAndSelf = (path) => path.split('/').map((_, index, segments) => segments.slice(0, index + 1).join('/'));

/**
 * `{ digest, paths }` for a tree, or `{ problem }` (fixed text) when the digest
 * cannot be trusted. `tree` must be a full object id. The canonical text is
 * one line `path NUL object-id NEWLINE` for each covered file, sorted by path
 * in plain UTF-16 code-unit order; `docs/harness/RULES.md` contributes the
 * SHA-256 of its canonical registry form in place of its object id. Covered
 * files are the protected files, every file under a protected prefix, every
 * file matching a `protected` glob, and every officer script (an argv element
 * that names a file in the tree). A symlink or submodule at, above or under a
 * covered path is a problem: nothing that decides a check is reached through
 * a link. A failed read is a problem too, never a digest that omits a file.
 */
export function digestOfTree(root, tree) {
  if (!OBJECT_ID.test(tree)) return { problem: treeNotIdMessage };
  try {
    return compute(root, tree);
  } catch (error) {
    return { problem: readFailedMessage(error.message) };
  }
}

function compute(root, tree) {
  const entries = listEntries(root, tree);
  const files = new Map(entries.filter((entry) => entry.type === 'blob' && entry.mode !== SYMLINK).map((entry) => [entry.path, entry]));
  const linkPaths = new Set(entries.filter((entry) => entry.mode === SYMLINK || entry.mode === GITLINK).map((entry) => entry.path));

  const linkedOfficers = ancestorsAndSelf(OFFICERS).find((path) => linkPaths.has(path));
  if (linkedOfficers !== undefined) return { problem: linkMessage(linkedOfficers) };
  const officersBytes = readBlob(root, tree, OFFICERS);
  let officers = null;
  if (officersBytes !== null) {
    try {
      officers = readOfficers(decode(officersBytes));
    } catch {
      // not UTF-8: officers stays null
    }
  }
  if (officers === null) return { problem: officersUnreadableMessage };

  const { officerCandidates, protectedGlobs } = officers;
  const underPrefix = (path) => PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix));
  const matchesProtectedGlob = (path) => protectedGlobs.some((glob) => matchesGlob(glob, path));

  // A path that is a directory, not a file, in the tree.
  const isDirectory = (path) => !files.has(path) && !linkPaths.has(path) && entries.some((entry) => entry.path.startsWith(`${path}/`));
  for (const path of PROTECTED_FILES) {
    if (isDirectory(path)) return { problem: notBlobMessage(path) };
  }
  for (const candidate of officerCandidates) {
    if (isDirectory(candidate.path)) return { problem: directoryMessage(candidate.id, candidate.element) };
  }

  const reachedThrough = [...PROTECTED_FILES, ...PROTECTED_PREFIXES.map((prefix) => prefix.slice(0, -1)), ...officerCandidates.map((candidate) => candidate.path)];
  const hidden = reachedThrough.flatMap(ancestorsAndSelf).find((path) => linkPaths.has(path));
  if (hidden !== undefined) return { problem: linkMessage(hidden) };
  const covered = [...linkPaths].find((path) => underPrefix(path) || matchesProtectedGlob(path));
  if (covered !== undefined) return { problem: linkMessage(covered) };

  const scripts = new Set(officerCandidates.map((candidate) => candidate.path));
  const paths = [...files.keys()]
    .filter((path) => PROTECTED_FILES.includes(path) || underPrefix(path) || matchesProtectedGlob(path) || scripts.has(path))
    .sort();
  let canonical = '';
  for (const path of paths) {
    let id = files.get(path).oid;
    if (path === RULES) {
      let text;
      try {
        text = decode(readBlob(root, tree, path));
      } catch {
        return { problem: notUtf8Message };
      }
      const parsed = parseRegistry(text);
      if (parsed.problems.length > 0) return { problem: invalidRulesMessage(parsed.problems[0].line, parsed.problems[0].text) };
      id = sha256(canonicalRegistry(parsed));
    }
    canonical += `${path}\0${id}\n`;
  }
  return { digest: sha256(canonical), paths };
}

// The rules of a tree's RULES.md by id; empty when the file is absent.
function rulesOf(root, tree) {
  const bytes = readBlob(root, tree, RULES);
  return new Map(bytes === null ? [] : parseRegistry(decode(bytes)).rules.map((rule) => [rule.id, rule]));
}

/**
 * The rules whose only change since `baseTree` is in their free wording: those
 * that are agent rules in both trees, whose block text differs and whose
 * covered part (everything but the free parts) is identical. Anything else
 * that changed, a rule added or removed, an owner rule edited, an agent rule's
 * covered line changed, changes the digest, so it is the owner's to approve
 * and is not listed. No base tree, no changes. A read that fails throws, so
 * the caller must refuse on a throw, never treat it as no changes.
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
