import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { KIT_VERSION, isolateProcessEnv, makeRepo, testEnv } from './test-repo.mjs';
import { OFFICERS, officersUnreadableMessage, digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { invalidVerdictKeyMessage, stateDir, verdictName } from '../../assets/scripts/ko-state.mjs';
import { passing, produceVerdict, readVerdict, writeVerdict } from '../../assets/scripts/ko-verdict.mjs';

isolateProcessEnv();

const TREE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const result = (id, outcome = 'pass') => ({ id, rule: null, result: outcome, exitCode: outcome === 'pass' ? 0 : null, seconds: 0.5, output: '' });
const verdictOf = (extra = {}) => ({
  schema: 1, tree: TREE, base: BASE, branch: 'feat', digest: 'd'.repeat(64), officers: [result('one'), result('two', 'skipped')],
  agentRuleChanges: [{ id: 'A1', change: 'reworded' }], waivers: [], startedAt: '2026-11-26T10:00:00.000Z', finishedAt: '2026-11-26T10:00:01.000Z', kitVersion: '0.1.0', ...extra,
});

function withRepo(files, body) {
  const repo = makeRepo({ files });
  return Promise.resolve(body(repo)).finally(() => repo.cleanup());
}

const writeRaw = (repo, tree, base, text) => {
  mkdirSync(join(stateDir(repo.root), 'verdicts'), { recursive: true });
  writeFileSync(join(stateDir(repo.root), verdictName(tree, base)), text);
};

test('a verdict is written, and read back from a linked worktree', async () => {
  await withRepo({}, (repo) => {
    const other = repo.addWorktree('side');
    writeVerdict(repo.root, verdictOf());
    assert.deepEqual(readVerdict(other, TREE, BASE), verdictOf());
    assert.deepEqual(readdirSync(join(stateDir(repo.root), 'verdicts')), [`${TREE}-${BASE}.json`]);
    writeVerdict(repo.root, verdictOf({ base: 'none' }));
    assert.deepEqual(readVerdict(repo.root, TREE, 'none'), verdictOf({ base: 'none' }));
  });
});

test('a verdict that is absent reads as null, and a name that could become a path is refused with fixed text', async () => {
  await withRepo({}, (repo) => {
    assert.equal(readVerdict(repo.root, TREE, BASE), null);
    assert.equal(existsSync(stateDir(repo.root)), false);
    for (const [tree, base] of [['../x', BASE], [TREE, 'main'], ['', 'none']]) {
      assert.throws(() => readVerdict(repo.root, tree, base), { name: 'StateError', message: invalidVerdictKeyMessage });
      assert.throws(() => writeVerdict(repo.root, verdictOf({ tree, base })), { name: 'StateError', message: invalidVerdictKeyMessage });
    }
    assert.equal(existsSync(stateDir(repo.root)), false);
  });
});

test('a verdict that cannot be trusted reads as null: other schema, a tree or base that is not the file\'s, a wrong shape, not JSON', async () => {
  await withRepo({}, (repo) => {
    const bad = [
      verdictOf({ schema: 2 }), verdictOf({ schema: undefined }), verdictOf({ tree: 'c'.repeat(40) }), verdictOf({ base: 'c'.repeat(40) }), verdictOf({ base: 'none' }),
      verdictOf({ branch: 1 }), verdictOf({ digest: null }), verdictOf({ officers: {} }), verdictOf({ officers: [{ ...result('one'), result: 'maybe' }] }),
      verdictOf({ officers: [{ ...result('one'), seconds: '1' }] }), verdictOf({ officers: [{ ...result('one'), id: 1 }] }), verdictOf({ officers: [null] }),
      verdictOf({ agentRuleChanges: null }), verdictOf({ waivers: 'none' }), verdictOf({ startedAt: 1 }), verdictOf({ finishedAt: undefined }), verdictOf({ kitVersion: 1 }),
      null, [], 'text', 7,
    ];
    for (const value of bad) {
      writeRaw(repo, TREE, BASE, JSON.stringify(value));
      assert.equal(readVerdict(repo.root, TREE, BASE), null, JSON.stringify(value));
    }
    writeRaw(repo, TREE, BASE, '{ not json');
    assert.equal(readVerdict(repo.root, TREE, BASE), null);
    writeRaw(repo, TREE, BASE, '');
    assert.equal(readVerdict(repo.root, TREE, BASE), null);
    writeVerdict(repo.root, verdictOf({ branch: null }));
    assert.deepEqual(readVerdict(repo.root, TREE, BASE), verdictOf({ branch: null }));
  });
});

test('a verdict file that is a symbolic link reads as null', async () => {
  await withRepo({}, (repo) => {
    writeRaw(repo, 'c'.repeat(40), 'none', JSON.stringify(verdictOf({ tree: 'c'.repeat(40), base: 'none' })));
    symlinkSync(join(stateDir(repo.root), 'verdicts', `${'c'.repeat(40)}-none.json`), join(stateDir(repo.root), 'verdicts', `${TREE}-${BASE}.json`));
    assert.equal(readVerdict(repo.root, TREE, BASE), null);
  });
});

test('passing is true only when the ids equal the officers read from the same tree, in order, and every result is pass or skipped', () => {
  const list = (...ids) => ids.map((id) => ({ id }));
  assert.equal(passing(verdictOf(), list('one', 'two')), true);
  assert.equal(passing(verdictOf({ officers: [] }), []), true);
  for (const outcome of ['fail', 'timeout', 'error']) {
    assert.equal(passing(verdictOf({ officers: [result('one'), result('two', outcome)] }), list('one', 'two')), false, outcome);
  }
  assert.equal(passing(verdictOf(), list('two', 'one')), false);
  assert.equal(passing(verdictOf(), list('one')), false);
  assert.equal(passing(verdictOf(), list('one', 'two', 'three')), false);
  assert.equal(passing(verdictOf({ officers: [] }), list('one')), false);
  assert.equal(passing(verdictOf(), []), false);
});

const officersFile = (...officers) => JSON.stringify({
  schema: 1, baseBranch: 'main', protected: [], officers: officers.map(({ id, argv, appliesTo = ['**'] }) => ({ id, rule: null, argv, appliesTo })),
});
const node = (code) => [process.execPath, '-e', code];

test('produceVerdict records the digest, the results and the supplied fields for the tree', async () => {
  const marker = (id) => `require("node:fs").writeFileSync(${JSON.stringify(id)}, "x")`;
  await withRepo({
    [OFFICERS]: officersFile({ id: 'ok', argv: node('') }, { id: 'bad', argv: node('process.exit(1)') }, { id: 'docs', argv: node(marker('docs-ran')), appliesTo: ['docs/**'] }),
    'src/a.js': 'one\n',
  }, async (repo) => {
    const tree = repo.git('rev-parse', 'HEAD^{tree}').stdout.trim();
    const officers = [
      { id: 'ok', rule: null, argv: node(''), appliesTo: ['**'], timeoutSeconds: 30, options: {} },
      { id: 'bad', rule: 'R1', argv: node('process.exit(1)'), appliesTo: ['**'], timeoutSeconds: 30, options: {} },
      { id: 'docs', rule: null, argv: node(marker('docs-ran')), appliesTo: ['docs/**'], timeoutSeconds: 30, options: {} },
    ];
    const waivers = [{ officer: 'bad', reason: 'x' }];
    const before = new Date().toISOString();
    const made = await produceVerdict(repo.root, { tree, base: 'none', baseTree: null, branch: 'main', officers, waivers, kitVersion: KIT_VERSION });
    const { verdict } = made;
    assert.equal(verdict.schema, 1);
    assert.deepEqual([verdict.tree, verdict.base, verdict.branch, verdict.kitVersion], [tree, 'none', 'main', KIT_VERSION]);
    assert.equal(verdict.digest, digestOfTree(repo.root, tree).digest);
    assert.deepEqual(verdict.officers.map((r) => [r.id, r.rule, r.result]), [['ok', null, 'pass'], ['bad', 'R1', 'fail'], ['docs', null, 'skipped']]);
    assert.deepEqual([verdict.agentRuleChanges, verdict.waivers], [[], waivers]);
    assert.ok(before <= verdict.startedAt && verdict.startedAt <= verdict.finishedAt && verdict.finishedAt <= new Date().toISOString());
    assert.equal(existsSync(join(repo.root, 'docs-ran')), false);
    writeVerdict(repo.root, verdict);
    assert.deepEqual(readVerdict(repo.root, tree, 'none'), verdict);
    assert.equal(passing(verdict, officers), false);
  });
});

test('produceVerdict returns the digest\'s problem and runs nothing when the digest cannot be trusted', async () => {
  await withRepo({ 'a.txt': 'x' }, async (repo) => {
    const tree = repo.git('rev-parse', 'HEAD^{tree}').stdout.trim();
    const officers = [{ id: 'ok', rule: null, argv: node(`require("node:fs").writeFileSync("ran", "x")`), appliesTo: ['**'], timeoutSeconds: 30, options: {} }];
    const made = await produceVerdict(repo.root, { tree, base: 'none', baseTree: null, branch: null, officers, waivers: [], kitVersion: '0.1.0' });
    assert.deepEqual(made, { problem: officersUnreadableMessage });
    assert.equal(existsSync(join(repo.root, 'ran')), false);
  });
});

test('two processes writing the same verdict at once leave one whole file and no temporary file', async () => {
  await withRepo({}, async (repo) => {
    const module = pathToFileURL(join(import.meta.dirname, '..', '..', 'assets', 'scripts', 'ko-verdict.mjs')).href;
    const writer = (label) => new Promise((resolve, reject) => {
      const code = `import(${JSON.stringify(module)}).then(({ writeVerdict }) => { for (let i = 0; i < 40; i++) writeVerdict(${JSON.stringify(repo.root)}, ${JSON.stringify(verdictOf({ branch: label }))}); });`;
      const child = spawn(process.execPath, ['-e', code], { env: testEnv(), stdio: 'ignore' });
      child.on('error', reject);
      child.on('close', (status) => (status === 0 ? resolve() : reject(new Error(`writer ${label} exited ${status}`))));
    });
    await Promise.all([writer('first'), writer('second')]);
    assert.deepEqual(readdirSync(join(stateDir(repo.root), 'verdicts')), [`${TREE}-${BASE}.json`]);
    assert.ok(['first', 'second'].includes(readVerdict(repo.root, TREE, BASE).branch));
  });
});
