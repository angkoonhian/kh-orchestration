// The session-start brief (Task 10): scripts/session-brief.mjs run as Claude Code runs the hook, a
// child process with the hook's JSON on standard input and a clean environment, in fixture
// repositories. Every state's exact text is asserted, and its length.
//
// The hook contract relied on, read from the Claude Code reference on 2026-11-26
// (https://code.claude.com/docs/en/hooks and https://code.claude.com/docs/en/plugins-reference):
//   - Registration: "Define plugin hooks in `hooks/hooks.json` with an optional top-level
//     `description` field. When a plugin is enabled, its hooks merge with your user and project hooks."
//     "`${CLAUDE_PLUGIN_ROOT}`: Absolute path of the plugin's installed version", resolving in hook
//     commands "Anywhere in `command` and `args`". A command hook with `args`: "When present,
//     `command` is resolved as an executable and spawned directly with `args` as the argument
//     vector, with no shell involved." (example: "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/scripts/format.js", "--fix"]).
//   - Manifest: "The manifest is optional. Without it, Claude Code loads the components it finds in
//     the standard layout." Standard layout: skills in `skills/`, hooks in `hooks/hooks.json`. The
//     manifest's `hooks` key "Loaded together with `hooks/hooks.json`"; `skills` "Adds to the
//     default `skills/` scan". So plugin.json declares neither here.
//   - Input: "For command hooks, this JSON arrives via stdin." Common fields include `session_id`,
//     `cwd` ("Current working directory when the hook is invoked") and `hook_event_name`; SessionStart
//     adds `source` ("`startup` for new sessions, `resume` ..., `clear` ..., `compact` ..., or `fork`").
//   - Output: "`additionalContext` | String added to Claude's context at the start of the conversation,
//     before the first prompt." in the form
//     {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
//     ("`hookSpecificOutput` requires a `hookEventName` field set to the event name"). Also: "A hook
//     that only adds context can print it without building JSON, because Claude Code adds a
//     SessionStart hook's plain-text stdout to Claude's context." The JSON form is used here.
//   kh-harness's hooks/hooks.json and scripts/session-nudge.mjs register and write the same way.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installKhHarness, makeRepo, testEnv } from './test-repo.mjs';
import { envPath } from './install.mjs';
import { gitIn, installed, owner } from './gate-fixture.mjs';
import { shellWord } from '../../assets/scripts/extension.mjs';
import { REFUSED_TEXT, hookLine } from '../../assets/scripts/ko-hooks.mjs';
import { stateDir } from '../../assets/scripts/ko-state.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(PLUGIN, 'scripts', 'session-brief.mjs');
const WORKING_CLI = '.claude/kh-orchestration/scripts/ko-cli.mjs';

const CHECKED = 'Commits in this repository are checked by kh-orchestration: a commit lands only when the officers passed on exactly the staged tree and the protected files are owner-approved.';
const OWNER_ONLY = 'Owner-only steps (approve, propose, waive, exempt, off, on, and the plugin\'s apply and uninstall --yes) are the owner\'s to run in their own terminal: ask, do not attempt.';
const OPEN_HERE = 'This worktree is open for proposals: protected files may be edited here.';
const NOT_OPEN_HERE = 'This worktree is not open for proposals: do not edit protected files here.';
const FIX = 'Only the owner can fix this: ask the owner to run the plugin\'s apply.';
const run = (root) => `node ${shellWord(join(root, '.claude/kh-orchestration/scripts/ko.mjs'))} run`;
const normal = (root, open = NOT_OPEN_HERE) => `${CHECKED} Before committing, run the officers with \`${run(root)}\`. ${OWNER_ONLY} ${open}`;
const refused = (clause) => `kh-orchestration is installed here, but ${clause}, so every commit here will be refused. ${FIX}`;
const unchecked = (clause) => `kh-orchestration is installed here, but ${clause}, so git does not run the commit gate here and commits are NOT being checked; only the owner can fix this (ask them to run the plugin's apply).`;
const unsure = (clause) => `kh-orchestration is installed here, but ${clause}. ${FIX}`;
const SCRIPTS_MISSING = `kh-orchestration is installed here, but its approved scripts are missing from the git directory, so commits may be refused. ${FIX}`;
const CONTRACT = 'kh-harness\'s contract with this plugin does not hold here';
const OFF = 'kh-orchestration is switched off for this repository by its owner: commits here are not being checked.';

// The hook as Claude Code runs it: its JSON on standard input, a clean environment.
function brief(cwd, { env = testEnv(), input = JSON.stringify({ session_id: 's', hook_event_name: 'SessionStart', source: 'startup', cwd }) } = {}) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: tmpdir(), env, input, encoding: 'utf8' });
}
// The additional context of a result that spoke, after checking the documented form.
function said(result) {
  assert.deepEqual([result.status, result.stderr], [0, '']);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ['hookSpecificOutput']);
  assert.deepEqual(Object.keys(output.hookSpecificOutput), ['hookEventName', 'additionalContext']);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof output.hookSpecificOutput.additionalContext, 'string');
  return output.hookSpecificOutput.additionalContext;
}
const silent = (result, why) => assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', ''], why);

// Every text a fixture produced, to hold all states to one bound.
const texts = [];
function check(root, expected, options) {
  const text = said(brief(root, options));
  assert.equal(text, expected);
  texts.push(text);
  return text;
}
const scratch = [];
const tmp = (prefix) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
};
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

// ---- silence ----

test('outside a git repository and in a repository without the install the brief is silent', () => {
  silent(brief(tmp('ko-brief-outside-')), 'outside');
  const plain = makeRepo();
  try {
    silent(brief(plain.root), 'no install');
    installKhHarness(plain.root);
    silent(brief(plain.root), 'kh-harness only');
  } finally {
    plain.cleanup();
  }
});

test('malformed, empty, incomplete or relative standard input is silent', () => {
  const repo = installed();
  for (const input of ['', 'not json', 'null', '[]', '{}', '{"cwd": 5}', '{"cwd": "relative/dir"}', `{"cwd": ${JSON.stringify(join(repo.root, 'no-such-dir'))}}`]) {
    silent(brief(repo.root, { input }), input);
  }
  const closed = spawnSync(process.execPath, [SCRIPT], { cwd: tmpdir(), env: testEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  silent(closed, 'closed standard input');
});

// ---- the states ----

test('installed and on: commits are checked, the run command, the owner-only steps, and that this worktree is not open', () => {
  const repo = installed();
  check(repo.root, normal(repo.root));
});

test('the run command is shell-quoted when the path needs it', () => {
  const parent = tmp('ko-brief-quote-');
  const repo = installed();
  const spaced = join(parent, 'a b');
  assert.equal(spawnSync('mv', [repo.root, spaced]).status, 0);
  assert.equal(spawnSync('git', ['worktree', 'repair'], { cwd: spaced, env: testEnv() }).status, 0);
  const text = said(brief(spaced));
  assert.ok(text.includes(`with \`node '${spaced}/.claude/kh-orchestration/scripts/ko.mjs' run\`. `), text);
  texts.push(text);
});

test('open for proposals here, and open in another worktree only', () => {
  const repo = installed();
  const side = repo.addWorktree('side');
  assert.equal(owner(repo.root, ['propose'], { cwd: side }).status, 0);
  check(repo.root, normal(repo.root, NOT_OPEN_HERE));
  assert.equal(owner(repo.root, ['propose']).status, 0);
  check(repo.root, normal(repo.root, OPEN_HERE));
});

test('switched off, and an exempt branch', () => {
  const repo = installed();
  assert.equal(owner(repo.root, ['exempt', 'main', '--reason', 'predates the install']).status, 0);
  check(repo.root, 'This branch, main, is exempt from kh-orchestration: its commits are not being checked.');
  assert.equal(owner(repo.root, ['off']).status, 0);
  check(repo.root, OFF);
  assert.equal(owner(repo.root, ['on']).status, 0);
});

test('a branch name is shown with control characters made visible and cut in length', () => {
  const repo = installed();
  const name = `feat/${'x'.repeat(200)}`;
  assert.equal(gitIn(repo.root, ['checkout', '-q', '-b', name]).status, 0);
  assert.equal(owner(repo.root, ['exempt', name, '--reason', 'r']).status, 0);
  const text = check(repo.root, `This branch, ${name.slice(0, 80)}..., is exempt from kh-orchestration: its commits are not being checked.`);
  assert.ok(!/[\p{Cc}]/u.test(text));
  const controls = gitIn(repo.root, ['checkout', '-q', '-b', 'a‮b']);
  assert.equal(controls.status, 0, controls.stderr);
  assert.equal(owner(repo.root, ['exempt', 'a‮b', '--reason', 'r']).status, 0);
  check(repo.root, 'This branch, a\\u{202e}b, is exempt from kh-orchestration: its commits are not being checked.');
});

// ---- the problems, each claim about a commit proved with a real `git commit` ----

const commitOf = (root, env) => gitIn(root, ['commit', '-q', '-m', 'work'], env);
const editHook = (root, name, change) => {
  const path = join(root, '.git', 'hooks', name);
  writeFileSync(path, change(readFileSync(path, 'utf8')));
};

test('a problem that makes the gate refuse is said to refuse, and the commit is refused', () => {
  const cases = {
    'its install is absent from this branch\'s tree': (root) => gitIn(root, ['rm', '-r', '-q', '--cached', '.claude/kh-orchestration/officers.json']),
    'the officers file in the staged tree cannot be used': (root) => {
      writeFileSync(join(root, '.claude/kh-orchestration/officers.json'), '{');
      gitIn(root, ['add', '-A']);
    },
    [CONTRACT]: (root) => rmSync(join(root, '.claude/kh-harness/extensions.json')),
    'the installed gate directory bin/ holds no gate': (root) => rmSync(join(stateDir(root), 'bin', 'gate.mjs')),
    'the pre-commit git hook names a program that is gone': (root) => editHook(root, 'pre-commit', (text) => text.replace(`'${envPath()}'`, '\'/nonexistent/env\'')),
  };
  for (const [clause, change] of Object.entries(cases)) {
    const repo = installed();
    change(repo.root);
    check(repo.root, refused(clause));
    const committed = commitOf(repo.root);
    assert.equal(committed.status, 1, clause);
    assert.ok(committed.stderr.length > 0, clause);
  }
});

test('with bin/ gone the brief says the approved scripts are missing, imports nothing, and the commit is refused', () => {
  const repo = installed();
  rmSync(join(stateDir(repo.root), 'bin'), { recursive: true });
  check(repo.root, SCRIPTS_MISSING);
  const committed = commitOf(repo.root);
  assert.equal(committed.status, 1);
  assert.ok(committed.stderr.includes(REFUSED_TEXT), committed.stderr);
  // Only the approved copy is missing; the same sentence, whatever else is in bin/.
  const other = installed();
  rmSync(join(stateDir(other.root), 'bin', 'ko-cli.mjs'));
  check(other.root, SCRIPTS_MISSING);
  const linked = installed();
  rmSync(join(stateDir(linked.root), 'bin', 'ko-cli.mjs'));
  mkdirSync(join(stateDir(linked.root), 'bin', 'ko-cli.mjs'));
  check(linked.root, SCRIPTS_MISSING);
});

test('a problem that makes git not run the gate is said so, and the commit lands unchecked', () => {
  const home = tmp('ko-brief-home-');
  writeFileSync(join(home, '.gitconfig'), '[core]\n\thooksPath = /dev/null\n');
  const globalEnv = { ...testEnv(), HOME: home };
  delete globalEnv.GIT_CONFIG_GLOBAL;
  const cases = [
    ['the pre-commit git hook is missing', (root) => rmSync(join(root, '.git', 'hooks', 'pre-commit'))],
    ['the pre-commit git hook is not kh-orchestration\'s', (root) => editHook(root, 'pre-commit', () => '#!/bin/sh\nexit 0\n')],
    ['the pre-commit git hook is not executable', (root) => chmodSync(join(root, '.git', 'hooks', 'pre-commit'), 0o644)],
    ['the pre-commit git hook is not where it runs first', (root) => editHook(root, 'pre-commit', () => `#!/bin/sh\nexit 0\n${hookLine('pre-commit', { env: envPath(), node: process.execPath })}\n`)],
    ['core.hooksPath is set in the global git configuration', () => {}, globalEnv],
  ];
  for (const [clause, change, env] of cases) {
    const repo = installed();
    change(repo.root);
    check(repo.root, unchecked(clause), env === undefined ? undefined : { env });
    const committed = commitOf(repo.root, env);
    assert.equal(committed.status, 0, `${clause}: ${committed.stderr}`);
  }
});

test('a hook or bin/ that differs from the approved one is said without claiming what a commit does', () => {
  const hook = installed();
  editHook(hook.root, 'pre-commit', (text) => `${text}# edited\n`);
  check(hook.root, unsure('the pre-commit git hook differs from the installed one'));
  const bin = installed();
  appendFileSync(join(stateDir(bin.root), 'bin', 'ko-verdict.mjs'), '\n// edited\n');
  check(bin.root, unsure('the installed gate directory bin/ differs from the approved scripts'));
});

test('the first problem is the one named, in the order status reports them', () => {
  const repo = installed();
  rmSync(join(repo.root, '.git', 'hooks', 'pre-commit'));
  rmSync(join(stateDir(repo.root), 'bin', 'gate.mjs'));
  check(repo.root, refused('the installed gate directory bin/ holds no gate'));
});

// ---- only the approved copy is imported ----

// A ko-cli.mjs that writes `marker` when it is loaded, and says everything is fine.
const markerStub = (marker) => `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'imported');\nexport const statusOf = () => ({});\nexport const agentCommand = () => 'x';\n`;

test('a ko-cli.mjs in the working copy is never imported: a clone, or a repository with a planted install, stays silent', () => {
  const planted = makeRepo();
  const marker = join(planted.root, 'imported.txt');
  planted.write(WORKING_CLI, markerStub(marker));
  planted.commitAll('a repository that carries an install');
  silent(brief(planted.root), 'a repository holding only the files');
  assert.ok(!existsSync(marker));

  // Installed on this machine, with a different working copy of the script: the approved one speaks
  // (and status, reading the working repository, sees that bin/ no longer equals the working copy).
  const repo = installed();
  const working = join(repo.root, 'marker.txt');
  writeFileSync(join(repo.root, WORKING_CLI), markerStub(working));
  check(repo.root, unsure('the installed gate directory bin/ differs from the approved scripts'));
  assert.ok(!existsSync(working));

  // A fresh clone has the files but no state directory in its git directory.
  const clone = installed();
  rmSync(stateDir(clone.root), { recursive: true });
  silent(brief(clone.root), 'no state directory');
});

// ---- failures are silent, and the hook always ends with 0 ----

const binCli = (root) => join(stateDir(root), 'bin', 'ko-cli.mjs');

test('a damaged, lying, exiting or noisy approved ko-cli.mjs, and a statusOf that throws, print nothing and exit 0', () => {
  const stubs = {
    syntax: 'export const x = ;\n',
    emptyModule: '',
    noExports: 'export const other = 1;\n',
    throws: 'export const statusOf = () => { throw new Error("git failed"); };\nexport const agentCommand = () => "x";\n',
    notAnObject: 'export const statusOf = () => 7;\nexport const agentCommand = () => "x";\n',
    wrongShape: 'export const statusOf = () => ({ off: "no" });\nexport const agentCommand = () => "x";\n',
    noHelper: 'export const statusOf = () => ({});\n',
    importsMissing: 'import "./does-not-exist.mjs";\nexport const statusOf = () => ({});\n',
    exits: 'process.exit(3);\n',
    exitsInStatus: 'export const statusOf = () => process.exit(3);\nexport const agentCommand = () => "x";\n',
    neverSettles: 'await new Promise(() => {});\nexport const statusOf = () => ({});\n',
  };
  for (const [name, source] of Object.entries(stubs)) {
    const repo = installed();
    writeFileSync(binCli(repo.root), source);
    silent(brief(repo.root), name);
  }
  // Output from the imported module never reaches the context, even beside a valid answer.
  const noisy = installed();
  writeFileSync(binCli(noisy.root), `process.stdout.write('stray text');\nconsole.log('more');\n${readFileSync(binCli(noisy.root), 'utf8')}`);
  silent(brief(noisy.root), 'stray output');
  const symlinked = installed();
  const real = join(symlinked.root, 'elsewhere.mjs');
  writeFileSync(real, readFileSync(binCli(symlinked.root)));
  rmSync(binCli(symlinked.root));
  symlinkSync(real, binCli(symlinked.root));
  check(symlinked.root, SCRIPTS_MISSING);
});

test('an input that never closes, or a module that keeps the process alive, ends silently with 0 inside the timeout', async () => {
  const repo = installed();
  writeFileSync(binCli(repo.root), 'setInterval(() => {}, 1000);\nexport const statusOf = () => ({});\nexport const agentCommand = () => "x";\n');
  const started = performance.now();
  const wait = (child) => new Promise((resolveWait) => {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', (status) => resolveWait({ status, out }));
  });
  const alive = spawn(process.execPath, [SCRIPT], { env: testEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
  alive.stdin.end(JSON.stringify({ cwd: repo.root }));
  const open = spawn(process.execPath, [SCRIPT], { env: testEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
  const results = await Promise.all([wait(alive), wait(open)]);
  open.stdin.destroy();
  assert.deepEqual(results, [{ status: 0, out: '' }, { status: 0, out: '' }]);
  const seconds = (performance.now() - started) / 1000;
  assert.ok(seconds >= 7.5 && seconds < 10, `${seconds} s`);
});

// ---- where it runs ----

test('from a subdirectory and from a linked worktree', () => {
  const repo = installed();
  mkdirSync(join(repo.root, 'tools', 'deep'), { recursive: true });
  check(join(repo.root, 'tools', 'deep'), normal(repo.root));
  // A linked worktree whose tree holds the install, committed past the gate as the owner would.
  assert.equal(gitIn(repo.root, ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'install']).status, 0);
  const side = repo.addWorktree('side');
  const text = said(brief(side));
  assert.ok(text.includes(`with \`node ${shellWord(join(side, '.claude/kh-orchestration/scripts/ko.mjs'))} run\`.`), text);
  texts.push(text);
});

test('a very long path falls back to the short run command and the text stays bounded', () => {
  const repo = installed();
  const parent = tmp('ko-brief-long-');
  const deep = join(parent, ...Array.from({ length: 4 }, () => 'p'.repeat(60)));
  mkdirSync(dirname(deep), { recursive: true });
  assert.equal(spawnSync('mv', [repo.root, deep]).status, 0);
  assert.equal(spawnSync('git', ['worktree', 'repair'], { cwd: deep, env: testEnv() }).status, 0);
  const text = said(brief(deep));
  assert.equal(text, `${CHECKED} Before committing, run the officers with \`node .claude/kh-orchestration/scripts/ko.mjs run\` from the repository's top directory. ${OWNER_ONLY} ${NOT_OPEN_HERE}`);
  texts.push(text);
});

// ---- what it may and may not do ----

// Records every program the brief starts: a preload that wraps child_process.
const PRELOAD = `const cp = require('node:child_process');
const { appendFileSync } = require('node:fs');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function (file, ...rest) {
    appendFileSync(process.env.KO_SPAWN_LOG, JSON.stringify([name, String(file)]) + '\\n');
    return original.call(this, file, ...rest);
  };
}
`;

test('it imports only node: built-ins and the plugin\'s ko-git.mjs, and the only program it starts is git', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const statics = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.ok(statics.every((specifier) => specifier.startsWith('node:') || specifier === '../assets/scripts/ko-git.mjs'), statics.join(', '));
  assert.equal([...source.matchAll(/\bimport\(/g)].length, 1);
  assert.ok(!/\.claude\/kh-orchestration\/scripts\/ko-cli/.test(source));
  assert.ok(!/^await /m.test(source), 'no top-level await');

  const dir = tmp('ko-brief-spawn-');
  const preload = join(dir, 'record.cjs');
  const log = join(dir, 'spawns.log');
  writeFileSync(preload, PRELOAD);
  const repo = installed();
  // The contract's files are intact (the probe is not made impossible), the brief says the usual.
  const env = { ...testEnv(), NODE_OPTIONS: `--require ${preload}`, KO_SPAWN_LOG: log };
  check(repo.root, normal(repo.root), { env });
  const started = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(started.length > 0);
  assert.deepEqual([...new Set(started.map(([, file]) => file))], ['git']);
});

test('it finishes well inside the hook\'s timeout of 10 seconds', () => {
  const repo = installed();
  const started = performance.now();
  said(brief(repo.root));
  const seconds = (performance.now() - started) / 1000;
  console.log(`# session-brief wall time: ${seconds.toFixed(2)} s`);
  assert.ok(seconds < 5, `${seconds} s`);
});

// ---- the manifest and the registration ----

test('hooks/hooks.json registers one SessionStart hook as kh-harness does, and the manifest and it point at existing files', () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'));
  assert.equal(typeof hooks.description, 'string');
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart']);
  assert.deepEqual(hooks.hooks.SessionStart, [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/session-brief.mjs'], timeout: 10 }] }]);
  assert.ok(existsSync(join(PLUGIN, hooks.hooks.SessionStart[0].hooks[0].args[0].replace('${CLAUDE_PLUGIN_ROOT}', ''))));
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'kh-orchestration');
  // Declared by convention: hooks/hooks.json and skills/ are found without a manifest key.
  assert.ok(!('hooks' in manifest) && !('skills' in manifest));
  const skill = readFileSync(join(PLUGIN, 'skills', 'orchestrate', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: orchestrate\ndescription: .+\n---\n/);
});

// Last: every text any state produced.
test('every state\'s text is one paragraph of fixed text under 600 characters', () => {
  assert.ok(texts.length >= 15, `${texts.length}`);
  for (const text of texts) {
    assert.ok(text.length < 600, `${text.length}: ${text}`);
    assert.ok(!/[\n\r#]/.test(text), text);
  }
  console.log(`# session-brief longest text: ${Math.max(...texts.map((text) => text.length))} characters`);
});
