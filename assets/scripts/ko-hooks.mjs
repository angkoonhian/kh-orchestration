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
const REFUSED_LINE = 'echo "kh-orchestration: the commit gate did not allow this commit." >&2';
const GATE = '"$d/kh-orchestration/bin/gate.mjs"';

// A word sh reads as itself, in single quotes.
const shQuote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const unquote = (word) => word.slice(1, -1).replaceAll("'\\''", "'");
const QUOTED = "'[^']*'(?:\\\\''[^']*')*";

/**
 * The exact text of hook `hook` (one of HOOK_NAMES) for the kit `version`, starting node through
 * the absolute `env` and the absolute `node` given.
 */
export function hookText(hook, { env, node, version }) {
  const allowlist = HOOK_ENV.map((name) => `\${${name}+"${name}=$${name}"}`).join(' ');
  const gate = [
    '# A gate that cannot be read refuses here, before node could print a trace; read, a builtin no',
    '# function can replace under sh -p, fails on a directory where a bare redirection would not.',
    `{ read -r _ < ${GATE}; } 2>/dev/null || { ${REFUSED_LINE}; exit 1; }`,
    `if out=$(${shQuote(env)} -i ${allowlist} ${shQuote(node)} ${GATE} ${hook} "$PPID"); then`,
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
