// The hook extension. It must stay ONE self-contained file that imports `node:`
// built-ins only (decision 3), so it imports nothing from the other scripts;
// `ko-digest.mjs` and the gate import from here, never the reverse. This part
// holds the pure path helpers; the hook entry point is added by a later task.

export const PROTECTED_PREFIXES = ['.claude/kh-orchestration/scripts/', '.claude/kh-harness/', '.claude/scripts/'];
export const PROTECTED_FILES = ['docs/harness/RULES.md', '.claude/kh-orchestration/officers.json', '.claude/settings.json'];

/**
 * Whether a path is one whose change needs the owner's approval: a protected
 * file, a path under a protected prefix, or one of `officerScripts`.
 * Precondition: `relPath` is repository-relative with `/` separators and already
 * normalised (no `.` or `..` segment, no symlink in it); the hook does that for
 * an absolute path. Matching is case-sensitive, so a case-insensitive
 * filesystem is the hook's concern too.
 */
export function isProtected(relPath, officerScripts) {
  return PROTECTED_FILES.includes(relPath)
    || PROTECTED_PREFIXES.some((prefix) => relPath.startsWith(prefix))
    || officerScripts.includes(relPath);
}

const withoutDotSlash = (element) => (element.startsWith('./') ? element.slice(2) : element);

// Whether an argv element, after a leading `./`, can name a file in the repository.
function isRelativePath(element) {
  return element !== '' && !element.startsWith('/') && !element.startsWith('-') && !element.split('/').includes('..');
}

/**
 * The candidate officer scripts of an `officers.json` text: the elements of each
 * officer's `argv` that are relative paths (no leading `/` or `-`, no `..`
 * segment, a leading `./` removed), in order, once each. A candidate need not
 * exist; the caller keeps those that are files in the tree. Null when the text
 * is not JSON of the shape `{ officers: [{ argv: [string, ...] }, ...] }`.
 */
export function officerScriptsOf(officersJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(officersJsonText);
  } catch {
    return null;
  }
  const list = parsed?.officers;
  if (!Array.isArray(list)) return null;
  const scripts = new Set();
  for (const officer of list) {
    const argv = officer?.argv;
    if (!Array.isArray(argv) || !argv.every((element) => typeof element === 'string')) return null;
    for (const element of argv.map(withoutDotSlash)) {
      if (isRelativePath(element)) scripts.add(element);
    }
  }
  return [...scripts];
}
