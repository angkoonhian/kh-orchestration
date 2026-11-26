// The hook extension, run by kh-harness's PreToolUse hook before every tool
// call through contract 1. It must stay ONE self-contained file that imports
// `node:` built-ins only (decision 3): kh-harness loads it from a `data:` URL
// of its hashed bytes, so it has no file location and cannot reach a sibling.
// `ko-digest.mjs` and the gate import its helpers, never the reverse.
//
// `preToolUse(payload)` stops a session taking a ONE-LINE way round the commit
// gate (decision 15 as replaced after Task 8's review; decisions 13 and 16),
// without blocking ordinary work. It is synchronous, starts no process, writes
// nothing and never throws: any failure inside it is a block with fixed text.
// A tool other than Bash and the edit tools is allowed at once, without
// touching the filesystem. The code below follows the rule set's order:
// words, the guarded area, git commands, owner-only commands, structure that
// cannot be seen, then the edit tools.
//
// Bash commands are read by `splitWords`, a small shell-word splitter, not a
// shell. It removes quotes and backslashes (with $'...' escapes), splits at
// ; && || | |& & ( ) and newlines, reads function bodies and case arms, keeps
// redirections and leading NAME=value assignments apart from the words, and
// reads here-document bodies. It parses $( ), backticks, <( ), >( ) and ${ }
// as commands of their own, an unquoted here-document's substitutions too,
// and the script a shell gets from -c. It expands nothing else: no variable,
// no glob (a word with a glob is matched against `.git` as a pattern), no
// alias; braces are expanded up to 64 variants, `{a,b}` and `{x..y}`.
//
// Stated limits, by design: the commit gate, the digest and verify-branch are
// the backstop for each of these.
// - eval, and variables holding paths (`D=.git; cd $D`) or flags: for commit a
//   flag in a variable is caught only when the word is wholly the expansion or
//   its literal text begins with `-` (`git commit x$F` is not), except a message
//   word that is wholly an expansion after an option that may take `-m` as its
//   value (`N=-n; git commit --trailer -m "$N"`), which is not caught; for merge
//   and pull a flag held in a plain parameter (`git merge $F`) is not caught;
//   a script written to disk and then run; string concatenation in inline code
//   (`'.gi'+'t/hooks'`).
// - git options that run a command (`rebase -x`, `bisect run`, `submodule
//   foreach`, `-c core.pager=...`), and an alias already configured.
// - commits git never hooks: cherry-pick, revert, am, rebase, fast-forward
//   merges, stash and update-ref plumbing, a clone then pull (verify-branch is
//   the remedy).
// - copying or unpacking over the git directory through its parent in ways
//   the word rules do not see, and a path reached through a link made earlier.
// - .claude/settings.local.json changed through the shell (the gate's
//   contract check is the backstop).
// - an unreadable officers.json leaves officer scripts and `protected` globs
//   unguarded for edits until the digest refuses the commit.
// - an encoded or otherwise opaque payload piped to an interpreter
//   (`... | base64 -d | sh`), and sed -f / awk -f script files.
// - editor scripting (`vim -es -c '!...'`, `ed`, `ex`), `tar
//   --checkpoint-action=exec=...`, and a copy of ko.mjs under another name.
// - a pager or editor that git starts (`git grep -O...`, `-c core.pager=...`);
//   an owner-only subcommand produced by a substitution (`ko.mjs $(echo
//   approve)`; ko.mjs itself refuses inside a session); a guarded path hidden
//   behind a glob inside code (`sed '1e rm .gi?/hooks/x'`).
// - a shell write to a tracked protected file such as officers.json: only the
//   edit tools are guarded there, and the digest refuses the commit.
// - environment variables that git or a shell runs as commands (GIT_EDITOR,
//   GIT_SSH_COMMAND, BASH_ENV, PROMPT_COMMAND...) when exported earlier rather
//   than set in the command's own assignments, which are scanned; and a
//   variable that steers git or its hooks (PATH, HOME, GIT_EXEC_PATH, GIT_COMMON_DIR, ...)
//   exported in an earlier command line, or inside a script fed to a shell on
//   its standard input. One exported in the same line as git is blocked.
// - a glob or a search whose output becomes another command's words (`chmod a-x
//   $(find . -name pre-commit)`, `find . -name pre-commit | xargs chmod a-x`,
//   `.g*/hooks`), and a ko.mjs name found by a search or a substitution.
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
// Messages

// A word the shell reads as itself: as it is when it holds nothing the shell would act on, else in single quotes.
export const shellWord = (text) => (/^[A-Za-z0-9._/@+=,:-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

const KO = 'node .claude/kh-orchestration/scripts/ko.mjs';
// The agents' commands a refusal names, in one table: the gate and ko.mjs import it from here, so
// every message names a command in the same words. The owner's commands act only from the
// approved copy in <git-common-dir>/kh-orchestration/bin/, a path of each repository: ko-state's
// ownerCommand builds them, and this file's own messages name that copy through git.
export const COMMANDS = Object.freeze({
  run: `${KO} run`,
  status: `${KO} status`,
  verifyBranch: `${KO} verify-branch`,
  unexempt: `${KO} unexempt`,
});
const OWNER_KO = 'node "$(git rev-parse --git-common-dir)/kh-orchestration/bin/ko.mjs"';
const RUN = COMMANDS.run;
const unseen = (reason) => `This command's structure cannot be seen (${reason}) and its text holds a way round the commit gate (no-verify, hooksPath, a .git path, an owner-only ko.mjs command), so it is blocked. Run it as plain commands.`;

// Every text the hook returns. Each is one line of at most 300 characters with no `<` or `>`,
// so kh-harness's cleaning leaves it as it is.
export const MESSAGES = Object.freeze({
  noVerify: `git may not skip the commit gate from a session. Run the officers with ${RUN}, then commit without --no-verify or -n.`,
  hiddenOption: 'A flag of git commit, merge or pull is given through a variable or a substitution, which could turn the hooks off, so it is blocked. Write the flags out literally.',
  commitTree: `git commit-tree makes a commit without the commit gate and is not run from a session. Run ${RUN}, then git commit.`,
  gitConfig: 'Git configuration that redirects hooks or names a command git runs (core.hooksPath, include, alias, mergeOptions, filters, fsmonitor, diff and merge drivers, pagers, editors, gpg and ssh programs) is not changed from a session. The owner changes it; git config --get reads it.',
  exportedEnv: 'This line runs git and sets a variable that steers git or a hook (NODE_OPTIONS etc., LD_*, DYLD_*, GIT_CONFIG_*, GIT_EXEC_PATH, GIT_COMMON_DIR, HOME, XDG_CONFIG_HOME, PATH, TMOUT, PS4, SHELLOPTS, BASH_ENV, ENV, BASH_FUNC_*), exports a function, or defines git as one. Run git in a line of its own.',
  gitEnv: 'GIT_CONFIG_*, GIT_EXEC_PATH (or --exec-path), GIT_COMMON_DIR, HOME, XDG_CONFIG_HOME, PATH, NODE_OPTIONS etc., LD_*, DYLD_*, TMOUT, SHELLOPTS, PS4, BASH_ENV, ENV and BASH_FUNC_* are not set for git from a session: they change what git and its hooks run. Run the git command without them.',
  xargs: 'A git command or ko.mjs run through xargs takes words the hook cannot see, so it is blocked. Run the command directly, with its subcommand and options written out.',
  guardedPath: `The git directory (its hooks, its config, the kh-orchestration shared state) is not changed from a session; ls, cat, grep, git log and the like may read it. To record a verdict, run ${RUN}.`,
  gitDirCwd: 'This session\'s working directory is inside a git directory, where only reading commands run. Change to the working tree first (cd to the repository root), then run the command.',
  ownerOnly: (command) => `ko.mjs ${command} is the owner's to run in their own terminal, outside Claude Code, from the approved copy. Ask the owner to run ${OWNER_KO} ${command}.`,
  sessionEnv: 'CLAUDECODE and CLAUDE_CODE_SESSION_ID are not unset or emptied from a session, nor the environment cleared in front of an owner command: the owner-only commands rely on them. Ask the owner to run the command in their own terminal.',
  installerHidden: 'This names kh-orchestration\'s apply.mjs or uninstall.mjs with a word the hook cannot read whole (a variable, a substitution, a brace or glob pattern, or xargs), which could hide --yes. Write the path and arguments out; --yes is the owner\'s to run in their own terminal.',
  installerOwnerOnly: 'kh-orchestration\'s apply --yes and uninstall --yes are the owner\'s to run in their own terminal, outside Claude Code: they change the hooks and the files the commit gate checks. Ask the owner to run it; without --yes it is a dry run, open here.',
  unsplittable: unseen('its quotes or nesting do not balance, or it nests too deeply'),
  feedsScript: unseen('it feeds a script to a shell or an interpreter'),
  runsCode: unseen('it runs a string as code'),
  hiddenCommand: unseen('its command word is a variable or a substitution'),
  tooLong: 'This command is longer than 100,000 characters, too long to check, so it is blocked. Split it into shorter commands.',
  pathTooLong: 'The working directory, the project directory or a path in this call is longer than 4,096 characters, so the call is blocked. Use a shorter path.',
  noCommand: 'This Bash call carries no command text to check, so it is blocked. Send the command as a string in the command field.',
  noTarget: 'This edit names no file path the hook can resolve, so it is blocked. Give the file\'s absolute path.',
  protectedEdit: `This file decides what passes the commit gate and is not edited from a session. The owner can open this worktree for proposals by running ${OWNER_KO} propose in their own terminal here.`,
  localSettingsEdit: '.claude/settings.local.json can switch the hooks off and, being untracked, no approval can cover it, so it is never edited from a session. The owner edits it in their own editor.',
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
// Words: the splitter

// The longest Bash command read; a longer one is blocked unread.
export const MAX_COMMAND_LENGTH = 100_000;
// How deeply substitutions, ${ } and scripts for a shell may nest before the command counts as
// one whose structure cannot be seen.
const MAX_DEPTH = 16;
// Thrown inside the splitter for text a shell would not accept, or that nests too deeply.
const UNPARSEABLE = Symbol('unparseable');
const unparseable = () => {
  throw UNPARSEABLE;
};

// A word: its text with quotes removed; `plain`, how many leading characters were unquoted
// literals (so `"A"=1` is no assignment); `quoted`; `expands`, whether a variable or a
// substitution is in it, and `spans`, where each one sits in `text` and whether it is quoted;
// `special`, whether an
// unquoted glob or brace character is in it.
const newWord = () => ({ text: '', plain: 0, quoted: false, expands: false, spans: [], special: false, name: undefined });
// A simple command: `raw`, its text as written; `pipe`, whether its input is a pipe, and
// `pipedFrom`/`pipedTo`, the commands on either side of that pipe.
// `substituted`, whether its output becomes another command's words (set when it ends).
const newCommand = (pipedFrom, pipe) => ({ assignments: [], words: [], redirects: [], heredocs: [], pipe, pipedFrom, pipedTo: null, start: null, raw: '', substituted: false });

function addLiteral(word, char) {
  if (word.plain === word.text.length) word.plain++;
  word.text += char;
  if (char === '*' || char === '?' || char === '[' || char === '{') word.special = true;
}
function addQuoted(word, text) {
  word.text += text;
  word.quoted = true;
}
// An expansion's span: where it sits in `text`, and whether it stands inside double quotes
// (an unquoted one is split into several words by the shell).
function addExpansion(word, raw, quoted = false) {
  word.spans.push([word.text.length, word.text.length + raw.length, quoted]);
  word.text += raw;
  word.expands = true;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const ENV_ASSIGNMENT = /^[^=-][^=]*=/;
function isAssignment(word) {
  const match = ASSIGNMENT.exec(word.text);
  return match !== null && match[0].length <= word.plain;
}
const isKeyword = (word, keyword) => !word.quoted && !word.expands && word.text === keyword;
const endsWord = (char) => char === undefined || ' \t\n;&|)'.includes(char);

const OUTPUT_OPERATORS = ['>>', '>|', '>&', '>'];
const INPUT_OPERATORS = ['<<<', '<<-', '<<', '<>', '<&', '<'];
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;

// Parses commands from p.src at p.pos into p.out until the end of the text or, when `nested`,
// until the `)` that closes a substitution. A substitution's commands reach p.out before the
// command holding it, the order a shell runs them. `name() {` drops the name and reads the
// body as commands; `case WORD in` drops its header and patterns and reads each arm's commands.
function parseList(p, nested) {
  if (p.depth > MAX_DEPTH) unparseable();
  const { src } = p;
  // Whether these commands' output becomes another command's words: a $( ), backtick or <( ) body.
  const substituted = nested || p.substituted === true;
  let command = newCommand(null, false);
  let word = null;
  let redirect = null;
  let heredocs = [];
  let parens = 0;
  const cases = [];
  const mark = () => {
    command.start ??= p.pos;
  };
  const current = () => {
    if (word === null) {
      mark();
      word = newWord();
    }
    return word;
  };
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
      const before = command.words[command.words.length - 2];
      if (before !== undefined && isKeyword(before, 'function') && command.words.slice(0, -2).every((earlier) => !earlier.quoted && RESERVED.has(earlier.text))) p.functions.push(word.text);
      if (command.words.length === 3 && isKeyword(command.words[0], 'case') && isKeyword(word, 'in')) {
        command = newCommand(null, false);
        cases.push('pattern');
      }
    }
    word = null;
  };
  const endCommand = (pipeNext) => {
    endWord();
    if (redirect !== null) unparseable();
    const ended = command;
    ended.raw = src.slice(ended.start ?? p.pos, p.pos);
    let kept = ended.assignments.length + ended.words.length + ended.redirects.length > 0;
    if (kept && cases.length > 0 && ended.words.length > 0 && isKeyword(ended.words[0], 'esac')) {
      cases.pop();
      kept = false;
    }
    ended.substituted = substituted;
    if (kept) p.out.push(ended);
    command = newCommand(pipeNext && kept ? ended : null, pipeNext);
    if (command.pipedFrom !== null) ended.pipedTo = command;
  };
  const startRedirect = (op, base) => {
    if (redirect !== null) unparseable();
    mark();
    redirect = { op, base };
    p.pos += base.length;
  };
  while (p.pos < src.length) {
    const char = src[p.pos];
    const next = src[p.pos + 1];
    if (cases.length > 0 && cases[cases.length - 1] === 'pattern' && word === null && redirect === null) {
      if (char === ' ' || char === '\t' || char === '\n') p.pos++;
      else if (src.startsWith('esac', p.pos) && endsWord(src[p.pos + 4])) {
        p.pos += 4;
        cases.pop();
      } else {
        skipCasePattern(p);
        cases[cases.length - 1] = 'body';
      }
    } else if (char === ' ' || char === '\t') {
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
      const width = src.startsWith(';;&', p.pos) ? 3 : next === ';' || next === '&' ? 2 : 1;
      if (width > 1 && cases.length > 0) cases[cases.length - 1] = 'pattern';
      p.pos += width;
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
    } else if (char === '(' && word !== null && word.plain === word.text.length && FUNCTION_NAME.test(word.text) && /^\(\s*\)/.test(src.slice(p.pos, p.pos + 64))) {
      // `name()`: the function's name goes to p.functions; its body follows as commands.
      p.functions.push(word.text);
      word = null;
      p.pos = src.indexOf(')', p.pos) + 1;
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
      const target = current();
      p.pos += 2;
      nestedList(p);
      addExpansion(target, src.slice(start, p.pos));
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
      const target = current();
      p.pos++;
      target.quoted = true;
      scanDouble(p, target, '"');
    } else if (char === '$') {
      parseDollar(p, current(), false);
    } else if (char === '`') {
      parseBacktick(p, current());
    } else {
      addLiteral(current(), char);
      p.pos++;
    }
  }
  if (nested || parens > 0 || cases.length > 0) unparseable();
  endCommand(false);
  for (const heredoc of heredocs) heredoc.command.heredocs.push('');
}

function nestedList(p) {
  p.depth++;
  parseList(p, true);
  p.depth--;
}

// A case pattern, `x|y)` or `(x)`, up to and past its closing parenthesis.
function skipCasePattern(p) {
  const { src } = p;
  if (src[p.pos] === '(') p.pos++;
  let depth = 0;
  for (;;) {
    if (p.pos >= src.length) unparseable();
    const char = src[p.pos];
    if (char === '\\') {
      p.pos += 2;
    } else if (char === "'") {
      const end = src.indexOf("'", p.pos + 1);
      if (end === -1) unparseable();
      p.pos = end + 1;
    } else if (char === '"') {
      p.pos++;
      scanDouble(p, newWord(), '"');
    } else if (char === '$') {
      parseDollar(p, newWord(), false);
    } else if (char === '(') {
      depth++;
      p.pos++;
    } else if (char === ')') {
      p.pos++;
      if (depth-- === 0) return;
    } else {
      p.pos++;
    }
  }
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
      parseBacktick(p, word, true);
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
    addExpansion(word, src.slice(start, p.pos), inDouble);
  } else if (next === '{') {
    p.pos += 2;
    scanBraced(p, inDouble);
    addExpansion(word, src.slice(start, p.pos), inDouble);
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
    addExpansion(word, src.slice(start, end), inDouble);
    p.pos = end;
  } else if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
    addExpansion(word, src.slice(start, start + 2), inDouble);
    p.pos += 2;
  } else {
    if (inDouble) word.text += '$';
    else addLiteral(word, '$');
    p.pos++;
  }
}

// The inside of ${ ... } up to its closing brace; substitutions inside are parsed. Each ${ is
// one level of nesting, counted like a substitution's.
function scanBraced(p, inDouble) {
  const { src } = p;
  p.depth++;
  if (p.depth > MAX_DEPTH) unparseable();
  let depth = 1;
  for (;;) {
    if (p.pos >= src.length) unparseable();
    const char = src[p.pos];
    if (char === '}') {
      p.pos++;
      if (--depth === 0) break;
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
  p.depth--;
}

// `...`: the text up to the next unescaped backtick, with \` \\ \$ unescaped, parsed as commands.
function parseBacktick(p, word, quoted = false) {
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
  parseList({ src: inner, pos: 0, depth: p.depth + 1, out: p.out, substituted: true }, false);
  addExpansion(word, src.slice(start, p.pos), quoted);
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

// The commands of a script, each with word objects, or null when a shell would not accept it
// or it nests deeper than MAX_DEPTH.
// The simple commands of `src`, or null when it cannot be split. The name of every function it
// defines (`name()`, `function name`) is added to `functions`.
function parseScript(src, depth, functions = []) {
  const p = { src, pos: 0, depth, out: [], functions };
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
 * a substitution come before the command that holds them; a function definition's name and a
 * case statement's header and patterns are left out. Null for a value that is not a string, and
 * when quotes, substitutions, parentheses or a case do not balance, a redirection has no target,
 * or nesting is deeper than 16. See the header comment for what it does not expand.
 */
export function splitWords(command) {
  const commands = typeof command === 'string' ? parseScript(command, 0) : null;
  return commands === null ? null : commands.map((entry) => ({
    assignments: entry.assignments.map((word) => word.text),
    words: entry.words.map((word) => word.text),
    redirects: entry.redirects.map((redirect) => ({ op: redirect.op, target: redirect.target.text })),
    heredocs: [...entry.heredocs],
    pipe: entry.pipe,
  }));
}

// ---------------------------------------------------------------------------
// Paths and the git directory, without starting a process (decision 16)

// The longest working directory, project directory or edit target read; longer blocks.
const MAX_PATH_LENGTH = 4096;
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

// The deepest existing ancestor of an absolute path (itself included), found by halving: if
// a path exists so do its ancestors, so this takes a number of lstat calls logarithmic in the
// path's depth. Returns it with the rest of the path's segments after it.
function deepestExisting(path) {
  const root = resolve(sep);
  const parts = path.slice(root.length).split(sep).filter((part) => part !== '');
  const prefix = (count) => join(root, ...parts.slice(0, count));
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lstatOrNull(prefix(middle)) !== null) low = middle;
    else high = middle - 1;
  }
  return { existing: prefix(low), tail: parts.slice(low) };
}

// The real path of `path`'s deepest existing ancestor, with the rest of `path` after it; a
// dangling link at that ancestor is kept as a name. Null when no real path can be had.
function realOfDeepest(path) {
  const { existing, tail } = deepestExisting(path);
  for (const [base, rest] of [[existing, tail], [dirname(existing), [basename(existing), ...tail]]]) {
    try {
      return join(realpathSync(base), ...rest);
    } catch {
      // a dangling link: try its directory
    }
  }
  return null;
}

// The nearest directory from `start` upward that holds a `.git` entry, or null. It starts at
// the deepest existing ancestor, since a directory that does not exist holds nothing.
function findRoot(start) {
  let dir = deepestExisting(start).existing;
  for (let steps = 0; steps <= start.length; steps++) {
    if (lstatOrNull(join(dir, '.git')) !== null) return dir;
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

// Whether a directory is shaped like a git directory: HEAD, objects/ and refs/ in it.
const isGitDirShaped = (dir) => lstatOrNull(join(dir, 'HEAD'))?.isFile() === true
  && lstatOrNull(join(dir, 'objects'))?.isDirectory() === true && lstatOrNull(join(dir, 'refs'))?.isDirectory() === true;

// A path word as git and the kernel read it: `//` and `/./` collapsed, a leading `./` dropped.
const normalizePath = (text) => text.replace(/\/{2,}/g, '/').replace(/\/(?:\.\/)+/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/\.$/, '');

// The directories a call is made from: the call's `cwd`, else CLAUDE_PROJECT_DIR, and that
// project directory. Either over MAX_PATH_LENGTH blocks.
function sessionDirs(payload) {
  for (const dir of [payload.cwd, process.env.CLAUDE_PROJECT_DIR]) {
    if (typeof dir === 'string' && dir.length > MAX_PATH_LENGTH) refuse(MESSAGES.pathTooLong);
  }
  const absolute = (dir) => (typeof dir === 'string' && isAbsolute(dir) ? dir : null);
  const project = absolute(process.env.CLAUDE_PROJECT_DIR);
  return { cwd: absolute(payload.cwd) ?? project, project };
}

// ---------------------------------------------------------------------------
// Bash, words: wrappers, the command word, text values

// Reserved words skipped before a command word.
const RESERVED = new Set(['!', '{', '}', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'coproc']);

// The name a word runs as: its last path segment, lower-cased, without `.exe`, and without the
// `=` or `{` zsh allows in front of a command word.
function commandName(word) {
  if (word.name !== undefined) return word.name;
  let text = word.text;
  if (word.plain > 0 && (text[0] === '=' || text[0] === '{')) text = text.slice(1);
  const name = text.slice(text.lastIndexOf('/') + 1).toLowerCase();
  word.name = name.endsWith('.exe') ? name.slice(0, -4) : name;
  return word.name;
}

// Skips a wrapper's options: `valued` short letters and `longValued` long names take the next
// word as their value (or the rest of the word); `positional` words (timeout's duration,
// repeat's count) come before the command.
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

// The wrappers skipped to find the command word (env is read by readEnv below).
const WRAPPERS = {
  command: optionSkipper(),
  builtin: optionSkipper(),
  sudo: optionSkipper({ valued: 'ugpCDrtUThR', longValued: ['--user', '--group', '--prompt', '--close-from', '--chdir', '--role', '--type', '--other-user', '--command-timeout', '--host', '--chroot'], assignments: true }),
  doas: optionSkipper({ valued: 'uCa' }),
  nice: optionSkipper({ valued: 'n', longValued: ['--adjustment'] }),
  ionice: optionSkipper({ valued: 'cnpPu', longValued: ['--class', '--classdata', '--pid', '--pgid', '--uid'] }),
  time: optionSkipper({ valued: 'fo', longValued: ['--format', '--output'] }),
  xargs: optionSkipper({ valued: 'IdaELnPs', longValued: ['--arg-file', '--delimiter', '--max-args', '--max-lines', '--max-procs', '--max-chars', '--process-slot-var'] }),
  exec: optionSkipper({ valued: 'a' }),
  nohup: optionSkipper(),
  timeout: optionSkipper({ valued: 'sk', longValued: ['--signal', '--kill-after'], positional: 1 }),
  stdbuf: optionSkipper({ valued: 'ioe', longValued: ['--input', '--output', '--error'] }),
  setsid: optionSkipper(),
  noglob: optionSkipper(),
  nocorrect: optionSkipper(),
  '-': optionSkipper(),
  repeat: optionSkipper({ positional: 1 }),
  busybox: optionSkipper(),
  taskset: optionSkipper({ positional: 1 }),
  chrt: optionSkipper({ valued: 'TPD', longValued: ['--sched-runtime', '--sched-period', '--sched-deadline'], positional: 1 }),
  flock: optionSkipper({ valued: 'wE', longValued: ['--timeout', '--conflict-exit-code'], positional: 1 }),
  watch: optionSkipper({ valued: 'n', longValued: ['--interval'] }),
  unbuffer: optionSkipper(),
};

// env's options. Its short `u C a S` and long `--unset --chdir --argv0 --split-string` take a
// value; a lone `-` is -i. The string of -S is split into words and JOINED with the words after
// it, then read again as env's own, as env does. Returns the words (rebuilt for -S), the index
// after env's options, its assignments and the names it unsets; `unseen` holds a -S string
// that cannot be split.
const ENV_VALUED = 'uCaS';
const ENV_LONG_VALUED = new Set(['--unset', '--chdir', '--argv0', '--split-string']);
function readEnv(words, from) {
  const result = { words, next: from, assignments: [], unsets: [], unseen: null, cleared: false };
  let i = from;
  for (let splits = 0; i < result.words.length;) {
    const word = result.words[i];
    const text = word.text;
    if (text === '--') {
      i++;
      break;
    }
    if (text === '-') {
      result.cleared = true;
      i++;
      continue;
    }
    // env(1) takes any NAME=VALUE whose name is not empty and holds no =, not only a shell
    // identifier: `env 'BASH_FUNC_git%%=() { …; }' git` sets an exported function.
    if (ENV_ASSIGNMENT.test(text)) {
      result.assignments.push(word);
      i++;
      continue;
    }
    if (!text.startsWith('-')) break;
    let option = null;
    let value;
    let width = 1;
    if (text.startsWith('--')) {
      const equals = text.indexOf('=');
      option = equals === -1 ? text : text.slice(0, equals);
      // --ignore-environment, as written or abbreviated as env accepts it.
      if (option.length > 3 && '--ignore-environment'.startsWith(option)) result.cleared = true;
      if (equals !== -1) value = text.slice(equals + 1);
      else if (ENV_LONG_VALUED.has(option)) {
        value = result.words[i + 1]?.text;
        width = 2;
      }
    } else {
      const k = [...text].findIndex((char, index) => index > 0 && ENV_VALUED.includes(char));
      if (text.slice(1, k === -1 ? undefined : k).includes('i')) result.cleared = true;
      if (k !== -1) {
        option = text[k];
        value = text.slice(k + 1) || result.words[i + 1]?.text;
        width = text.slice(k + 1) === '' ? 2 : 1;
      }
    }
    if (option === 'u' || option === '--unset') result.unsets.push(value ?? '');
    if (option === 'S' || option === '--split-string') {
      const split = splits++ < MAX_DEPTH ? parseScript(value ?? '', 1) : null;
      if (split === null || split.length > 1 || (split.length === 1 && split[0].redirects.length > 0)) {
        result.unseen = value ?? '';
        i += width;
        break;
      }
      const inserted = split.length === 0 ? [] : [...split[0].assignments, ...split[0].words];
      result.words = [...result.words.slice(0, i), ...inserted, ...result.words.slice(i + width)];
      continue;
    }
    i += width;
  }
  result.next = i;
  return result;
}

// The command a simple command runs, past reserved words, `function NAME` and the wrappers:
// { words, index, word, name, wrappers, envAssignments, unsets, unseen } with `word`
// undefined when there is none. `words` is the command's words, with env -S strings joined in.
function resolveCommand(command) {
  const resolved = { words: command.words, index: 0, word: undefined, name: '', wrappers: [], envAssignments: [], unsets: [], unseen: null, cleared: false };
  let index = 0;
  for (let steps = 0; index < resolved.words.length && steps <= resolved.words.length * 2 + MAX_DEPTH; steps++) {
    const word = resolved.words[index];
    if (word.expands) break;
    if (!word.quoted && RESERVED.has(word.text)) {
      index++;
      continue;
    }
    if (isKeyword(word, 'function')) {
      const name = resolved.words[index + 1];
      index += name !== undefined && !RESERVED.has(name.text) ? 2 : 1;
      continue;
    }
    const name = commandName(word);
    if (name === 'env') {
      const env = readEnv(resolved.words, index + 1);
      resolved.words = env.words;
      resolved.envAssignments.push(...env.assignments);
      resolved.unsets.push(...env.unsets);
      resolved.unseen ??= env.unseen;
      resolved.cleared ||= env.cleared;
      resolved.wrappers.push(name);
      index = env.next;
      continue;
    }
    if (!Object.hasOwn(WRAPPERS, name)) break;
    resolved.wrappers.push(name);
    index = Math.max(WRAPPERS[name](resolved.words, index + 1), index + 1);
  }
  resolved.index = index;
  resolved.word = resolved.words[index];
  resolved.name = resolved.word === undefined ? '' : commandName(resolved.word);
  return resolved;
}

// Text values: words that are a message, a body, a search pattern or echo's output (only while
// that output goes to readers and is not substituted into another command's words), never a
// path or a flag. `git` is the command's git invocation, or null.
const MESSAGE_SUBCOMMANDS = new Set(['commit', 'tag', 'merge', 'stash', 'notes']);
const SEARCH_SUBCOMMANDS = new Set(['log', 'show', 'shortlog', 'whatchanged', 'rev-list']);
// Search commands whose pattern is a text value. sed's and awk's programs are not: they can
// write files (sed's w command and s///w flag, awk's print >), so they are code (see sedPrograms
// and ALWAYS_CODE).
const PATTERN_COMMANDS = new Set(['grep', 'egrep', 'fgrep', 'rg']);
// Exclusion options, whose values are patterns, not paths, for the commands in EXCLUDING only.
const EXCLUDE_OPTIONS = ['--exclude', '--exclude-dir', '--exclude-from'];
const EXCLUDING = new Set(['tar', 'rsync', 'grep', 'rg', 'zip', 'du', 'diff', 'find']);
// find's name tests, whose pattern is a text value in the form `TEST PATTERN -prune -o ...`
// only, and never with -depth, -d or -delete, which make -prune keep nothing out.
const FIND_PRUNED = new Set(['-path', '-ipath', '-name', '-iname', '-wholename', '-iwholename']);
const PATTERN_OPTIONS = new Set(['-e', '--regexp', '--expression', '-f', '--file']);

// The words of `args` that are values of the options named: separate (`--grep x`), after `=`
// (`--grep=x`), or attached to a short one (`-Sx`, `-am x` for a letter in `shortLetters`); up to
// `--`, or past it with `pastDoubleDash` (`npm test -- --grep x` hands the option on).
const NO_VALUES = new Set();

function optionValues(args, longNames, shortLetters, pastDoubleDash = false) {
  const values = new Set();
  for (let i = 0; i < args.length; i++) {
    const text = args[i].text;
    if (text === '--' && !pastDoubleDash) break;
    if (text.startsWith('--')) {
      const name = text.split('=', 1)[0];
      if (!longNames.includes(name)) continue;
      if (text.includes('=')) values.add(args[i]);
      else if (args[i + 1] !== undefined) values.add(args[++i]);
    } else if (/^-[A-Za-z]/.test(text)) {
      const k = [...text].findIndex((char, index) => index > 0 && shortLetters.includes(char));
      if (k === -1) continue;
      if (k < text.length - 1) values.add(args[i]);
      else if (args[i + 1] !== undefined) values.add(args[++i]);
    }
  }
  return values;
}

// Long options whose values are text for any command: messages, titles, test-name patterns; and
// -k for pytest alone (pytest, py.test, python -m pytest), since -k is code or a path elsewhere
// (`parallel -k`, `tar -k`). These values are free of the flag, owner and code checks; unlike the
// text values above they are still judged as paths, since an unknown command may read such an
// option's value as a file.
const LOOSE_TEXT_OPTIONS = ['--grep', '--testNamePattern', '--test-name-pattern', '--title', '--body', '--message', '--description', '--label', '--name'];
function looseTextValues(resolved) {
  const args = resolved.words.slice(resolved.index + 1);
  const pytest = /^(pytest|py\.test)$/.test(resolved.name) || (/^python[0-9.]*$/.test(resolved.name) && args[0]?.text === '-m' && args[1]?.text === 'pytest');
  return optionValues(args, LOOSE_TEXT_OPTIONS, pytest ? 'k' : '', true);
}

// The first operand of a search command (its pattern), unless -e or -f gave the pattern.
function firstOperand(args) {
  if (args.some((word) => PATTERN_OPTIONS.has(word.text.split('=', 1)[0]))) return null;
  return args.find((word) => !word.text.startsWith('-')) ?? null;
}

// The exclusion patterns of a command in EXCLUDING whose output goes only to reading commands:
// --exclude and its kin, zip's -x operands, and find's pattern in `TEST PATTERN -prune -o`.
function exclusions(resolved, outputReadOnly) {
  if (!EXCLUDING.has(resolved.name) || !outputReadOnly) return NO_VALUES;
  const args = resolved.words.slice(resolved.index + 1);
  const values = optionValues(args, EXCLUDE_OPTIONS, '');
  const pruneKeepsOut = !args.some((word) => word.text === '-depth' || word.text === '-d' || word.text === '-delete');
  for (let i = 0; i < args.length; i++) {
    if (resolved.name === 'zip' && (args[i].text === '-x' || args[i].text === '--exclude')) {
      for (let k = i + 1; k < args.length && !args[k].text.startsWith('-'); k++) values.add(args[k]);
    }
    if (resolved.name === 'find' && pruneKeepsOut && FIND_PRUNED.has(args[i].text) && args[i + 2]?.text === '-prune' && args[i + 3]?.text === '-o') values.add(args[i + 1]);
  }
  return values;
}

function textValues(resolved, git, outputReadOnly, substituted = false) {
  const values = ownTextValues(resolved, git, outputReadOnly, substituted);
  const excluded = exclusions(resolved, outputReadOnly);
  return excluded.size === 0 ? values : new Set([...values, ...excluded]);
}

function ownTextValues(resolved, git, outputReadOnly, substituted) {
  const args = resolved.words.slice(resolved.index + 1);
  const { name } = resolved;
  if ((name === 'echo' || name === 'printf') && outputReadOnly && !substituted) return new Set(args);
  if (git !== null) {
    const values = new Set();
    if (MESSAGE_SUBCOMMANDS.has(git.sub)) for (const word of optionValues(git.rest, ['--message'], 'm')) values.add(word);
    if (SEARCH_SUBCOMMANDS.has(git.sub)) for (const word of optionValues(git.rest, ['--grep', '--author', '--committer'], 'SG')) values.add(word);
    if (git.sub === 'grep') {
      for (const word of optionValues(git.rest, ['--regexp'], 'e')) values.add(word);
      const pattern = firstOperand(git.rest);
      if (pattern !== null) values.add(pattern);
    }
    return values;
  }
  if (name === 'gh') return optionValues(args, ['--body', '--title', '--notes', '--raw-field', '--field'], 'btfF');
  if (name === 'node') return optionValues(args, ['--test-name-pattern', '--test-skip-pattern'], '');
  if (PATTERN_COMMANDS.has(name)) {
    const values = optionValues(args, ['--regexp', '--expression'], 'e');
    const pattern = firstOperand(args);
    if (pattern !== null) values.add(pattern);
    return values;
  }
  return NO_VALUES;
}

// ---------------------------------------------------------------------------
// Bash, the guarded area: the whole git directory

const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'stat', 'file', 'wc', 'grep', 'rg', 'test', '[', 'diff', 'cmp', 'sha256sum', 'less', 'jq', 'echo', 'printf', 'find']);
const READ_ONLY_GIT = new Set(['log', 'show', 'diff', 'status', 'ls-files', 'rev-parse', 'cat-file', 'grep', 'blame']);
// Options with which a read-only command writes or runs something after all.
const WRITING_OPTIONS = {
  find: /^-(delete|exec|execdir|ok|okdir|fprint.*|fls)$/,
  rg: /^--pre/,
  less: /^(-[oO]|--log-file|--LOG-FILE)/,
  file: /^(-C|--compile)$/,
  git: /^(--output(=|$)|--open-files-in-pager|-[A-Za-z]*O)/,
};
const WRITES_TO_FILES = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);
const MAX_BRACE_VARIANTS = 64;
const MAX_BRACE_WORD = 4096;

// Brace expansion of a word, `{a,b}` and `{x..y}` (single characters or small integers), at
// most MAX_BRACE_VARIANTS results; null when there would be more or the word is too long.
// Every brace counts, quoted or not: more variants, never fewer.
function braceVariants(text) {
  if (text.length > MAX_BRACE_WORD) return null;
  const done = [];
  const pending = [text];
  for (let steps = 0; pending.length > 0; steps++) {
    if (steps > 4 * MAX_BRACE_VARIANTS) return null;
    const item = pending.pop();
    const brace = firstBrace(item);
    if (brace === null) {
      done.push(item);
      if (done.length > MAX_BRACE_VARIANTS) return null;
    } else {
      if (brace.options.length > MAX_BRACE_VARIANTS) return null;
      for (const option of brace.options) pending.push(brace.before + option + brace.after);
    }
  }
  return done;
}

// The options of a sequence `x..y`, or null when it is not one.
function sequenceOptions(inner) {
  const match = /^(-?[0-9]+|[A-Za-z])\.\.(-?[0-9]+|[A-Za-z])$/.exec(inner);
  if (match === null) return null;
  const numeric = /[0-9]/.test(match[1]);
  if (numeric !== /[0-9]/.test(match[2])) return null;
  const from = numeric ? Number(match[1]) : match[1].charCodeAt(0);
  const to = numeric ? Number(match[2]) : match[2].charCodeAt(0);
  if (Math.abs(to - from) > MAX_BRACE_VARIANTS) return [...Array(MAX_BRACE_VARIANTS + 1)].map(() => '');
  const step = from <= to ? 1 : -1;
  const options = [];
  for (let value = from; value !== to + step; value += step) options.push(numeric ? String(value) : String.fromCharCode(value));
  return options;
}

// The first `{a,b}` or `{x..y}` in a text whose braces balance.
function firstBrace(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    const commas = [];
    for (let k = start; k < text.length; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === ',' && depth === 1) commas.push(k);
      else if (text[k] === '}' && --depth === 0) {
        const before = text.slice(0, start);
        const after = text.slice(k + 1);
        if (commas.length > 0) {
          const cuts = [start, ...commas, k];
          return { before, options: cuts.slice(1).map((cut, n) => text.slice(cuts[n] + 1, cut)), after };
        }
        const sequence = sequenceOptions(text.slice(start + 1, k));
        if (sequence !== null) return { before, options: sequence, after };
        break;
      }
    }
  }
  return null;
}

// The texts a word stands for after brace expansion; null when that is too many to list.
const variantsOf = (word) => (word.special ? braceVariants(word.text) : [word.text]);

// The real git directories of the session's repository and of the project's, lower-cased,
// read once per call and only for a word that is an absolute path.
function gitDirTexts(context) {
  if (context.gitDirTexts === undefined) {
    const texts = [];
    for (const dir of [context.cwd, context.project]) {
      const real = dir === null ? null : realOfDeepest(dir);
      const dirs = real === null ? null : gitDirsAround(real);
      if (dirs !== null) texts.push(dirs.gitDir.toLowerCase(), dirs.commonDir.toLowerCase());
    }
    context.gitDirTexts = texts;
  }
  return context.gitDirTexts;
}

// Whether a text, as a path, is in the git directory: a `.git` segment (a pattern segment
// starting with `.` that can match `.git` counts), or an absolute path inside the real git
// directories of the session's repository. Each whitespace-separated part is matched (xargs and
// a shell split a word there), as written and after its first `=`.
function guardedText(text, pattern, context) {
  // Without a `.` or a leading `/` no part can hold a `.git` segment or be an absolute path.
  if (!text.includes('.') && !text.includes('/')) return false;
  const parts = /\s/.test(text) ? text.split(/\s+/) : [text];
  for (const part of parts.flatMap((part) => (part.includes('=') ? [part, part.slice(part.indexOf('=') + 1)] : [part]))) {
    const lower = normalizePath(part).toLowerCase();
    for (const segment of lower.split('/')) {
      if (segment === '.git' || (pattern && segment.startsWith('.') && segmentMatches(segment.replace(/\[[^\]]*\]/g, '?'), '.git'))) return true;
    }
    if (lower.startsWith('/') && gitDirTexts(context).some((dir) => lower === dir || lower.startsWith(`${dir}/`))) return true;
  }
  return false;
}

// Whether an expansion in a word is followed by a `/hooks` or `/kh-orchestration` segment
// (`"$(git rev-parse --git-common-dir)/hooks"`, `$D/kh-orchestration/off`).
function expansionBeforeGuardedSegment(word) {
  for (const [, end] of word.spans) {
    let at = end;
    if (word.text[at] !== '/') continue;
    while (word.text[at] === '/' || (word.text[at] === '.' && word.text[at + 1] === '/')) at++;
    const next = word.text.slice(at, at + 17).toLowerCase();
    for (const name of ['hooks', 'kh-orchestration']) {
      if (next.startsWith(name) && (next.length === name.length || next[name.length] === '/')) return true;
    }
  }
  return false;
}

// A `.git` segment followed by /hooks, /config or /kh-orchestration, as a token in a text with
// quotes and backslashes removed: at the start, after a short option glued to it
// (`-o.git/hooks/x`), or after a character that is not a word character. In a sed program also after one of w W r R not preceded by a letter, since GNU sed
// takes a file name straight after those commands (`w.git/hooks/pre-commit`).
const GUARDED_TOKEN = /(?:^|^-[A-Za-z]+|[^A-Za-z0-9_])\.git\/+(?:hooks|config|kh-orchestration)(?![A-Za-z0-9_])/i;
const SED_GUARDED_TOKEN = /(?:^|[^A-Za-z0-9_]|(?<![A-Za-z])[wWrR])\.git\/+(?:hooks|config|kh-orchestration)(?![A-Za-z0-9_])/i;
const stripQuotes = (text) => normalizePath(text.replace(/['"\\]/g, ''));

// A bare `.git` token inside a substitution, whose output becomes the word (`cd $(echo .git)`).
const GIT_IN_SUBSTITUTION = /(?:^|[\s(`/])\.git(?=$|[\s)/`])/;
// A substitution asking git where its directory is (`$(git rev-parse --git-path hooks)`).
const GIT_DIR_QUERY = /\brev-parse\b[^)`]*?--(?:git-dir|git-common-dir|absolute-git-dir|git-path)\b/;

function guardedWord(word, context) {
  if (expansionBeforeGuardedSegment(word) || word.spans.some(([start, end]) => GIT_DIR_QUERY.test(word.text.slice(start, end)))) return true;
  if (GUARDED_TOKEN.test(stripQuotes(word.text))) return true;
  if (word.spans.some(([start, end]) => GIT_IN_SUBSTITUTION.test(stripQuotes(word.text.slice(start, end))))) return true;
  const variants = variantsOf(word);
  if (variants === null) return /\.g/i.test(word.text);
  return variants.some((text) => guardedText(text, word.special, context));
}

// Whether a command's own word only reads: its command word is read-only (git with a
// read-only subcommand), run directly (no assignment, no wrapper), with none of the options by
// which such a command writes or runs something. xargs is the one wrapper allowed, and only for
// a command that has no such options at all, since xargs can add any word from its input.
function readsOnly(command, resolved, git) {
  if (command.assignments.length > 0 || resolved.wrappers.some((name) => name !== 'xargs') || resolved.word === undefined || resolved.word.expands) return false;
  if (resolved.wrappers.includes('xargs') && (git !== null || Object.hasOwn(WRITING_OPTIONS, resolved.name))) return false;
  const args = resolved.words.slice(resolved.index + 1).map((word) => word.text);
  if (git !== null) return READ_ONLY_GIT.has(git.sub) && !args.some((text) => WRITING_OPTIONS.git.test(text));
  if (!READ_ONLY.has(resolved.name)) return false;
  const writing = WRITING_OPTIONS[resolved.name];
  return writing === undefined || !args.some((text) => writing.test(text));
}

// Whether a command and every command its output is piped into read only. Each command's
// answer is kept on it, so a long pipeline is walked once.
function pipelineReadsOnly(command) {
  const chain = [];
  for (let at = command; at !== null && at.pipelineReadsOnly === undefined; at = at.pipedTo) chain.push(at);
  for (let k = chain.length - 1; k >= 0; k--) {
    const at = chain[k];
    const resolved = resolveCommand(at);
    at.pipelineReadsOnly = readsOnly(at, resolved, gitInvocation(resolved)) && (at.pipedTo === null || at.pipedTo.pipelineReadsOnly);
  }
  return command.pipelineReadsOnly;
}

const writesTo = (redirect) => WRITES_TO_FILES.has(redirect.base) && !(redirect.base === '>&' && /^([0-9]+|-)$/.test(redirect.target.text));

// `rm -f .git/index.lock`, exactly: the one write to the git directory allowed (a stale lock).
function removesIndexLock(command) {
  const texts = command.words.map((word) => normalizePath(word.text));
  return command.assignments.length === 0 && command.redirects.length === 0 && texts.length === 3
    && texts[0] === 'rm' && texts[1] === '-f' && texts[2] === '.git/index.lock';
}

// Whether the session's working directory is inside a git directory: a `.git` segment in its
// real path, or an ancestor shaped like a git directory (a bare or separate one).
function cwdInGitDir(context) {
  if (context.inGitDir === undefined) {
    const real = context.cwd === null ? null : realOfDeepest(context.cwd) ?? context.cwd;
    let inside = real !== null && real.toLowerCase().split(sep).includes('.git');
    for (let dir = real, steps = 0; !inside && dir !== null && steps <= real.length; steps++) {
      inside = isGitDirShaped(dir);
      const parent = dirname(dir);
      dir = parent === dir ? null : parent;
    }
    context.inGitDir = inside;
  }
  return context.inGitDir;
}

// git rev-parse printing the git directory names it: its output may only be piped into reading commands.
const printsGitDir = (git) => git?.sub === 'rev-parse' && git.rest.some((word) => /^--(git-dir|git-common-dir|absolute-git-dir|git-path)$/.test(word.text));

// find that writes or runs something, with a name or path pattern that could match a hook,
// the state or the git directory (`find . -name pre-commit -delete`, `-path '*hooks/*'`).
const FIND_PATTERNS = new Set(['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex', '-lname', '-ilname']);
const GUARDED_NAMES = ['.git', 'hooks', 'kh-orchestration', 'pre-commit', 'pre-merge-commit'];
function findPatternGuarded(resolved) {
  if (resolved.name !== 'find') return false;
  const args = resolved.words.slice(resolved.index + 1);
  if (!args.some((word) => WRITING_OPTIONS.find.test(word.text))) return false;
  return args.some((word, index) => index > 0 && FIND_PATTERNS.has(args[index - 1].text) && (() => {
    const lower = word.text.toLowerCase();
    const last = lower.slice(lower.lastIndexOf('/') + 1).replace(/\[[^\]]*\]/g, '?');
    return GUARDED_NAMES.some((name) => lower.includes(name) || segmentMatches(last, name));
  })());
}

function judgeGuardedArea(command, resolved, git, values, context) {
  const reads = readsOnly(command, resolved, git) && (command.pipedTo === null || pipelineReadsOnly(command.pipedTo));
  if (!reads || command.redirects.some((redirect) => writesTo(redirect) && !redirect.target.text.startsWith('/'))) {
    if (cwdInGitDir(context)) refuse(MESSAGES.gitDirCwd);
  }
  const named = [...command.assignments, ...resolved.envAssignments, ...resolved.words.filter((word, index) => index !== resolved.index && !values.has(word))]
    .some((word) => guardedWord(word, context));
  const redirected = command.redirects.filter((redirect) => guardedWord(redirect.target, context));
  if (!named && redirected.length === 0 && !printsGitDir(git) && !findPatternGuarded(resolved)) return;
  if (removesIndexLock(command)) return;
  if (!reads || redirected.some(writesTo)) refuse(MESSAGES.guardedPath);
}

// ---------------------------------------------------------------------------
// Bash, git commands

// git's global options that take the next word as their value.
const GIT_VALUED = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source']);
// Subcommands whose hooks are the commit gate's; and those that take --no-verify harmlessly.
const GATED = new Set(['commit', 'merge', 'pull']);
const HARMLESS_NO_VERIFY = new Set(['push', 'rebase', 'am', 'fetch']);
// Subcommands that, run through xargs, take words from its input the hook cannot see.
const XARGS_HIDDEN = new Set(['commit', 'merge', 'pull', 'config', 'commit-tree']);
// Environment that changes git's configuration or programs: on any command for GIT_CONFIG*,
// on a git command for the rest.
const GIT_CONFIG_ENV = /^GIT_CONFIG[A-Za-z0-9_]*\+?=/i;
// PATH: a git command's PATH decides which programs its hooks start. GIT_COMMON_DIR: git looks
// for its hooks under it, so another one runs no hook of ours at all. The Node variables that load
// code or write files (NODE_OPTIONS, NODE_PATH, NODE_REPL_EXTERNAL_MODULE, NODE_EXTRA_CA_CERTS,
// NODE_V8_COVERAGE, NODE_COMPILE_CACHE), LD_* and DYLD_*: they load code into a process. The hooks
// start node through env -i, which drops all of these, so for them this rule is defence in depth;
// other NODE_* names (NODE_ENV, NODE_NO_WARNINGS) are everyday and allowed.
// TMOUT, SHELLOPTS, PS4, BASH_ENV, ENV and BASH_FUNC_*: they steer the shell a hook runs in.
const GUARDED_ENV = '(?:HOME|XDG_CONFIG_HOME|GIT_EXEC_PATH|GIT_COMMON_DIR|PATH|NODE_(?:OPTIONS|PATH|REPL_EXTERNAL_MODULE|EXTRA_CA_CERTS|V8_COVERAGE|COMPILE_CACHE)|LD_[A-Za-z0-9_]*|DYLD_[A-Za-z0-9_]*|TMOUT|SHELLOPTS|PS4|BASH_ENV|ENV|BASH_FUNC_[^=]*)';
const GIT_ENV = new RegExp(`^${GUARDED_ENV}\\+?=`, 'i');
// A variable set or exported elsewhere in a line that runs git reaches git's hooks just as well
// (decision 15, addition after Task 6's fourth re-review): these and GIT_CONFIG_*.
const EXPORTED_GUARD = new RegExp(`^(?:${GUARDED_ENV}|GIT_CONFIG[A-Za-z0-9_]*)$`, 'i');
const SETS_EXPORTS = new Set(['export', 'declare', 'typeset', 'readonly', 'local']);

// The git invocation a resolved command is, or null: git by its basename, or git-<sub> read as
// git <sub>. { sub, rest, configs, execPath }: the subcommand, the words after it, the k=v of
// each -c and --config-env, and whether --exec-path= names a directory.
function gitInvocation(resolved) {
  const args = resolved.words.slice(resolved.index + 1);
  if (resolved.name.startsWith('git-') && resolved.name.length > 4) return { sub: resolved.name.slice(4), rest: args, configs: [], execPath: false };
  if (resolved.name !== 'git') return null;
  const configs = [];
  let execPath = false;
  let i = 0;
  while (i < args.length && args[i].text.startsWith('-')) {
    const text = args[i].text;
    if (text === '-c' || text === '--config-env') configs.push(args[i + 1]?.text ?? '');
    else if (text.startsWith('--config-env=')) configs.push(text.slice('--config-env='.length));
    else if (text.startsWith('-c')) configs.push(text.slice(2));
    else if (text.startsWith('--exec-path=')) execPath = true;
    i += GIT_VALUED.has(text) ? 2 : 1;
  }
  return { sub: args[i]?.text, rest: args.slice(i + 1), configs, execPath };
}

// A configuration key that redirects or turns off hooks.
// Keys that name a command git runs (decision 15, addition after Task 6's third re-review): a clean
// filter or a monitor runs inside the gate's own git calls and can blind what it reads.
const COMMAND_KEY = /^(?:core\.(?:fsmonitor|sshcommand|editor|pager)|filter\..+\.(?:clean|smudge|process)|diff\.external|diff\..+\.(?:command|textconv)|merge\..+\.driver|sequence\.editor|pager\..+|gpg\.program|gpg\..+\.program)$/;
function hookKey(key) {
  const lower = key.toLowerCase();
  return lower === 'core.hookspath' || lower.startsWith('include.') || lower.startsWith('includeif.') || lower.startsWith('alias.') || /^branch\..*\.mergeoptions$/.test(lower)
    || COMMAND_KEY.test(lower);
}
// A section whose renaming or removal can do the same.
const hookSection = (name) => /^(core|include|includeif.*|alias|branch.*|filter.*|diff.*|merge.*|pager|gpg.*|sequence)$/i.test(name);

const CONFIG_VALUED = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value']);
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '-l', '--list']);
const CONFIG_WRITES = new Set(['--add', '--replace-all', '--unset', '--unset-all']);
const CONFIG_SECTIONS = new Set(['--rename-section', '--remove-section', 'rename-section', 'remove-section']);
const CONFIG_ACTIONS = new Set(['get', 'set', 'unset', 'list', 'edit', 'rename-section', 'remove-section', 'get-color', 'get-colorbool']);

// git config: a write (old or new syntax) of a hook key, a section change of a hook section, or --edit.
// The classic form stops reading options at its first operand (a value may begin with -). In the
// subcommand form (`git config set --local <key> <value>`) options stand anywhere after the
// subcommand, so they are skipped wherever they are to find the key.
function configChangesHooks(rest) {
  const options = [];
  const operands = [];
  let ended = false;
  for (let i = 0; i < rest.length; i++) {
    const text = rest[i].text;
    const subcommandForm = operands.length > 0 && CONFIG_ACTIONS.has(operands[0]);
    if (!ended && text === '--') ended = true;
    else if (!ended && text.startsWith('-') && (operands.length === 0 || subcommandForm)) {
      options.push(text.split('=', 1)[0]);
      if (CONFIG_VALUED.has(text)) i++;
    } else operands.push(text);
  }
  const action = CONFIG_ACTIONS.has(operands[0]) ? operands.shift() : null;
  if (action === 'edit' || options.includes('--edit') || options.includes('-e')) return true;
  if (CONFIG_SECTIONS.has(action) || options.some((option) => CONFIG_SECTIONS.has(option))) return operands.some(hookSection);
  const writes = action !== null ? action === 'set' || action === 'unset'
    : options.some((option) => CONFIG_WRITES.has(option)) || (!options.some((option) => CONFIG_READS.has(option)) && operands.length >= 2);
  return writes && operands.length > 0 && hookKey(operands[0]);
}

const isNoVerify = (text) => text.length >= 6 && '--no-verify'.startsWith(text);
// The shortest abbreviation git accepts, looked for anywhere in the raw text of a word that holds an expansion.
const NO_VERIFY_PREFIX = '--no-v';

// A word's text outside its expansions.
function literalOf(word) {
  let literal = '';
  let at = 0;
  for (const [start, end] of word.spans) {
    literal += word.text.slice(at, start);
    at = end;
  }
  return literal + word.text.slice(at);
}

// A plain parameter, `$NAME` or `${NAME}`: the one expansion a merge or pull operand may hold.
const PLAIN_PARAMETER = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/;

// Whether an expansion could be a flag. On commit, merge and pull, a word whose literal text
// begins with `-`, or that holds anything but plain parameters (a command substitution,
// backticks, `${NAME<op>...}`, `$@`), may; on commit, so may a word that is wholly an expansion.
// A branch or remote given as "$BRANCH" or "origin/${BRANCH}" is allowed, and on commit so is
// a long option's value made of quoted plain parameters (`--author="$A"`), which cannot split.
const quotedLongValue = (word) => /^--[A-Za-z-]+=/.test(word.text)
  && word.spans.every(([start, end, quoted]) => quoted && start > word.text.indexOf('=') && PLAIN_PARAMETER.test(word.text.slice(start, end)));
function hidesOption(sub, word) {
  if (!word.expands) return false;
  if (sub === 'commit' && quotedLongValue(word)) return false;
  const literal = literalOf(word);
  if (literal.startsWith('-') || (sub === 'commit' && literal === '')) return true;
  return word.spans.some(([start, end]) => !PLAIN_PARAMETER.test(word.text.slice(start, end)));
}

// A message or message file, on commit and merge (pull has none): the word after -m, --message,
// -F or --file, or after a short bundle ending in m or F whose letters before it are no `n` and
// no value letter (-am, -sm, -qam, -aF); or a value glued to one (-mText, -am"$MSG",
// --message=Text). The one place a flag word is free, and only while the option itself stands
// in option position: after a word that begins with `-` and has no `=` (which git may take as
// that word's value, as in `--trailer -m -n`), a message word that is a literal flag word blocks,
// and so does one holding an expansion whose literal text begins with `-` or whose text holds
// --no-v (`-m "-$N"`). A message word there that is wholly an expansion (`-m "$N"`) is not
// judged: a stated limit.
const MESSAGE_OPTIONS = new Set(['-m', '--message', '-F', '--file']);
const GLUED_LONG_MESSAGE = /^(--message=|--file=)/;
const bundleBefore = (text, at) => [...text.slice(1, at)].every((letter) => /[A-Za-z]/.test(letter) && letter !== 'n' && !COMMIT_VALUED_LETTERS.includes(letter));
const isMessageOption = (text) => MESSAGE_OPTIONS.has(text) || (/^-[A-Za-z]+[mF]$/.test(text) && bundleBefore(text, text.length - 1));
function isGluedMessage(text) {
  if (GLUED_LONG_MESSAGE.test(text)) return true;
  const at = text.search(/[mF]/);
  return text.startsWith('-') && !text.startsWith('--') && at > 0 && at < text.length - 1 && bundleBefore(text, at);
}
// commit's short letters that take a value: a bundle's letters after one of them are its value.
const COMMIT_VALUED_LETTERS = 'mFCctuS';

// Whether a word is a flag that turns the hooks off: a prefix of --no-verify of six or more
// characters, or on commit `-n` or a short bundle holding `n` before a value-taking letter
// (any character counts as a bundle letter: git refuses `-n#x`, the module need not know that).
function skipsHooks(sub, text) {
  if (isNoVerify(text)) return true;
  if (sub !== 'commit' || !/^-[^-]/.test(text)) return false;
  for (const letter of text.slice(1)) {
    if (letter === 'n') return true;
    if (COMMIT_VALUED_LETTERS.includes(letter)) return false;
  }
  return false;
}

// An unquoted command substitution, backticks or `${...}` operation is split by the shell into
// words of its own, any of which may be a flag, even in a message's place.
const splitsIntoFlags = (word) => word.spans.some(([start, end, quoted]) => !quoted && !PLAIN_PARAMETER.test(word.text.slice(start, end)));

// git commit, merge or pull, every word in ANY position, before or after `--`, whatever option
// precedes it (git's abbreviations let `--mess -- -n` take `--` as a value and keep `-n` live):
// a flag that turns the hooks off (skipsHooks), an expanding word whose raw text holds --no-v
// (`${X:---no-verify}`), or an expanding word that may hide a flag (hidesOption). The one
// exception is a message (isMessageOption, isGluedMessage), unless it is split into flags or,
// after a word that may take the message option as its value, is itself a flag word.
function judgeGated(sub, rest) {
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    const before = rest[i - 1]?.text;
    const swallowable = before !== undefined && before.startsWith('-') && !before.includes('=');
    const message = sub === 'pull' ? null : isMessageOption(word.text) ? rest[++i] : isGluedMessage(word.text) ? word : null;
    if (message !== null) {
      if (message !== undefined && splitsIntoFlags(message)) refuse(MESSAGES.hiddenOption);
      if (message !== undefined && message !== word && swallowable && (variantsOf(message) ?? [message.text]).some((text) => skipsHooks(sub, text))) refuse(MESSAGES.noVerify);
      if (message !== undefined && message !== word && swallowable && message.expands && (literalOf(message).startsWith('-') || message.text.includes(NO_VERIFY_PREFIX))) refuse(MESSAGES.hiddenOption);
      continue;
    }
    const variants = variantsOf(word);
    if (variants === null) refuse(MESSAGES.noVerify);
    if (word.expands && word.text.includes(NO_VERIFY_PREFIX)) refuse(MESSAGES.noVerify);
    if (hidesOption(sub, word)) refuse(MESSAGES.hiddenOption);
    if (variants.some((text) => skipsHooks(sub, text))) refuse(MESSAGES.noVerify);
  }
}

function judgeGitEnvironment(command, resolved, git) {
  const assignments = [...command.assignments, ...resolved.envAssignments];
  const exported = resolved.words.filter((word) => GIT_CONFIG_ENV.test(word.text));
  if (assignments.some((word) => GIT_CONFIG_ENV.test(word.text)) || exported.length > 0) refuse(MESSAGES.gitEnv);
  if (git !== null && (git.execPath || assignments.some((word) => GIT_ENV.test(word.text)))) refuse(MESSAGES.gitEnv);
}

function judgeGit(resolved, git, values) {
  if (git.configs.some((config) => hookKey(config.split('=', 1)[0]))) refuse(MESSAGES.gitConfig);
  if (git.sub === undefined) {
    if (resolved.wrappers.includes('xargs')) refuse(MESSAGES.xargs);
    return;
  }
  if (git.sub === 'commit-tree') refuse(MESSAGES.commitTree);
  if (git.sub === 'config' && configChangesHooks(git.rest)) refuse(MESSAGES.gitConfig);
  if (GATED.has(git.sub)) judgeGated(git.sub, git.rest);
  else if (!HARMLESS_NO_VERIFY.has(git.sub)) {
    for (const word of git.rest) {
      if (word.text === '--') break;
      const variants = values.has(word) ? [] : variantsOf(word);
      if (variants === null || variants.some(isNoVerify)) refuse(MESSAGES.noVerify);
    }
  }
  if (resolved.wrappers.includes('xargs') && XARGS_HIDDEN.has(git.sub)) refuse(MESSAGES.xargs);
}

// ---------------------------------------------------------------------------
// Bash, owner-only commands and the session's marks

const OWNER_ONLY = ['approve', 'propose', 'waive', 'exempt', 'off', 'on'];
const SESSION_NAMES = new Set(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']);
const SESSION_EMPTIED = /^(CLAUDECODE|CLAUDE_CODE_SESSION_ID)=$/;
// node's options that take the next word, so that its script operand is found.

// Whether a word matches `name` as written, by a brace variant, or as a glob pattern.
function couldBe(word, name) {
  if (!word.special) return word.text.toLowerCase() === name;
  const variants = variantsOf(word) ?? [word.text];
  return variants.some((text) => {
    const lower = text.toLowerCase();
    return lower === name || (word.special && segmentMatches(lower.replace(/\[[^\]]*\]/g, '?'), name));
  });
}
const basenameWord = (word) => (word.text.includes('/') ? { ...word, text: word.text.slice(word.text.lastIndexOf('/') + 1) } : word);
// A refusal of an owner's command: when env cleared the environment in front of it (env -i, env -),
// the session's marks were hidden from the command's own check, and the message says so.
const refuseOwner = (resolved, message) => refuse(resolved.cleared ? MESSAGES.sessionEnv : message);
// kh-orchestration's installer (after Task 9's review): a word whose basename could be apply.mjs or
// uninstall.mjs on a path naming kh-orchestration. kh-harness's own apply.mjs is not one.
const isInstallerName = (word) => ['apply.mjs', 'uninstall.mjs'].some((name) => couldBe(basenameWord(word), name));
const isInstaller = (word) => /kh-orchestration/i.test(word.text) && isInstallerName(word);

// Owner-only commands, whatever runs ko.mjs (node, bun, deno, tsx, npx, the file itself): in a
// command whose command word is not read-only, a word that is not a text value and whose
// basename could be ko.mjs, followed by an owner-only subcommand; and kh-orchestration's
// installer with --yes among the command's words.
function judgeOwner(command, resolved, values, loose) {
  const unsets = [...resolved.unsets, ...(resolved.name === 'unset' ? resolved.words.slice(resolved.index + 1).map((word) => word.text) : [])];
  if ([...command.assignments, ...resolved.envAssignments].some((word) => SESSION_EMPTIED.test(word.text)) || unsets.some((name) => SESSION_NAMES.has(name))) refuse(MESSAGES.sessionEnv);
  if (resolved.word === undefined || READ_ONLY.has(resolved.name)) return;
  // After Task 9's re-review: --yes may hide in any word of the command that the hook cannot read
  // whole (an expansion, a brace or glob pattern) or come from xargs; assignment values cannot
  // become its arguments, so the words from the command word on are the ones read.
  const literalYes = resolved.words.some((other) => other.text === '--yes');
  const unreadable = resolved.wrappers.includes('xargs') || resolved.words.slice(resolved.index).some((other) => other.expands || other.special);
  for (let at = 0; at < resolved.words.length; at++) {
    const word = resolved.words[at];
    if (values.has(word) || loose.has(word)) continue;
    if (couldBe(basenameWord(word), 'ko.mjs')) judgeOwnerSubcommand(resolved, at);
    // Behind a cleared environment any installer's --yes is blocked, whatever its path says: the
    // installer's own session check could not see the session (a cd can hide the plugin's path).
    if (isInstaller(word) || (resolved.cleared && isInstallerName(word))) {
      if (literalYes) refuseOwner(resolved, MESSAGES.installerOwnerOnly);
      if (unreadable) refuseOwner(resolved, MESSAGES.installerHidden);
    }
  }
  // A cleared environment in front of --yes with a word that could name an installer unseen
  // (`xargs -I{} env -i node {} . --yes`).
  if (resolved.cleared && literalYes && unreadable) refuseOwner(resolved, MESSAGES.installerHidden);
}

// The words after a ko.mjs at `at`. The subcommand is the first word that is not an option; a
// word right after an option may be that option's value, so the word after it is read too. A
// word holding an expansion may be an option. The walk stops at the first word that settles it,
// so every word is read at most twice whatever the number of ko.mjs words.
function judgeOwnerSubcommand(resolved, at) {
  let afterOption = false;
  let seen = false;
  for (let i = at + 1; i < resolved.words.length; i++) {
    const word = resolved.words[i];
    if (word.text === '--') {
      afterOption = false;
      continue;
    }
    if (word.text.startsWith('-') || word.expands) {
      afterOption = !word.text.includes('=');
      continue;
    }
    seen = true;
    const owner = OWNER_ONLY.find((name) => couldBe(word, name));
    if (owner !== undefined) refuseOwner(resolved, MESSAGES.ownerOnly(owner));
    if (!afterOption) return;
    afterOption = false;
  }
  if (!seen && resolved.wrappers.includes('xargs')) refuse(MESSAGES.xargs);
}

// ---------------------------------------------------------------------------
// Bash, when structure cannot be seen: the raw text is scanned for danger tokens

// The guarded-path tokens: a `.git` segment followed by /hooks, /config or /kh-orchestration,
// and an expansion followed by /hooks or /kh-orchestration.
const PATH_TOKENS = [
  GUARDED_TOKEN,
  /(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\([^)]{0,200}\)|`[^`]{0,200}`)\/+(?:hooks|kh-orchestration)(?![a-z0-9_.-])/i,
];
// (A substitution's inside is read for at most 200 characters, so the scan stays linear.)
// The path tokens for a sed program: SED_GUARDED_TOKEN and the expansion token.
const SED_PATH_TOKENS = [SED_GUARDED_TOKEN, PATH_TOKENS[1]];
// Every danger token: the path tokens and the flag and word tokens.
const DANGER = [
  ...PATH_TOKENS,
  /no-verif/i, /hookspath/i, /commit-tree/i, /mergeoptions/i, /include\.path/i, /git_config/i, /claudecode/i, /claude_code_session_id/i,
  /ko\.mjs[\s\S]{0,40}?(?<![a-z0-9-])(?:approve|propose|waive|exempt|off|on)(?![a-z0-9-])/i,
  /commit[\s\S]{0,20}?(?<![^\s'"(;&|=`])-[a-zA-Z]*n(?![a-zA-Z0-9_-])/,
];

// What is scanned, when, and with which tokens. Every caller of `scanned` below:
// - judgeBash: a command that cannot be split, its whole text; DANGER (unsplittable).
// - judgeScript: a shell's -c, a COMMAND_STRING command's -c/--command or an env -S string that
//   cannot be split, that string; DANGER.
// - judgeWhitespaceOperands: every operand holding whitespace that is not a text value, in a
//   command whose command word is not read-only, that word, and every assignment value holding
//   whitespace; DANGER. It reaches eval, trap, alias, awk, find -exec, ssh, docker and any runner
//   no table names when the code is one word with a space in it; not code without whitespace,
//   a script on disk, or a variable exported earlier.
// - judgeGuardedArea (via guardedWord, not `scanned`): every path word, quote-stripped, for
//   GUARDED_TOKEN.
// - judgeUnseen: a command word that is a variable or a substitution, that command's raw text;
//   deno eval, that command's raw text; source or `.`
//   reading standard input, the command and its here-document bodies; DANGER. A -S string that
//   cannot be split; DANGER.
// - judgeSed calls holdsAny directly on sed's program operands (every -e value, or the first
//   operand): SED_PATH_TOKENS, since a sed pattern legitimately holds words such as hooksPath;
//   SED_PATH_TOKENS and DANGER when a program runs a shell command (SED_RUNS: an e command or
//   an s///e flag). sed programs are left out of judgeWhitespaceOperands.
// - judgeShell, judgeInterpreter and judgeUnseen's runner check (via scanFedScript): a script fed
//   on standard input to a shell, an interpreter, a command-string runner without -c, or a command
//   with a later shell word (unshare sh), from a
//   pipe the whole command line, from a here-document or here-string the command and its
//   bodies, from /dev/stdin, `-` or <( ) the command; and an interpreter's inline code, the
//   command and its bodies; DANGER. Inline code is any word before `--` that is one of an
//   interpreter's long inline options (node --eval, --print) or a short group holding one of
//   its letters (node e p, python c, perl e E n p, ruby e n p, php r, lua, Rscript and
//   osascript e), wherever it stands.
// Each text is scanned with `$IFS` and `${IFS}` read as a space, as written and with quotes,
// backslashes and parentheses (zsh's glob groups, `.git/h(o)oks`) taken out.
function holdsAny(tokens, texts) {
  return texts.some((text) => {
    const normal = normalizePath(text.replace(/\$\{?IFS\}?/g, ' '));
    const stripped = normal.replace(/['"\\()]/g, '');
    return tokens.some((pattern) => pattern.test(normal) || pattern.test(stripped));
  });
}
const scanned = (message, ...texts) => {
  if (holdsAny(DANGER, texts)) refuse(message);
};
// Code that names the plugin's own scripts (after Task 7's review): importing them and calling
// their functions is the one-line way to write a verdict, an approval or the switch, or to run
// an owner command with a forged environment. Scanned in inline code and in fed scripts only, so
// running, reading, staging or committing those files stays allowed.
// And code naming kh-orchestration together with its installer's modules (install.mjs, apply.mjs,
// uninstall.mjs; after Task 9's review), wherever each stands: the two are looked for apart, so the
// scan stays linear.
const NAMES_INSTALLER = { test: (text) => /kh-orchestration/i.test(text) && /(?:install|apply)\.mjs/i.test(text) };
const PLUGIN_MODULES = [/kh-orchestration\/+(?:scripts|bin)(?![a-z0-9_.-])/i, /ko-(?:cli|state|gate)\.mjs/i, NAMES_INSTALLER];
const scannedCode = (message, ...texts) => {
  if (holdsAny([...DANGER, ...PLUGIN_MODULES], texts)) refuse(message);
};

// A sed program that runs a shell command: an `e` command (after an address, `!`, `;` or a
// brace, or at the start) or an `s` command whose flags hold `e`.
const SED_RUNS = [/(?:^|[;\n{}!$0-9/])\s*e(?:\s|;|$)/, /[^A-Za-z0-9\s][gpiImMw0-9]*e[gpiImMw0-9]*\s*(?:;|}|$)/m];

// sed's programs: SED_PATH_TOKENS always; the full danger scan only when a program runs a shell
// command (SED_RUNS), so a sed edit of a document mentioning `git commit -n` is allowed.
function judgeSed(args) {
  const programs = sedPrograms(args).map((word) => word.text);
  const runs = programs.some((text) => SED_RUNS.some((pattern) => pattern.test(text)));
  if (holdsAny(runs ? [...SED_PATH_TOKENS, ...DANGER] : SED_PATH_TOKENS, programs)) refuse(MESSAGES.runsCode);
}

// sed's program operands: every -e or --expression value, or else its first operand; none with
// -f (a script on disk, a stated limit).
function sedPrograms(args) {
  const programs = [...optionValues(args, ['--expression'], 'e')];
  if (programs.length > 0 || args.some((word) => /^(-f|--file)/.test(word.text))) return programs;
  const first = args.find((word) => !word.text.startsWith('-'));
  return first === undefined ? [] : [first];
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'yash', 'fish']);
const SHELL_VALUED = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
// Commands whose -c (alone or in a bundle such as -qc) or --command value is a command line for a
// shell; flock takes it after its file, as a wrapper.
const COMMAND_STRING = new Set(['su', 'script', 'runuser', 'flock']);
const COMMAND_OPTION = /^(-[A-Za-z]*c[A-Za-z]*|--command)$/;

// The command line a COMMAND_STRING command is given, or null.
function commandString(resolved) {
  const from = resolved.wrappers.includes('flock') ? resolved.index : COMMAND_STRING.has(resolved.name) ? resolved.index + 1 : -1;
  if (from === -1) return null;
  for (let i = from; i < resolved.words.length; i++) {
    const text = resolved.words[i].text;
    if (text.startsWith('--command=')) return text.slice('--command='.length);
    if (COMMAND_OPTION.test(text)) return resolved.words[i + 1]?.text ?? null;
  }
  return null;
}

// The short letters and long options with which an interpreter runs code given on its command line.
function inlineOptionsOf(name) {
  if (name === 'node' || name === 'nodejs' || name === 'bun') return { short: 'ep', long: ['--eval', '--print'] };
  if (/^(python|pypy)[0-9.]*$/.test(name)) return { short: 'c', long: [] };
  if (name === 'perl') return { short: 'eEnp', long: [] };
  if (name === 'ruby') return { short: 'enp', long: [] };
  if (name === 'lua' || name === 'rscript' || name === 'osascript') return { short: 'e', long: [] };
  if (name === 'php') return { short: 'r', long: [] };
  return null;
}

// Whether a script operand is standard input in disguise: `-`, /dev/stdin, a process substitution.
const stdinOperand = (word) => word.text === '-' || word.text === '/dev/stdin' || word.text.startsWith('<(');
const hasHereString = (command) => command.redirects.some((redirect) => redirect.base === '<<<');

// A script fed on standard input: from a pipe the whole command line is the script's source;
// from a here-document or a here-string, the command and its bodies.
function scanFedScript(command, context) {
  if (command.pipe) scannedCode(MESSAGES.feedsScript, context.command);
  if (command.heredocs.length > 0 || hasHereString(command)) scannedCode(MESSAGES.feedsScript, command.raw, ...command.heredocs);
}

// A shell: its -c script is parsed and judged as commands; a script from standard input,
// /dev/stdin or a process substitution is scanned; a script on disk is not read.
function judgeShell(command, args, context, depth) {
  let i = 0;
  let inline = false;
  let stdin = false;
  while (i < args.length) {
    const text = args[i].text;
    if (text === '--') {
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
  if (i < args.length && !stdin && !stdinOperand(args[i])) return;
  if (i < args.length && stdinOperand(args[i])) scannedCode(MESSAGES.feedsScript, command.raw, ...command.heredocs);
  scanFedScript(command, context);
}

// Inline code is looked for in every word before `--`, whatever precedes it: which options
// take a value is not modelled, so `perl -M strict -e ...` and `node -r fs -e ...` are found.
// The first word that is not an option is taken as the script operand for standard input.
function judgeInterpreter(command, args, inlineOptions, context) {
  let operand = null;
  let inline = false;
  for (const word of args) {
    const text = word.text;
    if (text === '--') break;
    if (operand === null && (!text.startsWith('-') || text === '-')) operand = word;
    const long = inlineOptions.long.some((option) => text === option || text.startsWith(`${option}=`));
    const short = /^-[A-Za-z]+$/.test(text) && [...inlineOptions.short].some((letter) => text.includes(letter));
    if (long || short) inline = true;
  }
  if (inline) scannedCode(MESSAGES.runsCode, command.raw, ...command.heredocs);
  else if (operand === null || stdinOperand(operand)) scanFedScript(command, context);
}

// A word holding whitespace is possibly code: every assignment value holding whitespace or $IFS (leading or through env:
// BASH_ENV, PROMPT_COMMAND, GIT_EDITOR, GIT_SSH_COMMAND...), and every operand that is not a
// text value, whatever runs it (ssh, docker, tmux, watch, guile -c, make ARGS=...), unless the
// command word is a reader used as one (find with -exec is not). sed's programs have their own
// rule (judgeSed). This reaches code given as one word with a space in it; it does not reach
// code without whitespace, a script on disk, or a variable exported earlier.
function judgeWhitespaceOperands(command, resolved, values, loose) {
  for (const word of [...command.assignments, ...resolved.envAssignments]) {
    if (/\s|\$\{?IFS\b/.test(word.text)) scanned(MESSAGES.runsCode, word.text);
  }
  if (resolved.word === undefined) return;
  const writing = WRITING_OPTIONS[resolved.name];
  if (READ_ONLY.has(resolved.name) && (writing === undefined || !resolved.words.some((word) => writing.test(word.text)))) return;
  const programs = resolved.name === 'sed' ? new Set(sedPrograms(resolved.words.slice(resolved.index + 1))) : NO_VALUES;
  for (const word of resolved.words) {
    if (!values.has(word) && !loose.has(word) && !programs.has(word) && /\s/.test(word.text)) scanned(MESSAGES.runsCode, word.text);
  }
}

function judgeUnseen(command, resolved, values, context, depth) {
  if (resolved.unseen !== null) scanned(MESSAGES.unsplittable, resolved.unseen);
  if (resolved.word === undefined) return;
  if (resolved.word.expands) {
    scanned(MESSAGES.hiddenCommand, command.raw);
    return;
  }
  const { name } = resolved;
  const args = resolved.words.slice(resolved.index + 1);
  if (name === 'deno' && args[0]?.text === 'eval') scannedCode(MESSAGES.runsCode, command.raw);
  if (name === 'sed') judgeSed(args);
  if (SHELLS.has(name)) judgeShell(command, args, context, depth);
  const script = commandString(resolved);
  if (script !== null) judgeScript(script, context, depth);
  // A command-string runner without -c, or a command with a later word that is a shell (unshare
  // sh, docker run img sh), reads a script from its standard input.
  const runner = COMMAND_STRING.has(name) || resolved.wrappers.includes('flock');
  if ((runner && script === null) || args.some((word) => !values.has(word) && SHELLS.has(commandName(word)))) scanFedScript(command, context);
  if ((name === 'source' || name === '.') && (args.length === 0 || stdinOperand(args[0]))) {
    scannedCode(MESSAGES.feedsScript, command.raw, ...command.heredocs);
    scanFedScript(command, context);
  }
  const inlineOptions = inlineOptionsOf(name);
  if (inlineOptions !== null) judgeInterpreter(command, args, inlineOptions, context);
}

// ---------------------------------------------------------------------------
// Bash, judging a command

// A script given on a command line: parsed and judged as the command's own; one that cannot
// be split is scanned.
function judgeScript(text, context, depth) {
  const commands = depth + 1 > MAX_DEPTH ? null : parseScript(text, depth + 1, context.line.functions);
  if (commands === null) scanned(MESSAGES.unsplittable, text);
  else judgeCommands(commands, context, depth + 1);
}

function judgeCommand(command, context, depth) {
  const resolved = resolveCommand(command);
  const git = gitInvocation(resolved);
  noteLineEnvironment(command, resolved, git, context.line);
  const outputReadOnly = command.pipedTo === null || pipelineReadsOnly(command.pipedTo);
  const values = textValues(resolved, git, outputReadOnly, command.substituted);
  judgeGuardedArea(command, resolved, git, values, context);
  judgeGitEnvironment(command, resolved, git);
  if (git !== null) judgeGit(resolved, git, values);
  const loose = looseTextValues(resolved);
  judgeOwner(command, resolved, values, loose);
  judgeInnerCommand(resolved, values);
  judgeUnseen(command, resolved, values, context, depth);
  judgeWhitespaceOperands(command, resolved, values, loose);
}

// A git word after the command word, behind a wrapper the tables above do not know (ssh,
// strace, npx, a coproc's name, sh -c '"$@"' _ git ...), is judged as a command word too.
function innerGit(resolved, values) {
  const at = resolved.words.findIndex((word, index) => index > resolved.index && !values.has(word) && !word.expands
    && (commandName(word) === 'git' || commandName(word).startsWith('git-')));
  if (at === -1) return null;
  const inner = { ...resolved, index: at, word: resolved.words[at], name: commandName(resolved.words[at]) };
  const git = gitInvocation(inner);
  return git === null ? null : { inner, git };
}

function judgeInnerCommand(resolved, values) {
  const found = innerGit(resolved, values);
  if (found !== null) judgeGit(found.inner, found.git, textValues(found.inner, found.git, true));
}

function judgeCommands(commands, context, depth) {
  for (const command of commands) judgeCommand(command, context, depth);
}

// The line as a whole (decision 15, addition after Task 6's fourth re-review), across every
// script in it (a substitution, a function body, a shell's -c script): whether it runs git, and
// whether it sets a guarded variable (as an assignment of its own, before any command, through
// env, or through export/declare/typeset/readonly/local) or exports a function. Each reaches a git
// command later in the line and its hooks; judgeBash refuses the two together, as it does a line
// that runs git and defines a function named git.
const nameOf = (word) => word.text.split(/\+?=/, 1)[0];
function noteLineEnvironment(command, resolved, git, line) {
  if (git !== null || innerGit(resolved, NO_VALUES) !== null) line.runsGit = true;
  if ([...command.assignments, ...resolved.envAssignments].some((word) => EXPORTED_GUARD.test(nameOf(word)))) line.steers = true;
  if (!SETS_EXPORTS.has(resolved.name)) return;
  const operands = resolved.words.slice(resolved.index + 1);
  if (operands.some((word) => /^-[a-zA-Z]*f/.test(word.text) || (!word.text.startsWith('-') && EXPORTED_GUARD.test(nameOf(word))))) line.steers = true;
}

function judgeBash(payload) {
  const command = payload.tool_input?.command;
  if (typeof command !== 'string') refuse(MESSAGES.noCommand);
  if (command.length > MAX_COMMAND_LENGTH) refuse(MESSAGES.tooLong);
  const line = { runsGit: false, steers: false, functions: [] };
  const context = { command, ...sessionDirs(payload), gitDirTexts: undefined, inGitDir: undefined, line };
  const commands = parseScript(command, 0, line.functions);
  if (commands === null) scanned(MESSAGES.unsplittable, command);
  else judgeCommands(commands, context, 0);
  if (line.runsGit && (line.steers || line.functions.includes('git'))) refuse(MESSAGES.exportedEnv);
}

// ---------------------------------------------------------------------------
// The edit tools

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TARGET_KEYS = ['file_path', 'notebook_path'];
const MAX_LINK_HOPS = 40;
const OFFICERS_PATH = '.claude/kh-orchestration/officers.json';
const RULES_FOLDED = 'docs/harness/rules.md';
const LOCAL_SETTINGS_FOLDED = '.claude/settings.local.json';

// Where a write to `path` lands: links followed, a dangling one too.
function realTarget(path) {
  let current = path;
  for (let hops = 0; hops < MAX_LINK_HOPS; hops++) {
    const real = realOfDeepest(current);
    if (real === null) refuse(MESSAGES.noTarget);
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

// Judged as written and where the write lands: the git directory of the target's repository or
// of the session's always blocks; settings.local.json always blocks; RULES.md is always allowed;
// another protected file blocks unless this worktree is open for proposals.
function judgeTarget(path, cwd, sessionGitDirs) {
  if (!isAbsolute(path) && cwd === null) refuse(MESSAGES.noTarget);
  const lexical = resolve(cwd ?? sep, path);
  for (const candidate of new Set([lexical, realTarget(lexical)])) {
    if (sessionGitDirs !== null && (isInside(candidate, sessionGitDirs.gitDir) || isInside(candidate, sessionGitDirs.commonDir))) refuse(MESSAGES.gitDirEdit);
    const dirs = gitDirsAround(dirname(candidate));
    if (dirs === null) continue;
    const rel = relative(dirs.root, candidate).split(sep).join('/');
    const folded = rel.toLowerCase();
    if (folded === '.git' || folded.startsWith('.git/') || isInside(candidate, dirs.gitDir) || isInside(candidate, dirs.commonDir)) refuse(MESSAGES.gitDirEdit);
    if (folded === LOCAL_SETTINGS_FOLDED) refuse(MESSAGES.localSettingsEdit);
    if (folded !== RULES_FOLDED && protectedHere(rel, dirs.root) && !openForProposals(dirs.root)) refuse(MESSAGES.protectedEdit);
  }
}

function judgeEdit(payload) {
  const input = payload.tool_input;
  const paths = input !== null && typeof input === 'object' ? TARGET_KEYS.filter((key) => Object.hasOwn(input, key)).map((key) => input[key]) : [];
  if (paths.length === 0 || !paths.every((path) => typeof path === 'string' && path !== '' && !path.includes('\0'))) refuse(MESSAGES.noTarget);
  if (paths.some((path) => path.length > MAX_PATH_LENGTH)) refuse(MESSAGES.pathTooLong);
  const { cwd } = sessionDirs(payload);
  const real = cwd === null ? null : realOfDeepest(cwd);
  const sessionGitDirs = real === null ? null : gitDirsAround(real);
  for (const path of paths) judgeTarget(path, cwd, sessionGitDirs);
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
