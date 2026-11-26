// V8: a business-logic or architecture change updates the docs in the same branch.
//
// A kh-orchestration officer (decision 10), copied into the target repository as a standalone
// script: Node built-ins only, no import from the plugin. It reads
//   KO_OPTIONS       { "logic": [glob...], "docs": [glob...] }
//   KO_CHANGED_FILE  the changed paths, NUL-separated (a deleted path and both sides of a rename)
//   KO_WAIVERS       a JSON array of { rule, reason }
// and exits 0 to pass, 1 to fail. Malformed input is a failure too (exit 1), with fixed text.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RULE = 'V8';
const MAX_LISTED = 20;
const MAX_GLOB_LENGTH = 512;
const OPTION_KEYS = ['logic', 'docs'];

// A control character is shown as \uXXXX so that a path or a reason cannot rewrite the screen.
const visible = (text) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);

export const waivedMessage = (reason) => `${RULE}: waived by the owner. Reason: ${visible(reason)}\n`;

export const MESSAGES = Object.freeze({
  badOptions: `${RULE}: KO_OPTIONS must be a JSON object with exactly the keys logic and docs, each a list of globs. Fix the officer's options in officers.json.\n`,
  badGlob: (glob) => `${RULE}: the glob ${JSON.stringify(visible(glob))} in KO_OPTIONS is not valid. Fix the officer's options in officers.json.\n`,
  badChangedFile: `${RULE}: KO_CHANGED_FILE is not set or names a file that cannot be read.\n`,
  badWaivers: `${RULE}: KO_WAIVERS must be a JSON array of objects with a string rule and a string reason.\n`,
  docsChanged: `${RULE}: a documentation path changed.\n`,
  noLogic: `${RULE}: no business-logic or architecture path changed.\n`,
  logicWithoutDocs: (logicPaths) => [
    `${RULE}: a business-logic or architecture path changed and no documentation path did.`,
    'Changed logic paths:',
    ...logicPaths.slice(0, MAX_LISTED).map((path) => `  ${visible(path)}`),
    ...(logicPaths.length > MAX_LISTED ? [`and ${logicPaths.length - MAX_LISTED} more.`] : []),
    `Update a documentation path in this branch, or ask the owner for a waiver of ${RULE} with a reason.`,
    '',
  ].join('\n'),
});

// ---------------------------------------------------------------------------
// The glob matcher: a copy of isValidGlob and matchesGlob of the plugin's
// assets/scripts/extension.mjs (decision 9), kept here because an officer is standalone.
// docs-with-logic.test.mjs asserts that the two agree on one table.

const INVALID_GLOB_CHARACTERS = /[[\]{}\\]/;

export function isValidGlob(glob) {
  return glob.length <= MAX_GLOB_LENGTH && !INVALID_GLOB_CHARACTERS.test(glob)
    && glob.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..' && (segment === '**' || !segment.includes('**')));
}

// One glob segment against one path segment: `*` is zero or more characters, `?` exactly one.
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

// A `**` segment matches zero or more whole path segments, except a trailing one, which needs at
// least one; a lone `**` matches every path.
export function matchesGlob(glob, path) {
  if (glob === '**') return true;
  const segments = glob.split('/');
  const parts = path.split('/');
  const rows = segments.length;
  const columns = parts.length;
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

// ---------------------------------------------------------------------------
// The officer

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

// { logic, docs } from KO_OPTIONS, or a refusal text.
function readOptions(text) {
  let options;
  try {
    options = JSON.parse(text ?? '');
  } catch {
    return { problem: MESSAGES.badOptions };
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return { problem: MESSAGES.badOptions };
  const keys = Object.keys(options);
  if (keys.length !== OPTION_KEYS.length || !OPTION_KEYS.every((key) => keys.includes(key) && isStringList(options[key]))) return { problem: MESSAGES.badOptions };
  const invalid = [...options.logic, ...options.docs].find((glob) => !isValidGlob(glob));
  if (invalid !== undefined) return { problem: MESSAGES.badGlob(invalid) };
  return options;
}

function readWaivers(text) {
  let waivers;
  try {
    waivers = JSON.parse(text ?? '');
  } catch {
    return null;
  }
  const wellFormed = (waiver) => waiver !== null && typeof waiver === 'object' && typeof waiver.rule === 'string' && typeof waiver.reason === 'string';
  return Array.isArray(waivers) && waivers.every(wellFormed) ? waivers : null;
}

function readChanged(file) {
  if (file === undefined) return null;
  try {
    return readFileSync(file, 'utf8').split('\0').filter((path) => path !== '');
  } catch {
    return null;
  }
}

/** The officer's verdict from its environment: `{ exitCode, output }`. */
export function judge(environment) {
  const options = readOptions(environment.KO_OPTIONS);
  if (options.problem !== undefined) return { exitCode: 1, output: options.problem };
  const waivers = readWaivers(environment.KO_WAIVERS);
  if (waivers === null) return { exitCode: 1, output: MESSAGES.badWaivers };
  const changed = readChanged(environment.KO_CHANGED_FILE);
  if (changed === null) return { exitCode: 1, output: MESSAGES.badChangedFile };

  const logicPaths = changed.filter((path) => options.logic.some((glob) => matchesGlob(glob, path)));
  if (logicPaths.length === 0) return { exitCode: 0, output: MESSAGES.noLogic };
  if (changed.some((path) => options.docs.some((glob) => matchesGlob(glob, path)))) return { exitCode: 0, output: MESSAGES.docsChanged };
  const waiver = waivers.find(({ rule }) => rule === RULE);
  if (waiver !== undefined) return { exitCode: 0, output: waivedMessage(waiver.reason) };
  return { exitCode: 1, output: MESSAGES.logicWithoutDocs(logicPaths) };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, output } = judge(process.env);
  process.stdout.write(output);
  process.exitCode = exitCode;
}
