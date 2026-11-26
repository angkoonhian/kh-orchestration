// The three git hooks' texts (decision 18, final form), in one place: the installer writes them
// with `hookText`, and status compares each installed hook byte for byte with the text generated
// from the paths and version the hook itself names (`hookParts`), so a hook that was edited,
// truncated or left by another kit is reported, not judged by its header alone.
//
// `sh -p` imports no function and reads no ENV, SHELLOPTS or PS4. The common directory is the
// hook's own path less /hooks/<name>: hooks live only in <common>/hooks, and a copy elsewhere finds
// no gate and refuses. No command is called by name: env and node by the absolute paths recorded
// at install, the token tested by a case statement. A gate that cannot be read (missing, a
// directory, empty or without a first line) refuses with the builtin read, before node could print
// a trace. Allow only on the gate's exit 0 AND its
// token on standard output; the git process id ($PPID) is passed on. reference-transaction starts
// node only in the prepared state of a git process that has an in-flight record, found by a
// pattern (a file, a directory or a dangling link all match), so every other ref update runs no
// command at all.

export const HOOK_NAMES = Object.freeze(['pre-commit', 'pre-merge-commit', 'reference-transaction']);

// The variables a hook passes to node, each only if set: what node and the gate's git need, the
// GIT_* variables git 2.56.1 exports to its hooks (seen by experiment for commit, commit -a, a
// partial commit, amend, merge, a conflicted merge concluded, a linked worktree, GIT_DIR and
// GIT_WORK_TREE from the caller, and reference-transaction), and the three a caller may set to name
// the repository git itself uses.
const HOOK_ENV = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_EXEC_PATH', 'GIT_EDITOR', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_REFLOG_ACTION',
  'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];
const HOOK_COMMENT = [
  '# Node starts through env -i with only these variables, each passed only if set: PATH, HOME, TMPDIR,',
  '# LANG, LC_ALL; the GIT_* variables git 2.56.1 exports to its hooks (GIT_DIR, GIT_WORK_TREE,',
  '# GIT_INDEX_FILE, GIT_PREFIX, GIT_EXEC_PATH, GIT_EDITOR, GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL,',
  '# GIT_AUTHOR_DATE, GIT_REFLOG_ACTION); and GIT_COMMON_DIR, GIT_OBJECT_DIRECTORY and',
  '# GIT_ALTERNATE_OBJECT_DIRECTORIES, which name the repository git itself uses when a caller sets',
  '# them. Nothing else reaches node: no NODE_*, no LD_*, no BASH_*.',
];
// The line every hook prints when the gate did not allow; the installer's self-test expects it.
export const REFUSED_TEXT = 'kh-orchestration: the commit gate did not allow this commit.';
const REFUSED_LINE = `echo "${REFUSED_TEXT}" >&2`;
const gateAt = (dir) => `"$${dir}/kh-orchestration/bin/gate.mjs"`;

// A word sh reads as itself, in single quotes.
const shQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const unquote = (word) => word.slice(1, -1).replaceAll("'\\''", "'");
const QUOTED = "'[^']*'(?:\\\\''[^']*')*";

// The pieces both forms share, for a common directory held in the variable `dir`: the builtin read
// that refuses a gate that cannot be opened, and node started through env -i with the allowlist.
const readGate = (dir) => `{ read -r _ < ${gateAt(dir)}; } 2>/dev/null`;
const startNode = (hook, { env, node }, dir) => `${shQuote(env)} -i ${HOOK_ENV.map((name) => `\${${name}+"${name}=$${name}"}`).join(' ')} ${shQuote(node)} ${gateAt(dir)} ${hook} "$PPID"`;

/**
 * The exact text of hook `hook` (one of HOOK_NAMES) for the kit `version`, starting node through
 * the absolute `env` and the absolute `node` given.
 */
export function hookText(hook, { env, node, version }) {
  const gate = [
    '# A gate that cannot be read refuses here, before node could print a trace; read, a builtin no',
    '# function can replace under sh -p, fails on a directory where a bare redirection would not.',
    `${readGate('d')} || { ${REFUSED_LINE}; exit 1; }`,
    `if out=$(${startNode(hook, { env, node }, 'd')}); then`,
    "  case $out in 'kh-orchestration: allowed') exit 0 ;; esac",
    'fi',
    REFUSED_LINE,
    'exit 1',
    '',
  ];
  const header = ['#!/bin/sh -p', `# kh-orchestration ${version} ${hook}. Do not edit.`, ...HOOK_COMMENT];
  if (hook !== 'reference-transaction') return [...header, 'd=${0%/hooks/*}', ...gate].join('\n');
  return [
    ...header,
    '# Only the prepared state of a git process that has an in-flight record starts node; the record',
    '# is found by a pattern, so a file, a directory or a dangling link all count, and no command runs.',
    'case $1 in prepared) ;; *) exit 0 ;; esac',
    'd=${0%/hooks/*}',
    'for f in "$d/kh-orchestration/inflight-$PPID".jso[n]; do',
    "  case $f in *'.jso[n]') exit 0 ;; esac",
    'done',
    ...gate,
  ].join('\n');
}

/**
 * The one line that runs the gate as hook `hook` would, for a hook file that is someone else's
 * (apply, Task 9, prints it when it finds one): added directly after that file's first line, it
 * refuses (exit 1, the fixed line) unless the gate allows, and otherwise lets the rest of the file
 * run. It must stand in <git-common-dir>/hooks/, as the hooks do. Its variables are prefixed ko_ so
 * that it changes none of the file's own; for reference-transaction it starts node only in the
 * prepared state of a git process that has an in-flight record, and must come before anything that
 * reads standard input.
 */
export function hookLine(hook, { env, node }) {
  const check = `${readGate('ko_d')} && ko_out=$(${startNode(hook, { env, node }, 'ko_d')}) && case $ko_out in 'kh-orchestration: allowed') ;; *) (exit 1) ;; esac || { ${REFUSED_LINE}; exit 1; }`;
  if (hook !== 'reference-transaction') return `ko_d=\${0%/hooks/*}; ${check}`;
  return `case $1 in prepared) ko_d=\${0%/hooks/*}; for ko_f in "$ko_d/kh-orchestration/inflight-$PPID".jso[n]; do case $ko_f in *'.jso[n]') ;; *) ${check} ;; esac; done ;; esac`;
}

const LINE_START = new RegExp(`ko_out=\\$\\((${QUOTED}) -i .* (${QUOTED}) "\\$ko_d/kh-orchestration/bin/gate\\.mjs" `);

// The first line a hosting hook may have, and the lines that may stand between it and our line.
const SH_FIRST = /^#!\/bin\/sh(?: -p)?$/;
const NOTHING_RUNS = /^\s*(?:#.*)?$/;

/**
 * The env and Node named by a line of `text` that is exactly the line hookLine gives for hook
 * `hook` and those paths, `{ env, node, first }`; null when no line is. `first` says whether it
 * is the file's first command — its first line is `#!/bin/sh` (with or without -p) and only blank
 * or comment lines stand between: only then does a hook file that is someone else's host the gate
 * (after Task 9's re-review), since anything before the line can skip it.
 */
export function hostedParts(text, hook) {
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const start = line.includes('$ko_d/kh-orchestration/bin/gate.mjs') ? line.match(LINE_START) : null;
    if (start === null) continue;
    const parts = { env: unquote(start[1]), node: unquote(start[2]) };
    if (hookLine(hook, parts) !== line) continue;
    const first = index > 0 && SH_FIRST.test(lines[0]) && lines.slice(1, index).every((between) => NOTHING_RUNS.test(between));
    return { ...parts, first };
  }
  return null;
}

const HEADER = /^#!\/bin\/sh -p\n# kh-orchestration (\S+) (\S+)\. Do not edit\.\n/;
const NODE_START = new RegExp(`^if out=\\$\\((${QUOTED}) -i .* (${QUOTED}) "\\$d/kh-orchestration/bin/gate\\.mjs" `, 'm');

/**
 * What an installed hook's text names, `{ hook, version, env, node }`, read from its header and
 * its node line (`env` and `node` null when it has no such line); null when it has no
 * kh-orchestration header, so it is not one of ours. Regenerating `hookText` from these and
 * comparing bytes says whether the hook is exactly one this kit writes.
 */
export function hookParts(text) {
  const header = text.match(HEADER);
  if (header === null) return null;
  const start = text.match(NODE_START);
  return { version: header[1], hook: header[2], env: start === null ? null : unquote(start[1]), node: start === null ? null : unquote(start[2]) };
}
