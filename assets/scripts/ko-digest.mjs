// The digest: one hash over the files that decide what "passing" means
// (decision 11). It is built from a tree object only, never from the working
// directory or the index, so it is the same from any worktree.
import { createHash } from 'node:crypto';
import { listTree, readBlob } from './ko-git.mjs';
import { parseRegistry, canonicalRegistry } from './ko-registry.mjs';
import { PROTECTED_FILES, PROTECTED_PREFIXES, officerScriptsOf } from './extension.mjs';

const RULES = 'docs/harness/RULES.md';
const OFFICERS = '.claude/kh-orchestration/officers.json';

export const invalidRulesMessage = (line, text) => `${RULES} line ${line}: ${text}`;
export const notUtf8Message = `${RULES} is not valid UTF-8.`;
export const officersUnreadableMessage = `${OFFICERS} is absent from the tree or is not an officers file.`;
export const readFailedMessage = (reason) => `The protected files could not be read: ${reason}`;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Throws when the bytes are not valid UTF-8.
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

/**
 * `{ digest, paths }` for a tree, or `{ problem }` (fixed text) when the digest
 * cannot be trusted. The canonical text is one line `path NUL sha256 NEWLINE`
 * for each protected path present in the tree, sorted by path in plain
 * UTF-16 code-unit order. The hash is of the blob's bytes; a symlink is a blob
 * whose bytes are its target, so it is hashed as that. `RULES.md` contributes
 * the hash of its canonical form instead. Protected paths are the protected
 * files, every file under a protected prefix, and the officer scripts: the
 * files of the tree named in an officer's `argv`.
 */
export function digestOfTree(root, tree) {
  try {
    return compute(root, tree);
  } catch (error) {
    return { problem: readFailedMessage(error.message) };
  }
}

function compute(root, tree) {
  const officersBytes = readBlob(root, tree, OFFICERS);
  if (officersBytes === null) return { problem: officersUnreadableMessage };
  let candidates = null;
  try {
    candidates = officerScriptsOf(decode(officersBytes));
  } catch {
    // not UTF-8: candidates stays null
  }
  if (candidates === null) return { problem: officersUnreadableMessage };

  const inTree = new Set(listTree(root, tree, ''));
  // A protected file is read whether or not the listing names it, so a directory
  // or a submodule at its path is a failed read, not a file that is absent.
  const paths = new Set(PROTECTED_FILES);
  for (const path of inTree) {
    if (PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))) paths.add(path);
  }
  for (const script of candidates) {
    if (inTree.has(script)) paths.add(script);
  }

  const sorted = [...paths].sort();
  let canonical = '';
  const present = [];
  for (const path of sorted) {
    const bytes = readBlob(root, tree, path);
    if (bytes === null) continue; // a protected file absent from the tree contributes nothing
    present.push(path);
    let hash;
    if (path === RULES) {
      let text;
      try {
        text = decode(bytes);
      } catch {
        return { problem: notUtf8Message };
      }
      const parsed = parseRegistry(text);
      if (parsed.problems.length > 0) return { problem: invalidRulesMessage(parsed.problems[0].line, parsed.problems[0].text) };
      hash = sha256(canonicalRegistry(parsed));
    } else {
      hash = sha256(bytes);
    }
    canonical += `${path}\0${hash}\n`;
  }
  return { digest: sha256(canonical), paths: present };
}

// The rules of a tree's RULES.md by id; empty when the file is absent.
function rulesOf(root, tree) {
  const bytes = readBlob(root, tree, RULES);
  return new Map(bytes === null ? [] : parseRegistry(decode(bytes)).rules.map((rule) => [rule.id, rule]));
}

/**
 * The rules an agent reworded since `baseTree`: those that are agent rules in
 * both trees and whose block text differs. A rule added or removed, or an owner
 * rule edited, changes the digest, so it is the owner's to approve and is not
 * listed. No base tree, no changes. A read that fails throws; the caller refuses.
 */
export function agentRuleChanges(root, baseTree, tree) {
  if (baseTree === null) return [];
  const before = rulesOf(root, baseTree);
  const changes = [];
  for (const [id, rule] of rulesOf(root, tree)) {
    const earlier = before.get(id);
    if (earlier?.agent && rule.agent && earlier.block !== rule.block) changes.push({ id, change: 'reworded' });
  }
  return changes;
}
