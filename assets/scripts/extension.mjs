// The hook extension, run by kh-harness's PreToolUse hook before every tool
// call through contract 1. It must stay ONE self-contained file that imports
// `node:` built-ins only (decision 3): kh-harness loads it from a `data:` URL
// of its hashed bytes, so it has no file location and cannot reach a sibling.
// `ko-digest.mjs` and the gate import its helpers, never the reverse.
//
// `preToolUse(payload)` blocks the ways round the commit gate from inside a
// session (decision 15 as amended, decisions 13 and 16). It is synchronous,
// starts no process, writes nothing, and never throws: any failure inside it
// is a block with fixed text. A tool other than Bash and the edit tools is
// allowed at once without touching the filesystem.
//
// Bash commands are read by `splitWords`, a small shell-word splitter, not a
// shell. It removes quotes and backslashes (including $'...' escapes), splits
// at ; && || | |& & ( ) and newlines, skips comments, keeps redirections and
// leading NAME=value assignments apart from the words, and reads here-document
// bodies. It looks into $( ), backticks, <( ), >( ) and ${ } (each parsed as
// commands of their own), into an unquoted here-document's substitutions, and
// into the script given to a shell by -c, a here-document, a here-string or
// env -S. It expands nothing else: no variable, no glob (a word with a glob
// or a brace is matched against the guarded paths as a pattern, and braces
// are expanded up to 64 variants), no alias, no command substitution's output.
// What it cannot see into counts, under "when in doubt block", only when the
// command mentions git, ko.mjs, kh-orchestration or hooksPath: an unsplittable
// command, eval and trap, inline code for an interpreter (node -e, python -c,
// awk, ...), a script piped to a shell or an interpreter, a command word that
// is a variable or a substitution, and find -exec.
//
// Known NOT caught, by design (the commit gate and the digest are the
// backstop, and decision 13 says this guards against a skipped step, not
// against an agent set on cheating):
// - a variable or a substitution's output used as a git argument
//   (`F=--no-verify; git commit $F`, `git commit $(echo -n)`), and eval of
//   such a variable in a command that does not mention git;
// - a script written to disk and then run (`bash x.sh`, `node x.mjs`,
//   `source x.sh`), and a git alias already configured (`git ci -n`);
// - a command that runs its arguments as a command other than the wrappers
//   named below (`ssh`, `su -c`, `watch`, `parallel`, `flock`, `script -c`);
// - a path reached by changing directory first (`cd .git && rm hooks/x`) or
//   through a link made earlier, and a write to `.git/config` from Bash
//   (an include.path that sets hooksPath);
// - commits made without the pre-commit hook by other commands (`git am`,
//   `rebase`, `cherry-pick`, `hash-object -t commit` with `update-ref`).
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

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

// ---------------------------------------------------------------------------
// The hook: messages

const RUN = 'node .claude/kh-orchestration/scripts/ko.mjs run';
const doubt = (reason) => `This command could not be checked (${reason}) and it mentions git, the git hooks, the kh-orchestration state or ko.mjs, so it is blocked. Run it as plain commands the hook can read.`;

// Every text the hook returns. Each is one line of at most 300 characters with no `<` or `>`,
// so kh-harness's cleaning leaves it as it is.
export const MESSAGES = Object.freeze({
  noVerify: `git may not skip the commit gate from a session. Run the officers with ${RUN}, then commit without --no-verify or -n.`,
  commitTree: `git commit-tree makes a commit without the commit gate and is not run from a session. Run ${RUN}, then git commit.`,
  hooksPath: 'core.hooksPath is not set, unset or overridden from a session: it would switch the commit gate off. The owner changes it in their own terminal; to read it, run git config --get core.hooksPath.',
  alias: 'A git alias is not defined from a session: an alias can hide a way round the commit gate. The owner defines aliases in their own terminal; to read one, run git config --get alias.NAME.',
  gitConfigEnv: 'A GIT_CONFIG_* variable is not set from a session: it can change which hooks git runs. Run the git command without it.',
  guardedPath: `The git hooks folder and the kh-orchestration shared state are not changed from a session; ls, cat, grep and the like may read them. To record a verdict, run ${RUN}.`,
  ownerOnly: (command) => `ko.mjs ${command} is the owner's to run in their own terminal, outside Claude Code. Ask the owner to run node .claude/kh-orchestration/scripts/ko.mjs ${command}.`,
  xargs: 'git commit, merge, pull or config run through xargs takes arguments the hook cannot see, so it is blocked. Run the git command directly.',
  unsplittable: doubt('it cannot be split into words'),
  runsCode: doubt('it runs a string as code'),
  hiddenCommand: doubt('its command word is a variable or a substitution'),
  feedsScript: doubt('it feeds a script to a shell or an interpreter'),
  tooLong: 'This command is longer than 100,000 characters, too long to check, so it is blocked. Split it into shorter commands.',
  noCommand: 'This Bash call carries no command text to check, so it is blocked.',
  noTarget: 'This edit names no file path the hook can resolve, so it is blocked. Give the file\'s absolute path.',
  protectedEdit: 'This file decides what passes the commit gate and is not edited from a session. The owner can open this worktree for proposals by running node .claude/kh-orchestration/scripts/ko.mjs propose in their own terminal here.',
  gitDirEdit: `Files inside the git directory (its hooks, its config, the kh-orchestration shared state) are not edited from a session. Use git commands for git's own files, and ${RUN} for a verdict.`,
  stateUnreadable: 'The .git of this repository is neither a directory nor a readable gitdir file, so the commit gate\'s state cannot be found and this call is blocked. Repair .git outside this session.',
  internal: 'The kh-orchestration extension failed while checking this call, so the call is blocked. Ask the owner to reinstall kh-orchestration.',
});

// Thrown anywhere below to block the call with a fixed message; preToolUse catches it.
class Refusal {
  constructor(message) {
    this.message = message;
  }
}
const refuse = (message) => {
  throw new Refusal(message);
};

// ---------------------------------------------------------------------------
// The word splitter

// The longest Bash command read; a longer one is blocked unread.
export const MAX_COMMAND_LENGTH = 100_000;
// How deeply substitutions and scripts for a shell may nest before the command counts as unsplittable.
const MAX_DEPTH = 16;
// Thrown inside the splitter for text a shell would not accept, or that nests too deeply.
const UNPARSEABLE = Symbol('unparseable');
const unparseable = () => {
  throw UNPARSEABLE;
};

// A word: its text with quotes removed; `plain`, how many leading characters were unquoted
// literals (so `"A"=1` is no assignment); `quoted`; `expands`, whether a variable or a
// substitution is in it; `special`, whether an unquoted glob or brace character is.
const newWord = () => ({ text: '', plain: 0, quoted: false, expands: false, special: false });
const newCommand = (pipe) => ({ assignments: [], words: [], redirects: [], heredocs: [], pipe });

function addLiteral(word, char) {
  if (word.plain === word.text.length) word.plain++;
  word.text += char;
  if (char === '*' || char === '?' || char === '[' || char === '{') word.special = true;
}
function addQuoted(word, text) {
  word.text += text;
  word.quoted = true;
}
function addExpansion(word, raw) {
  word.text += raw;
  word.expands = true;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
function isAssignment(word) {
  const match = ASSIGNMENT.exec(word.text);
  return match !== null && match[0].length <= word.plain;
}

const OUTPUT_OPERATORS = ['>>', '>|', '>&', '>'];
const INPUT_OPERATORS = ['<<<', '<<-', '<<', '<>', '<&', '<'];

// Parses commands from p.src at p.pos into p.out until the end of the text or, when `nested`,
// until the `)` that closes a substitution. A substitution's commands reach p.out before the
// command holding it, the order a shell runs them.
function parseList(p, nested) {
  if (p.depth > MAX_DEPTH) unparseable();
  const { src } = p;
  let command = newCommand(false);
  let word = null;
  let redirect = null;
  let heredocs = [];
  let parens = 0;
  const current = () => (word ??= newWord());
  const endWord = () => {
    if (word === null) return;
    if (redirect !== null) {
      command.redirects.push({ op: redirect.op, base: redirect.base, target: word });
      if (redirect.base === '<<' || redirect.base === '<<-') heredocs.push({ word, strip: redirect.base === '<<-', command });
      redirect = null;
    } else if (command.words.length === 0 && isAssignment(word)) {
      command.assignments.push(word);
    } else {
      command.words.push(word);
    }
    word = null;
  };
  const endCommand = (pipeNext) => {
    endWord();
    if (redirect !== null) unparseable();
    if (command.assignments.length + command.words.length + command.redirects.length > 0) p.out.push(command);
    command = newCommand(pipeNext);
  };
  const startRedirect = (op, base) => {
    if (redirect !== null) unparseable();
    redirect = { op, base };
    p.pos += base.length;
  };
  while (p.pos < src.length) {
    const char = src[p.pos];
    const next = src[p.pos + 1];
    if (char === ' ' || char === '\t') {
      endWord();
      p.pos++;
    } else if (char === '\n') {
      endCommand(false);
      p.pos++;
      readHeredocs(p, heredocs);
      heredocs = [];
    } else if (char === '#' && word === null) {
      while (p.pos < src.length && src[p.pos] !== '\n') p.pos++;
    } else if (char === ';') {
      endCommand(false);
      p.pos += next === ';' || next === '&' ? 2 : 1;
    } else if (char === '&' && next === '&') {
      endCommand(false);
      p.pos += 2;
    } else if (char === '&' && next === '>') {
      endWord();
      const op = src[p.pos + 2] === '>' ? '&>>' : '&>';
      startRedirect(op, op);
    } else if (char === '&') {
      endCommand(false);
      p.pos++;
    } else if (char === '|') {
      endCommand(next !== '|');
      p.pos += next === '|' || next === '&' ? 2 : 1;
    } else if (char === '(' && word !== null && word.plain === word.text.length && isAssignment(word) && word.text.endsWith('=')) {
      // An array assignment `a=(x y)`: read to its `)` as a substitution would be.
      const start = p.pos;
      p.pos++;
      nestedList(p);
      addExpansion(word, src.slice(start, p.pos));
    } else if (char === '(') {
      if (word !== null) unparseable();
      endCommand(false);
      parens++;
      p.pos++;
    } else if (char === ')') {
      endCommand(false);
      p.pos++;
      if (parens > 0) parens--;
      else if (nested) return;
      else unparseable();
    } else if ((char === '<' || char === '>') && next === '(') {
      const start = p.pos;
      p.pos += 2;
      nestedList(p);
      addExpansion(current(), src.slice(start, p.pos));
    } else if (char === '<' || char === '>') {
      let fd = '';
      if (word !== null && word.plain === word.text.length && /^[0-9]+$/.test(word.text)) {
        fd = word.text;
        word = null;
      } else {
        endWord();
      }
      const base = (char === '>' ? OUTPUT_OPERATORS : INPUT_OPERATORS).find((op) => src.startsWith(op, p.pos));
      startRedirect(fd + base, base);
    } else if (char === '\\') {
      if (next === '\n') p.pos += 2;
      else if (next === undefined) {
        addLiteral(current(), '\\');
        p.pos++;
      } else {
        addQuoted(current(), next);
        p.pos += 2;
      }
    } else if (char === "'") {
      const end = src.indexOf("'", p.pos + 1);
      if (end === -1) unparseable();
      addQuoted(current(), src.slice(p.pos + 1, end));
      p.pos = end + 1;
    } else if (char === '"') {
      p.pos++;
      current().quoted = true;
      scanDouble(p, word, '"');
    } else if (char === '$') {
      parseDollar(p, current(), false);
    } else if (char === '`') {
      parseBacktick(p, current());
    } else {
      addLiteral(current(), char);
      p.pos++;
    }
  }
  if (nested || parens > 0) unparseable();
  endCommand(false);
  for (const heredoc of heredocs) heredoc.command.heredocs.push('');
}

function nestedList(p) {
  p.depth++;
  parseList(p, true);
  p.depth--;
}

// Reads the text inside double quotes into `word` up to the closing quote; with `terminator`
// null, reads to the end of the text (an unquoted here-document body, scanned for its
// substitutions). Inside, a backslash escapes only $ ` " \ and a newline.
function scanDouble(p, word, terminator) {
  const { src } = p;
  for (;;) {
    if (p.pos >= src.length) {
      if (terminator === null) return;
      unparseable();
    }
    const char = src[p.pos];
    if (char === terminator) {
      p.pos++;
      return;
    }
    if (char === '\\') {
      const next = src[p.pos + 1];
      if (next === undefined) {
        if (terminator !== null) unparseable();
        word.text += char;
        p.pos++;
      } else if (next === '\n') {
        p.pos += 2;
      } else if (next === '$' || next === '`' || next === '"' || next === '\\') {
        word.text += next;
        p.pos += 2;
      } else {
        word.text += char;
        p.pos++;
      }
    } else if (char === '$') {
      parseDollar(p, word, true);
    } else if (char === '`') {
      parseBacktick(p, word);
    } else {
      word.text += char;
      p.pos++;
    }
  }
}

// At a `$`: a substitution, a parameter, $'...' or $"...", or a lone dollar sign.
function parseDollar(p, word, inDouble) {
  const { src } = p;
  const start = p.pos;
  const next = src[p.pos + 1];
  if (next === '(') {
    p.pos += 2;
    nestedList(p);
    addExpansion(word, src.slice(start, p.pos));
  } else if (next === '{') {
    p.pos += 2;
    scanBraced(p, inDouble);
    addExpansion(word, src.slice(start, p.pos));
  } else if (next === "'" && !inDouble) {
    p.pos += 2;
    addQuoted(word, decodeAnsiC(p));
  } else if (next === '"' && !inDouble) {
    p.pos += 2;
    word.quoted = true;
    scanDouble(p, word, '"');
  } else if (next !== undefined && /[A-Za-z_]/.test(next)) {
    let end = p.pos + 2;
    while (end < src.length && /[A-Za-z0-9_]/.test(src[end])) end++;
    addExpansion(word, src.slice(start, end));
    p.pos = end;
  } else if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
    addExpansion(word, src.slice(start, start + 2));
    p.pos += 2;
  } else {
    if (inDouble) word.text += '$';
    else addLiteral(word, '$');
    p.pos++;
  }
}

// The inside of ${ ... } up to its closing brace; substitutions inside are parsed.
function scanBraced(p, inDouble) {
  const { src } = p;
  let depth = 1;
  for (;;) {
    if (p.pos >= src.length) unparseable();
    const char = src[p.pos];
    if (char === '}') {
      p.pos++;
      if (--depth === 0) return;
    } else if (char === '{') {
      depth++;
      p.pos++;
    } else if (char === '\\') {
      p.pos += 2;
    } else if (char === '"') {
      p.pos++;
      scanDouble(p, newWord(), '"');
    } else if (char === "'" && !inDouble) {
      const end = src.indexOf("'", p.pos + 1);
      if (end === -1) unparseable();
      p.pos = end + 1;
    } else if (char === '$') {
      parseDollar(p, newWord(), inDouble);
    } else if (char === '`') {
      parseBacktick(p, newWord());
    } else {
      p.pos++;
    }
  }
}

// `...`: the text up to the next unescaped backtick, with \` \\ \$ unescaped, parsed as commands.
function parseBacktick(p, word) {
  const { src } = p;
  const start = p.pos;
  let inner = '';
  let index = p.pos + 1;
  for (;;) {
    if (index >= src.length) unparseable();
    const char = src[index];
    if (char === '`') break;
    if (char === '\\' && (src[index + 1] === '`' || src[index + 1] === '\\' || src[index + 1] === '$')) {
      inner += src[index + 1];
      index += 2;
    } else {
      inner += char;
      index++;
    }
  }
  p.pos = index + 1;
  parseList({ src: inner, pos: 0, depth: p.depth + 1, out: p.out }, false);
  addExpansion(word, src.slice(start, p.pos));
}

const ANSI_C = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' };

// The inside of $'...' up to its closing quote, with its escapes decoded.
function decodeAnsiC(p) {
  const { src } = p;
  let out = '';
  for (;;) {
    if (p.pos >= src.length) unparseable();
    const char = src[p.pos];
    if (char === "'") {
      p.pos++;
      return out;
    }
    if (char !== '\\') {
      out += char;
      p.pos++;
      continue;
    }
    const next = src[p.pos + 1];
    if (next === undefined) unparseable();
    const digits = (pattern, max, from) => {
      let end = from;
      while (end < src.length && end - from < max && pattern.test(src[end])) end++;
      return src.slice(from, end);
    };
    if (ANSI_C[next] !== undefined) {
      out += ANSI_C[next];
      p.pos += 2;
    } else if (/[0-7]/.test(next)) {
      const octal = digits(/[0-7]/, 3, p.pos + 1);
      out += String.fromCharCode(parseInt(octal, 8) & 0xff);
      p.pos += 1 + octal.length;
    } else if (next === 'x' || next === 'u' || next === 'U') {
      const hex = digits(/[0-9A-Fa-f]/, next === 'x' ? 2 : next === 'u' ? 4 : 8, p.pos + 2);
      const code = hex === '' ? -1 : parseInt(hex, 16);
      out += code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : `\\${next}`;
      p.pos += 2 + hex.length;
    } else if (next === 'c' && p.pos + 2 < src.length) {
      out += String.fromCharCode(src.charCodeAt(p.pos + 2) & 0x1f);
      p.pos += 3;
    } else {
      out += `\\${next}`;
      p.pos += 2;
    }
  }
}

// After a newline: the bodies of the here-documents opened on the line just ended, each up to
// the line that is its delimiter (leading tabs stripped for <<-), or to the end of the text.
// A body whose delimiter is unquoted is scanned for substitutions.
function readHeredocs(p, heredocs) {
  const { src } = p;
  for (const { word, strip, command } of heredocs) {
    let body = '';
    while (p.pos < src.length) {
      const newline = src.indexOf('\n', p.pos);
      const end = newline === -1 ? src.length : newline;
      const line = strip ? src.slice(p.pos, end).replace(/^\t+/, '') : src.slice(p.pos, end);
      p.pos = newline === -1 ? src.length : newline + 1;
      if (line === word.text) break;
      body += `${line}\n`;
    }
    command.heredocs.push(body);
    if (!word.quoted) scanDouble({ src: body, pos: 0, depth: p.depth + 1, out: p.out }, newWord(), null);
  }
}

// The commands of a script, each with word objects, or null when a shell would not accept it.
function parseScript(src, depth) {
  const p = { src, pos: 0, depth, out: [] };
  try {
    parseList(p, false);
  } catch (error) {
    if (error === UNPARSEABLE) return null;
    throw error;
  }
  return p.out;
}

/**
 * Splits a shell command into its simple commands: one entry per simple command, each
 * `{ assignments, words, redirects: [{ op, target }], heredocs, pipe }` with quotes removed,
 * where `assignments` are the leading NAME=value words, `op` is a redirection operator with
 * any file descriptor before it (`2>`, `<<<`), `heredocs` the bodies of its here-documents,
 * and `pipe` whether its standard input is the previous command's output. The commands inside
 * a substitution come before the command that holds them. Null when quotes, substitutions or
 * parentheses do not balance, a redirection has no target, or nesting is deeper than 16.
 * See the header comment for what it does not expand.
 */
export function splitWords(command) {
  const commands = parseScript(command, 0);
  return commands === null ? null : commands.map((entry) => ({
    assignments: entry.assignments.map((word) => word.text),
    words: entry.words.map((word) => word.text),
    redirects: entry.redirects.map((redirect) => ({ op: redirect.op, target: redirect.target.text })),
    heredocs: [...entry.heredocs],
    pipe: entry.pipe,
  }));
}

// ---------------------------------------------------------------------------
// The git directory, without starting a process (decision 16)

const MAX_GIT_FILE_BYTES = 4096;
const MAX_STATE_BYTES = 1024 * 1024;

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// The text of a regular file (not a link) of at most `max` bytes, or null.
function readSmallFile(path, max) {
  const stats = lstatOrNull(path);
  if (stats === null || !stats.isFile() || stats.size > max) return null;
  try {
    const text = readFileSync(path, 'utf8');
    return text.length <= max ? text : null;
  } catch {
    return null;
  }
}

// One line of text, without the line ending git may have written after it.
const oneLine = (text) => (text === null ? null : /^([^\r\n]+)(?:\r?\n)?$/.exec(text)?.[1] ?? null);

// The real paths of a worktree's own git directory and of the shared one, read from `.git`
// at `root`: a directory is both; a file of one line `gitdir: <path>` (relative to `root`)
// names a directory whose `commondir` file names the shared one (relative to it), or which is
// itself the shared one when it has no `commondir` (git's rule, as for a submodule). Anything
// else, including a link at any of these, is null.
function gitDirsOf(root) {
  const dotGit = join(root, '.git');
  const stats = lstatOrNull(dotGit);
  if (stats === null) return null;
  if (stats.isDirectory()) {
    const real = realpathSync(dotGit);
    return { gitDir: real, commonDir: real };
  }
  const line = stats.isFile() ? oneLine(readSmallFile(dotGit, MAX_GIT_FILE_BYTES)) : null;
  if (line === null || !line.startsWith('gitdir: ') || line.length === 'gitdir: '.length) return null;
  const gitDir = resolve(root, line.slice('gitdir: '.length));
  if (lstatOrNull(gitDir)?.isDirectory() !== true) return null;
  let commonDir = gitDir;
  const commonFile = join(gitDir, 'commondir');
  const commonStats = lstatOrNull(commonFile);
  if (commonStats !== null) {
    const named = commonStats.isFile() ? oneLine(readSmallFile(commonFile, MAX_GIT_FILE_BYTES)) : null;
    if (named === null) return null;
    commonDir = resolve(gitDir, named);
    if (lstatOrNull(commonDir)?.isDirectory() !== true) return null;
  }
  return { gitDir: realpathSync(gitDir), commonDir: realpathSync(commonDir) };
}

/**
 * Decision 16. The shared state directory, `<git common dir>/kh-orchestration`, of the
 * worktree whose root is `root`, found by reading `.git` (see gitDirsOf) without starting
 * git; null when `.git` is absent or is not of a form read there.
 */
export function sharedStateDirSync(root) {
  const dirs = gitDirsOf(root);
  return dirs === null ? null : join(dirs.commonDir, 'kh-orchestration');
}

// The nearest directory from `start` upward that holds a `.git` entry, or null.
function findRoot(start) {
  let dir = start;
  for (let steps = 0; steps <= start.length; steps++) {
    const stats = lstatOrNull(join(dir, '.git'));
    if (stats !== null) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// The git directories of the repository holding `dir`, null outside any; a .git that cannot be read blocks.
function gitDirsAround(dir) {
  const root = findRoot(dir);
  if (root === null) return null;
  const dirs = gitDirsOf(root);
  if (dirs === null) refuse(MESSAGES.stateUnreadable);
  return { root, ...dirs };
}

const isInside = (path, dir) => {
  const a = path.toLowerCase();
  const b = dir.toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};

// The directory the session works in: the call's `cwd`, else CLAUDE_PROJECT_DIR; null without either.
function sessionDir(payload) {
  for (const dir of [payload.cwd, process.env.CLAUDE_PROJECT_DIR]) {
    if (typeof dir === 'string' && isAbsolute(dir)) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Bash

const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'stat', 'file', 'wc', 'grep', 'rg', 'test', '[', 'diff', 'cmp', 'sha256sum', 'less']);
const WRITES_TO_FILES = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
const OWNER_ONLY = new Set(['approve', 'propose', 'waive', 'exempt', 'off', 'on']);
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'coproc']);
const MENTION = /\bgit\b|ko\.mjs|kh-orchestration|hookspath/i;
const GIT_CONFIG_NAME = /^GIT_CONFIG[A-Za-z0-9_]*\+?=/i;
const MAX_BRACE_VARIANTS = 64;
const MAX_BRACE_WORD = 4096;

// The name a word runs as: its last path segment, lower-cased, without `.exe`.
function commandName(text) {
  const name = text.slice(text.lastIndexOf('/') + 1).toLowerCase();
  return name.endsWith('.exe') ? name.slice(0, -4) : name;
}

// Skips a wrapper's options: `valued` short letters and `longValued` long names take the next
// word as their value; `positional` further words (timeout's duration) come before the command.
function optionSkipper({ valued = '', longValued = [], assignments = false, positional = 0 } = {}) {
  return (words, index) => {
    let i = index;
    while (i < words.length) {
      const text = words[i].text;
      if (text === '--') {
        i++;
        break;
      }
      if (assignments && ASSIGNMENT.test(text)) i++;
      else if (text.startsWith('--')) i += longValued.includes(text) ? 2 : 1;
      else if (text.startsWith('-') && text.length > 1) {
        let step = 1;
        for (let k = 1; k < text.length; k++) {
          if (valued.includes(text[k])) {
            if (k === text.length - 1) step = 2;
            break;
          }
        }
        i += step;
      } else break;
    }
    return i + positional;
  };
}

const WRAPPERS = {
  env: optionSkipper({ valued: 'uCS', longValued: ['--unset', '--chdir', '--split-string'], assignments: true }),
  command: optionSkipper(),
  builtin: optionSkipper(),
  sudo: optionSkipper({ valued: 'ugpCDrtUTh', longValued: ['--user', '--group', '--prompt', '--close-from', '--chdir', '--role', '--type', '--other-user', '--command-timeout', '--host'], assignments: true }),
  doas: optionSkipper({ valued: 'uC' }),
  nice: optionSkipper({ valued: 'n', longValued: ['--adjustment'] }),
  ionice: optionSkipper({ valued: 'cn', longValued: ['--class', '--classdata'] }),
  time: optionSkipper({ valued: 'fo', longValued: ['--format', '--output'] }),
  xargs: optionSkipper({ valued: 'IdaELnPs', longValued: ['--arg-file', '--delimiter', '--max-args', '--max-lines', '--max-procs', '--max-chars'] }),
  exec: optionSkipper({ valued: 'a' }),
  nohup: optionSkipper(),
  timeout: optionSkipper({ valued: 'sk', longValued: ['--signal', '--kill-after'], positional: 1 }),
  stdbuf: optionSkipper({ valued: 'ioe', longValued: ['--input', '--output', '--error'] }),
  setsid: optionSkipper(),
};

// The strings env -S or --split-string gives as a command line.
function envScripts(words, from, to) {
  const scripts = [];
  for (let i = from; i < to; i++) {
    const text = words[i].text;
    if (text === '-S' || text === '--split-string') scripts.push(words[i + 1]?.text ?? '');
    else if (text.startsWith('--split-string=')) scripts.push(text.slice('--split-string='.length));
    else if (/^-[^-]*S/.test(text)) scripts.push(text.slice(text.indexOf('S') + 1) || (words[i + 1]?.text ?? ''));
  }
  return scripts;
}

// The command a simple command runs, past reserved words and the wrappers above:
// { index, word, name, wrappers, scripts } with `word` undefined when there is none.
function resolveCommand(command) {
  const { words } = command;
  const wrappers = [];
  const scripts = [];
  let index = 0;
  while (index < words.length) {
    const word = words[index];
    if (word.expands) break;
    if (!word.quoted && RESERVED.has(word.text)) {
      index++;
      continue;
    }
    if (!word.quoted && word.text === 'function') {
      index += 2;
      continue;
    }
    const name = commandName(word.text);
    const skip = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (skip === undefined) break;
    wrappers.push(name);
    const next = skip(words, index + 1);
    if (name === 'env') scripts.push(...envScripts(words, index + 1, next));
    index = Math.max(next, index + 1);
  }
  const word = words[index];
  return { index, word, name: word === undefined ? '' : commandName(word.text), wrappers, scripts };
}

// Brace expansion of a word, at most MAX_BRACE_VARIANTS results; null when there would be more
// or the word is too long to expand. Every brace counts, quoted or not: more variants, never fewer.
function braceVariants(text) {
  if (text.length > MAX_BRACE_WORD) return null;
  const done = [];
  const pending = [text];
  for (let steps = 0; pending.length > 0; steps++) {
    if (steps > 4 * MAX_BRACE_VARIANTS) return null;
    const item = pending.pop();
    const alternation = firstAlternation(item);
    if (alternation === null) {
      done.push(item);
      if (done.length > MAX_BRACE_VARIANTS) return null;
    } else {
      for (const option of alternation.options) pending.push(alternation.before + option + alternation.after);
    }
  }
  return done;
}

// The first `{a,b}` in a text whose braces balance and which holds a comma at its own level.
function firstAlternation(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    const commas = [];
    for (let k = start; k < text.length; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === ',' && depth === 1) commas.push(k);
      else if (text[k] === '}' && --depth === 0) {
        if (commas.length === 0) break;
        const cuts = [start, ...commas, k];
        return { before: text.slice(0, start), options: cuts.slice(1).map((cut, n) => text.slice(cuts[n] + 1, cut)), after: text.slice(k + 1) };
      }
    }
  }
  return null;
}

// The texts a word stands for after brace expansion; null when that is too many to list.
const variantsOf = (word) => (word.special ? braceVariants(word.text) : [word.text]);

// Whether some `.git` segment of a glob pattern is followed by a `hooks` or `kh-orchestration`
// one, matching `*` and `?` (and `[...]`, read as `?`) by the glob segment rules.
function patternNamesGuarded(lower) {
  const segments = lower.replace(/\[[^\]/]*\]/g, '?').split('/');
  for (let k = 0; k + 1 < segments.length; k++) {
    if (segmentMatches(segments[k], '.git') && (segmentMatches(segments[k + 1], 'hooks') || segmentMatches(segments[k + 1], 'kh-orchestration'))) return true;
  }
  return false;
}

// Whether `.git/` is followed, anywhere later, by a `/kh-orchestration` segment.
function namesSharedState(lower) {
  const git = lower.indexOf('.git/');
  if (git === -1) return false;
  for (let at = lower.indexOf('/kh-orchestration', git + 4); at !== -1; at = lower.indexOf('/kh-orchestration', at + 1)) {
    const after = lower[at + '/kh-orchestration'.length];
    if (after === undefined || after === '/') return true;
  }
  return false;
}

// The resolved shared paths of the session's repository, lower-cased, read once per call.
function guardTexts(context) {
  if (context.guards === undefined) {
    const dirs = context.cwd === null ? null : gitDirsAround(context.cwd);
    context.guards = dirs === null ? [] : [join(dirs.commonDir, 'hooks'), join(dirs.commonDir, 'kh-orchestration')].map((dir) => dir.toLowerCase());
  }
  return context.guards;
}

// Whether a text names a path under the git directory's hooks/ or kh-orchestration/.
function guardedText(text, pattern, context) {
  const lower = text.toLowerCase();
  if (lower.includes('.git/hooks') || namesSharedState(lower) || (pattern && patternNamesGuarded(lower))) return true;
  if (!lower.includes('hooks') && !lower.includes('kh-orchestration')) return false;
  return guardTexts(context).some((guard) => lower.includes(guard));
}

function guardedWord(word, context) {
  const variants = variantsOf(word);
  if (variants === null) return /hooks|kh-orchestration/i.test(word.text);
  return variants.some((text) => guardedText(text, word.special, context));
}

// Whether a command that names a guarded path only reads it: one of READ_ONLY, run directly
// (no assignment, no wrapper), with none of its own ways to run or write something, and no
// redirection that writes to a guarded path.
function onlyReads(command, resolved, context) {
  if (command.assignments.length > 0 || resolved.wrappers.length > 0 || resolved.word === undefined || resolved.word.expands) return false;
  if (!READ_ONLY.has(resolved.name)) return false;
  const args = command.words.slice(resolved.index + 1).map((word) => word.text);
  if (resolved.name === 'rg' && args.some((text) => text.startsWith('--pre'))) return false;
  if (resolved.name === 'less' && args.some((text) => /^(-[oO]|--log-file|--LOG-FILE)/.test(text))) return false;
  return !command.redirects.some((redirect) => WRITES_TO_FILES.has(redirect.base)
    && !(redirect.base === '>&' && /^([0-9]+|-)$/.test(redirect.target.text)) && guardedWord(redirect.target, context));
}

const isNoVerify = (text) => text.length >= 6 && '--no-verify'.startsWith(text);

const COMMIT_SHORT_VALUED = 'mFCct';
const COMMIT_SHORT_OPTIONAL = 'uS';
const COMMIT_LONG_VALUED = new Set(['--message', '--file', '--author', '--date', '--template', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--cleanup', '--trailer', '--pathspec-from-file']);

// One argument of git commit: whether it turns the hooks off, and whether it takes the next word as its value.
function commitOption(text) {
  if (text.startsWith('--')) return { skips: isNoVerify(text), takesNext: !text.includes('=') && COMMIT_LONG_VALUED.has(text) };
  if (!text.startsWith('-') || text.length < 2) return { skips: false, takesNext: false };
  for (let k = 1; k < text.length; k++) {
    if (text[k] === 'n') return { skips: true, takesNext: false };
    if (COMMIT_SHORT_VALUED.includes(text[k])) return { skips: false, takesNext: k === text.length - 1 };
    if (COMMIT_SHORT_OPTIONAL.includes(text[k])) break;
  }
  return { skips: false, takesNext: false };
}

// Whether git commit's arguments hold --no-verify (or an abbreviation) or -n, values and what follows `--` aside.
function commitSkipsHooks(args) {
  for (let i = 0; i < args.length; i++) {
    const variants = variantsOf(args[i]);
    if (variants === null) return true;
    if (variants.length > 1) {
      if (variants.some((text) => commitOption(text).skips)) return true;
    } else {
      if (variants[0] === '--') return false;
      const { skips, takesNext } = commitOption(variants[0]);
      if (skips) return true;
      if (takesNext) i++;
    }
  }
  return false;
}

// For any other git command (merge, pull, an alias): whether a word before `--` is --no-verify or an abbreviation of it.
function argsSkipHooks(args) {
  for (const word of args) {
    const variants = variantsOf(word);
    if (variants === null) return true;
    if (variants.length === 1 && variants[0] === '--') return false;
    if (variants.some(isNoVerify)) return true;
  }
  return false;
}

const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list']);

function configWritesAlias(args) {
  const texts = args.map((word) => word.text);
  const action = texts.find((text) => !text.startsWith('-'));
  const reads = texts.some((text) => CONFIG_READS.has(text)) || action === 'get' || action === 'list';
  return !reads && texts.some((text) => text.toLowerCase().startsWith('alias.'));
}

const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);

function judgeGit(args, resolved) {
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-')) {
    const text = args[i].text;
    const override = text === '-c' || text === '--config-env' ? args[i + 1]?.text : text.startsWith('--config-env=') ? text.slice('--config-env='.length) : undefined;
    if (override?.toLowerCase().startsWith('alias.')) refuse(MESSAGES.alias);
    i += GIT_VALUED.has(text) ? 2 : 1;
  }
  const sub = args[i]?.text;
  if (sub === undefined) return;
  const rest = args.slice(i + 1);
  if (sub === 'commit-tree') refuse(MESSAGES.commitTree);
  if (sub === 'config' && configWritesAlias(rest)) refuse(MESSAGES.alias);
  if (sub === 'commit' ? commitSkipsHooks(rest) : argsSkipHooks(rest)) refuse(MESSAGES.noVerify);
  if (resolved.wrappers.includes('xargs') && ['commit', 'merge', 'pull', 'config'].includes(sub)) refuse(MESSAGES.xargs);
}

// `git config --get core.hooksPath` exactly, the one command that may name hooksPath.
function readsHooksPath(command) {
  const texts = command.words.map((word) => word.text);
  return command.assignments.length === 0 && texts.length === 4 && !command.words.some((word) => word.expands)
    && texts[0] === 'git' && texts[1] === 'config' && texts[2] === '--get' && texts[3].toLowerCase() === 'core.hookspath';
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'fish']);
const SHELL_VALUED = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const ALWAYS_CODE = new Set(['eval', 'trap', 'awk', 'gawk', 'mawk', 'nawk']);

// The short letters and long options with which an interpreter runs code given on its command line.
function inlineOptionsOf(name) {
  if (name === 'node' || name === 'nodejs' || name === 'bun') return { short: 'ep', long: ['--eval', '--print'] };
  if (/^(python|pypy)[0-9.]*$/.test(name)) return { short: 'c', long: [] };
  if (name === 'perl') return { short: 'eE', long: [] };
  if (name === 'ruby' || name === 'lua' || name === 'rscript' || name === 'osascript') return { short: 'e', long: [] };
  if (name === 'php') return { short: 'r', long: [] };
  return null;
}

const readsStdinScript = (command) => command.pipe || command.heredocs.length > 0 || command.redirects.some((redirect) => redirect.base === '<<<');

// Whether a text mentions git, ko.mjs, kh-orchestration, hooksPath or the resolved shared paths.
function mentionsText(text, context) {
  const lower = text.toLowerCase();
  return MENTION.test(text) || ((lower.includes('hooks') || lower.includes('kh-orchestration')) && guardTexts(context).some((guard) => lower.includes(guard)));
}

// Whether the whole command mentions them, with quotes and backslashes taken out.
function mentions(context) {
  context.mentioned ??= mentionsText(context.command.replace(/[\\'"]/g, ''), context);
  return context.mentioned;
}

// Blocks with `message` when the command mentions them.
const doubtful = (context, message) => {
  if (mentions(context)) refuse(message);
};

// Blocks with `message` when the code in `words` mentions them; a word holding a variable or
// a substitution could be anything the command holds, so then the whole command is asked.
function doubtfulCode(words, context, message) {
  if (words.some((word) => word.expands) ? mentions(context) : words.some((word) => mentionsText(word.text, context))) refuse(message);
}

// A script given on a command line or a standard input: its commands are judged as the command's own.
function judgeScript(text, context, depth) {
  const commands = depth + 1 > MAX_DEPTH ? null : parseScript(text, depth + 1);
  if (commands === null) doubtful(context, MESSAGES.unsplittable);
  else judgeCommands(commands, context, depth + 1);
}

function judgeShell(command, args, context, depth) {
  let i = 0;
  let inline = false;
  let stdin = false;
  while (i < args.length) {
    const text = args[i].text;
    if (text === '--' || text === '-') {
      if (text === '-') stdin = true;
      i++;
      break;
    }
    if (SHELL_VALUED.has(text)) i += 2;
    else if (/^[-+][A-Za-z]+$/.test(text)) {
      if (text[0] === '-' && text.includes('c')) inline = true;
      if (text[0] === '-' && text.includes('s')) stdin = true;
      i++;
    } else if (text.startsWith('--')) i++;
    else break;
  }
  if (inline) {
    if (i < args.length) judgeScript(args[i].text, context, depth);
    return;
  }
  if (i < args.length && !stdin) return;
  for (const body of command.heredocs) judgeScript(body, context, depth);
  for (const redirect of command.redirects) if (redirect.base === '<<<') judgeScript(redirect.target.text, context, depth);
  if (command.pipe) doubtful(context, MESSAGES.feedsScript);
}

// An interpreter runs code from its command line (node -e, python -c) or, with no script operand,
// from its standard input when that is a pipe, a here-document or a here-string.
function judgeInterpreter(command, args, inlineOptions, context) {
  let operand = false;
  let inline = false;
  for (const word of args) {
    const text = word.text;
    if (!text.startsWith('-') || text === '-') {
      operand = text !== '-';
      break;
    }
    const long = inlineOptions.long.some((option) => text === option || text.startsWith(`${option}=`));
    const short = /^-[A-Za-z]+$/.test(text) && [...inlineOptions.short].some((letter) => text.includes(letter));
    if (long || short) inline = true;
  }
  if (inline) doubtfulCode(args, context, MESSAGES.runsCode);
  else if (!operand && readsStdinScript(command)) doubtful(context, MESSAGES.feedsScript);
}

function judgeCommand(command, context, depth) {
  const every = [...command.assignments, ...command.words, ...command.redirects.map((redirect) => redirect.target)];
  if (command.assignments.some((word) => GIT_CONFIG_NAME.test(word.text)) || command.words.some((word) => GIT_CONFIG_NAME.test(word.text))) refuse(MESSAGES.gitConfigEnv);
  if (every.some((word) => word.text.toLowerCase().includes('hookspath')) && !readsHooksPath(command)) refuse(MESSAGES.hooksPath);
  const resolved = resolveCommand(command);
  if (every.some((word) => guardedWord(word, context)) && !onlyReads(command, resolved, context)) refuse(MESSAGES.guardedPath);
  for (let k = 0; k < command.words.length; k++) {
    if (commandName(command.words[k].text) !== 'ko.mjs') continue;
    const sub = command.words.slice(k + 1).find((word) => !word.text.startsWith('-'))?.text.toLowerCase();
    if (OWNER_ONLY.has(sub)) refuse(MESSAGES.ownerOnly(sub));
  }
  for (const script of resolved.scripts) judgeScript(script, context, depth);
  if (resolved.word === undefined) return;
  if (resolved.word.expands) {
    doubtful(context, MESSAGES.hiddenCommand);
    return;
  }
  const { name } = resolved;
  const args = command.words.slice(resolved.index + 1);
  if (name === 'git') judgeGit(args, resolved);
  const runsCode = ALWAYS_CODE.has(name) || (name === 'find' && args.some((word) => FIND_EXEC.has(word.text))) || (name === 'deno' && args[0]?.text === 'eval');
  if (runsCode) doubtfulCode(args, context, MESSAGES.runsCode);
  if (SHELLS.has(name)) judgeShell(command, args, context, depth);
  if ((name === 'source' || name === '.') && readsStdinScript(command)) doubtful(context, MESSAGES.feedsScript);
  const inlineOptions = inlineOptionsOf(name);
  if (inlineOptions !== null) judgeInterpreter(command, args, inlineOptions, context);
}

function judgeCommands(commands, context, depth) {
  for (const command of commands) judgeCommand(command, context, depth);
}

function judgeBash(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') refuse(MESSAGES.noCommand);
  if (command.length > MAX_COMMAND_LENGTH) refuse(MESSAGES.tooLong);
  const context = { command, cwd: sessionDir(payload), guards: undefined, mentioned: undefined };
  const commands = parseScript(command, 0);
  if (commands === null) doubtful(context, MESSAGES.unsplittable);
  else judgeCommands(commands, context, 0);
}

// ---------------------------------------------------------------------------
// The edit tools

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TARGET_KEYS = ['file_path', 'notebook_path'];
const MAX_PATH_LENGTH = 4096;
const MAX_LINK_HOPS = 40;
const OFFICERS_PATH = '.claude/kh-orchestration/officers.json';
const RULES_FOLDED = 'docs/harness/rules.md';

// The real path of the deepest existing ancestor of `path`, with the rest of `path` after it.
function realOfDeepest(path) {
  const tail = [];
  let existing = path;
  for (let steps = 0; steps <= path.length; steps++) {
    try {
      return join(realpathSync(existing), ...tail);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') refuse(MESSAGES.noTarget);
    }
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
  }
  return refuse(MESSAGES.noTarget);
}

// Where a write to `path` lands: links followed, a dangling one too.
function realTarget(path) {
  let current = path;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    const real = realOfDeepest(current);
    if (lstatOrNull(real)?.isSymbolicLink() !== true) return real;
    current = resolve(dirname(real), readlinkSync(real));
  }
  return refuse(MESSAGES.noTarget);
}

// The officer scripts and protected globs a worktree's officers.json names; none when it cannot be read.
function protectionOf(root) {
  const text = readSmallFile(join(root, OFFICERS_PATH), MAX_STATE_BYTES);
  const officers = text === null ? null : readOfficers(text);
  return { scripts: officers?.officerCandidates.map((candidate) => candidate.path) ?? [], globs: officers?.protectedGlobs ?? [] };
}

// Protected as written, or lower-cased against the lower-cased lists, so a case-insensitive
// filesystem is no way round. Every fixed entry is lower case already but RULES.md, which the
// caller always allows.
function protectedHere(rel, root) {
  const { scripts, globs } = protectionOf(root);
  const lower = (texts) => texts.map((text) => text.toLowerCase());
  return isProtected(rel, scripts, globs) || isProtected(rel.toLowerCase(), lower(scripts), lower(globs));
}

// Whether proposals.json, `{ worktrees: [<real path of a worktree root>...] }`, lists this
// worktree. Absent, unreadable or of another shape: no worktree is open.
function openForProposals(root) {
  const dir = sharedStateDirSync(root);
  const text = dir === null ? null : readSmallFile(join(dir, 'proposals.json'), MAX_STATE_BYTES);
  if (text === null) return false;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const worktrees = value?.worktrees;
  return Array.isArray(worktrees) && worktrees.every((entry) => typeof entry === 'string') && worktrees.includes(realpathSync(root));
}

function judgeTarget(path, cwd, sessionDirs) {
  if (!isAbsolute(path) && cwd === null) refuse(MESSAGES.noTarget);
  const lexical = resolve(cwd ?? sep, path);
  for (const candidate of new Set([lexical, realTarget(lexical)])) {
    if (sessionDirs !== null && (isInside(candidate, sessionDirs.gitDir) || isInside(candidate, sessionDirs.commonDir))) refuse(MESSAGES.gitDirEdit);
    const dirs = gitDirsAround(dirname(candidate));
    if (dirs === null) continue;
    const rel = relative(dirs.root, candidate).split(sep).join('/');
    const folded = rel.toLowerCase();
    if (folded === '.git' || folded.startsWith('.git/') || isInside(candidate, dirs.gitDir) || isInside(candidate, dirs.commonDir)) refuse(MESSAGES.gitDirEdit);
    if (folded !== RULES_FOLDED && protectedHere(rel, dirs.root) && !openForProposals(dirs.root)) refuse(MESSAGES.protectedEdit);
  }
}

function judgeEdit(payload) {
  const input = payload.tool_input;
  const paths = input !== null && typeof input === 'object' ? TARGET_KEYS.filter((key) => Object.hasOwn(input, key)).map((key) => input[key]) : [];
  if (paths.length === 0 || !paths.every((path) => typeof path === 'string' && path !== '' && path.length <= MAX_PATH_LENGTH && !path.includes('\0'))) refuse(MESSAGES.noTarget);
  const cwd = sessionDir(payload);
  const sessionDirs = cwd === null ? null : gitDirsAround(cwd);
  for (const path of paths) judgeTarget(path, cwd, sessionDirs);
}

/**
 * The contract 1 PreToolUse extension. Allows a call or blocks it with a fixed message (see
 * MESSAGES); never throws and never returns anything else. A tool other than Bash, Edit,
 * Write, MultiEdit and NotebookEdit is allowed at once.
 */
export function preToolUse(payload) {
  try {
    const tool = payload?.tool_name;
    if (tool === 'Bash') judgeBash(payload);
    else if (EDIT_TOOLS.has(tool)) judgeEdit(payload);
    return { decision: 'allow' };
  } catch (error) {
    return { decision: 'block', message: error instanceof Refusal ? error.message : MESSAGES.internal };
  }
}
