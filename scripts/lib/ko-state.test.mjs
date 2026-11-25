import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, symlinkSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateProcessEnv, makeRepo } from './test-repo.mjs';
import {
  StateError, appendJournal, corruptMessage, invalidValueMessage, isOff, readState, stateDir, unknownNameMessage, writeFailedMessage, writeState,
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
