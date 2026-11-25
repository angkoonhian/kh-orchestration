// What this file relies on from kh-harness's docs/CONTRACT.md (kit 0.3.0), read 2026-11-26,
// section "How each extension is run":
//   "the bytes, with CRLF made LF, are imported as a `data:` URL. So an extension is **one
//   self-contained file**: it may import `node:` built-ins and nothing else."
//   "`import.meta.url` is that `data:` URL, not the file's path; find the repository through
//   `process.env.CLAUDE_PROJECT_DIR`, which Claude Code sets."
//   "**`preToolUse(payload)` is called**, synchronously. ... `payload` is a fresh `structuredClone` of
//   the hook input Claude Code sent (its `session_id`, `cwd`, `hook_event_name`, `tool_name`,
//   `tool_input`, `tool_use_id` and the rest)"
//   "`{ decision: 'block', message }`, where `message` is a string of 1 to 300 characters"
//   "The result must be a plain object (its prototype `Object.prototype`) with exactly those own keys.
//   A promise is not a result"
//   "each run of tabs, CR, LF, U+0085, U+2028 and U+2029 becomes one space; ... `<` and `>` become
//   `&lt;` and `&gt;`" (so no message holds a line break, `<` or `>`).
//   "An extension may read small files. It must not start a process, wait on anything, write to
//   standard output or standard error, or exit."
// The tool_input field names, from Claude Code's hooks reference (code.claude.com/docs/en/hooks,
// read 2026-11-26), PreToolUse: Bash `command` ("The shell command to execute"); Write `file_path`
// ("Absolute path to the file to write"); Edit `file_path` ("Absolute path to the file to edit").
// NotebookEdit's `notebook_path` is from the tool's own schema in Claude Code ("The absolute path to
// the Jupyter notebook file to edit"); the reference lists no MultiEdit table, so the extension
// takes every one of `file_path` and `notebook_path` that a call carries, for every edit tool.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachesOtherFiles } from './self-contained.mjs';
import { installKhHarness, isolateProcessEnv, makeRepo, registerExtension, testEnv } from './test-repo.mjs';
import {
  MAX_COMMAND_LENGTH, MAX_GLOBS, MESSAGES, PROTECTED_FILES, PROTECTED_PREFIXES,
  isProtected, isValidGlob, matchesGlob, preToolUse, readOfficers, sharedStateDirSync, splitWords,
} from '../../assets/scripts/extension.mjs';
import { PROBE_PAYLOAD } from '../../assets/scripts/ko-contract.mjs';
import { stateDir, writeState } from '../../assets/scripts/ko-state.mjs';
import { checkContract1, probeContract1 } from '../../assets/scripts/verify-contract-1.mjs';

isolateProcessEnv();

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'scripts', 'extension.mjs');
const officersText = (argvs, extra = {}) => JSON.stringify({
  schema: 1, baseBranch: 'main', protected: [],
  officers: argvs.map((argv, index) => ({ id: `o${index}`, rule: 'A1', argv, appliesTo: ['**'], timeoutSeconds: 60, options: {} })),
  ...extra,
});

test('extension.mjs reaches no file but node: built-ins', () => {
  assert.deepEqual(reachesOtherFiles(readFileSync(EXTENSION, 'utf8')), []);
});

test('the self-containment check finds every way to reach another file, and passes node: imports', () => {
  const bad = [
    "import x from '../y.mjs';", "import x from './y.mjs'", "import { a } from 'pkg';", "export { a } from '../y.mjs';", "export * from './y.mjs';",
    "import './side.mjs';", "/* c */ import x from '../y.mjs';", "import(`./x.mjs`)", "import(name)", "await import('./x.mjs')", "import('node:fs' + x)",
    "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r('./x');", "const x = require('./x');",
    "import {\n  a,\n  b,\n} from '../y.mjs';", "import /* from 'node:fs' */ x from './evil.mjs';", "import { a /* from \"node:fs\" */ } from './evil.mjs';",
    "import /* c */ ('./evil.mjs')", "const u = 'http://x'; import y from './evil.mjs';", "const u = \"//\"; export * from './evil.mjs';",
  ];
  for (const source of bad) assert.notDeepEqual(reachesOtherFiles(source), [], source);
  const good = [
    "import { createHash } from 'node:crypto';", "import fs, { x } from \"node:fs\";", "import 'node:fs';", "export { a } from 'node:path';", "await import('node:fs');",
    "import {\n  a,\n} from 'node:path';\nexport const x = 1;", '// the word import in a comment\nexport const y = 2;', "/* import x from './y.mjs' */ import fs from 'node:fs';", "// import('./x.mjs')\nimport fs from 'node:fs';",
    "const u = 'http://x'; import fs from 'node:fs';",
  ];
  for (const source of good) assert.deepEqual(reachesOtherFiles(source), [], source);
});

test('the protected prefixes and files are the brief\'s lists', () => {
  assert.deepEqual(PROTECTED_PREFIXES, ['.claude/kh-orchestration/scripts/', '.claude/kh-harness/', '.claude/scripts/']);
  assert.deepEqual(PROTECTED_FILES, ['docs/harness/RULES.md', '.claude/kh-orchestration/officers.json', '.claude/settings.json']);
});

test('a compiled glob: **/ matches zero or more directories, a trailing /** what is under the directory, a lone ** everything; * and ? never cross /', () => {
  const table = [
    ['src/a.js', 'src/a.js', true], ['src/a.js', 'src/b.js', false], ['src/*.js', 'src/a.js', true], ['src/*.js', 'src/deep/a.js', false],
    ['**/*.py', 'a.py', true], ['**/*.py', 'x/a.py', true], ['**/*.py', 'x/y/a.py', true], ['**/*.py', 'a.pyc', false], ['**/*.py', 'xa.py/b', false],
    ['src/**/a.js', 'src/a.js', true], ['src/**/a.js', 'src/x/y/a.js', true], ['src/**/a.js', 'srcx/a.js', false], ['src/**/a.js', 'src/xa.js', false],
    ['lib/**', 'lib/a', true], ['lib/**', 'lib/a/b', true], ['lib/**', 'lib', false], ['lib/**', 'libx/a', false],
    ['**', 'x', true], ['**', 'a/b/c', true], ['**', '.hidden/x', true], ['**/a.js', '.hidden/a.js', true], ['**/x', 'ax', false],
    ['a?c', 'abc', true], ['a?c', 'a/c', false], ['a?c', 'ac', false], ['*', 'a/b', false], ['*', 'ab', true], ['a.b', 'aXb', false], ['a.b', 'a.b', true],
    ['a+b', 'a+b', true], ['a(b)', 'a(b)', true], ['a.js', 'A.js', false], ['x/*/y', 'x/m/y', true], ['x/*/y', 'x/m/n/y', false], ['a$b', 'a$b', true],
  ];
  for (const [glob, path, expected] of table) assert.equal(matchesGlob(glob, path), expected, `${glob} ${path}`);
});

// Runs a match in a child process that is killed after 5 s, so a matcher that never returns fails
// the test instead of hanging the suite. The child times the match itself. The algorithm's step
// count is bounded by the product of the glob's and the path's lengths, a few million steps at most
// here, so 100 ms is generous and does not depend on load.
function timedMatch(glob, path) {
  const code = `import { matchesGlob } from ${JSON.stringify(new URL(EXTENSION, 'file:').href)};
    const [glob, path] = JSON.parse(process.argv[1]);
    const started = performance.now();
    const result = matchesGlob(glob, path);
    console.log(JSON.stringify({ result, ms: performance.now() - started }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify([glob, path])], { encoding: 'utf8', timeout: 5000 });
  return run.status === 0 ? JSON.parse(run.stdout) : { result: null, ms: Infinity };
}

test('a glob built to make a backtracking matcher blow up is answered correctly within 100 ms', () => {
  const cases = [
    ['*'.repeat(30) + 'b', 'a'.repeat(200), false],
    ['*a*a*a*a*ab', 'a'.repeat(200), false],
    ['*a*a*a*a*ab', `${'a'.repeat(200)}b`, true],
    ['**/a/**/a/**/a/**/a/**/a/**/a/b', 'a/'.repeat(100), false],
    ['**/a/**/a/**/a/**/a/**/a/**/a/b', `${'a/'.repeat(100)}b`, true],
    ['*a'.repeat(256), 'a'.repeat(4096), true],
    ['*a'.repeat(255) + '*b', 'a'.repeat(4096), false],
  ];
  for (const [glob, path, expected] of cases) {
    const { result, ms } = timedMatch(glob, path);
    assert.equal(result, expected, glob.slice(0, 40));
    assert.ok(ms < 100, `${glob.slice(0, 40)} took ${ms} ms`);
  }
});

test('a glob over 512 characters or more than 64 protected globs make the officers file unreadable', () => {
  assert.equal(isValidGlob('a'.repeat(512)), true);
  assert.equal(isValidGlob('a'.repeat(513)), false);
  assert.equal(MAX_GLOBS, 64);
  const globs = (count) => Array.from({ length: count }, (_, index) => `d${index}/**`);
  assert.notEqual(readOfficers(officersText([['node', 'a.mjs']], { protected: globs(64) })), null);
  assert.equal(readOfficers(officersText([['node', 'a.mjs']], { protected: globs(65) })), null);
  assert.equal(readOfficers(officersText([['node', 'a.mjs']], { protected: ['a'.repeat(513)] })), null);
});

test('an invalid glob makes the officers file unreadable: empty, absolute, a .., . or empty segment, a trailing /, or [ ] { } \\', () => {
  for (const glob of ['', '/abs/x', '../x', 'a/../x', './x', 'a/./b', '.', '..', 'a//b', 'docs/', '/', 'a**b', 'a/**b', '**b', 'a**', '***', 'a/**/b**', 'a[b]', 'a]', '{a,b}', 'a}', 'a\\b']) {
    assert.equal(readOfficers(officersText([['node', 'a.mjs']], { protected: [glob] })), null, JSON.stringify(glob));
  }
  for (const glob of ['a', 'a/b.js', '**', '**/*.py', 'lib/**', 'a.b/c?', '.hidden/**']) {
    assert.notEqual(readOfficers(officersText([['node', 'a.mjs']], { protected: [glob] })), null, glob);
  }
});

test('isProtected is true for a protected file, a path under a protected prefix, an officer script and a protected glob, and false otherwise', () => {
  const scripts = ['tools/officers/a1.mjs'];
  const globs = ['config/**', 'package.json'];
  for (const path of [...PROTECTED_FILES, '.claude/scripts/x.sh', '.claude/kh-harness/deep/er/y.mjs', '.claude/kh-orchestration/scripts/gate.mjs', 'tools/officers/a1.mjs', 'config/a/b.yml', 'package.json']) {
    assert.equal(isProtected(path, scripts, globs), true, path);
  }
  for (const path of ['src/app.js', 'docs/harness/RULES.md.bak', 'docs/harness/rules.md', '.claude/Settings.json', '.claude/scripts', '.claude/scriptsx/a', '.claude/kh-orchestration/state.json', 'tools/officers/a1.mjs.orig', 'config', 'sub/package.json']) {
    assert.equal(isProtected(path, scripts, globs), false, path);
  }
});

test('readOfficers gives candidates from argv elements and from the value after = of an option, normalised, and the protected globs', () => {
  const read = (argv) => readOfficers(officersText([argv]))?.officerCandidates.map((candidate) => candidate.path);
  assert.deepEqual(read(['node', './scripts/../scripts/check.mjs']), ['node', 'scripts/check.mjs']);
  assert.deepEqual(read(['x', 'scripts/./check.mjs', 'scripts//check.mjs', '././scripts/check.mjs']), ['x', 'scripts/check.mjs', 'scripts/check.mjs', 'scripts/check.mjs']);
  assert.deepEqual(read(['node', '--import=./scripts/check.mjs', '--flag', '-x', '--a=b=c']), ['node', 'scripts/check.mjs', 'b=c']);
  assert.deepEqual(read(['node', 'scripts/']), ['node', 'scripts']);
  assert.deepEqual(read(['node', '../up.mjs', '/etc/passwd', '..', 'a/../../b', '', '.', '--out=/abs']), ['node']);
  assert.deepEqual(read(['a\\b.mjs']), ['a\\b.mjs']);
  const parsed = readOfficers(officersText([['node', 'a.mjs']], { protected: ['config/**'] }));
  assert.deepEqual(parsed.protectedGlobs, ['config/**']);
  assert.deepEqual(parsed.officerCandidates, [
    { id: 'o0', element: 'node', path: 'node' }, { id: 'o0', element: 'a.mjs', path: 'a.mjs' },
  ]);
});

test('readOfficers is null for anything not of the shape: not JSON, schema not exactly 1, protected absent or not valid globs, officers or argv malformed', () => {
  const good = JSON.parse(officersText([['node', 'a.mjs']]));
  assert.notEqual(readOfficers(JSON.stringify(good)), null);
  const variants = {
    'not json': 'not json', empty: '', 'null': 'null', array: '[]',
    'schema 2': { ...good, schema: 2 }, 'schema string': { ...good, schema: '1' }, 'schema absent': { ...good, schema: undefined },
    'protected absent': { ...good, protected: undefined }, 'protected not array': { ...good, protected: 'a' }, 'protected element not string': { ...good, protected: [1] },
    'officers absent': { ...good, officers: undefined }, 'officers object': { ...good, officers: {} }, 'officer null': { ...good, officers: [null] },
    'argv absent': { ...good, officers: [{ id: 'o' }] }, 'argv empty': { ...good, officers: [{ id: 'o', argv: [] }] },
    'argv not strings': { ...good, officers: [{ id: 'o', argv: ['node', 1] }] }, 'id absent': { ...good, officers: [{ argv: ['node'] }] },
  };
  for (const [name, value] of Object.entries(variants)) {
    assert.equal(readOfficers(typeof value === 'string' ? value : JSON.stringify(value)), null, name);
  }
});

// ---- Task 8: the hook entry point ----

const repos = [];
after(() => {
  for (const repo of repos) repo.cleanup();
});
function repoFor(files = {}) {
  const repo = makeRepo({ files });
  repos.push(repo);
  return repo;
}

const OFFICERS = JSON.stringify({
  schema: 1, baseBranch: 'main', protected: ['config/**'],
  officers: [{ id: 'lint', rule: 'A1', argv: ['node', 'tools/check.mjs'], appliesTo: ['**'], timeoutSeconds: 60, options: {} }],
});
const FILES = {
  '.claude/kh-orchestration/officers.json': OFFICERS, '.claude/settings.json': '{}\n', '.claude/scripts/dispatch-pre-tool.mjs': 'x\n',
  'tools/check.mjs': 'x\n', 'config/a.yml': 'x\n', 'docs/harness/RULES.md': '# Rules\n', 'src/app.js': 'x\n',
};

let shared;
const bashRepo = () => (shared ??= repoFor(FILES));
const call = (tool_name, tool_input, cwd) => preToolUse({ session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' });
const bash = (command, cwd = bashRepo().root) => call('Bash', { command }, cwd);
const ALLOW = { decision: 'allow' };
const blocked = (message) => ({ decision: 'block', message });

test('preToolUse is synchronous: its result is a plain object, never a promise, with exactly the contract\'s keys', () => {
  for (const result of [call('Read', { file_path: '/x' }, '/'), bash('git commit --no-verify'), bash('ls')]) {
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(typeof result.then, 'undefined');
    assert.ok(result.decision === 'allow' ? Object.keys(result).length === 1 : Object.keys(result).join() === 'decision,message');
  }
});

test('every message is fixed text of 1 to 300 characters on one line, with no < or >', () => {
  const texts = Object.values(MESSAGES).flatMap((value) => (typeof value === 'function' ? ['approve', 'propose', 'waive', 'exempt', 'off', 'on'].map(value) : [value]));
  assert.ok(texts.length >= 15);
  for (const text of texts) {
    assert.ok(text.length >= 1 && text.length <= 300, `${text.length}: ${text}`);
    assert.doesNotMatch(text, /[\n\r\t<>\u0085\u2028\u2029]/, text);
  }
});

test('a tool that is none of Bash and the edit tools is allowed without touching the filesystem', () => {
  const names = ['lstatSync', 'statSync', 'realpathSync', 'readFileSync', 'openSync', 'readSync', 'existsSync', 'readdirSync'];
  const saved = Object.fromEntries(names.map((name) => [name, fs[name]]));
  let touched = 0;
  for (const name of names) fs[name] = () => { touched++; throw new Error('touched'); };
  syncBuiltinESMExports();
  try {
    for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'Task', 'mcp__x__y', undefined]) {
      assert.deepEqual(call(tool, { file_path: '/repo/.claude/settings.json', command: 'git commit -n' }, '/repo'), ALLOW, String(tool));
    }
  } finally {
    Object.assign(fs, saved);
    syncBuiltinESMExports();
  }
  assert.equal(touched, 0);
});

test('a malformed payload never throws: anything but the two results is a block with fixed text', () => {
  for (const payload of [undefined, null, 1, 'Bash', [], {}, { tool_name: 'Bash' }, { tool_name: 'Bash', tool_input: null }, { tool_name: 'Bash', tool_input: { command: 7 } }]) {
    const result = preToolUse(payload);
    assert.ok(result.decision === 'allow' || result.decision === 'block', JSON.stringify(payload));
  }
  assert.deepEqual(preToolUse({ tool_name: 'Bash', tool_input: { command: 7 } }), blocked(MESSAGES.noCommand));
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    assert.deepEqual(call(tool, {}, bashRepo().root), blocked(MESSAGES.noTarget), tool);
    assert.deepEqual(call(tool, { file_path: 3 }, bashRepo().root), blocked(MESSAGES.noTarget), tool);
    assert.deepEqual(call(tool, { file_path: 'src/app.js' }, undefined), blocked(MESSAGES.noTarget), `${tool} relative with no cwd`);
  }
});

test('a Bash command over the cap is blocked unread; one at the cap is read', () => {
  assert.equal(MAX_COMMAND_LENGTH, 100_000);
  const atCap = `echo ${'x'.repeat(MAX_COMMAND_LENGTH - 'echo '.length)}`;
  assert.equal(atCap.length, MAX_COMMAND_LENGTH);
  assert.deepEqual(bash(atCap), ALLOW);
  assert.deepEqual(bash(`${atCap}x`), blocked(MESSAGES.tooLong));
});

// [command, expected message]. Decision 15 as replaced after Task 8's review ("the rule set
// after Task 8's review" in amendments.md), in its order: words, the guarded area, git
// commands, owner-only commands, structure that cannot be seen. Each construct is blocked at
// least once beside an allowed near miss (ALLOWED below).
const KO = 'node .claude/kh-orchestration/scripts/ko.mjs';
const BLOCKED = [
  // the brief's rows
  ['git commit --no-verify', MESSAGES.noVerify], ['git commit -n -m x', MESSAGES.noVerify], ['git commit -an', MESSAGES.noVerify],
  ['git merge --no-verify x', MESSAGES.noVerify], ['git -c core.hooksPath=/x commit', MESSAGES.gitConfig], ['git config core.hooksPath /x', MESSAGES.gitConfig], ["NODE_OPTIONS='--import=data:text/javascript,process.stdout.write(%22kh-orchestration:%20allowed%5Cn%22);process.exit(0)' git commit -q -m forged", MESSAGES.gitEnv], ["git config filter.x.clean 'git show HEAD:%f'", MESSAGES.gitConfig], ["git config core.fsmonitor tools/fsm.sh", MESSAGES.gitConfig], ["git -c core.fsmonitor=x commit -m y", MESSAGES.gitConfig], ["git config core.sshCommand 'sh -c x'", MESSAGES.gitConfig], ["git config diff.external x", MESSAGES.gitConfig], ["git config merge.ours.driver true", MESSAGES.gitConfig], ["LD_PRELOAD=/x.so git commit -m y", MESSAGES.gitEnv], ["env NODE_OPTIONS=--require=/x git commit -m y", MESSAGES.gitEnv], ["DYLD_INSERT_LIBRARIES=/x git commit -m y", MESSAGES.gitEnv], ["git config diff.x.textconv cat", MESSAGES.gitConfig], ["git config pager.log less", MESSAGES.gitConfig], ["git config gpg.ssh.program x", MESSAGES.gitConfig], ["git config sequence.editor x", MESSAGES.gitConfig], ["git config --remove-section filter.lfs", MESSAGES.gitConfig],
  ['git commit-tree abc', MESSAGES.commitTree], ['env X=1 git commit --no-verify', MESSAGES.noVerify], ['cd a && git commit -n', MESSAGES.noVerify],
  [`${KO} approve`, MESSAGES.ownerOnly('approve')], ['echo x > .git/hooks/pre-commit', MESSAGES.guardedPath], ['rm -rf .git/kh-orchestration/verdicts', MESSAGES.guardedPath],

  // words: wrappers, env in every form, git by basename and as git-<sub>, zsh's = and {
  ['env - git commit -n -m x', MESSAGES.noVerify], ['env - PATH=/usr/bin git commit -n -m x', MESSAGES.gitEnv], ['env -a x git commit -n -m x', MESSAGES.noVerify],
  ['env --argv0 x git commit -n -m x', MESSAGES.noVerify], ['env --argv0=x git commit -n', MESSAGES.noVerify], ['env -S "git commit" -n -m x', MESSAGES.noVerify],
  ["env -S 'git commit -n'", MESSAGES.noVerify], ['env "-S git commit -n"', MESSAGES.noVerify], ['env -iS "git commit -n"', MESSAGES.noVerify],
  ['env --split-string="git commit -n"', MESSAGES.noVerify], ['env -C . -u X -i git commit -n', MESSAGES.noVerify], ['env -- git commit -n', MESSAGES.noVerify],
  ['/usr/bin/git commit -n', MESSAGES.noVerify], ['/usr/lib/git-core/git-commit -n -m x', MESSAGES.noVerify], ['git-commit-tree abc', MESSAGES.commitTree],
  ['=git commit -n -m x', MESSAGES.noVerify], ['{git commit -n -m x}', MESSAGES.noVerify], ['noglob git commit -n -m x', MESSAGES.noVerify],
  ['nocorrect git commit -n', MESSAGES.noVerify], ['repeat 1 git commit -n -m x', MESSAGES.noVerify], ['command git commit -n', MESSAGES.noVerify],
  ['sudo -u me git commit -n', MESSAGES.noVerify], ['sudo -R /x git commit -n', MESSAGES.noVerify], ['sudo --chroot /x git commit -n', MESSAGES.noVerify],
  ['doas -a style git commit -n', MESSAGES.noVerify], ['ionice -p 1 git commit -n', MESSAGES.noVerify], ['xargs --process-slot-var V git commit -n', MESSAGES.noVerify],
  ['nice -n 5 git commit -n', MESSAGES.noVerify], ['time -p git commit -n', MESSAGES.noVerify], ['exec -a x git commit -n', MESSAGES.noVerify],
  ['nohup git commit -n', MESSAGES.noVerify], ['timeout -k 1 -s KILL 5 git commit -n', MESSAGES.noVerify], ['X=1 Y=2 git commit -n', MESSAGES.noVerify],
  ['git -C sub commit -n', MESSAGES.noVerify], ['git --namespace x -p --no-pager commit -n', MESSAGES.noVerify], ['git --git-dir .git commit -m x', MESSAGES.guardedPath], ['git -C. commit -n', MESSAGES.noVerify],
  ['echo commit -n -m x | xargs git', MESSAGES.xargs], ['echo commit-tree abc | xargs git', MESSAGES.xargs], ['echo -n | xargs git commit -m x', MESSAGES.xargs],
  ['echo approve | xargs node .claude/kh-orchestration/scripts/ko.mjs', MESSAGES.xargs],

  // the guarded area: the whole git directory, paths normalised, expansions before /hooks
  ['chmod -x .git//hooks/pre-commit', MESSAGES.guardedPath], ['chmod -x .git/./hooks/pre-commit', MESSAGES.guardedPath], ['echo x > .git//hooks/pre-commit', MESSAGES.guardedPath],
  ['chmod -x /abs/repo/.git//hooks/pre-commit', MESSAGES.guardedPath], ['rm .git/x/../hooks/pre-commit', MESSAGES.guardedPath], ['rm ./.git/./kh-orchestration', MESSAGES.guardedPath],
  ['chmod -x "$(git rev-parse --git-common-dir)/hooks/pre-commit"', MESSAGES.guardedPath], ['touch "$(git rev-parse --git-common-dir)/kh-orchestration/off"', MESSAGES.guardedPath],
  ['rm $D/hooks/pre-commit', MESSAGES.guardedPath], ['ls .git/hooks/pre-commit | xargs chmod -x', MESSAGES.guardedPath],
  ['ls -d .git/kh-orchestration | xargs -I{} touch {}/off', MESSAGES.guardedPath], ['ls .git/hooks | while read f; do chmod -x "$f"; done', MESSAGES.guardedPath],
  ['cat .git/hooks/pre-commit | grep x | xargs rm', MESSAGES.guardedPath], ['cd .git/hooks && chmod -x pre-commit', MESSAGES.guardedPath], ['cd .git && mv kh-orchestration x', MESSAGES.guardedPath],
  ['pushd .git/hooks', MESSAGES.guardedPath], ["printf '[core]\\n\\thooksPath = /nonexistent\\n' >> .git/config", MESSAGES.guardedPath],
  ['chmod -x .git/hook{s..s}/pre-commit', MESSAGES.guardedPath], ['mv .git/kh-orchestratio{n..n} /tmp/x', MESSAGES.guardedPath], ['rm .gi{t..t}/hooks/x', MESSAGES.guardedPath],
  ['find .git -name pre-commit -delete', MESSAGES.guardedPath], ['find .git -name x -exec rm {} +', MESSAGES.guardedPath], ['find .git -fprint /tmp/x', MESSAGES.guardedPath],
  ['chmod -R a-x .git', MESSAGES.guardedPath], ['cp -r /tmp/h/. .git/', MESSAGES.guardedPath], ['tar xf h.tar -C .git', MESSAGES.guardedPath], ['mv .git .git2', MESSAGES.guardedPath],
  ['sed -i s/x/y/ .git/config', MESSAGES.guardedPath], ['vim .git/COMMIT_EDITMSG', MESSAGES.guardedPath], ['echo ref > .git/description', MESSAGES.guardedPath],
  ['rm .GIT/HOOKS/pre-commit', MESSAGES.guardedPath], ['rm .gi?/hooks/pre-commit', MESSAGES.guardedPath], ['rm .g*/h*/pre-commit', MESSAGES.guardedPath],
  ['rm .gi[t]/hooks/pre-commit', MESSAGES.guardedPath], ['rm {.git,x}/hooks/pre-commit', MESSAGES.guardedPath], ['rm -rf .git/kh-orchestration', MESSAGES.guardedPath],
  ['sudo cat .git/hooks/pre-commit', MESSAGES.guardedPath], ['LESSOPEN="|x" less .git/hooks/pre-commit', MESSAGES.guardedPath], ['rg --pre=x y .git/hooks', MESSAGES.guardedPath],
  ['git diff --output=.git/hooks/pre-commit', MESSAGES.guardedPath], ['git grep -O x .git', MESSAGES.guardedPath], ['tee .git/hooks/pre-commit', MESSAGES.guardedPath],
  ['H=.git/hooks/pre-commit', MESSAGES.guardedPath], ['cat a 2> .git/hooks/x', MESSAGES.guardedPath], ['ls &> .git/hooks/x', MESSAGES.guardedPath],
  ['cat <> .git/hooks/x', MESSAGES.guardedPath], ['rm -f .git/index.lock .git/hooks/pre-commit', MESSAGES.guardedPath], ['rm -rf .git/index.lock', MESSAGES.guardedPath],
  ['git add .git/hooks', MESSAGES.guardedPath], ['tar czf /tmp/x.tgz .git', MESSAGES.guardedPath], ['rsync -a src/ .git/hooks/', MESSAGES.guardedPath],
  ['find . -path ./.git -print -delete', MESSAGES.guardedPath], ['zip -r x.zip .git', MESSAGES.guardedPath],
  ['echo "see .git/hooks/pre-commit" | xargs rm', MESSAGES.guardedPath], ["sudo sh -c 'echo x > .git/hooks/pre-commit'", MESSAGES.guardedPath],

  // git commands
  ['git commit --no-ver', MESSAGES.noVerify], ['git commit --no-v', MESSAGES.noVerify], ['git merge --no-verif x', MESSAGES.noVerify], ['git pull --no-verify', MESSAGES.noVerify],
  ['git ci --no-verify', MESSAGES.noVerify], ['git cherry-pick --no-verify x', MESSAGES.noVerify], ['git commit --verify --no-verify -m x', MESSAGES.noVerify],
  ['git commit -nm x', MESSAGES.noVerify], ['git commit -a -n', MESSAGES.noVerify], ['git commit -vn', MESSAGES.noVerify], ['git commit -m x -n', MESSAGES.noVerify],
  ['git commit -qn -m x', MESSAGES.noVerify], ['git commit -S -n -m x', MESSAGES.noVerify], ['git commit -C HEAD -n', MESSAGES.noVerify], ['git commit --mess x -n', MESSAGES.noVerify],
  ['git commit ${X:--n} -m x', MESSAGES.hiddenOption], ['git commit -${X:-n} -m x', MESSAGES.hiddenOption], ['git commit -m x $(printf -- -n)', MESSAGES.hiddenOption],
  ['git commit `echo -n` -m x', MESSAGES.hiddenOption], ['git commit "$@"', MESSAGES.hiddenOption], ['git commit $F', MESSAGES.hiddenOption], ['git commit -${X}', MESSAGES.hiddenOption],
  ['git merge -${X} x', MESSAGES.hiddenOption], ['git pull --${F}', MESSAGES.hiddenOption], ['git merge "-$F" x', MESSAGES.hiddenOption],
  ['git commit -m x -{n,q}', MESSAGES.noVerify], ['git commit --no-verif{y,}', MESSAGES.noVerify],
  ['git -c include.path=/x/evil.cfg commit -m x', MESSAGES.gitConfig], ['git config include.path /x/evil.cfg', MESSAGES.gitConfig],
  ['git config --local include.path ../evil.cfg', MESSAGES.gitConfig], ['git config includeIf.gitdir:/x.path /y', MESSAGES.gitConfig],
  ['git config branch.main.mergeOptions "--no-ff --no-verify"', MESSAGES.gitConfig], ['git config branch.main.mergeoptions --no-verify', MESSAGES.gitConfig],
  ['git -c CORE.HOOKSPATH=/x commit -m x', MESSAGES.gitConfig], ['git -ccore.hooksPath=/x commit -m x', MESSAGES.gitConfig], ['git --config-env=core.hooksPath=X commit', MESSAGES.gitConfig],
  ['git --config-env core.hooksPath=X commit', MESSAGES.gitConfig], ['git config --unset core.HOOKSPATH', MESSAGES.gitConfig], ['git config --worktree core.hooksPath /x', MESSAGES.gitConfig],
  ['git config -f x.cfg --add core.hooksPath /x', MESSAGES.gitConfig], ['git config --replace-all core.hooksPath /x', MESSAGES.gitConfig], ['git config core.hooksP""ath /x', MESSAGES.gitConfig],
  ["git config $'core.hooksPat\\x68' /x", MESSAGES.gitConfig], ['git -c alias.ci=commit ci', MESSAGES.gitConfig], ['git config alias.ci "commit -n"', MESSAGES.gitConfig],
  ['git config --global alias.x y', MESSAGES.gitConfig], ['git config set alias.x y', MESSAGES.gitConfig], ['git --config-env=alias.x=E x', MESSAGES.gitConfig],
  ['git config --edit', MESSAGES.gitConfig], ['git config --rename-section x include', MESSAGES.gitConfig],
  ['HOME=/x git commit -m x', MESSAGES.gitEnv], ['XDG_CONFIG_HOME=/x git commit -m x', MESSAGES.gitEnv], ['env HOME=/x git commit -m x', MESSAGES.gitEnv], ['PATH=/tmp/f:$PATH git commit -m x', MESSAGES.gitEnv], ['env PATH=/tmp/f git commit -m x', MESSAGES.gitEnv],
  ['GIT_CONFIG_COUNT=1 git status', MESSAGES.gitEnv], ['env GIT_CONFIG_GLOBAL=/x git commit', MESSAGES.gitEnv], ['export GIT_CONFIG_PARAMETERS=x', MESSAGES.gitEnv],
  ['GIT_EXEC_PATH=/tmp/evil git commit -m x', MESSAGES.gitEnv], ['git --exec-path=/tmp/evil commit -m x', MESSAGES.gitEnv],

  // owner-only commands and the session's marks
  ...['propose', 'waive', 'exempt', 'off', 'on'].map((command) => [`${KO} ${command} x`, MESSAGES.ownerOnly(command)]),
  ['node ./KO.MJS approve', MESSAGES.ownerOnly('approve')], ['cd .claude/kh-orchestration/scripts && node ko.mjs off', MESSAGES.ownerOnly('off')],
  ['node .claude/kh-orchestration/scripts/k?.mjs approve', MESSAGES.ownerOnly('approve')], ['node .claude/kh-orchestration/scripts/ko.mj[s] approve', MESSAGES.ownerOnly('approve')],
  ['node .claude/kh-orchestration/scripts/k*.mjs approve', MESSAGES.ownerOnly('approve')], [`${KO} appro{ve,ve}`, MESSAGES.ownerOnly('approve')],
  [`${KO} --root . approve`, MESSAGES.ownerOnly('approve')], [`${KO} --json approve`, MESSAGES.ownerOnly('approve')], [`${KO} -- approve`, MESSAGES.ownerOnly('approve')],
  [`${KO} o[n]`, MESSAGES.ownerOnly('on')], [`node --import ./x.mjs ${KO.slice(5)} waive`, MESSAGES.ownerOnly('waive')], ['./ko.mjs off', MESSAGES.ownerOnly('off')],
  ['env -u CLAUDECODE node x.mjs', MESSAGES.sessionEnv], ['env -uCLAUDE_CODE_SESSION_ID node x.mjs', MESSAGES.sessionEnv], ['env --unset=CLAUDECODE x', MESSAGES.sessionEnv],
  ['CLAUDECODE= node x.mjs', MESSAGES.sessionEnv], ['CLAUDE_CODE_SESSION_ID="" node x.mjs', MESSAGES.sessionEnv], ['unset CLAUDECODE CLAUDE_CODE_SESSION_ID', MESSAGES.sessionEnv],
  ['unset -v CLAUDE_CODE_SESSION_ID', MESSAGES.sessionEnv],

  // structure that cannot be seen: the raw text holds a danger token
  ['git commit -m "unbalanced -n', MESSAGES.unsplittable], ['echo "$(git commit -n', MESSAGES.unsplittable], ["echo 'ko.mjs approve", MESSAGES.unsplittable],
  ["echo 'x hooksPath", MESSAGES.unsplittable], ['echo "see .git/hooks', MESSAGES.unsplittable],
  [`echo ${'$('.repeat(40)}git commit -n${')'.repeat(40)}`, MESSAGES.unsplittable], [`echo ${'${a:-'.repeat(5000)}x hooksPath`, MESSAGES.unsplittable],
  ['bash <(echo "git commit -n -m x")', MESSAGES.feedsScript], ['source <(echo "git commit -n -m x")', MESSAGES.feedsScript], ['. <(echo "git commit -n")', MESSAGES.feedsScript],
  ['bash /dev/stdin <<< "git commit -n -m x"', MESSAGES.feedsScript], ['. /dev/stdin <<< "git commit -n"', MESSAGES.feedsScript], ["bash -s <<< 'git commit -n -m x'", MESSAGES.feedsScript],
  ['bash <<EOF\ngit commit -n\nEOF', MESSAGES.feedsScript], ['bash <<-EOF\n\tgit commit -n\n\tEOF', MESSAGES.feedsScript], ["bash <<< 'git commit -n'", MESSAGES.feedsScript],
  ["cat <<'E' | bash\ngit commit -n\nE", MESSAGES.feedsScript], ['echo git commit -n | sh', MESSAGES.noVerify], ['echo commit -n | sh', MESSAGES.feedsScript], ["printf 'git commit -n' | bash -s", MESSAGES.feedsScript],
  ["echo 'git commit -n' | bash - x", MESSAGES.feedsScript], ["echo 'ko.mjs  approve' | sh", MESSAGES.feedsScript], ['python3 - <<EOF\nimport os; os.remove(".git/hooks/pre-commit")\nEOF', MESSAGES.feedsScript],
  ['node -e "require(\'fs\').rmSync(\'.git/hooks/pre-commit\')"'.replace('require(', 'req' + 'uire('), MESSAGES.guardedPath],
  ['python3 -c "open(\'.git/hooks/pre-commit\', \'w\')"', MESSAGES.guardedPath], ["perl -e 'system(\"git commit -n\")'", MESSAGES.runsCode],
  ["ruby -e 'system(\"git commit -n\")'", MESSAGES.runsCode], ["awk 'BEGIN{system(\"git commit -n\")}'", MESSAGES.runsCode], ['deno eval "x(\'--no-verify\')"', MESSAGES.runsCode],
  ['node -e "x(\'GIT_CONFIG_COUNT\')"', MESSAGES.runsCode], ['node -e "x(\'include.path\')"', MESSAGES.runsCode], ['node -e "delete process.env.CLAUDECODE"', MESSAGES.runsCode],
  ['eval "git commit -n -m x"', MESSAGES.runsCode], ['eval "g""it commit -n"', MESSAGES.runsCode], ['trap "git commit -n" EXIT', MESSAGES.runsCode],
  ['find . -maxdepth 0 -exec git commit -n -m x \;', MESSAGES.noVerify], ['find . -exec sh -c "x commit -n" \;', MESSAGES.runsCode], ['G=git; $G commit -n -m x', MESSAGES.hiddenCommand], ['$(echo git) commit -n', MESSAGES.hiddenCommand],

  // a program that can write files is code: a guarded path inside it blocks
  ["sed -n 'w .git/hooks/pre-commit' a", MESSAGES.guardedPath], ["sed -n '/re/w .git/hooks/pre-commit' a", MESSAGES.guardedPath],
  ["sed 's/x/y/w .git/hooks/pre-commit' a", MESSAGES.guardedPath], ["sed -e 's/x/y/w .git/hooks/pre-commit' a", MESSAGES.guardedPath],
  ["sed --expression='w .git/kh-orchestration/off' a", MESSAGES.guardedPath], ["sed -n '/\\.git\\/hooks/p' docs/x.md", MESSAGES.guardedPath],
  ["sed -n 's/x/y/w '\"$(git rev-parse --git-dir)\"'/hooks/x' a", MESSAGES.guardedPath], ["sed -n 'w $D/hooks/pre-commit' a", MESSAGES.runsCode],
  ['awk \'{print > ".git/hooks/x"}\' f', MESSAGES.guardedPath], ['perl -ne \'open(F,">.git/hooks/pre-commit")\' f', MESSAGES.guardedPath],
  ["ruby -ne 'File.write(\".git/config\", 1)' f", MESSAGES.guardedPath],

  // cap adjudication
  ['pushd "$(echo ./.git)" && chmod a-x hooks/pre-commit', MESSAGES.guardedPath], ['cd "$(echo ./.git)"', MESSAGES.guardedPath], ['cd $(echo x/../.git)', MESSAGES.guardedPath],
  ['cd "$(echo "$PWD/.git")"', MESSAGES.guardedPath],
  ['N=n; git commit --trailer -m "-$N"', MESSAGES.hiddenOption], ['N=n; git commit --author -m "-$N"', MESSAGES.hiddenOption], ['git commit --trailer -m "${X}--no-verify"', MESSAGES.hiddenOption],
  ["sh -c 'git${IFS}commit${IFS}-n${IFS}-m${IFS}y'", MESSAGES.hiddenCommand], ["bash -c 'git commit${IFS}-n -m y'", MESSAGES.runsCode],
  ["GIT_EDITOR='git${IFS}commit${IFS}--no-verify${IFS}-m${IFS}y;true' git tag -a v1", MESSAGES.runsCode], ["X='git$IFS''commit$IFS-n' sh -c true", MESSAGES.runsCode],
  ['git commit --author=$A -m x', MESSAGES.hiddenOption], ['git commit --author="x$(echo y)" -m x', MESSAGES.hiddenOption],
  // fourth re-review
  ['git commit --trailer -m -n', MESSAGES.noVerify], ['git merge --into-name -m --no-verify side', MESSAGES.noVerify], ['git merge --into -m --no-verify side', MESSAGES.noVerify],
  ['git merge --into-name -F --no-verify side', MESSAGES.noVerify], ['git pull --no-rebase -o -m --no-verify . side', MESSAGES.noVerify],
  ['git pull --server-option -m --no-verify . side', MESSAGES.noVerify], ['git pull -m --no-verify', MESSAGES.noVerify], ['git commit -anm x', MESSAGES.noVerify],
  ['git commit -nam x', MESSAGES.noVerify], ['git commit --amend -m -n', MESSAGES.noVerify],
  ["BASH_ENV=<(echo 'git commit -n -m y') bash -c true", MESSAGES.runsCode], ["ENV='$(git commit -n -m y)' sh -i", MESSAGES.runsCode],
  ["PROMPT_COMMAND='git commit -n -m y; exit' bash -i", MESSAGES.runsCode], ["GIT_EDITOR='git commit -n -m y; true' git tag -a v1", MESSAGES.runsCode],
  [`GIT_SSH_COMMAND='sh -c "git commit -n -m y"' git fetch ssh://h/r`, MESSAGES.runsCode], [`GIT_EXTERNAL_DIFF='sh -c "git commit -n -m y"' git diff HEAD`, MESSAGES.runsCode],
  ["env GIT_EDITOR='git commit --no-verify' git tag -a v1", MESSAGES.runsCode],
  ['sort -o.git/hooks/pre-commit /dev/null', MESSAGES.guardedPath], ['curl -so.git/hooks/pre-commit url', MESSAGES.guardedPath], ['less -o.git/hooks/x f', MESSAGES.guardedPath],
  ['cd $(echo .git) && chmod a-x hooks/pre-commit', MESSAGES.guardedPath], ['cd "$(echo .git)" && chmod a-x hooks/pre-commit', MESSAGES.guardedPath],
  ['cd `echo .git` && chmod a-x hooks/pre-commit', MESSAGES.guardedPath], ['pushd $(echo .git)', MESSAGES.guardedPath], ['cd $(printf .git) && mv hooks h', MESSAGES.guardedPath],
  ['chmod a-x $(printf %s/hooks/pre-commit .git)', MESSAGES.guardedPath],
  ["parallel -k 'git commit -n -m {}' ::: y", MESSAGES.runsCode], ["sort -k 'git commit -n'", MESSAGES.runsCode],
  ["script -q /dev/null <<'EOF'\ngit commit -n -m y\nEOF", MESSAGES.feedsScript], ["unshare sh <<'EOF'\ngit commit -n -m y\nEOF", MESSAGES.feedsScript],
  ["script -q /dev/null <<< 'git commit -n -m y'", MESSAGES.feedsScript], ["echo 'git commit -n -m y' | script -q /dev/null", MESSAGES.feedsScript],
  ["echo 'git commit -n -m y' | unshare sh", MESSAGES.feedsScript], ["su -l me <<'EOF'\ngit commit -n -m y\nEOF", MESSAGES.feedsScript],
  ["sed 's|.*|git commit -n|ge' a", MESSAGES.runsCode], ["sed '$!e git commit -n' a", MESSAGES.runsCode], ["sed '1 e git commit -n' a", MESSAGES.runsCode],
  ["sed -e 's/x/y/' -e 'e git commit -n' a", MESSAGES.runsCode], ['X="git commit -n"; eval $X', MESSAGES.runsCode],

  // third re-review: flag words wherever they stand, guarded paths as tokens, whitespace operands as code
  ['git commit --mess -- -n', MESSAGES.noVerify], ['git commit --templ -- -n -m x', MESSAGES.noVerify], ['git merge --mess -- --no-verify side', MESSAGES.noVerify],
  ['git merge --into-name -- --no-verify side', MESSAGES.noVerify], ['git commit -- -n', MESSAGES.noVerify], ['git commit --author x -n', MESSAGES.noVerify],
  ['git merge side -- --no-verify', MESSAGES.noVerify], ['git commit -m x -- --no-verify', MESSAGES.noVerify], ['git commit -m $(echo x -n)', MESSAGES.hiddenOption],
  ['git commit -m$(echo x -n)', MESSAGES.hiddenOption], ['git commit -F `echo f -n`', MESSAGES.hiddenOption], ['git commit -m -m -n', MESSAGES.noVerify],
  ["chmod a-x $(echo .g''it/hooks/pre-commit)", MESSAGES.guardedPath], ["chmod a-x `echo .g''it/hooks/pre-commit`", MESSAGES.guardedPath],
  ["chmod a-x \"$(printf %s .g''it/hooks/pre-commit)\"", MESSAGES.guardedPath], ['racket -e \'(delete-file ".git/hooks/pre-commit")\'', MESSAGES.guardedPath],
  ['lua -e \'os.remove(".git/hooks/pre-commit")\'', MESSAGES.guardedPath], ['chmod a-x .g\\it/hooks/pre-commit', MESSAGES.guardedPath], ['chmod a-x ".git"/hooks/pre-commit', MESSAGES.guardedPath],
  ['julia -e \'rm("x/../.git/config")\'', MESSAGES.guardedPath],
  ["script -qc 'git commit -n -m x' /dev/null", MESSAGES.noVerify], ["script --command='git commit -n -m x' /dev/null", MESSAGES.noVerify],
  ["taskset 1 bash -c 'git commit -n -m x'", MESSAGES.noVerify], ["flock /tmp/l -c 'git commit -n -m x'", MESSAGES.noVerify], ["chrt -b 0 sh -c 'git commit -n -m x'", MESSAGES.noVerify],
  ["guile -c '(system \"git commit -n -m x\")'", MESSAGES.runsCode], ["ssh host 'git commit --no-verify -m x'", MESSAGES.runsCode], ['docker run img sh -c "git commit -n -m x"', MESSAGES.runsCode],
  ["tmux new-session 'git commit -n -m x'", MESSAGES.runsCode], ["watch 'git commit -n -m x'", MESSAGES.runsCode], ["nohup sh -c 'git -c core.hooksPath=/x commit -m y'", MESSAGES.gitConfig],
  ["unbuffer git commit -n", MESSAGES.noVerify], ["flock /tmp/l git commit -n", MESSAGES.noVerify], ["watch -n 1 git commit -n", MESSAGES.noVerify],
  ["make run ARGS='ko.mjs approve'", MESSAGES.runsCode], ['git grep -lO x .git', MESSAGES.guardedPath], ['git grep -lOvim x .git', MESSAGES.guardedPath],

  // second re-review: exemptions an attacker could satisfy, and sed and inline code wherever they stand
  ['find . -path ./.git/hooks/pre-commit -prune | xargs chmod a-x', MESSAGES.guardedPath], ['find . -depth -path ./.git -prune -o -type f -print0 | xargs -0 chmod a-x', MESSAGES.guardedPath],
  ['find . -path ./.git -prune | xargs chmod -R a-x', MESSAGES.guardedPath], ['find . -path ./.git/hooks -prune | xargs chmod -R a-x', MESSAGES.guardedPath],
  ['find . -path ./.git -prune -o -print | xargs chmod -R a-x', MESSAGES.guardedPath], ['find . -d -path ./.git -prune -o -print | xargs rm', MESSAGES.guardedPath],
  ['find . -path ./.git -prune -o -delete', MESSAGES.guardedPath], ['cp --exclude .git/hooks/pre-commit x', MESSAGES.guardedPath], ['tar czf - --exclude=.git/x . | xargs rm', MESSAGES.guardedPath],
  ['git merge --no-edit $(echo --no-verify) side', MESSAGES.noVerify], ['git merge `echo --no-verify` side', MESSAGES.noVerify], ['git merge ${X:---no-verify} side', MESSAGES.noVerify],
  ['git merge "${X:---no-verify}" side', MESSAGES.noVerify], ['git pull $(echo --no-verify)', MESSAGES.noVerify], ['git pull origin main ${X:---no-verify}', MESSAGES.noVerify],
  ['git merge $(cat f) side', MESSAGES.hiddenOption], ['git merge ${X:-y} side', MESSAGES.hiddenOption], ['git merge "${X#x}"', MESSAGES.hiddenOption], ['git pull "$@"', MESSAGES.hiddenOption],
  ['git merge "$(git rev-parse --abbrev-ref @{u})"', MESSAGES.hiddenOption], ['git commit -m x origin/$(echo a)', MESSAGES.hiddenOption], ['git commit -m x a${X:-b}', MESSAGES.hiddenOption],
  ["sed 's/x/y/w.git/hooks/pre-commit' a", MESSAGES.runsCode], ["sed -n '$w.git/hooks/pre-commit' /dev/null", MESSAGES.runsCode], ["echo 'exit 0' | sed -n 'w.git/hooks/pre-commit'", MESSAGES.runsCode],
  ["sed -n 'W.git/hooks/pre-commit' a", MESSAGES.runsCode], ["sed -n '1w.git/hooks/x' a", MESSAGES.runsCode], ["sed -n '/x/w.git/kh-orchestration/off' a", MESSAGES.runsCode],
  ["sed -n 'w./.git//hooks/x' a", MESSAGES.guardedPath], ["sed '1e git commit -n -m x' a", MESSAGES.runsCode], ["sed 's/.*/git commit -n -m x/e' a", MESSAGES.runsCode], ["sed '1e ko.mjs approve' a", MESSAGES.runsCode],
  ['git merge "x${Y}--no-verify" y', MESSAGES.noVerify],
  ['perl -M strict -e \'unlink ".git/hooks/pre-commit"\'', MESSAGES.guardedPath], ['perl -I . -e \'unlink ".git/hooks/pre-commit"\'', MESSAGES.guardedPath],
  ['python3 -W ignore -c \'import os; os.remove(".git/hooks/pre-commit")\'', MESSAGES.guardedPath], ['python3 -X dev -c \'import os; os.remove(".git/hooks/pre-commit")\'', MESSAGES.guardedPath],
  ['node -r fs -e \'x(".git/hooks/pre-commit")\'', MESSAGES.guardedPath], ['node --require fs -e \'x(".git/hooks/pre-commit")\'', MESSAGES.guardedPath],
  ['ruby -r fileutils -e \'FileUtils.rm(".git/hooks/pre-commit")\'', MESSAGES.guardedPath], ['perl -n script.pl -e \'x(".git/config")\'', MESSAGES.guardedPath],
  ['bunx tsx .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')], ['bun x tsx .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')],
  ['deno .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')], ['deno task t .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')],
  ['tsx .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')], ['ts-node .claude/kh-orchestration/scripts/ko.mjs propose', MESSAGES.ownerOnly('propose')],
  ['npx tsx .claude/kh-orchestration/scripts/ko.mjs waive', MESSAGES.ownerOnly('waive')], ['pnpm dlx tsx .claude/kh-orchestration/scripts/ko.mjs exempt', MESSAGES.ownerOnly('exempt')],
  ['bun --define x=1 .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')], ['bun --port 3000 .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')],
  ['bun run --filter x .claude/kh-orchestration/scripts/ko.mjs off', MESSAGES.ownerOnly('off')], ['deno run --ext js .claude/kh-orchestration/scripts/ko.mjs on', MESSAGES.ownerOnly('on')],
  ['vim ko.mjs on', MESSAGES.ownerOnly('on')], ['echo -delete | xargs find .git/hooks', MESSAGES.guardedPath], ['echo --pre=sh | xargs rg x .git', MESSAGES.guardedPath],
  ['echo --output=.git/hooks/x | xargs git diff', MESSAGES.guardedPath], ['ls .git | xargs less', MESSAGES.guardedPath],

  // owner-only commands under node, nodejs, bun and deno run
  ['bun .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')], ['bun run .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')],
  ['deno run .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')], ['deno run -A .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')],
  ['deno run --config deno.json --allow-read .claude/kh-orchestration/scripts/ko.mjs waive', MESSAGES.ownerOnly('waive')], ['nodejs .claude/kh-orchestration/scripts/ko.mjs off', MESSAGES.ownerOnly('off')],
  ['npx bun .claude/kh-orchestration/scripts/ko.mjs exempt', MESSAGES.ownerOnly('exempt')],

  // readings beyond the rule set's letter (see the Task 8 fix report)
  ['rm $(git rev-parse --git-path hooks)/pre-commit', MESSAGES.guardedPath], ['touch $(git rev-parse --git-path kh-orchestration/off)', MESSAGES.guardedPath],
  ['git rev-parse --git-common-dir | xargs -I{} touch {}/kh-orchestration/off', MESSAGES.guardedPath], ["find . -path '*hooks/pre-commit' -delete", MESSAGES.guardedPath],
  ["find . -name 'pre-*' -delete", MESSAGES.guardedPath], ['ssh localhost git commit -n', MESSAGES.noVerify], ['strace -f git commit --no-verify', MESSAGES.noVerify],
  ['npx git commit -n', MESSAGES.noVerify], ['npx node .claude/kh-orchestration/scripts/ko.mjs waive', MESSAGES.ownerOnly('waive')], ['coproc X { git commit -n; }', MESSAGES.noVerify],
  ["sh -c '\"$@\"' _ git commit -n", MESSAGES.noVerify], ['if true { git commit -n -m x }', MESSAGES.noVerify], ["alias gc='git commit -n'; gc", MESSAGES.runsCode],
  [`${KO} "$X" approve`, MESSAGES.ownerOnly('approve')], ['chmod -x .git/h(o)oks/pre-commit', MESSAGES.unsplittable],
  ["busybox sh -c 'git commit -n'", MESSAGES.noVerify], ["su -c 'git commit -n'", MESSAGES.noVerify], ["script -c 'git commit -n' /dev/null", MESSAGES.noVerify], ['chmod -x .git/(hooks|x)/pre-commit', MESSAGES.unsplittable],

  // the splitter: quotes, escapes, separators, groups, functions, case arms, substitutions, shells
  ['git commit --no-"verify"', MESSAGES.noVerify], ['git commit --no-ver\\ify', MESSAGES.noVerify], ["git commit $'--no-verify'", MESSAGES.noVerify],
  ["git commit $'\\x2dn'", MESSAGES.noVerify], ["git commit $'\\055n'", MESSAGES.noVerify], ["g''it commit -n", MESSAGES.noVerify], ['g"i"t commit -n', MESSAGES.noVerify],
  ['git com\\\nmit -n', MESSAGES.noVerify], ['git commit \\\n  -n', MESSAGES.noVerify], ['echo ok;git commit -n', MESSAGES.noVerify], ['true&&git commit -n', MESSAGES.noVerify],
  ['false||git commit -n', MESSAGES.noVerify], ['x|git commit -n', MESSAGES.noVerify], ['x|&git commit -n', MESSAGES.noVerify], ['sleep 1 & git commit -n', MESSAGES.noVerify],
  ['echo a\ngit commit -n', MESSAGES.noVerify], ['(git commit -n)', MESSAGES.noVerify], ['{ git commit -n; }', MESSAGES.noVerify], ['if true; then git commit -n; fi', MESSAGES.noVerify],
  ['while x; do git commit -n; done', MESSAGES.noVerify], ['! git commit -n', MESSAGES.noVerify], ['f() { git commit -n; }; f', MESSAGES.noVerify],
  ['function f { git commit -n; }', MESSAGES.noVerify], ['function f() { git commit -n; }', MESSAGES.noVerify], ['coproc git commit -n', MESSAGES.noVerify],
  ['case x in x) git commit -n;; esac', MESSAGES.noVerify], ['case x in (x) echo; git commit -n;; esac', MESSAGES.noVerify],
  ['case $y in a|b) true;; *) git commit -n;; esac', MESSAGES.noVerify], ['case x in\n  x)\n    git commit -n\n    ;;\nesac', MESSAGES.noVerify],
  ['echo $(git commit -n)', MESSAGES.noVerify], ['echo `git commit -n`', MESSAGES.noVerify], ['echo "$(git commit -n)"', MESSAGES.noVerify],
  ['cat <(git commit -n)', MESSAGES.noVerify], ['echo $(echo $(git commit -n))', MESSAGES.noVerify], ['echo ${X:-$(git commit -n)}', MESSAGES.noVerify],
  ['cat <<EOF\n$(git commit -n)\nEOF', MESSAGES.noVerify], ['x=(a $(git commit -n))', MESSAGES.noVerify],
  ['git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" --no-verify', MESSAGES.noVerify],
  ["bash -c 'git commit -n'", MESSAGES.noVerify], ["sh -ec 'git commit -n'", MESSAGES.noVerify], ["bash -o pipefail -c 'git commit -n'", MESSAGES.noVerify],
  ["bash -c -- 'git commit -n'", MESSAGES.noVerify], ['xargs sh -c "git commit -n"', MESSAGES.noVerify], ["bash -c 'bash -c \"git commit -n\"'", MESSAGES.noVerify],
];

const ALLOWED = [
  // the brief's rows, and the rows the old rules blocked that the review found everyday
  'git commit -m "fix -n flag"', 'git commit -m "--no-verify is banned"', 'git merge -n x', 'git log -n 5', `${KO} run`, 'ls .git/hooks',
  'git commit -m "docs: say core.hooksPath conflicts are reported"', 'git commit -m "fix(extension): block writes to .git/hooks"',
  'git commit -m "feat: the gate lives in .git/kh-orchestration/bin"',
  'git commit -m "$(cat <<\'EOF\'\nfeat(x): something is now true\n\nBody mentions git commit --no-verify and -n and .git/hooks/pre-commit.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nEOF\n)"',
  'git tag -a v1 -m "release: gate lives in .git/hooks"', 'gh pr create --title x --body "the hooks in .git/hooks/pre-commit run the gate"',
  'gh pr create --body="see .git/hooks" --title=".git/kh-orchestration"', 'git stash push -m "wip: before touching hooksPath handling"', 'git notes add -m ".git/hooks"',
  'grep -n hooksPath docs/design.md', 'rg hooksPath docs/', 'git grep -n hooksPath', 'git log --grep="hooksPath" --oneline', 'git log -S"--no-verify" --oneline',
  'git log -G "\\.git/hooks"', "sed -n '/hooksPath/p' docs/design.md", 'node --test --test-name-pattern="hooksPath" scripts/lib/',
  'node --test --test-name-pattern "git commit -n" scripts/lib/', 'git checkout -b fix/hooksPath-report', 'git branch -m fix/hookspath-conflict',
  'echo "see .git/hooks/pre-commit"', 'printf "%s\\n" .git/hooks/pre-commit', 'git log --oneline -- .git/hooks', 'jq . .git/kh-orchestration/verdicts/x.json',
  "find .git/kh-orchestration -name '*.json'", 'node -e "console.log(require(\'child_process\').execSync(\'git status\').toString())"'.replace('require(', 'req' + 'uire('),
  'python3 -c "import subprocess; print(subprocess.run([\'git\',\'status\']))"', "python3 - <<'EOF'\nimport subprocess\nprint(subprocess.check_output(['git','status']))\nEOF",
  "awk '/git/ {print}' README.md", "find . -name '*.mjs' -exec grep -l git {} +", 'f() { git status; }; f',
  'case "$(git rev-parse --abbrev-ref HEAD)" in main) echo m;; esac', 'git push --no-verify', 'git rebase --no-verify main', 'git fetch --no-verify', 'git am --no-verify x.patch',
  'wc -l assets/scripts/ko.mjs on off', 'git config core.hooksPath', 'git config --show-origin --get core.hooksPath', 'git config --get core.hooksPath x',
  'git config --get-all include.path', 'git config --list', 'git config -l | grep -i hooks', 'git config get alias.ci', 'git config alias.ci',
  'rm -f .git/index.lock', 'rm -f ./.git/index.lock', 'cat .git/HEAD', 'ls .git', `${KO} unexempt old-branch`, `${KO} status`, `${KO} verify-branch --no-run`,
  `${KO} run approve`, 'echo hookspath', 'grep -rn "\\.git/hooks" docs/',

  // near misses of the blocked rows
  'git commit --no-e', 'git commit --no-edit', 'git commit -m -n', 'git commit -uno', 'git commit -amn', 'git commit -C HEAD',
  'git commit -F msg.txt', 'git commit --message --no-verify', 'git merge --no-verify-signatures x', 'git merge --no-stat x', 'git log --no-merges', 'git fetch -n',
  'git clean -n', 'git cherry-pick -n abc', 'git commit -m "$MSG"', 'git commit -F "$F"', 'git commit -m "$(date)"', '/usr/bin/gitk commit -n', 'legit commit -n',
  'echo git commit -n', 'echo "git commit --no-verify"', 'git -C commit log -n 1', 'git status', 'git config user.name x', 'git config --get user.name',
  'git config branch.main.remote origin', 'GIT_PAGER=cat git log', 'GIT_OPTIONAL_LOCKS=0 git status', 'GIT_EDITOR=true git rebase --continue',
  'MY_GIT_CONFIG_X=1 ls', 'HOME=/tmp npm test', 'git config core.fsmonitor', 'git config --get filter.lfs.clean', 'NODE_OPTIONS=--max-old-space-size=4096 npm test', 'NODE_ENV=test npm test', 'git lfs install', 'PATH="$PATH:./node_modules/.bin" npm test', 'CLAUDECODE=1 node x.mjs', 'env -u FOO node x.mjs', 'unset FOO',
  'cat .git/hooks/pre-commit', 'grep -rn x .git/kh-orchestration', 'cat .git/hooks/pre-commit > /tmp/copy', 'head -n 3 .git/hooks/pre-commit 2>/dev/null',
  'test -f .git/hooks/pre-commit', '[ -x .git/hooks/pre-merge-commit ]', 'stat .git/kh-orchestration/approvals.json', 'diff .git/hooks/pre-commit x',
  'wc -l < .git/kh-orchestration/journal.jsonl', 'ls .git/hooks | wc -l', 'cat .git/kh-orchestration/journal.jsonl | tail -5 | jq .', 'git show HEAD:.git/hooks',
  'git -C .git/hooks status', 'ls src/hooks', 'rm -rf src/hooks', 'cat .github/hooks/x > y', 'rm .gitignore', 'rm -rf ./*', 'ls "$(git rev-parse --git-common-dir)/hooks"',
  'cat "$(git rev-parse --git-common-dir)/hooks/pre-commit"', 'rm -rf $ROOT/.claude/kh-orchestration/x', 'rm "$X/src/hooks/a"', 'cd "$(git rev-parse --show-toplevel)" && npm test',
  'node ko.mjs', 'cat ko.mjs.approve', 'node --test assets/scripts/ko.mjs.test.mjs', 'grep -c approve assets/scripts/ko.mjs',
  'echo "unbalanced', "echo 'it''s", 'git commit -m "unbalanced', 'eval "ls"', "bash -c 'ls -la'", 'node -e "1"', 'node scripts/x.mjs', 'python3 -c "print(1)"',
  'echo x | sh -c "cat"', 'cat <<EOF\ngit commit -n and .git/hooks\nEOF', "cat <<'EOF'\n$(git commit -n)\nEOF", 'cat > docs/notes.md <<\'EOF\'\nNever --no-verify; hooks are in .git/hooks.\nEOF',
  'git commit -m x # --no-verify', 'git commit -m x \\#--no-verify', 'echo $(git status)', 'find . -name "*.js"', 'npm test', 'ls | wc -l', 'echo a#b', '', '   ', '# git commit -n',
  "git log --format=%H | awk '{print $1}'", 'git ls-files | xargs grep -l foo', 'git show HEAD:package.json | node -e "process.stdin.pipe(process.stdout)"',
  'git diff | python3 -m json.tool', "git log | perl -ne 'print if /x/'", 'echo x.git | node', 'case "$x" in a) echo a;; esac',
  "find . -name '*.orig' -delete",
  // a program that names no guarded path stays allowed, whatever words it holds
  "sed -n '/hooksPath/p' f", "sed -i 's/a/b/' src/x.js", "sed -e 's/--no-verify//' f", "awk '{print $1 > \"out.txt\"}' f",
  // exclusions are text values
  'tar czf out.tgz --exclude=.git .', 'rsync -a --exclude .git ./ /tmp/x/', 'rsync -a --exclude .git/hooks src/ dst/', 'grep -rn foo --exclude-dir=.git .',
  "zip -r x.zip . -x '.git/*'", "zip -r x.zip . -x '.git/*' '*.tmp'", "find . -path ./.git -prune -o -name '*.py' -print", 'rsync -a --exclude-from=.git/info/exclude src/ dst/',
  'tar -czf x.tgz --exclude-vcs .', "find . -name .git -prune -o -type f -print",
  // cap adjudication: near misses
  'ls "$(echo src/.github)"', 'git commit --amend -m "fix: $ISSUE"', 'IFS=, read -r a b <<< "x,y"', 'while IFS= read -r line; do echo "$line"; done < f',
  'git commit --author="$A" -m x', 'git commit --date="$D" -m x', 'git commit --author="${A}" -m x',
  // A stated limit, documented as allowed: a message word that is wholly an expansion, after an
  // option that may take `-m` as its value, holds a flag in a variable (`N=-n`); closing it would
  // need a table of git's value-taking options and their abbreviations.
  'N=-n; git commit --trailer -m "$N"',
  // fourth re-review: near misses
  'git commit -am "$MSG"', 'git commit -am"$MSG"', 'git commit -sm "$MSG"', 'git commit -qam "$MSG"', 'git commit -vam "$MSG"', 'git commit -aF "$F"', 'git commit --amend -m "$MSG"',
  'git commit -am "$(cat <<\'EOF\'\nfeat: x mentions --no-verify and .git/hooks/pre-commit\nEOF\n)"', 'git merge -m "merge it" side', 'git commit -a -m "fix -n"',
  'NODE_OPTIONS="--max-old-space-size=4096 --trace-warnings" npm test', 'GIT_AUTHOR_NAME="A B" git commit -m x', 'MSG="fix: a b c" && git commit -m "$MSG"',
  'PGOPTIONS="-c statement_timeout=0" psql -c "select 1"', 'echo "$(git rev-parse --short HEAD)"', 'ls $(echo src)', 'sort -o out.txt in.txt',
  'gh api repos/x/issues -f body="commit -n"', 'gh api x -F title="a --no-verify b"', 'gh api x --raw-field body="hooksPath and commit -n"', 'python3 -m pytest -k "no_verify or x"', 'pytest -k "commit -n"',
  "cat <<'EOF' > docs/guide.md\nNever run git commit --no-verify; the hook is .git/hooks/pre-commit.\nEOF", "tee docs/x.md <<'EOF'\nNever run git commit --no-verify; see .git/hooks/pre-commit.\nEOF",
  "python3 - <<'EOF'\nimport subprocess\nsubprocess.run(['git','status'])\nEOF", "sed -i 's/use --no-verify here/x/' docs/a.md", "sed -i 's/git commit -n/git commit/' docs/a.md",
  "sed -n '/ko.mjs approve/p' f", "sed -i 's/approve the plan/approve it/' docs/a.md", 'docker run img sh -c "npm ci"',
  // third re-review: near misses
  'git commit -m "--no-verify is banned" -a', 'git commit -mn', 'git commit -m"Fix $ISSUE"', 'git commit -m"Fix $ISSUE" -a', 'git commit --message="use -n carefully"',
  'git merge --no-verify-signatures side', 'git merge -n side', "sed -i 's#https://x.git/hooks#y#' README.md", "sed 's/old.git\\/hooks/new/' f", "sed -n '/my.git\\/config/p' f",
  'docker run img sh -c "npm test && git status"', "ssh host 'git pull && npm ci'", 'npm test -- --grep "no-verify flag is refused"', 'pytest -k "no_verify or hookspath"',
  'gh issue create --title "hooksPath conflict" --body "set core.hooksPath and commit -n"', 'jest --testNamePattern "commit -n is blocked"',
  'git commit -m "docs: explain why git commit -n is refused"', 'npm run build -- --name "my app"', "bash -c 'npm test && npm run lint'", 'git commit -F "my notes.txt"',
  // second re-review: the exemptions kept, and their near misses
  "find . -path ./.git -prune -o -type f -print | xargs grep -l foo", 'git merge "origin/${BRANCH}"', 'python3 -m pytest -k "no_verify"', 'node -r ./setup.mjs scripts/build.mjs',
  "sed -e 's/--no-verify//' notes.md", "sed -i 's/github/gitlab/' README.md", 'grep approve .claude/kh-orchestration/scripts/ko.mjs', 'diff ko.mjs approve', 'cat ko.mjs',
  'node .claude/kh-orchestration/scripts/ko.mjs status --json', 'git add assets/scripts/ko.mjs', 'git commit -m "ko.mjs approve now asks for the word"', 'ls .git/hooks | xargs cat',
  "du -sh --exclude=.git .", 'diff -r --exclude=.git a b', 'rg foo --exclude-dir .git',
  // a branch or remote given by a variable
  'git merge "$BRANCH"', 'git merge $BRANCH', 'git pull "$REMOTE" main', 'git commit -F "$FILE"', 'git commit -m"$MSG"', 'git commit --message="$MSG"',
  // ko.mjs's reading subcommands under other runtimes
  'bun .claude/kh-orchestration/scripts/ko.mjs run', 'bun run .claude/kh-orchestration/scripts/ko.mjs status', 'deno run -A .claude/kh-orchestration/scripts/ko.mjs run', 'deno test x.mjs approve', 'which git', 'brew install git', 'alias ll="ls -la"', 'git rev-parse --git-common-dir | cat', 'ls "$(git rev-parse --git-dir)"',
  'for f in $(git ls-files); do node --check "$f"; done', 'if git diff --quiet; then echo clean; fi', 'echo $((1 + 2))', 'x=$(git status --porcelain)',
];

// One line per row the rules answer otherwise, so a failure names every such row at once.
function mismatches(rows) {
  return rows.flatMap(([command, expected]) => {
    const got = bash(command);
    return isDeepStrictEqual(got, expected) ? [] : [`${JSON.stringify(command).slice(0, 120)} -> ${got.decision}${got.message ? `: ${got.message.slice(0, 50)}` : ''}`];
  });
}

test('the Bash table: each blocked command is blocked with its message', () => {
  assert.deepEqual(mismatches(BLOCKED.map(([command, message]) => [command, blocked(message)])), []);
});

test('the Bash table: each allowed command is allowed', () => {
  assert.deepEqual(mismatches(ALLOWED.map((command) => [command, ALLOW])), []);
});

// fixtures/extension/corpus.txt: every command of the Task 8 review's probe lists (everyday.txt,
// attack.txt, a2.txt to a6.txt), each under the answer the replaced rule set gives it. The
// answers were read one by one against that rule set; an allowed attack is a stated limit.
test('the review\'s everyday and attack corpora get the answers recorded beside them', () => {
  const rows = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'extension', 'corpus.txt'), 'utf8').replace(/\n$/, '').split('\n=====\n')
    .map((entry) => {
      const [verdict, ...rest] = entry.replace(/^\n/, '').split('\n');
      return [rest.join('\n'), verdict];
    });
  assert.ok(rows.length > 500, `${rows.length} rows`);
  const wrong = rows.filter(([command, verdict]) => bash(command).decision !== verdict).map(([command, verdict]) => `${verdict}: ${JSON.stringify(command).slice(0, 100)}`);
  assert.deepEqual(wrong, []);
});

test('a command naming the resolved shared git directory is judged as one naming .git, from any worktree', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const separate = realpathSync(mkdtempSync(join(tmpdir(), 'ko-gitdir-')));
  repos.push({ cleanup: () => rmSync(separate, { recursive: true, force: true }) });
  const moved = join(separate, 'gd');
  assert.equal(repo.git('init', '-q', '--separate-git-dir', moved).status, 0);
  const worktree = repo.addWorktree('feature');
  for (const cwd of [repo.root, worktree]) {
    assert.deepEqual(bash(`rm ${moved}/hooks/pre-commit`, cwd), blocked(MESSAGES.guardedPath), cwd);
    assert.deepEqual(bash(`rm ${moved}//objects/x`, cwd), blocked(MESSAGES.guardedPath), cwd);
    assert.deepEqual(bash(`echo x > ${moved.toUpperCase()}/KH-ORCHESTRATION/approvals.json`, cwd), blocked(MESSAGES.guardedPath), cwd);
    assert.deepEqual(bash(`cat ${moved}/hooks/pre-commit`, cwd), ALLOW, cwd);
    assert.deepEqual(bash(`rm ${separate}/other`, cwd), ALLOW, cwd);
  }
  assert.deepEqual(bash('touch kh-orchestration/off', moved), blocked(MESSAGES.gitDirCwd), 'a separate git directory as cwd, found through the project');
});

test('with cwd inside a git directory only reading commands run, and cd into one is blocked', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const worktree = repo.addWorktree('wt');
  const common = join(repo.root, '.git');
  for (const cwd of [common, join(common, 'hooks'), join(common, 'worktrees', 'wt')]) {
    for (const command of ['touch kh-orchestration/off', 'chmod -x hooks/pre-commit', 'chmod -x pre-commit', 'rm -rf x', 'node x.mjs', 'ls > x', 'ls | xargs rm']) {
      assert.deepEqual(bash(command, cwd), blocked(MESSAGES.gitDirCwd), `${command} in ${cwd}`);
    }
    for (const command of ['ls', 'cat HEAD', 'ls -la hooks', 'git log -1', 'grep -r x .', 'cat config | grep core']) assert.deepEqual(bash(command, cwd), ALLOW, `${command} in ${cwd}`);
  }
  assert.deepEqual(bash('touch x', worktree), ALLOW);
  assert.deepEqual(bash('cd .git', repo.root), blocked(MESSAGES.guardedPath));
});

test('a Bash command naming an absolute path from a repository whose .git cannot be read is blocked with fixed text', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const worktree = repo.addWorktree('broken');
  writeFileSync(join(worktree, '.git'), 'not a gitdir line\n');
  assert.deepEqual(bash(`rm ${worktree}/a.txt`, worktree), blocked(MESSAGES.stateUnreadable));
  assert.deepEqual(bash('rm a.txt', worktree), ALLOW);
  assert.deepEqual(bash('npm test', worktree), ALLOW);
});

test('a cwd or a project directory over 4,096 characters blocks a judged tool at once, and an unjudged tool is still allowed', () => {
  const long = `/${'a/'.repeat(40_000)}`;
  for (const [tool, input] of [['Bash', { command: 'ls /x/hooks' }], ['Edit', { file_path: 'x' }], ['Write', { file_path: '/tmp/x' }]]) {
    const started = performance.now();
    assert.deepEqual(call(tool, input, long), blocked(MESSAGES.pathTooLong), tool);
    assert.ok(performance.now() - started < 50, tool);
  }
  assert.deepEqual(call('Read', { file_path: 'x' }, long), ALLOW);
  assert.deepEqual(call('Edit', { file_path: `/${'b'.repeat(4097)}` }, '/'), blocked(MESSAGES.pathTooLong));
});

test('splitWords: one entry per simple command, with assignments, words, redirections and here-document bodies apart', () => {
  const entry = (fields) => ({ assignments: [], words: [], redirects: [], heredocs: [], pipe: false, ...fields });
  assert.deepEqual(splitWords('A=1 B="x y" git commit -m "a b" 2>err.txt >out <in && ls|wc'), [
    entry({ assignments: ['A=1', 'B=x y'], words: ['git', 'commit', '-m', 'a b'], redirects: [{ op: '2>', target: 'err.txt' }, { op: '>', target: 'out' }, { op: '<', target: 'in' }] }),
    entry({ words: ['ls'] }), entry({ words: ['wc'], pipe: true }),
  ]);
  assert.deepEqual(splitWords('"A=1" x A=2'), [entry({ words: ['A=1', 'x', 'A=2'] })]);
  assert.deepEqual(splitWords('echo ">" \\> \'a b\'\\ c'), [entry({ words: ['echo', '>', '>', 'a b c'] })]);
  assert.deepEqual(splitWords("cat <<'E' >o\nbody $(x)\nE\nnext"), [
    entry({ words: ['cat'], redirects: [{ op: '<<', target: 'E' }, { op: '>', target: 'o' }], heredocs: ['body $(x)\n'] }), entry({ words: ['next'] }),
  ]);
  assert.deepEqual(splitWords('echo $(git status) "$(ls)"'), [entry({ words: ['git', 'status'] }), entry({ words: ['ls'] }), entry({ words: ['echo', '$(git status)', '$(ls)'] })]);
  assert.deepEqual(splitWords('a &>f; b &>>g; c >&2; d <<<"w"'), [
    entry({ words: ['a'], redirects: [{ op: '&>', target: 'f' }] }), entry({ words: ['b'], redirects: [{ op: '&>>', target: 'g' }] }),
    entry({ words: ['c'], redirects: [{ op: '>&', target: '2' }] }), entry({ words: ['d'], redirects: [{ op: '<<<', target: 'w' }] }),
  ]);
  assert.deepEqual(splitWords('# all comment\necho a # b'), [entry({ words: ['echo', 'a'] })]);
  assert.deepEqual(splitWords("echo \"a\\\"b\\$c\\d\" $'\\t'"), [entry({ words: ['echo', 'a"b$c\\d', '\t'] })]);
  assert.deepEqual(splitWords(''), []);
  for (const unbalanced of ['echo "a', "echo 'a", 'echo $(a', 'echo `a', 'echo a)', 'echo >', 'echo ${a', "echo $'a"]) {
    assert.equal(splitWords(unbalanced), null, unbalanced);
  }
});

test('splitWords reads function bodies and case arms as commands, and a non-string as null', () => {
  const words = (command) => {
    const split = splitWords(command);
    return split === null ? null : split.map((entry) => entry.words);
  };
  assert.deepEqual(words('f() { git status; }; f'), [['{', 'git', 'status'], ['}'], ['f']]);
  assert.deepEqual(words('function g() { a; }'), [['function', '{', 'a'], ['}']]);
  assert.deepEqual(words('case "$(b)" in x|y) c;; (z) d ;& *) e;;& esac; f'), [['b'], ['c'], ['d'], ['e'], ['f']]);
  assert.deepEqual(words('case x in\n a)\n  b\n  ;;\n esac\nc'), [['b'], ['c']]);
  assert.deepEqual(words('case x in a) b'), null);
  for (const value of [undefined, null, 1, {}, ['ls']]) assert.equal(splitWords(value), null);
});

test('nesting deeper than the splitter counts is null from splitWords and never a throw, in every construct that nests', () => {
  for (const unit of ['${a:-', '"${a:-', '$(', '"$(', '<(', '${a:-"', '$((', 'x=(', '$(echo "$(', '${a:-`echo ']) {
    const command = `echo ${unit.repeat(5000)}`;
    const started = performance.now();
    assert.equal(splitWords(command), null, unit);
    assert.ok(['allow', 'block'].includes(bash(command).decision), unit);
    assert.ok(performance.now() - started < 200, unit);
  }
});

test('splitWords on random shell-like text returns entries or null and never throws, and preToolUse always returns a result', () => {
  const alphabet = ['git', ' ', 'commit', '-n', '"', "'", '\\', '$(', ')', '`', ';', '&', '|', '<', '>', '<<', 'EOF', '\n', '#', '{', '}', '$', '(', '.git/hooks', 'ko.mjs', '=', 'x'];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
  for (let round = 0; round < 3000; round++) {
    let command = '';
    for (let piece = next() % 24; piece > 0; piece--) command += alphabet[next() % alphabet.length];
    const split = splitWords(command);
    assert.ok(split === null || Array.isArray(split), command);
    const result = bash(command);
    assert.ok(result.decision === 'allow' || (result.decision === 'block' && result.message.length <= 300), command);
  }
});

// ---- the edit tools ----

const EDIT_TOOLS = [['Edit', 'file_path'], ['Write', 'file_path'], ['MultiEdit', 'file_path'], ['NotebookEdit', 'notebook_path']];
const edit = (path, cwd, tool = 'Edit') => call(tool, { [Object.fromEntries(EDIT_TOOLS)[tool]]: path }, cwd);

test('an edit of a protected file is blocked by every edit tool; RULES.md and other files are allowed', () => {
  const repo = repoFor(FILES);
  for (const [tool] of EDIT_TOOLS) {
    for (const path of ['.claude/kh-orchestration/officers.json', '.claude/scripts/dispatch-pre-tool.mjs', '.claude/settings.json', 'tools/check.mjs', 'config/a.yml', '.claude/kh-harness/extensions.json', '.claude/kh-orchestration/scripts/new.mjs']) {
      assert.deepEqual(edit(join(repo.root, path), repo.root, tool), blocked(MESSAGES.protectedEdit), `${tool} ${path}`);
    }
    for (const path of ['docs/harness/RULES.md', 'src/app.js', 'src/new/file.js', 'tools/other.mjs', '.claude/settings.local.json.bak']) {
      assert.deepEqual(edit(join(repo.root, path), repo.root, tool), ALLOW, `${tool} ${path}`);
    }
  }
});

test('.claude/settings.local.json is never edited from a session, open for proposals or not, by any path to it', () => {
  const repo = repoFor(FILES);
  const target = join(repo.root, '.claude/settings.local.json');
  writeFileSync(target, '{}\n');
  symlinkSync(target, join(repo.root, 'local-link.json'));
  for (const open of [false, true]) {
    if (open) writeState(repo.root, 'proposals.json', { worktrees: [repo.root] });
    for (const [tool] of EDIT_TOOLS) {
      for (const path of [target, '.claude/settings.local.json', join(repo.root, '.CLAUDE/Settings.Local.json'), join(repo.root, 'local-link.json'), join(repo.root, 'src/../.claude/settings.local.json')]) {
        assert.deepEqual(edit(path, repo.root, tool), blocked(MESSAGES.localSettingsEdit), `${tool} ${path} open=${open}`);
      }
    }
    assert.deepEqual(edit(join(repo.root, '.claude/settings.json'), repo.root), open ? ALLOW : blocked(MESSAGES.protectedEdit));
  }
});

test('an edit of a protected file is allowed in a worktree open for proposals and still blocked in every other', () => {
  const repo = repoFor(FILES);
  const worktree = repo.addWorktree('proposal');
  const target = (root) => join(root, '.claude/settings.json');
  writeState(repo.root, 'proposals.json', { worktrees: [worktree] });
  assert.deepEqual(edit(target(worktree), worktree), ALLOW);
  assert.deepEqual(edit(target(repo.root), repo.root), blocked(MESSAGES.protectedEdit));
  assert.deepEqual(edit(target(repo.root), worktree), blocked(MESSAGES.protectedEdit), 'the main checkout\'s file from the open worktree');
  writeState(repo.root, 'proposals.json', { worktrees: [repo.root] });
  assert.deepEqual(edit(target(repo.root), repo.root), ALLOW);
  assert.deepEqual(edit(target(worktree), worktree), blocked(MESSAGES.protectedEdit));
  assert.deepEqual(edit(join(repo.root, '.git/hooks/pre-commit'), repo.root), blocked(MESSAGES.gitDirEdit), 'the hooks stay blocked while open');
  for (const bad of ['not json', '{"worktrees": "x"}', '{"worktrees": [1]}', '[]', 'null']) {
    writeFileSync(join(stateDir(repo.root), 'proposals.json'), bad);
    assert.deepEqual(edit(target(repo.root), repo.root), blocked(MESSAGES.protectedEdit), bad);
  }
});

test('an absolute path, a path with .., a relative path, a path through a link to the root and a case-folded path all get the same answer', () => {
  const repo = repoFor(FILES);
  const link = join(dirname(repo.root), 'link-to-root');
  symlinkSync(repo.root, link);
  const forms = (root, rel) => [join(root, rel), `${root}/src/../${rel}`, `${root}/./src/./../${rel}`, join(link, rel)];
  for (const path of forms(repo.root, '.claude/settings.json')) assert.deepEqual(edit(path, repo.root), blocked(MESSAGES.protectedEdit), path);
  for (const path of forms(repo.root, 'src/app.js')) assert.deepEqual(edit(path, repo.root), ALLOW, path);
  assert.deepEqual(edit('.claude/settings.json', repo.root), blocked(MESSAGES.protectedEdit), 'relative to cwd');
  assert.deepEqual(edit('../.claude/settings.json', join(repo.root, 'src')), blocked(MESSAGES.protectedEdit), 'relative with ..');
  for (const path of ['.CLAUDE/Settings.json', '.claude/SCRIPTS/x.mjs', 'TOOLS/check.mjs', 'Config/b.yml']) {
    assert.deepEqual(edit(join(repo.root, path), repo.root), blocked(MESSAGES.protectedEdit), path);
  }
  assert.deepEqual(edit(join(repo.root, 'docs/harness/rules.md'), repo.root), ALLOW);
});

test('a link is judged by where it is and by where it leads', () => {
  const repo = repoFor(FILES);
  symlinkSync(join(repo.root, '.claude/settings.json'), join(repo.root, 'innocent.json'));
  assert.deepEqual(edit(join(repo.root, 'innocent.json'), repo.root), blocked(MESSAGES.protectedEdit));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ko-outside-')));
  repos.push({ cleanup: () => rmSync(outside, { recursive: true, force: true }) });
  writeFileSync(join(outside, 'tools.mjs'), 'x\n');
  rmSync(join(repo.root, 'tools/check.mjs'));
  symlinkSync(join(outside, 'tools.mjs'), join(repo.root, 'tools/check.mjs'));
  assert.deepEqual(edit(join(repo.root, 'tools/check.mjs'), repo.root), blocked(MESSAGES.protectedEdit), 'a protected path that is a link out');
  assert.deepEqual(edit(join(outside, 'tools.mjs'), repo.root), ALLOW, 'the file outside, by its own path');
  assert.deepEqual(edit(join(outside, 'free.txt'), outside), ALLOW, 'a target outside any repository');
});

test('a target inside the git directory is always blocked: hooks, shared state, config, through a worktree and through a link', () => {
  const repo = repoFor(FILES);
  const worktree = repo.addWorktree('wt');
  writeState(repo.root, 'proposals.json', { worktrees: [repo.root, worktree] });
  const common = join(repo.root, '.git');
  symlinkSync(join(common, 'hooks'), join(repo.root, 'hookslink'));
  const targets = [
    [join(common, 'hooks/pre-commit'), repo.root], [join(common, 'kh-orchestration/approvals.json'), repo.root], [join(common, 'config'), repo.root],
    [join(common, 'hooks/pre-commit'), worktree], [join(common, 'kh-orchestration/verdicts/x.json'), worktree], [join(worktree, '.git'), worktree],
    [join(common, 'worktrees/wt/config.worktree'), worktree], [join(repo.root, 'hookslink/pre-commit'), repo.root], [join(repo.root, '.GIT/HOOKS/pre-commit'), repo.root],
    ['.git/hooks/pre-commit', repo.root],
  ];
  for (const [path, cwd] of targets) {
    for (const [tool] of EDIT_TOOLS) assert.deepEqual(edit(path, cwd, tool), blocked(MESSAGES.gitDirEdit), `${tool} ${path} from ${cwd}`);
  }
});

test('a separate git directory is found through the .git file, and a target in it is blocked', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const separate = realpathSync(mkdtempSync(join(tmpdir(), 'ko-gitdir-')));
  repos.push({ cleanup: () => rmSync(separate, { recursive: true, force: true }) });
  const moved = join(separate, 'gd');
  assert.equal(repo.git('init', '-q', '--separate-git-dir', moved).status, 0);
  assert.deepEqual(edit(join(moved, 'hooks/pre-commit'), repo.root), blocked(MESSAGES.gitDirEdit));
  assert.deepEqual(edit(join(repo.root, 'a.txt'), repo.root), ALLOW);
});

test('an unreadable .git blocks an edit in its repository with fixed text', () => {
  const repo = repoFor(FILES);
  const worktree = repo.addWorktree('broken');
  for (const text of ['not a gitdir line\n', 'gitdir: /nowhere/at/all\n', 'gitdir: a\ngitdir: b\n', '']) {
    writeFileSync(join(worktree, '.git'), text);
    assert.deepEqual(edit(join(worktree, 'src/app.js'), worktree), blocked(MESSAGES.stateUnreadable), JSON.stringify(text));
  }
  rmSync(join(worktree, '.git'));
  symlinkSync(join(repo.root, '.git'), join(worktree, '.git'));
  assert.deepEqual(edit(join(worktree, 'src/app.js'), worktree), blocked(MESSAGES.stateUnreadable), 'a .git that is a link');
});

test('without a readable officers.json the fixed files and prefixes still apply, and officer scripts and globs do not', () => {
  const repo = repoFor(FILES);
  const officers = join(repo.root, '.claude/kh-orchestration/officers.json');
  for (const state of ['absent', 'not json', 'a directory']) {
    rmSync(officers, { recursive: true, force: true });
    if (state === 'not json') writeFileSync(officers, '{');
    if (state === 'a directory') mkdirSync(officers);
    assert.deepEqual(edit(join(repo.root, '.claude/settings.json'), repo.root), blocked(MESSAGES.protectedEdit), state);
    assert.deepEqual(edit(officers, repo.root), blocked(MESSAGES.protectedEdit), state);
    assert.deepEqual(edit(join(repo.root, 'tools/check.mjs'), repo.root), ALLOW, state);
    assert.deepEqual(edit(join(repo.root, 'config/a.yml'), repo.root), ALLOW, state);
  }
});

// ---- sharedStateDirSync ----

test('sharedStateDirSync is stateDir without starting git, from the main checkout and from a linked worktree', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const worktree = repo.addWorktree('wt');
  assert.equal(sharedStateDirSync(repo.root), stateDir(repo.root));
  assert.equal(sharedStateDirSync(worktree), stateDir(repo.root));
  const gitdir = readFileSync(join(worktree, '.git'), 'utf8').slice('gitdir: '.length).trim();
  writeFileSync(join(worktree, '.git'), `gitdir: ${relative(worktree, gitdir)}\r\n`);
  assert.equal(sharedStateDirSync(worktree), stateDir(repo.root), 'a relative gitdir with CRLF');
  writeFileSync(join(gitdir, 'commondir'), `${join(repo.root, '.git')}\n`);
  assert.equal(sharedStateDirSync(worktree), stateDir(repo.root), 'an absolute commondir');
});

test('sharedStateDirSync is null for no .git, a link, a file not of one gitdir line, a gitdir that is not a directory, and a commondir that is not one', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const worktree = repo.addWorktree('wt');
  const gitFile = readFileSync(join(worktree, '.git'), 'utf8');
  const gitdir = gitFile.slice('gitdir: '.length).trim();
  assert.equal(sharedStateDirSync(dirname(repo.root)), null);
  for (const text of ['', 'gitdir:\n', 'gitdir: \n', 'GITDIR: x\n', `${gitFile}extra\n`, `gitdir: ${join(gitdir, 'commondir')}\n`, `gitdir: ${gitdir}${'/'.repeat(5000)}\n`]) {
    writeFileSync(join(worktree, '.git'), text);
    assert.equal(sharedStateDirSync(worktree), null, JSON.stringify(text.slice(0, 60)));
  }
  writeFileSync(join(worktree, '.git'), gitFile);
  writeFileSync(join(gitdir, 'commondir'), 'no/such/dir\n');
  assert.equal(sharedStateDirSync(worktree), null, 'a commondir naming nothing');
  rmSync(join(gitdir, 'commondir'));
  mkdirSync(join(gitdir, 'commondir'));
  assert.equal(sharedStateDirSync(worktree), null, 'a commondir that is a directory');
  rmSync(join(worktree, '.git'));
  symlinkSync(join(repo.root, '.git'), join(worktree, '.git'));
  assert.equal(sharedStateDirSync(worktree), null, 'a .git that is a link');
});

test('sharedStateDirSync follows git where a gitdir has no commondir: the gitdir is its own shared directory, as for a submodule', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const worktree = repo.addWorktree('wt');
  const gitdir = readFileSync(join(worktree, '.git'), 'utf8').slice('gitdir: '.length).trim();
  rmSync(join(gitdir, 'commondir'));
  assert.equal(sharedStateDirSync(worktree), join(realpathSync(gitdir), 'kh-orchestration'));
});

// ---- through the real kh-harness hook (step 4) ----

// A repository with kh-harness installed and this extension registered.
function registeredRepo() {
  const repo = repoFor({ 'a.txt': 'x\n' });
  installKhHarness(repo.root);
  return { repo, entry: registerExtension(repo.root) };
}

// The session log and its markers go to this run's own directories, not the user's.
function hookEnv(root) {
  return { ...testEnv(), CLAUDE_PROJECT_DIR: root, KH_DATA_DIR: process.env.KH_DATA_DIR, HK_MARKER_DIR: process.env.HK_MARKER_DIR };
}
const hookDirs = realpathSync(mkdtempSync(join(tmpdir(), 'ko-hook-data-')));
process.env.KH_DATA_DIR = join(hookDirs, 'data');
process.env.HK_MARKER_DIR = join(hookDirs, 'markers');
after(() => rmSync(hookDirs, { recursive: true, force: true }));

test('through the real hook: the contract checks and the probe find no problem and no warning, an allowed call prints nothing, and a blocked one is denied', () => {
  const { repo, entry } = registeredRepo();
  assert.deepEqual(checkContract1(repo.root, entry), { problems: [], warnings: [] });
  assert.deepEqual(probeContract1(repo.root, entry, { ...PROBE_PAYLOAD, cwd: repo.root }), { problems: [] });
  const run = (payload) => spawnSync(process.execPath, [join(repo.root, '.claude/scripts/dispatch-pre-tool.mjs')], {
    cwd: repo.root, input: JSON.stringify({ session_id: 'ko-step-4', cwd: repo.root, hook_event_name: 'PreToolUse', tool_use_id: 'u', ...payload }), encoding: 'utf8', env: hookEnv(repo.root),
  });
  for (const payload of [{ tool_name: 'Bash', tool_input: { command: 'git status' } }, { tool_name: 'Edit', tool_input: { file_path: join(repo.root, 'a.txt'), old_string: 'x', new_string: 'y' } }]) {
    const allowed = run(payload);
    assert.deepEqual([allowed.status, allowed.stdout, allowed.stderr], [0, '', ''], payload.tool_name);
  }
  const denied = run({ tool_name: 'Edit', tool_input: { file_path: join(repo.root, '.claude/settings.json'), old_string: 'x', new_string: 'y' } });
  assert.equal(denied.status, 0);
  assert.ok(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason.split('\n').includes(`kh-harness extension kh-orchestration: ${MESSAGES.protectedEdit}`));
});
