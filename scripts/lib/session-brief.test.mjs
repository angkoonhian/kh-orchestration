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
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installKhHarness, makeRepo, testEnv } from './test-repo.mjs';
import { gitIn, installed, owner } from './gate-fixture.mjs';
import { shellWord } from '../../assets/scripts/extension.mjs';
import { stateDir } from '../../assets/scripts/ko-state.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(PLUGIN, 'scripts', 'session-brief.mjs');
const CLI = '.claude/kh-orchestration/scripts/ko-cli.mjs';

const CHECKED = 'Commits in this repository are checked by kh-orchestration: a commit lands only when the officers passed on exactly the staged tree and the protected files are owner-approved.';
const OWNER_ONLY = 'Owner-only steps (approve, propose, waive, exempt, off, on, and the plugin\'s apply and uninstall --yes) are the owner\'s to run in their own terminal: ask, do not attempt.';
const OPEN_HERE = 'This worktree is open for proposals: protected files may be edited here.';
const NOT_OPEN_HERE = 'This worktree is not open for proposals: do not edit protected files here.';
const FIX = 'Only the owner can fix this: ask the owner to run the plugin\'s apply.';
const run = (root) => `node ${shellWord(join(root, '.claude/kh-orchestration/scripts/ko.mjs'))} run`;
const normal = (root, open = NOT_OPEN_HERE) => `${CHECKED} Before committing, run the officers with \`${run(root)}\`. ${OWNER_ONLY} ${open}`;
const broken = (clause) => `kh-orchestration is installed here, but ${clause}, so every commit here will be refused. ${FIX}`;
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

// ---- the problems that refuse every commit ----

test('a missing bin/, a missing or foreign or broken hook, a global core.hooksPath and a removed extension entry', () => {
  const home = tmp('ko-brief-home-');
  {
    const repo = installed();
    rmSync(join(stateDir(repo.root), 'bin'), { recursive: true });
    check(repo.root, broken('the installed gate directory bin/ is missing'));
  }
  {
    const repo = installed();
    rmSync(join(repo.root, '.git', 'hooks', 'pre-commit'));
    check(repo.root, broken('the pre-commit git hook is missing'));
  }
  {
    const repo = installed();
    writeFileSync(join(repo.root, '.git', 'hooks', 'pre-merge-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo.root, '.git', 'hooks', 'pre-merge-commit'), 0o755);
    check(repo.root, broken('the pre-merge-commit git hook is not kh-orchestration\'s'));
  }
  {
    const repo = installed();
    chmodSync(join(repo.root, '.git', 'hooks', 'pre-commit'), 0o644);
    check(repo.root, broken('the pre-commit git hook is not executable'));
  }
  {
    const repo = installed();
    writeFileSync(join(home, '.gitconfig'), '[core]\n\thooksPath = /dev/null\n');
    const env = { ...testEnv(), HOME: home };
    delete env.GIT_CONFIG_GLOBAL;
    check(repo.root, 'kh-orchestration is installed here, but core.hooksPath is set in the global git configuration, so git runs none of its hooks and commits are not being checked. Only the owner can fix this.', { env });
  }
  {
    const repo = installed();
    rmSync(join(repo.root, '.claude/kh-harness/extensions.json'));
    const text = said(brief(repo.root));
    assert.ok(text.startsWith('kh-orchestration is installed here, but kh-harness contract 1 does not hold ('), text);
    assert.ok(text.endsWith(`), so every commit here will be refused. ${FIX}`), text);
    texts.push(text);
  }
  {
    const repo = installed();
    assert.equal(gitIn(repo.root, ['rm', '-r', '-q', '--cached', '.claude/kh-orchestration/officers.json']).status, 0);
    check(repo.root, broken('its install is absent from this branch\'s tree'));
  }
});

test('the first problem is the one named, in the order status reports them', () => {
  const repo = installed();
  rmSync(join(stateDir(repo.root), 'bin'), { recursive: true });
  rmSync(join(repo.root, '.git', 'hooks', 'pre-commit'));
  check(repo.root, broken('the installed gate directory bin/ is missing'));
});

// ---- failures are silent ----

const stubCli = (root, source) => writeFileSync(join(root, CLI), source);

test('a damaged, missing, replaced or lying ko-cli.mjs, and a statusOf that throws, print nothing and exit 0', () => {
  const stubs = {
    syntax: 'export const x = ;\n',
    emptyModule: '',
    noExports: 'export const other = 1;\n',
    throws: 'export const statusOf = () => { throw new Error("git failed"); };\nexport const agentCommand = () => "x";\n',
    notAnObject: 'export const statusOf = () => 7;\nexport const agentCommand = () => "x";\n',
    wrongShape: 'export const statusOf = () => ({ off: "no" });\nexport const agentCommand = () => "x";\n',
    noHelper: 'export const statusOf = () => ({});\n',
    importsMissing: 'import "./does-not-exist.mjs";\nexport const statusOf = () => ({});\n',
  };
  for (const [name, source] of Object.entries(stubs)) {
    const repo = installed();
    stubCli(repo.root, source);
    silent(brief(repo.root), name);
  }
  const gone = installed();
  rmSync(join(gone.root, CLI));
  silent(brief(gone.root), 'missing');
  const linked = installed();
  const real = join(linked.root, 'elsewhere.mjs');
  writeFileSync(real, readFileSync(join(linked.root, CLI)));
  rmSync(join(linked.root, CLI));
  symlinkSync(real, join(linked.root, CLI));
  silent(brief(linked.root), 'symlink');
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

test('it imports only node: built-ins and, dynamically, the one ko-cli.mjs, and runs nothing from the repository', () => {
  const source = readFileSync(SCRIPT, 'utf8');
  const statics = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((match) => match[1]);
  assert.ok(statics.length > 0 && statics.every((specifier) => specifier.startsWith('node:')), statics.join(', '));
  assert.equal([...source.matchAll(/\bimport\(/g)].length, 1);
  assert.deepEqual([...source.matchAll(/'(\.claude[^']*)'/g)].map((match) => match[1]), [CLI]);
  assert.deepEqual([...source.matchAll(/\bspawnSync\(\s*'([^']+)'/g)].map((match) => match[1]), ['git']);
  assert.ok(!/\bexecFile|\bexecSync|\bspawn\(|\bfork\(|\beval\(/.test(source));

  // A stub where the gate's probe would run: it must never run.
  const repo = installed();
  const marker = join(repo.root, 'probe-ran.txt');
  mkdirSync(join(repo.root, '.claude/scripts'), { recursive: true });
  writeFileSync(join(repo.root, '.claude/scripts/dispatch-pre-tool.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.stdout.write('{}');\n`);
  // Replacing the file changes the contract's files, so the brief names that problem; the stub never ran.
  const text = said(brief(repo.root));
  assert.ok(text.startsWith('kh-orchestration is installed here, but kh-harness contract 1 does not hold ('), text);
  texts.push(text);
  assert.ok(!existsSync(marker));
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
