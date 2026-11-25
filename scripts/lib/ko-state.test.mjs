import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { isolateProcessEnv, makeRepo } from './test-repo.mjs';
import {
  StateError, appendJournal, corruptMessage, invalidValueMessage, invalidVerdictKeyMessage, isOff, readApprovals, readExemptions, readInflight, readState, removeInflight, removeStaleInflight, shapeMessage, stateDir,
  invalidPidMessage, stateUnreadableMessage, unknownNameMessage, writeInflight, verdictName, writeFailedMessage, writeState,
} from '../../assets/scripts/ko-state.mjs';

// The modules take the caller's git environment; a test must not inherit a hook's.
isolateProcessEnv();

function withRepo(body) {
  const repo = makeRepo();
  try {
    return body(repo);
  } finally {
    repo.cleanup();
  }
}

test('stateDir is kh-orchestration under the git common directory, the same from a linked worktree', () => {
  withRepo((repo) => {
    const second = repo.addWorktree('side');
    assert.equal(stateDir(repo.root), join(repo.root, '.git', 'kh-orchestration'));
    assert.equal(stateDir(second), stateDir(repo.root));
  });
});

test('readState returns the fallback for an absent file and does not create the directory', () => {
  withRepo((repo) => {
    const fallback = { digests: [] };
    assert.equal(readState(repo.root, 'approvals.json', fallback), fallback);
    assert.equal(existsSync(stateDir(repo.root)), false);
  });
});

test('readState throws a StateError with fixed text for corrupt JSON, never the fallback', () => {
  withRepo((repo) => {
    mkdirSync(stateDir(repo.root), { recursive: true });
    for (const text of ['{"digests": [', '', 'not json']) {
      writeFileSync(join(stateDir(repo.root), 'approvals.json'), text);
      assert.throws(
        () => readState(repo.root, 'approvals.json', { digests: [] }),
        (error) => error instanceof StateError && error.message === corruptMessage('approvals.json'),
      );
    }
  });
});

test('readState throws a StateError for a file that cannot be read', () => {
  withRepo((repo) => {
    mkdirSync(join(stateDir(repo.root), 'waivers.json'), { recursive: true });
    assert.throws(() => readState(repo.root, 'waivers.json', []), { name: 'StateError', message: corruptMessage('waivers.json') });
  });
});

test('readState reads a JSON value, including one that looks like a fallback', () => {
  withRepo((repo) => {
    mkdirSync(stateDir(repo.root), { recursive: true });
    writeFileSync(join(stateDir(repo.root), 'exemptions.json'), 'null');
    assert.equal(readState(repo.root, 'exemptions.json', ['fallback']), null);
  });
});

test('state names are a fixed set with no path separators', () => {
  withRepo((repo) => {
    for (const name of ['../approvals.json', 'verdicts/x.json', 'approvals', 'journal.jsonl', 'off', '']) {
      assert.throws(() => readState(repo.root, name, null), { name: 'StateError', message: unknownNameMessage(name) });
      assert.throws(() => writeState(repo.root, name, {}), { name: 'StateError', message: unknownNameMessage(name) });
    }
    assert.equal(existsSync(stateDir(repo.root)), false);
  });
});

test('writeState round-trips a value, replaces an old one and leaves no temporary file', () => {
  withRepo((repo) => {
    writeState(repo.root, 'approvals.json', { digests: [{ digest: 'a', approvedAt: 'then', branch: 'main' }] });
    writeState(repo.root, 'approvals.json', { digests: [] });
    assert.deepEqual(readState(repo.root, 'approvals.json', null), { digests: [] });
    assert.deepEqual(readdirSync(stateDir(repo.root)), ['approvals.json']);
    assert.equal(readFileSync(join(stateDir(repo.root), 'approvals.json'), 'utf8'), '{\n  "digests": []\n}\n');
  });
});

test('writeState from a linked worktree is read from the main checkout', () => {
  withRepo((repo) => {
    const second = repo.addWorktree('side');
    writeState(second, 'proposals.json', ['x']);
    assert.deepEqual(readState(repo.root, 'proposals.json', null), ['x']);
  });
});

test('a failed writeState throws a StateError, keeps the old file and leaves no temporary file', { skip: process.getuid?.() === 0 }, () => {
  withRepo((repo) => {
    writeState(repo.root, 'waivers.json', { old: true });
    const dir = stateDir(repo.root);
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => writeState(repo.root, 'waivers.json', { old: false }), { name: 'StateError', message: writeFailedMessage('waivers.json') });
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.deepEqual(readState(repo.root, 'waivers.json', null), { old: true });
    assert.deepEqual(readdirSync(dir), ['waivers.json']);
  });
});

test('isOff is true only while the off file exists', () => {
  withRepo((repo) => {
    assert.equal(isOff(repo.root), false);
    mkdirSync(stateDir(repo.root), { recursive: true });
    writeFileSync(join(stateDir(repo.root), 'off'), '');
    assert.equal(isOff(repo.root), true);
  });
});

test('appendJournal appends one JSON line per entry and keeps earlier lines', () => {
  withRepo((repo) => {
    appendJournal(repo.root, { event: 'first', note: 'two\nlines' });
    appendJournal(repo.root, { event: 'second' });
    const lines = readFileSync(join(stateDir(repo.root), 'journal.jsonl'), 'utf8').split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[2], '');
    assert.deepEqual(JSON.parse(lines[0]), { event: 'first', note: 'two\nlines' });
    assert.deepEqual(JSON.parse(lines[1]), { event: 'second' });
  });
});

test('readState throws for a dangling symlink and for a symlink to a valid file, never the fallback', () => {
  withRepo((repo) => {
    const dir = stateDir(repo.root);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(dir, 'missing-target'), join(dir, 'approvals.json'));
    assert.throws(() => readState(repo.root, 'approvals.json', { digests: [] }), { name: 'StateError', message: corruptMessage('approvals.json') });
    writeFileSync(join(dir, 'real.json'), '{}');
    symlinkSync(join(dir, 'real.json'), join(dir, 'waivers.json'));
    assert.throws(() => readState(repo.root, 'waivers.json', []), { name: 'StateError', message: corruptMessage('waivers.json') });
  });
});

test('writeState rejects a value that does not serialise to JSON that parses back, and writes nothing', () => {
  withRepo((repo) => {
    const circular = {};
    circular.self = circular;
    writeState(repo.root, 'waivers.json', { old: true });
    for (const value of [undefined, () => 1, 10n, circular, Symbol('s')]) {
      assert.throws(() => writeState(repo.root, 'waivers.json', value), { name: 'StateError', message: invalidValueMessage('waivers.json') });
    }
    assert.deepEqual(readState(repo.root, 'waivers.json', null), { old: true });
    assert.deepEqual(readdirSync(stateDir(repo.root)), ['waivers.json']);
    assert.throws(() => writeState(repo.root, 'approvals.json', undefined), { name: 'StateError' });
    assert.equal(existsSync(join(stateDir(repo.root), 'approvals.json')), false);
  });
});

test('appendJournal rejects an entry that does not serialise, and appends nothing', () => {
  withRepo((repo) => {
    appendJournal(repo.root, { event: 'first' });
    assert.throws(() => appendJournal(repo.root, undefined), { name: 'StateError', message: invalidValueMessage('journal.jsonl') });
    assert.throws(() => appendJournal(repo.root, { n: 1n }), { name: 'StateError', message: invalidValueMessage('journal.jsonl') });
    assert.equal(readFileSync(join(stateDir(repo.root), 'journal.jsonl'), 'utf8'), '{"event":"first"}\n');
  });
});

const TREE = 'a'.repeat(40);
const BASE = 'b'.repeat(64);

test('verdictName joins a full hexadecimal tree and a full hexadecimal base or none, and refuses anything that could become a path', () => {
  assert.equal(verdictName(TREE, BASE), `verdicts/${TREE}-${BASE}.json`);
  assert.equal(verdictName(TREE, 'none'), `verdicts/${TREE}-none.json`);
  for (const [tree, base] of [['abc', 'none'], [TREE, 'main'], [TREE, ''], ['../x', 'none'], [`${TREE}/..`, 'none'], [TREE.toUpperCase(), 'none'], [TREE, `${BASE}\n`], [TREE, 'none/'], [undefined, 'none'], [TREE, null]]) {
    assert.throws(() => verdictName(tree, base), { name: 'StateError', message: invalidVerdictKeyMessage });
  }
});

test('a verdict file is read and written by state like any other: absent is the fallback, corrupt throws, a write leaves one whole file', () => {
  withRepo((repo) => {
    const name = verdictName(TREE, 'none');
    assert.equal(readState(repo.root, name, null), null);
    writeState(repo.root, name, { first: 1 });
    writeState(repo.root, name, { second: 2 });
    assert.deepEqual(readState(repo.root, name, null), { second: 2 });
    assert.deepEqual(readdirSync(join(stateDir(repo.root), 'verdicts')), [`${TREE}-none.json`]);
    writeFileSync(join(stateDir(repo.root), name), '{');
    assert.throws(() => readState(repo.root, name, null), { name: 'StateError', message: corruptMessage(name) });
  });
});

const DIGEST = 'a'.repeat(64);

test('readApprovals: absent is nothing approved; the records are given back as written', () => {
  withRepo((repo) => {
    assert.deepEqual(readApprovals(repo.root), []);
    const digests = [{ digest: DIGEST, approvedAt: '2026-11-26T00:00:00.000Z', branch: 'main' }, { digest: 'b'.repeat(64), approvedAt: 'x', branch: null }];
    writeState(repo.root, 'approvals.json', { digests });
    assert.deepEqual(readApprovals(repo.root), digests);
  });
});

test('readApprovals throws a StateError with fixed text for any other shape, never "nothing approved"', () => {
  withRepo((repo) => {
    const entry = { digest: DIGEST, approvedAt: 'x', branch: 'main' };
    for (const value of [
      [], null, 7, {}, { digests: {} }, { digests: [entry], extra: 1 }, { digests: [null] }, { digests: [{ ...entry, digest: 'A'.repeat(64) }] },
      { digests: [{ ...entry, digest: 'a'.repeat(63) }] }, { digests: [{ ...entry, approvedAt: 1 }] }, { digests: [{ ...entry, branch: 3 }] },
      { digests: [{ digest: DIGEST, approvedAt: 'x' }] }, { digests: [{ ...entry, more: true }] },
    ]) {
      writeState(repo.root, 'approvals.json', value);
      assert.throws(() => readApprovals(repo.root), (error) => error instanceof StateError && error.message === shapeMessage('approvals.json'), JSON.stringify(value));
    }
    writeFileSync(join(stateDir(repo.root), 'approvals.json'), '{"digests": [');
    assert.throws(() => readApprovals(repo.root), { name: 'StateError', message: corruptMessage('approvals.json') });
  });
});

test('readExemptions: absent is no branch exempt; the records are given back as written', () => {
  withRepo((repo) => {
    assert.deepEqual(readExemptions(repo.root), []);
    const branches = [{ name: 'old/feature', reason: 'predates the install', at: '2026-11-26T00:00:00.000Z' }];
    writeState(repo.root, 'exemptions.json', { branches });
    assert.deepEqual(readExemptions(repo.root), branches);
  });
});

test('readExemptions throws a StateError with fixed text for any other shape, never "no branch exempt"', () => {
  withRepo((repo) => {
    const entry = { name: 'b', reason: 'r', at: 'x' };
    for (const value of [
      [], null, 'x', {}, { branches: 'b' }, { branches: [entry], extra: 1 }, { branches: [7] }, { branches: [{ ...entry, name: '' }] },
      { branches: [{ ...entry, reason: '' }] }, { branches: [{ ...entry, at: null }] }, { branches: [{ name: 'b', reason: 'r' }] }, { branches: [{ ...entry, more: 1 }] },
    ]) {
      writeState(repo.root, 'exemptions.json', value);
      assert.throws(() => readExemptions(repo.root), (error) => error instanceof StateError && error.message === shapeMessage('exemptions.json'), JSON.stringify(value));
    }
  });
});

const INFLIGHT_TREE = 'c'.repeat(40);

test('an in-flight record: written by temporary file and rename, read back, removed; absent reads as null', () => {
  withRepo((repo) => {
    assert.equal(readInflight(repo.root, '4242'), null);
    writeInflight(repo.root, '4242', INFLIGHT_TREE);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir(repo.root), 'inflight-4242.json'), 'utf8')), { tree: INFLIGHT_TREE });
    assert.deepEqual(readdirSync(stateDir(repo.root)).filter((name) => name.endsWith('.tmp')), []);
    assert.equal(readInflight(repo.root, '4242'), INFLIGHT_TREE);
    removeInflight(repo.root, '4242');
    assert.equal(readInflight(repo.root, '4242'), null);
    removeInflight(repo.root, '4242');
  });
});

test('an in-flight record is named by digits only, holds a full tree id, and any other shape is a StateError', () => {
  withRepo((repo) => {
    for (const pid of ['', '0', '01', '12a', '../x', '1/2', ' 1', '12345678901', 12]) {
      assert.throws(() => writeInflight(repo.root, pid, INFLIGHT_TREE), { name: 'StateError', message: invalidPidMessage }, String(pid));
      assert.throws(() => readInflight(repo.root, pid), { name: 'StateError', message: invalidPidMessage }, String(pid));
    }
    assert.throws(() => writeInflight(repo.root, '7', 'abc'), { name: 'StateError', message: shapeMessage('inflight-7.json') });
    for (const value of [{}, { tree: 'x' }, { tree: INFLIGHT_TREE, more: 1 }, [INFLIGHT_TREE]]) {
      writeState(repo.root, 'inflight-7.json', value);
      assert.throws(() => readInflight(repo.root, '7'), { name: 'StateError', message: shapeMessage('inflight-7.json') });
    }
  });
});

test('removeStaleInflight removes the records of processes that no longer exist and keeps a live one\'s', () => {
  withRepo((repo) => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeInflight(repo.root, dead, INFLIGHT_TREE);
    writeInflight(repo.root, String(process.pid), INFLIGHT_TREE);
    writeFileSync(join(stateDir(repo.root), 'inflight-x.json'), '{}');
    assert.deepEqual(removeStaleInflight(repo.root), [dead]);
    assert.equal(readInflight(repo.root, dead), null);
    assert.equal(readInflight(repo.root, String(process.pid)), INFLIGHT_TREE);
    assert.ok(existsSync(join(stateDir(repo.root), 'inflight-x.json')), 'a name that is not ours is left alone');
  });
});

test('removeStaleInflight on a repository with no state directory removes nothing', () => {
  withRepo((repo) => {
    assert.deepEqual(removeStaleInflight(repo.root), []);
  });
});

test('removeStaleInflight on a state directory that cannot be read says so, not that something could not be written', () => {
  withRepo((repo) => {
    mkdirSync(stateDir(repo.root), { recursive: true });
    chmodSync(stateDir(repo.root), 0o000);
    try {
      assert.throws(() => removeStaleInflight(repo.root), { name: 'StateError', message: stateUnreadableMessage });
    } finally {
      chmodSync(stateDir(repo.root), 0o755);
    }
    assert.equal(stateUnreadableMessage, 'The shared state directory could not be read; nothing proceeds on state that cannot be read.');
  });
});
