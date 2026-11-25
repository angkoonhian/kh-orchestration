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
import { spawnSync } from 'node:child_process';
import fs, { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachesOtherFiles } from './self-contained.mjs';
import { KIT_VERSION, installKhHarness, isolateProcessEnv, makeRepo, testEnv } from './test-repo.mjs';
import {
  MAX_COMMAND_LENGTH, MAX_GLOBS, MESSAGES, PROTECTED_FILES, PROTECTED_PREFIXES,
  isProtected, isValidGlob, matchesGlob, preToolUse, readOfficers, sharedStateDirSync, splitWords,
} from '../../assets/scripts/extension.mjs';
import { stateDir, writeState } from '../../assets/scripts/ko-state.mjs';
import { checkContract1, lfSha256, probeContract1 } from '../../assets/scripts/verify-contract-1.mjs';

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

// [command, expected message]. The brief's table, the amended decision 15's constructs (each
// blocked at least once beside an allowed near miss), Review Focus 5, and the splitter's own rows.
const BLOCKED = [
  // the brief
  ['git commit --no-verify', MESSAGES.noVerify], ['git commit -n -m x', MESSAGES.noVerify], ['git commit -an', MESSAGES.noVerify],
  ['git merge --no-verify x', MESSAGES.noVerify], ['git -c core.hooksPath=/x commit', MESSAGES.hooksPath], ['git config core.hooksPath /x', MESSAGES.hooksPath],
  ['git commit-tree abc', MESSAGES.commitTree], ['env X=1 git commit --no-verify', MESSAGES.noVerify], ['cd a && git commit -n', MESSAGES.noVerify],
  ['node .claude/kh-orchestration/scripts/ko.mjs approve', MESSAGES.ownerOnly('approve')], ['echo x > .git/hooks/pre-commit', MESSAGES.guardedPath],
  ['rm -rf .git/kh-orchestration/verdicts', MESSAGES.guardedPath], ['git commit -m "unbalanced', MESSAGES.unsplittable],
  // abbreviated --no-verify: six characters or more
  ['git commit --no-ver', MESSAGES.noVerify], ['git commit --no-v', MESSAGES.noVerify], ['git merge --no-verif x', MESSAGES.noVerify], ['git pull --no-verify', MESSAGES.noVerify],
  ['git ci --no-verify', MESSAGES.noVerify],
  // git by basename, behind wrappers, with global options
  ['/usr/bin/git commit -n', MESSAGES.noVerify], ['command git commit -n', MESSAGES.noVerify], ['sudo -u me git commit -n', MESSAGES.noVerify],
  ['nice -n 5 git commit -n', MESSAGES.noVerify], ['time git commit -n', MESSAGES.noVerify], ['exec git commit -n', MESSAGES.noVerify],
  ['nohup git commit -n', MESSAGES.noVerify], ['timeout 5 git commit -n', MESSAGES.noVerify], ['timeout -k 1 -s KILL 5 git commit -n', MESSAGES.noVerify],
  ['env -i -u HOME PATH=/bin git commit -n', MESSAGES.noVerify], ['X=1 Y=2 git commit -n', MESSAGES.noVerify],
  ['git -C sub commit -n', MESSAGES.noVerify], ['git --git-dir=.git --work-tree=. commit -n', MESSAGES.noVerify], ['git --git-dir .git -p --no-pager commit -n', MESSAGES.noVerify],
  ['git --namespace x --exec-path=/x commit --no-verify', MESSAGES.noVerify], ['echo x | xargs git commit -m', MESSAGES.xargs], ['xargs -0 git commit', MESSAGES.xargs],
  // commit's short options
  ['git commit -nm x', MESSAGES.noVerify], ['git commit -a -n', MESSAGES.noVerify], ['git commit -vn', MESSAGES.noVerify], ['git commit -m x -n', MESSAGES.noVerify],
  // hooksPath, alias, GIT_CONFIG_*
  ['git --config-env=core.hooksPath=H commit', MESSAGES.hooksPath], ['git config --unset core.HOOKSPATH', MESSAGES.hooksPath], ['echo hookspath', MESSAGES.hooksPath],
  ['git config --get core.hooksPath x', MESSAGES.hooksPath], ['sudo git config --get core.hooksPath', MESSAGES.hooksPath],
  ['git -c alias.ci=commit ci', MESSAGES.alias], ['git config alias.ci "commit -n"', MESSAGES.alias], ['git config --global alias.x y', MESSAGES.alias],
  ['git config set alias.x y', MESSAGES.alias], ['git --config-env=alias.x=E x', MESSAGES.alias],
  ['GIT_CONFIG_COUNT=1 git status', MESSAGES.gitConfigEnv], ['env GIT_CONFIG_GLOBAL=/x git commit', MESSAGES.gitConfigEnv], ['export GIT_CONFIG_PARAMETERS=x', MESSAGES.gitConfigEnv],
  ['git_config_count=1 git status', MESSAGES.gitConfigEnv],
  // the guarded paths
  ['cp a .git/hooks/', MESSAGES.guardedPath], ['cat x > .git/hooks/pre-commit', MESSAGES.guardedPath], ['ls .git/hooks >> .git/kh-orchestration/x', MESSAGES.guardedPath],
  ['find .git/hooks -delete', MESSAGES.guardedPath], ['git add .git/hooks', MESSAGES.guardedPath], ['rm .GIT/HOOKS/pre-commit', MESSAGES.guardedPath],
  ['rm .gi?/hooks/pre-commit', MESSAGES.guardedPath], ['rm .g*/h*/pre-commit', MESSAGES.guardedPath], ['rm .gi[t]/hooks/pre-commit', MESSAGES.guardedPath],
  ['rm {.git,x}/hooks/pre-commit', MESSAGES.guardedPath], ['rm -rf .git/kh-orchestration', MESSAGES.guardedPath], ['rm -rf ../main/.git/worktrees/../kh-orchestration/', MESSAGES.guardedPath],
  ['sudo cat .git/hooks/pre-commit', MESSAGES.guardedPath], ['LESSOPEN="|x" less .git/hooks/pre-commit', MESSAGES.guardedPath], ['rg --pre=x y .git/hooks', MESSAGES.guardedPath],
  ['tee .git/hooks/pre-commit', MESSAGES.guardedPath], ['H=.git/hooks/pre-commit', MESSAGES.guardedPath], ['cat a 2> .git/hooks/x', MESSAGES.guardedPath],
  ['ls &> .git/hooks/x', MESSAGES.guardedPath], ['cat a >| .git/hooks/x', MESSAGES.guardedPath], ['cat <> .git/hooks/x', MESSAGES.guardedPath],
  ['python3 -c "open(\'.git/hooks/pre-commit\', \'w\')"', MESSAGES.guardedPath],
  // the owner-only commands
  ...['propose', 'waive', 'exempt', 'off', 'on'].map((command) => [`node .claude/kh-orchestration/scripts/ko.mjs ${command} x`, MESSAGES.ownerOnly(command)]),
  ['node ./KO.MJS approve', MESSAGES.ownerOnly('approve')], ['cd .claude/kh-orchestration/scripts && node ko.mjs off', MESSAGES.ownerOnly('off')],
  // when in doubt: what the splitter cannot see into, in a command that mentions git, the paths or ko.mjs
  ['echo "$(git commit -n', MESSAGES.unsplittable], ["echo 'ko.mjs approve", MESSAGES.unsplittable], ['eval "git commit -n"', MESSAGES.runsCode],
  ['X="git commit -n"; eval $X', MESSAGES.runsCode], ['trap "git commit -n" EXIT', MESSAGES.runsCode], ['node -e "x(\'git\')"', MESSAGES.runsCode],
  ['node --eval=git', MESSAGES.runsCode], ['python3 -Bc "import git"', MESSAGES.runsCode], ['perl -ne "print git"', MESSAGES.runsCode],
  ["awk '{ system(\"git commit -n\") }' f", MESSAGES.runsCode], ['find . -name x -exec git commit -n \;', MESSAGES.runsCode],
  ['G=git; $G commit -n', MESSAGES.hiddenCommand], ['$(echo git) commit -n', MESSAGES.hiddenCommand], ['G=git; "${G}" commit', MESSAGES.hiddenCommand],
  ['echo git commit -n | sh', MESSAGES.feedsScript], ['echo x.git | node', MESSAGES.feedsScript], ["printf 'git commit -n' | bash -s", MESSAGES.feedsScript],
  ['git show HEAD:x.sh | source /dev/stdin', MESSAGES.feedsScript],
  ["echo 'git commit -n' | bash - x", MESSAGES.feedsScript],
  // what the splitter does see into: quotes, escapes, separators, groups, substitutions, scripts for a shell
  ['git commit --no-"verify"', MESSAGES.noVerify], ['git commit --no-ver\\ify', MESSAGES.noVerify], ["git commit $'--no-verify'", MESSAGES.noVerify],
  ["git commit $'\\x2dn'", MESSAGES.noVerify], ["git commit $'\\055n'", MESSAGES.noVerify], ["g''it commit -n", MESSAGES.noVerify], ['g"i"t commit -n', MESSAGES.noVerify],
  ['echo ok;git commit -n', MESSAGES.noVerify], ['true&&git commit -n', MESSAGES.noVerify], ['false||git commit -n', MESSAGES.noVerify],
  ['x|git commit -n', MESSAGES.noVerify], ['x|&git commit -n', MESSAGES.noVerify], ['sleep 1 & git commit -n', MESSAGES.noVerify], ['echo a\ngit commit -n', MESSAGES.noVerify],
  ['(git commit -n)', MESSAGES.noVerify], ['{ git commit -n; }', MESSAGES.noVerify], ['if true; then git commit -n; fi', MESSAGES.noVerify],
  ['while x; do git commit -n; done', MESSAGES.noVerify], ['! git commit -n', MESSAGES.noVerify], ['echo $(git commit -n)', MESSAGES.noVerify],
  ['echo `git commit -n`', MESSAGES.noVerify], ['echo "$(git commit -n)"', MESSAGES.noVerify], ['echo "`git commit -n`"', MESSAGES.noVerify],
  ['cat <(git commit -n)', MESSAGES.noVerify], ['echo $(echo $(git commit -n))', MESSAGES.noVerify], ['echo ${X:-$(git commit -n)}', MESSAGES.noVerify],
  ['git commit -m "$(cat <<\'EOF\'\nmsg\nEOF\n)" --no-verify', MESSAGES.noVerify], ['git commit \\\n  -n', MESSAGES.noVerify],
  ['git commit -{n,m}', MESSAGES.noVerify], ['git commit --no-verif{y,}', MESSAGES.noVerify],
  ["bash -c 'git commit -n'", MESSAGES.noVerify], ["sh -ec 'git commit -n'", MESSAGES.noVerify], ["bash -o pipefail -c 'git commit -n'", MESSAGES.noVerify],
  ["sudo sh -c 'echo x > .git/hooks/pre-commit'", MESSAGES.guardedPath], ["env -S 'git commit -n'", MESSAGES.noVerify], ['xargs sh -c "git commit -n"', MESSAGES.noVerify],
  ['bash <<EOF\ngit commit -n\nEOF', MESSAGES.noVerify], ['bash <<-EOF\n\tgit commit -n\n\tEOF', MESSAGES.noVerify], ["bash <<< 'git commit -n'", MESSAGES.noVerify],
  ['cat <<EOF\n$(git commit -n)\nEOF', MESSAGES.noVerify], ["bash -c 'bash -c \"git commit -n\"'", MESSAGES.noVerify],
  ['function f { git commit -n; }', MESSAGES.noVerify], ['coproc git commit -n', MESSAGES.noVerify], ['deno eval "git"', MESSAGES.runsCode],
  [`echo ${'$('.repeat(40)}git${')'.repeat(40)}`, MESSAGES.unsplittable],
];

const ALLOWED = [
  // the brief
  'git commit -m "fix -n flag"', 'git commit -m "--no-verify is banned"', 'git merge -n x', 'git log -n 5',
  'node .claude/kh-orchestration/scripts/ko.mjs run', 'ls .git/hooks',
  // near misses
  'git commit --no-e', 'git commit --no-edit', 'git commit -m -n', 'git commit -- -n', 'git commit -uno', 'git commit -amn', 'git commit -C HEAD',
  'git commit -F msg.txt', 'git commit --message --no-verify', 'git merge --no-verify-signatures x', 'git merge --no-stat x', 'git log --no-merges',
  '/usr/bin/gitk commit -n', 'legit commit -n', 'echo git commit -n', 'echo "git commit --no-verify"', 'git -C commit log -n 1', 'git status',
  'git config --get core.hooksPath', 'git config --get alias.ci', 'git config --get user.name', 'git config user.name x', 'GIT_PAGER=cat git log',
  'MY_GIT_CONFIG_X=1 ls', 'ls .git/hooks', 'cat .git/hooks/pre-commit', 'grep -rn x .git/kh-orchestration', 'cat .git/hooks/pre-commit > /tmp/copy',
  'head -n 3 .git/hooks/pre-commit 2>/dev/null', 'test -f .git/hooks/pre-commit', '[ -x .git/hooks/pre-merge-commit ]', 'stat .git/kh-orchestration/approvals.json',
  'diff .git/hooks/pre-commit x', 'wc -l < .git/kh-orchestration/journal.jsonl', 'ls src/hooks', 'rm -rf src/hooks', 'cat .github/hooks/x > y',
  'node .claude/kh-orchestration/scripts/ko.mjs status', 'node .claude/kh-orchestration/scripts/ko.mjs verify-branch', 'node ko.mjs', 'cat ko.mjs.approve',
  'echo "unbalanced', "echo 'it''s", 'eval "ls"', "bash -c 'ls -la'", 'node -e "1"', 'node scripts/x.mjs', 'python3 -c "print(1)"', 'echo x | sh -c "cat"',
  'cat <<EOF\ngit commit -n and .git/hooks\nEOF', "cat <<'EOF'\n$(git commit -n)\nEOF", 'git commit -m "$(cat <<\'EOF\'\nfix -n and --no-verify\nEOF\n)"',
  'git commit -m x # --no-verify', 'git commit -m x \\#--no-verify', 'echo $(git status)', 'find . -name "*.js"', 'npm test', 'ls | wc -l', 'cat "a > .git/hooks"', "grep ' > .git/hooks/x' f",
  'echo a#b', '', '   ', '# git commit -n',
  // the code an interpreter is given is what must mention git, not the rest of the line
  "git log --format=%H | awk '{print $1}'", 'git ls-files | xargs grep -l foo', 'git show HEAD:package.json | node -e "process.stdin.pipe(process.stdout)"',
  'git diff | python3 -m json.tool', "git log | perl -ne 'print if /x/'",
];

test('the Bash table: each blocked command is blocked with its message', () => {
  for (const [command, message] of BLOCKED) assert.deepEqual(bash(command), blocked(message), JSON.stringify(command));
});

test('the Bash table: each allowed command is allowed', () => {
  for (const command of ALLOWED) assert.deepEqual(bash(command), ALLOW, JSON.stringify(command));
});

test('a command naming the resolved shared git directory is judged as one naming .git/hooks, from any worktree', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const separate = realpathSync(mkdtempSync(join(tmpdir(), 'ko-gitdir-')));
  repos.push({ cleanup: () => rmSync(separate, { recursive: true, force: true }) });
  const moved = join(separate, 'gd');
  assert.equal(repo.git('init', '-q', '--separate-git-dir', moved).status, 0);
  const worktree = repo.addWorktree('feature');
  for (const cwd of [repo.root, worktree]) {
    assert.deepEqual(bash(`rm ${moved}/hooks/pre-commit`, cwd), blocked(MESSAGES.guardedPath), cwd);
    assert.deepEqual(bash(`echo x > ${moved.toUpperCase()}/KH-ORCHESTRATION/approvals.json`, cwd), blocked(MESSAGES.guardedPath), cwd);
    assert.deepEqual(bash(`cat ${moved}/hooks/pre-commit`, cwd), ALLOW, cwd);
    assert.deepEqual(bash(`rm ${moved}/objects/x`, cwd), ALLOW, cwd);
  }
});

test('a Bash command that mentions hooks from a repository whose .git cannot be read is blocked with fixed text', () => {
  const repo = repoFor({ 'a.txt': 'x\n' });
  const worktree = repo.addWorktree('broken');
  writeFileSync(join(worktree, '.git'), 'not a gitdir line\n');
  assert.deepEqual(bash('rm src/hooks/x', worktree), blocked(MESSAGES.stateUnreadable));
  assert.deepEqual(bash('npm test', worktree), ALLOW);
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
    for (const path of ['docs/harness/RULES.md', 'src/app.js', 'src/new/file.js', 'tools/other.mjs', '.claude/settings.local.json']) {
      assert.deepEqual(edit(join(repo.root, path), repo.root, tool), ALLOW, `${tool} ${path}`);
    }
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

const MODULE = '.claude/kh-orchestration/scripts/extension.mjs';
const PROBE = { session_id: 'probe', cwd: '', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git commit --no-verify' }, tool_use_id: 'probe-1' };

// A repository with kh-harness installed and this extension registered as the contract's
// "extensions file" section says: written whole to a temporary file in .claude/kh-harness/ and renamed.
function registeredRepo() {
  const repo = repoFor({ 'a.txt': 'x\n' });
  installKhHarness(repo.root);
  mkdirSync(join(repo.root, dirname(MODULE)), { recursive: true });
  copyFileSync(EXTENSION, join(repo.root, MODULE));
  const entry = { id: 'kh-orchestration', version: KIT_VERSION, module: MODULE, sha256: lfSha256(readFileSync(join(repo.root, MODULE))), onFailure: 'block' };
  const temporary = join(repo.root, '.claude/kh-harness/extensions.json.tmp');
  writeFileSync(temporary, `${JSON.stringify([entry], null, 2)}\n`);
  renameSync(temporary, join(repo.root, '.claude/kh-harness/extensions.json'));
  return { repo, entry };
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
  assert.deepEqual(probeContract1(repo.root, entry, { ...PROBE, cwd: repo.root }), { problems: [] });
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
