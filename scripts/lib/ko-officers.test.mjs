import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isolateProcessEnv, makeRepo } from './test-repo.mjs';
import { MAX_GLOBS, matchesGlob } from '../../assets/scripts/extension.mjs';
import { OFFICERS, officersUnreadableMessage, treeNotIdMessage } from '../../assets/scripts/ko-digest.mjs';
import {
  DEFAULT_TIMEOUT_SECONDS, MAX_OUTPUT_CHARACTERS, MAX_TIMEOUT_SECONDS, duplicateIdMessage, invalidOfficersMessage, officersOfTree, runOfficers, signalMessage, startFailedMessage,
} from '../../assets/scripts/ko-officers.mjs';

isolateProcessEnv();

const TREE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const officer = (extra = {}) => ({ id: 'o1', rule: null, argv: ['node', '-e', ''], appliesTo: ['**'], ...extra });
const document = (extra = {}) => ({ schema: 1, baseBranch: 'main', protected: [], officers: [officer()], ...extra });
const treeOf = (repo) => repo.git('rev-parse', 'HEAD^{tree}').stdout.trim();

function withRepo(files, body) {
  const repo = makeRepo({ files });
  try {
    return body(repo);
  } finally {
    repo.cleanup();
  }
}

async function inRepo(files, body) {
  const repo = makeRepo({ files });
  try {
    return await body(repo);
  } finally {
    repo.cleanup();
  }
}

const readDocument = (value, files = {}) => withRepo({ [OFFICERS]: typeof value === 'string' ? value : JSON.stringify(value), ...files }, (repo) => officersOfTree(repo.root, treeOf(repo)));
const problemOf = (value) => readDocument(value).problem;

test('officersOfTree reads the file from the tree with defaults filled in, and shares the one glob matcher', () => {
  const result = readDocument(document({ officers: [officer({ id: 'a', rule: 'R1', appliesTo: ['**/*.py'] }), officer({ id: 'b', timeoutSeconds: 5, options: { n: 1 } })] }));
  assert.deepEqual(result, {
    baseBranch: 'main',
    officers: [
      { id: 'a', rule: 'R1', argv: ['node', '-e', ''], appliesTo: ['**/*.py'], timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, options: {} },
      { id: 'b', rule: null, argv: ['node', '-e', ''], appliesTo: ['**'], timeoutSeconds: 5, options: { n: 1 } },
    ],
  });
  assert.equal(DEFAULT_TIMEOUT_SECONDS, 600);
  assert.equal(matchesGlob('**/*.py', 'x/a.py'), true);
});

test('officersOfTree reads the tree, not the working directory', () => {
  withRepo({ [OFFICERS]: JSON.stringify(document()) }, (repo) => {
    writeFileSync(join(repo.root, OFFICERS), JSON.stringify(document({ baseBranch: 'other' })));
    assert.equal(officersOfTree(repo.root, treeOf(repo)).baseBranch, 'main');
  });
});

test('officersOfTree returns the digest module\'s problem when the file cannot be read, and an empty list is valid', () => {
  withRepo({ 'a.txt': 'x' }, (repo) => {
    assert.deepEqual(officersOfTree(repo.root, treeOf(repo)), { problem: officersUnreadableMessage });
  });
  assert.deepEqual(readDocument('not json'), { problem: officersUnreadableMessage });
  assert.deepEqual(readDocument(document({ schema: 2 })), { problem: officersUnreadableMessage });
  assert.deepEqual(readDocument(document({ officers: [] })), { baseBranch: 'main', officers: [] });
  withRepo({ 'a.txt': 'x' }, (repo) => {
    assert.match(officersOfTree(repo.root, TREE).problem, /^The protected files could not be read: /);
    for (const name of ['HEAD', 'main', 'HEAD^{tree}'.slice(0, 4), '--output=x', '']) {
      assert.deepEqual(officersOfTree(repo.root, name), { problem: treeNotIdMessage }, name);
    }
  });
});

test('officersOfTree refuses what the runner cannot run, with fixed text naming the problem', () => {
  const cases = [
    [document({ baseBranch: '' }), 'baseBranch must be a non-empty string'],
    [document({ baseBranch: 1 }), 'baseBranch must be a non-empty string'],
    [{ ...document(), extra: 1 }, 'it has a key other than schema, baseBranch, protected and officers'],
    [{ schema: 1, protected: [], officers: [] }, 'it has a key other than schema, baseBranch, protected and officers'],
    [document({ officers: [{ ...officer(), extra: 1 }] }), 'officer o1 has a key other than id, rule, argv, appliesTo, timeoutSeconds and options'],
    [document({ officers: [{ id: 'o1', argv: ['x'], appliesTo: ['**'] }] }), 'officer o1 is missing the key rule'],
    [document({ officers: [{ id: 'o1', rule: null, argv: ['x'] }] }), 'officer o1 is missing the key appliesTo'],
    [document({ officers: [officer({ id: '' })] }), 'an officer has an empty id'],
    [document({ officers: [officer({ argv: [''] })] }), 'officer o1: argv must start with a command, and no element may contain a NUL character'],
    [document({ officers: [officer({ argv: ['tr\u0000ue'] })] }), 'officer o1: argv must start with a command, and no element may contain a NUL character'],
    [document({ officers: [officer({ argv: ['node', 'a\u0000b'] })] }), 'officer o1: argv must start with a command, and no element may contain a NUL character'],
    [document({ officers: [officer({ rule: 1 })] }), 'officer o1: rule must be a string or null'],
    [document({ officers: [officer({ appliesTo: [] })] }), 'officer o1: appliesTo must be a non-empty list of valid globs'],
    [document({ officers: [officer({ appliesTo: ['a/'] })] }), 'officer o1: appliesTo must be a non-empty list of valid globs'],
    [document({ officers: [officer({ appliesTo: [1] })] }), 'officer o1: appliesTo must be a non-empty list of valid globs'],
    [document({ officers: [officer({ appliesTo: 'x' })] }), 'officer o1: appliesTo must be a non-empty list of valid globs'],
    [document({ officers: [officer({ appliesTo: Array.from({ length: MAX_GLOBS + 1 }, (_, i) => `f${i}`) })] }), 'officer o1: appliesTo must be a non-empty list of valid globs'],
    ...[0, 3601, 1.5, '5', null].map((value) => [document({ officers: [officer({ timeoutSeconds: value })] }), 'officer o1: timeoutSeconds must be an integer from 1 to 3600']),
    ...[null, [], 'x', 1].map((value) => [document({ officers: [officer({ options: value })] }), 'officer o1: options must be an object']),
  ];
  for (const [value, reason] of cases) {
    assert.deepEqual(problemOf(value), invalidOfficersMessage(reason), reason);
  }
  assert.equal(MAX_TIMEOUT_SECONDS, 3600);
  assert.deepEqual(problemOf(document({ officers: [officer(), officer()] })), duplicateIdMessage('o1'));
  assert.equal(problemOf(document({ officers: [officer({ timeoutSeconds: 3600 }), officer({ id: 'o2', timeoutSeconds: 1 })] })), undefined);
});

// ---- running ----

const node = (code) => [process.execPath, '-e', code];
const run = (repo, officers, extra = {}) => runOfficers(repo.root, { base: BASE, tree: TREE, changed: ['src/a.js'], waivers: [], officers: officers.map((entry) => ({ rule: null, appliesTo: ['**'], timeoutSeconds: 30, options: {}, ...entry })), ...extra });

test('every officer runs in listed order, even after a failure, and the results carry the record fields', async () => {
  await inRepo({ 'a.txt': 'x' }, async (repo) => {
    const results = await run(repo, [
      { id: 'good', rule: 'R1', argv: node('process.stdout.write("out"); process.stderr.write("err")') },
      { id: 'bad', argv: node('process.exit(3)') },
      { id: 'after', argv: node('') },
    ]);
    assert.deepEqual(results.map((r) => [r.id, r.rule, r.result, r.exitCode]), [['good', 'R1', 'pass', 0], ['bad', null, 'fail', 3], ['after', null, 'pass', 0]]);
    assert.equal(results[0].output, 'outerr');
    assert.equal(typeof results[0].seconds, 'number');
    assert.equal(Math.round(results[0].seconds * 1000), results[0].seconds * 1000);
    assert.ok(results[0].seconds > 0);
  });
});

test('officers run one at a time', async () => {
  await inRepo({}, async (repo) => {
    const log = join(repo.root, '..', 'order.log');
    const step = (name) => node(`const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(log)}, "start ${name}\\n"); setTimeout(() => { fs.appendFileSync(${JSON.stringify(log)}, "end ${name}\\n"); }, 200);`);
    await run(repo, [{ id: 'a', argv: step('a') }, { id: 'b', argv: step('b') }]);
    assert.equal(readFileSync(log, 'utf8'), 'start a\nend a\nstart b\nend b\n');
  });
});

test('an officer none of whose globs match a changed path is skipped and not started', async () => {
  await inRepo({}, async (repo) => {
    const marker = join(repo.root, 'started');
    const results = await run(repo, [
      { id: 'py', appliesTo: ['**/*.py', 'docs/**'], argv: node(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`) },
      { id: 'js', appliesTo: ['src/*.js'], argv: node('') },
    ]);
    assert.deepEqual(results[0], { id: 'py', rule: null, result: 'skipped', exitCode: null, seconds: 0, output: '' });
    assert.equal(results[1].result, 'pass');
    assert.equal(existsSync(marker), false);
    assert.equal((await run(repo, [{ id: 'x', argv: node('') }], { changed: [] }))[0].result, 'skipped');
  });
});

test('KO_OPTIONS, KO_BASE, KO_TREE and KO_CHANGED_FILE reach the officer, and the changed-paths file lives outside the repository and is removed afterwards', async () => {
  await inRepo({}, async (repo) => {
    const out = join(repo.root, '..', 'seen.json');
    const code = `const fs = require("node:fs"); const file = process.env.KO_CHANGED_FILE;
      fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ options: process.env.KO_OPTIONS, base: process.env.KO_BASE, tree: process.env.KO_TREE, file, text: fs.readFileSync(file, "utf8"), cwd: process.cwd() }));`;
    const [result] = await run(repo, [{ id: 'env', options: { level: 2 }, argv: node(code) }], { changed: ['a b.js', 'dir/c.js'] });
    assert.equal(result.result, 'pass', result.output);
    const seen = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(seen.options, '{"level":2}');
    assert.equal(seen.base, BASE);
    assert.equal(seen.tree, TREE);
    assert.equal(seen.text, 'a b.js\0dir/c.js');
    assert.equal(seen.cwd, repo.root);
    assert.equal(seen.file.startsWith(repo.root), false);
    // Its own directory, not a count of all of them: other test files run officers at the same time.
    assert.equal(existsSync(dirname(seen.file)), false);
  });
});

test('the officer does not inherit git\'s hook variables', async () => {
  await inRepo({}, async (repo) => {
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];
    for (const name of names) process.env[name] = '/nowhere';
    try {
      const [result] = await run(repo, [{ id: 'env', argv: node(`process.stdout.write(JSON.stringify(Object.keys(process.env).filter((n) => n.startsWith("GIT_"))))`) }]);
      assert.equal(result.output, '[]');
    } finally {
      for (const name of names) delete process.env[name];
    }
  });
});

test('a command that does not exist is an error with fixed text, and the run goes on', async () => {
  await inRepo({}, async (repo) => {
    const results = await run(repo, [{ id: 'gone', argv: ['/nonexistent/officer-command', 'x'] }, { id: 'next', argv: node('') }]);
    assert.deepEqual(results[0], { id: 'gone', rule: null, result: 'error', exitCode: null, seconds: results[0].seconds, output: startFailedMessage('/nonexistent/officer-command') });
    assert.equal(results[1].result, 'pass');
  });
});

test('an officer killed by a signal that is not ours is an error', async () => {
  await inRepo({}, async (repo) => {
    const [result] = await run(repo, [{ id: 'killed', argv: node('process.kill(process.pid, "SIGKILL")') }]);
    assert.deepEqual([result.result, result.exitCode, result.output], ['error', null, signalMessage('SIGKILL')]);
  });
});

test('argv is run without a shell', async () => {
  await inRepo({}, async (repo) => {
    const [result] = await run(repo, [{ id: 'echo', argv: ['echo', '; touch x'] }]);
    assert.equal(result.output, '; touch x\n');
    assert.equal(existsSync(join(repo.root, 'x')), false);
  });
});

test('a timeout kills the officer and its descendants and is named as a timeout', async () => {
  await inRepo({}, async (repo) => {
    const marker = join(repo.root, '..', 'grandchild-ran');
    const child = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x"), 2500)`;
    const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" }); process.stdout.write("started"); setInterval(() => {}, 1000);`;
    const [result] = await run(repo, [{ id: 'slow', timeoutSeconds: 1, argv: node(parent) }]);
    assert.deepEqual([result.result, result.exitCode, result.output], ['timeout', null, 'started']);
    assert.ok(result.seconds >= 1 && result.seconds < 2.5, String(result.seconds));
    await new Promise((resolve) => setTimeout(resolve, 3000));
    assert.equal(existsSync(marker), false);
  });
});

test('a timeout ends an officer that ignores the polite signal', async () => {
  await inRepo({}, async (repo) => {
    const [result] = await run(repo, [{ id: 'stubborn', timeoutSeconds: 1, argv: node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);') }]);
    assert.equal(result.result, 'timeout');
  });
});

test('output is the first 4000 characters of standard output then standard error, whole characters and valid text', async () => {
  await inRepo({}, async (repo) => {
    const [cut, joined, lenient, flood] = await run(repo, [
      { id: 'cut', argv: node('process.stdout.write("x".repeat(5000))') },
      { id: 'joined', argv: node('process.stderr.write("E"); process.stdout.write("O".repeat(3999) + "Z")') },
      { id: 'lenient', argv: node('process.stdout.write(Buffer.concat([Buffer.from("ok"), Buffer.from([0xff, 0xfe])]))') },
      { id: 'flood', argv: node('const chunk = Buffer.alloc(1 << 20, "a"); let n = 0; (function more() { while (n++ < 256) { if (!process.stdout.write(chunk)) return process.stdout.once("drain", more); } })();') },
    ]);
    assert.equal(MAX_OUTPUT_CHARACTERS, 4000);
    assert.equal(cut.output, 'x'.repeat(4000));
    assert.equal(joined.output, `${'O'.repeat(3999)}ZE`.slice(0, 4000));
    assert.equal(lenient.output, 'ok��');
    assert.equal(flood.result, 'pass');
    assert.equal(flood.output, 'a'.repeat(4000));
  });
  await inRepo({}, async (repo) => {
    const [astral] = await run(repo, [{ id: 'astral', argv: node('process.stdout.write("x".repeat(3999) + "\\u{1F600}")') }]);
    assert.equal(astral.output, 'x'.repeat(3999));
    assert.equal(astral.output.isWellFormed(), true);
  });
});

test('an argv that cannot be spawned is an error with the start-failure text, and the remaining officers still run', async () => {
  await inRepo({}, async (repo) => {
    const results = await run(repo, [
      { id: 'empty', argv: [''] },
      { id: 'nul', argv: ['tr\u0000ue'] },
      { id: 'nul-arg', argv: [process.execPath, 'a\u0000b'] },
      { id: 'after', argv: node('') },
    ]);
    assert.deepEqual(results.map((r) => [r.result, r.output]), [['error', startFailedMessage('')], ['error', startFailedMessage('tr\u0000ue')], ['error', startFailedMessage(process.execPath)], ['pass', '']]);
  });
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pidFile = (repo) => join(repo.root, '..', 'stray.pid');
// An officer whose leader ends at once, leaving a descendant that holds the output pipes; `detached` puts the descendant in a group of its own.
const straySpawner = (repo, detached, seconds) => node(
  `const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, ${seconds * 1000})"], { detached: ${detached}, stdio: ["ignore", "inherit", "inherit"] });
   require("node:fs").writeFileSync(${JSON.stringify(pidFile(repo))}, String(child.pid)); child.unref();`,
);
const killStray = (repo) => {
  try {
    process.kill(Number(readFileSync(pidFile(repo), 'utf8')), 'SIGKILL');
  } catch {
    // already gone
  }
};

test('the run ends by the timeout plus its grace even when a descendant in another group holds the pipes', async () => {
  await inRepo({}, async (repo) => {
    try {
      const started = Date.now();
      const [result] = await run(repo, [{ id: 'sticky', timeoutSeconds: 1, argv: node(`process.stdout.write("kept"); require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref(); setInterval(() => {}, 1000);`) }]);
      assert.equal(result.result, 'timeout');
      assert.equal(result.output, 'kept');
      assert.ok(Date.now() - started < 4000, `${Date.now() - started} ms`);
    } finally {
      killStray(repo);
    }
  });
});

test('a leader that exits 0 is a pass even while a descendant in another group holds the pipes, and the run does not wait for it', async () => {
  await inRepo({}, async (repo) => {
    try {
      const started = Date.now();
      const [result] = await run(repo, [{ id: 'detached', argv: straySpawner(repo, true, 20) }]);
      assert.equal(result.result, 'pass');
      assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
    } finally {
      killStray(repo);
    }
  });
});

test('a background child left in the officer\'s group is killed when the officer finishes, whatever the result', async () => {
  await inRepo({}, async (repo) => {
    for (const exit of ['', 'process.exit(1);']) {
      try {
        const started = Date.now();
        const [result] = await run(repo, [{ id: 'leaky', argv: node(`${straySpawner(repo, false, 20).at(-1)} ${exit}`) }]);
        assert.equal(result.result, exit === '' ? 'pass' : 'fail');
        assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
        await new Promise((resolve) => setTimeout(resolve, 200));
        assert.equal(alive(Number(readFileSync(pidFile(repo), 'utf8'))), false);
      } finally {
        killStray(repo);
      }
    }
  });
});

test('standard output and standard error are decoded separately, so a split character is two invalid bytes', async () => {
  await inRepo({}, async (repo) => {
    const [result] = await run(repo, [{ id: 'split', argv: node('process.stdout.write(Buffer.from([0xc3])); process.stderr.write(Buffer.from([0xa9]))') }]);
    assert.equal(result.output, '\ufffd\ufffd');
  });
});

test('the officer inherits no git configuration and no KO_ variable but the five it is given', async () => {
  await inRepo({}, async (repo) => {
    const names = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'KO_STRAY', 'KO_OPTIONS_EXTRA'];
    for (const name of names) process.env[name] = 'x';
    process.env.KEEP_ME = 'y';
    try {
      const [result] = await run(repo, [{ id: 'env', argv: node('process.stdout.write(JSON.stringify(Object.keys(process.env).filter((n) => /^(GIT_|KO_|KEEP_)/.test(n)).sort()))') }]);
      assert.deepEqual(JSON.parse(result.output), ['KEEP_ME', 'KO_BASE', 'KO_CHANGED_FILE', 'KO_OPTIONS', 'KO_TREE', 'KO_WAIVERS']);
    } finally {
      for (const name of [...names, 'KEEP_ME']) delete process.env[name];
    }
  });
});

test('KO_WAIVERS gives every officer the waivers in force as a JSON array of { rule, reason }, and [] when there are none', async () => {
  await inRepo({}, async (repo) => {
    const show = node('process.stdout.write(process.env.KO_WAIVERS)');
    const waivers = [{ rule: 'V8', branch: 'feat', reason: 'docs land next', at: '2026-11-26T00:00:00.000Z' }, { rule: 'V11', branch: 'feat', reason: 'a "quoted" why', at: 'x' }];
    const [one, two] = await run(repo, [{ id: 'a', argv: show }, { id: 'b', argv: show }], { waivers });
    assert.deepEqual(JSON.parse(one.output), [{ rule: 'V8', reason: 'docs land next' }, { rule: 'V11', reason: 'a "quoted" why' }]);
    assert.equal(two.output, one.output);
    const [none] = await run(repo, [{ id: 'a', argv: show }]);
    assert.equal(none.output, '[]');
  });
});
