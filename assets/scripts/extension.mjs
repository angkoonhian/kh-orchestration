// The hook extension. It must stay ONE self-contained file that imports `node:`
// built-ins only (decision 3), so it imports nothing from the other scripts;
// `ko-digest.mjs` and the gate import from here, never the reverse. This part
// holds the pure path helpers; the hook entry point is added by a later task.
import { posix } from 'node:path';

export const PROTECTED_PREFIXES = ['.claude/kh-orchestration/scripts/', '.claude/kh-harness/', '.claude/scripts/'];
export const PROTECTED_FILES = ['docs/harness/RULES.md', '.claude/kh-orchestration/officers.json', '.claude/settings.json'];

const INVALID_GLOB_CHARACTERS = /[[\]{}\\]/;

// A valid glob is not empty, not absolute, ends in no `/`, has no empty, `.` or `..`
// segment, and has none of `[ ] { } \`.
const isValidGlob = (glob) => !INVALID_GLOB_CHARACTERS.test(glob) && glob.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

const matchers = new Map();

/**
 * Decision 9, compiled once per glob: a function from a repository-relative
 * path with `/` separators to whether the glob matches it. `*` matches any run
 * of characters but `/`, `?` one character but `/`; `**/` matches zero or more
 * directories (`**` + `/*.py` matches `a.py` and `x/a.py`); a trailing `/**`
 * matches everything under the directory, not the directory itself; a lone
 * `**` matches every path; any other `**` matches any run of characters,
 * `/` and dot-directories included. Everything else is literal and
 * case-sensitive. The glob must be valid (see `readOfficers`).
 */
export function compileGlob(glob) {
  let matcher = matchers.get(glob);
  if (matcher === undefined) {
    let source = '';
    for (let index = 0; index < glob.length;) {
      const rest = glob.slice(index);
      if (rest.startsWith('**/')) {
        source += '(?:.*/)?';
        index += 3;
      } else if (rest === '/**') {
        source += '/.+';
        index += 3;
      } else if (rest.startsWith('**')) {
        source += '.*';
        index += 2;
      } else {
        source += rest[0] === '*' ? '[^/]*' : rest[0] === '?' ? '[^/]' : rest[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        index += 1;
      }
    }
    const expression = new RegExp(`^${source}$`, 's');
    matcher = (path) => expression.test(path);
    matchers.set(glob, matcher);
  }
  return matcher;
}

/**
 * Whether a path is one whose change needs the owner's approval: a protected
 * file, a path under a protected prefix, one of `officerScripts`, or one
 * matching a `protectedGlobs` glob.
 * Precondition: `relPath` is repository-relative with `/` separators and already
 * normalised (no `.` or `..` segment, no symlink in it); the hook does that for
 * an absolute path. Matching is case-sensitive, so a case-insensitive
 * filesystem is the hook's concern too.
 */
export function isProtected(relPath, officerScripts, protectedGlobs) {
  return PROTECTED_FILES.includes(relPath)
    || PROTECTED_PREFIXES.some((prefix) => relPath.startsWith(prefix))
    || officerScripts.includes(relPath)
    || protectedGlobs.some((glob) => compileGlob(glob)(relPath));
}

// The path an argv element names, as a candidate: the element, or the value after the
// first `=` of an element starting with `-`; POSIX-normalised, without a trailing `/`.
// Backslashes are not separators. Null for what names no place inside the repository:
// an empty value, the root `.`, an absolute path, or one that climbs out with `..`.
function candidatePath(element) {
  const value = element.startsWith('-') ? element.slice(element.indexOf('=') + 1) : element;
  if (element.startsWith('-') && !element.includes('=')) return null;
  if (value === '') return null;
  const normal = posix.normalize(value).replace(/\/$/, '');
  if (normal === '.' || normal === '..' || normal.startsWith('../') || normal.startsWith('/')) return null;
  return normal;
}

/**
 * Reads an `officers.json` text (decision 6): `{ schema: 1, protected: [glob...],
 * officers: [{ id, argv: [string...] }...] }`. Returns `{ officerCandidates,
 * protectedGlobs }`, where each candidate is `{ id, element, path }`: the officer,
 * the argv element as written, and the path it names (see `candidatePath`). A
 * candidate need not exist; the caller keeps what is in the tree. Returns null
 * when the text is not of that shape.
 */
export function readOfficers(officersJsonText) {
  let parsed;
  try {
    parsed = JSON.parse(officersJsonText);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || parsed.schema !== 1) return null;
  const globs = parsed.protected;
  if (!Array.isArray(globs) || !globs.every((glob) => typeof glob === 'string' && isValidGlob(glob))) return null;
  if (!Array.isArray(parsed.officers)) return null;
  const officerCandidates = [];
  for (const officer of parsed.officers) {
    const argv = officer?.argv;
    if (typeof officer?.id !== 'string' || !Array.isArray(argv) || argv.length === 0 || !argv.every((element) => typeof element === 'string')) return null;
    for (const element of argv) {
      const path = candidatePath(element);
      if (path !== null) officerCandidates.push({ id: officer.id, element, path });
    }
  }
  return { officerCandidates, protectedGlobs: [...globs] };
}
