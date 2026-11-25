// The hook extension. It must stay ONE self-contained file that imports `node:`
// built-ins only (decision 3), so it imports nothing from the other scripts;
// `ko-digest.mjs` and the gate import from here, never the reverse. This part
// holds the pure path helpers; the hook entry point is added by a later task.
import { posix } from 'node:path';

export const PROTECTED_PREFIXES = ['.claude/kh-orchestration/scripts/', '.claude/kh-harness/', '.claude/scripts/'];
export const PROTECTED_FILES = ['docs/harness/RULES.md', '.claude/kh-orchestration/officers.json', '.claude/settings.json'];

const INVALID_GLOB_CHARACTERS = /[[\]{}\\]/;
const MAX_GLOB_LENGTH = 512;
// The most globs one list in an officers file may hold (`protected`, and an officer's `appliesTo`).
export const MAX_GLOBS = 64;

/**
 * A valid glob is at most 512 characters, not empty, not absolute, ends in no
 * `/`, has no empty, `.` or `..` segment and none of `[ ] { } \`, and uses
 * `**` only as a whole segment (`a**b` is invalid).
 */
export function isValidGlob(glob) {
  return glob.length <= MAX_GLOB_LENGTH && !INVALID_GLOB_CHARACTERS.test(glob)
    && glob.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && (segment === '**' || !segment.includes('**')));
}

// One glob segment against one path segment, with no `/` in either: `*` is zero or more
// characters, `?` exactly one, anything else itself. Characters are UTF-16 code units, so
// `?` matches half of a surrogate pair. The two-pointer algorithm remembers only the last
// `*`, so it takes at most (glob length x path length) steps and cannot backtrack deeply.
function segmentMatches(glob, text) {
  let g = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (g < glob.length && glob[g] === '*') {
      star = g++;
      resume = t;
    } else if (g < glob.length && (glob[g] === '?' || glob[g] === text[t])) {
      g++;
      t++;
    } else if (star !== -1) {
      g = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

const compiled = new Map();

/**
 * Decision 9. Whether a valid glob matches a repository-relative path with `/`
 * separators. Both are split at `/`. A `**` segment matches zero or more whole
 * path segments (so `**` + `/*.py` matches `a.py` and `x/a.py`, and `src/**` +
 * `/a.js` matches `src/a.js`), except that a trailing `/**` needs at least one
 * segment under the directory, so it does not match the directory itself; a
 * lone `**` matches every path. Other segments match by `segmentMatches`, so
 * `*` and `?` never cross `/`. Everything else is literal, case-sensitive,
 * and dot-directories are nothing special. The table has one row per glob
 * segment and one column per path segment and each cell takes one
 * segment match, so the work is bounded by (glob length x path length)
 * whatever the glob holds; no regular expression is built from a glob.
 */
export function matchesGlob(glob, path) {
  let segments = compiled.get(glob);
  if (segments === undefined) {
    segments = glob.split('/');
    compiled.set(glob, segments);
  }
  if (glob === '**') return true;
  const parts = path.split('/');
  const rows = segments.length;
  const columns = parts.length;
  // below[j]: does the glob from the next row on match the path from segment j on?
  let below = Array.from({ length: columns + 1 }, (_, column) => column === columns);
  for (let row = rows - 1; row >= 0; row--) {
    const here = new Array(columns + 1).fill(false);
    if (segments[row] === '**') {
      const trailing = row === rows - 1;
      for (let column = columns; column >= 0; column--) {
        here[column] = trailing ? column < columns : below[column] || (column < columns && here[column + 1]);
      }
    } else {
      for (let column = 0; column < columns; column++) {
        here[column] = below[column + 1] && segmentMatches(segments[row], parts[column]);
      }
    }
    below = here;
  }
  return below[0];
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
    || protectedGlobs.some((glob) => matchesGlob(glob, relPath));
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
  if (!Array.isArray(globs) || globs.length > MAX_GLOBS || !globs.every((glob) => typeof glob === 'string' && isValidGlob(glob))) return null;
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
