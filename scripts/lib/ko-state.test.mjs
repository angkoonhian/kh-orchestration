import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { installedScript, isolateProcessEnv, makeRepo, testEnv } from './test-repo.mjs';
import {
  StateError, appendJournal, corruptMessage, invalidValueMessage, invalidVerdictKeyMessage, isOff, readApprovals, readExemptions, readInflight, readState, removeInflight, removeStaleInflight, shapeMessage, stateDir,
  invalidPidMessage, stateUnreadableMessage, unknownNameMessage, writeInflight, verdictName, writeFailedMessage, writeState,
  binIncompleteMessage, binEntryMessage, listInflight, readProposals, readWaivers, refreshBin, switchOff, switchOn,
  invalidCommitMessage, ownerCommand, readAccepted, writeAccepted, binPreflightMessage, approvalStanding,
} from '../../assets/scripts/ko-state.mjs';
import { objectMismatchMessage } from '../../assets/scripts/ko-digest.mjs';

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
    const digests = [
      { digest: DIGEST, approvedAt: '2026-11-26T00:00:00.000Z', branch: 'main' }, { digest: 'b'.repeat(64), approvedAt: 'x', branch: null },
      { digest: 'c'.repeat(64), tree: 'd'.repeat(40), approvedAt: 'x', branch: 'main' }, { digest: 'e'.repeat(64), tree: 'f'.repeat(64), approvedAt: 'x', branch: null },
    ];
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
      { digests: [{ ...entry, tree: null }] }, { digests: [{ ...entry, tree: 'a'.repeat(39) }] }, { digests: [{ ...entry, tree: 'A'.repeat(40) }] },
      { digests: [{ ...entry, tree: 'a'.repeat(40), more: 1 }] },
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
const INFLIGHT = { tree: INFLIGHT_TREE, base: 'none' };

test('an in-flight record: written by temporary file and rename, read back, removed; absent reads as null', () => {
  withRepo((repo) => {
    assert.equal(readInflight(repo.root, '4242'), null);
    writeInflight(repo.root, '4242', INFLIGHT);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir(repo.root), 'inflight-4242.json'), 'utf8')), INFLIGHT);
    assert.deepEqual(readdirSync(stateDir(repo.root)).filter((name) => name.endsWith('.tmp')), []);
    assert.deepEqual(readInflight(repo.root, '4242'), INFLIGHT);
    removeInflight(repo.root, '4242');
    assert.equal(readInflight(repo.root, '4242'), null);
    removeInflight(repo.root, '4242');
  });
});

test('an in-flight record is named by digits only, holds a full tree id, and any other shape is a StateError', () => {
  withRepo((repo) => {
    for (const pid of ['', '0', '01', '12a', '../x', '1/2', ' 1', '12345678901', 12]) {
      assert.throws(() => writeInflight(repo.root, pid, INFLIGHT), { name: 'StateError', message: invalidPidMessage }, String(pid));
      assert.throws(() => readInflight(repo.root, pid), { name: 'StateError', message: invalidPidMessage }, String(pid));
    }
    for (const value of [{ tree: 'abc', base: 'none' }, { tree: INFLIGHT_TREE, base: 'x' }, { tree: INFLIGHT_TREE }]) {
      assert.throws(() => writeInflight(repo.root, '7', value), { name: 'StateError', message: shapeMessage('inflight-7.json') }, JSON.stringify(value));
    }
    writeInflight(repo.root, '7', { tree: INFLIGHT_TREE, base: 'd'.repeat(40) });
    assert.deepEqual(readInflight(repo.root, '7'), { tree: INFLIGHT_TREE, base: 'd'.repeat(40) });
    for (const value of [{}, { tree: 'x' }, { tree: INFLIGHT_TREE }, { tree: INFLIGHT_TREE, base: 'none', more: 1 }, { tree: INFLIGHT_TREE, base: 7 }, [INFLIGHT_TREE]]) {
      writeState(repo.root, 'inflight-7.json', value);
      assert.throws(() => readInflight(repo.root, '7'), { name: 'StateError', message: shapeMessage('inflight-7.json') });
    }
  });
});

test('removeStaleInflight removes the records of processes that no longer exist and keeps a live one\'s', () => {
  withRepo((repo) => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeInflight(repo.root, dead, INFLIGHT);
    writeInflight(repo.root, String(process.pid), INFLIGHT);
    writeFileSync(join(stateDir(repo.root), 'inflight-x.json'), '{}');
    assert.deepEqual(removeStaleInflight(repo.root), [dead]);
    assert.equal(readInflight(repo.root, dead), null);
    assert.deepEqual(readInflight(repo.root, String(process.pid)), INFLIGHT);
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

test('readWaivers: absent is no waiver; the records are given back as written', () => {
  withRepo((repo) => {
    assert.deepEqual(readWaivers(repo.root), []);
    const waivers = [{ rule: 'V8', branch: 'feature/x', reason: 'docs follow in the next branch', at: '2026-11-26T00:00:00.000Z' }];
    writeState(repo.root, 'waivers.json', { waivers });
    assert.deepEqual(readWaivers(repo.root), waivers);
  });
});

test('readWaivers throws a StateError with fixed text for any other shape, never "no waiver"', () => {
  withRepo((repo) => {
    const entry = { rule: 'V8', branch: 'b', reason: 'r', at: 'x' };
    for (const value of [
      [], null, {}, { waivers: {} }, { waivers: [entry], extra: 1 }, { waivers: [7] }, { waivers: [{ ...entry, rule: '' }] }, { waivers: [{ ...entry, rule: '8V' }] },
      { waivers: [{ ...entry, rule: 'a b' }] }, { waivers: [{ ...entry, branch: null }] }, { waivers: [{ ...entry, reason: '' }] }, { waivers: [{ ...entry, at: 1 }] },
      { waivers: [{ rule: 'V8', branch: 'b', reason: 'r' }] }, { waivers: [{ ...entry, more: 1 }] },
    ]) {
      writeState(repo.root, 'waivers.json', value);
      assert.throws(() => readWaivers(repo.root), (error) => error instanceof StateError && error.message === shapeMessage('waivers.json'), JSON.stringify(value));
    }
  });
});

test('readProposals: absent is no worktree open; absolute paths are given back; any other shape is a StateError', () => {
  withRepo((repo) => {
    assert.deepEqual(readProposals(repo.root), []);
    writeState(repo.root, 'proposals.json', { worktrees: ['/a/b', '/c'] });
    assert.deepEqual(readProposals(repo.root), ['/a/b', '/c']);
    for (const value of [[], { worktrees: 'x' }, { worktrees: ['relative/path'] }, { worktrees: [''] }, { worktrees: [1] }, { worktrees: [], more: 1 }]) {
      writeState(repo.root, 'proposals.json', value);
      assert.throws(() => readProposals(repo.root), { name: 'StateError', message: shapeMessage('proposals.json') }, JSON.stringify(value));
    }
  });
});

test('switchOff creates the off file by temporary file and rename, switchOn removes it; each is idempotent', () => {
  withRepo((repo) => {
    switchOn(repo.root);
    assert.equal(isOff(repo.root), false);
    switchOff(repo.root);
    switchOff(repo.root);
    assert.equal(isOff(repo.root), true);
    assert.deepEqual(readdirSync(stateDir(repo.root)), ['off']);
    switchOn(repo.root);
    switchOn(repo.root);
    assert.equal(isOff(repo.root), false);
    assert.deepEqual(readdirSync(stateDir(repo.root)), []);
  });
});

test('listInflight names every in-flight record with whether its process is alive, touching nothing', () => {
  withRepo((repo) => {
    assert.deepEqual(listInflight(repo.root), []);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    writeInflight(repo.root, dead, INFLIGHT);
    writeInflight(repo.root, String(process.pid), INFLIGHT);
    writeFileSync(join(stateDir(repo.root), 'inflight-x.json'), '{}');
    const expected = [{ pid: dead, live: false }, { pid: String(process.pid), live: true }].sort((a, b) => (`inflight-${a.pid}.json` < `inflight-${b.pid}.json` ? -1 : 1));
    assert.deepEqual(listInflight(repo.root), expected);
    assert.deepEqual(readInflight(repo.root, dead), INFLIGHT);
  });
});

const SCRIPTS = '.claude/kh-orchestration/scripts';
const binOf = (root) => join(stateDir(root), 'bin');
const binFiles = (root) => Object.fromEntries(readdirSync(binOf(root)).sort().map((name) => [name, readFileSync(join(binOf(root), name), 'utf8')]));
const treeOfIndex = (repo) => {
  assert.equal(repo.git('add', '-A').status, 0);
  return repo.git('write-tree').stdout.trim();
};

// The real installed scripts, each ending in a line naming `version`, so two trees differ in every
// file; refreshBin's pre-flight loads them, so they must be real.
const ASSET_NAMES = readdirSync(new URL('../../assets/scripts/', import.meta.url)).filter((name) => name.endsWith('.mjs')).sort();
const versionLine = (version, pad = '') => `// ${version}${pad}\n`;
function writeScripts(repo, version, pad) {
  for (const name of ASSET_NAMES) repo.write(`${SCRIPTS}/${name}`, `${installedScript(name)}${versionLine(version, pad)}`);
}
const versionOf = (text) => text.slice(text.lastIndexOf('\n', text.length - 2) + 1).match(/^\/\/ (\w+)/)?.[1];

test('refreshBin replaces bin/ with the tree\'s scripts, the .mjs files directly under the scripts folder only', () => {
  withRepo((repo) => {
    writeScripts(repo, 'one');
    repo.write(`${SCRIPTS}/notes.txt`, 'not a script\n');
    repo.write(`${SCRIPTS}/deeper/x.mjs`, 'not directly under\n');
    repo.write('elsewhere.mjs', 'not installed\n');
    const first = treeOfIndex(repo);
    mkdirSync(binOf(repo.root), { recursive: true });
    writeFileSync(join(binOf(repo.root), 'stale.mjs'), 'from an older kit\n');
    refreshBin(repo.root, first);
    assert.deepEqual(Object.keys(binFiles(repo.root)), ASSET_NAMES);
    assert.ok(Object.values(binFiles(repo.root)).every((text) => versionOf(text) === 'one'));
    writeScripts(repo, 'two');
    refreshBin(repo.root, treeOfIndex(repo));
    assert.ok(Object.values(binFiles(repo.root)).every((text) => versionOf(text) === 'two'));
    assert.deepEqual(readdirSync(stateDir(repo.root)), ['bin'], 'no temporary or old directory is left');
  });
});

test('refreshBin refuses a tree without gate.mjs, an entry that is not a regular file, and a blob that does not hash to its id, and leaves bin/ as it was', () => {
  withRepo((repo) => {
    writeScripts(repo, 'one');
    refreshBin(repo.root, treeOfIndex(repo));
    const before = binFiles(repo.root);

    repo.git('rm', '-q', '--cached', `${SCRIPTS}/gate.mjs`);
    const noGate = repo.git('write-tree').stdout.trim();
    assert.throws(() => refreshBin(repo.root, noGate), { name: 'StateError', message: binIncompleteMessage });
    assert.equal(binIncompleteMessage, 'The tree holds no .claude/kh-orchestration/scripts/gate.mjs or ko.mjs, so bin/ is not refreshed from it: the hooks or the owner\'s commands would find nothing to run. Stage the install\'s scripts first.');

    symlinkSync('gate.mjs', join(repo.root, SCRIPTS, 'ko-link.mjs'));
    const withLink = treeOfIndex(repo);
    assert.throws(() => refreshBin(repo.root, withLink), { name: 'StateError', message: binEntryMessage(`${SCRIPTS}/ko-link.mjs`) });
    assert.equal(binEntryMessage('p'), 'p is not a regular file in the tree, so bin/ is not refreshed from it.');
    assert.equal(repo.git('rm', '-q', '-f', `${SCRIPTS}/ko-link.mjs`).status, 0);

    // A loose object whose content no longer hashes to its name: git does not check on read.
    writeScripts(repo, 'forged');
    const forgedTree = treeOfIndex(repo);
    const objectPath = (oid) => join(repo.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
    const oid = repo.git('rev-parse', `${forgedTree}:${SCRIPTS}/gate.mjs`).stdout.trim();
    const other = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo.root, input: 'other bytes\n', encoding: 'utf8' }).stdout.trim();
    chmodSync(objectPath(oid), 0o644);
    writeFileSync(objectPath(oid), readFileSync(objectPath(other)));
    assert.throws(() => refreshBin(repo.root, forgedTree), { name: 'StateError', message: objectMismatchMessage(`${SCRIPTS}/gate.mjs`) });
    assert.deepEqual(binFiles(repo.root), before);
  });
});

test('refreshBin loads the new copy before it replaces bin/: a script that does not parse, or a sibling that is missing, refuses with bin/ as it was', () => {
  withRepo((repo) => {
    writeScripts(repo, 'one');
    refreshBin(repo.root, treeOfIndex(repo));
    const before = binFiles(repo.root);
    const original = (name) => `${installedScript(name)}${versionLine('one')}`;
    const cases = [
      ['ko-cli.mjs', () => repo.write(`${SCRIPTS}/ko-cli.mjs`, original('ko-cli.mjs').replace('export async function main(argv) {', 'export async function main(argv) { syntax error here'))],
      ['ko-gate.mjs', () => rmSync(join(repo.root, SCRIPTS, 'ko-gate.mjs'))],
      ['gate.mjs', () => repo.write(`${SCRIPTS}/gate.mjs`, `${original('gate.mjs')}}}\n`)],
      ['ko.mjs', () => repo.write(`${SCRIPTS}/ko.mjs`, `${original('ko.mjs')}process.exitCode = 3;\n`)],
    ];
    for (const [script, breakIt] of cases) {
      breakIt();
      assert.throws(() => refreshBin(repo.root, treeOfIndex(repo)), { name: 'StateError', message: binPreflightMessage(script) }, script);
      assert.deepEqual(binFiles(repo.root), before, script);
      assert.deepEqual(readdirSync(stateDir(repo.root)), ['bin'], `${script}: the new copy is removed`);
      writeScripts(repo, 'one');
    }
    assert.equal(
      binPreflightMessage('ko-cli.mjs'),
      'The staged tree\'s .claude/kh-orchestration/scripts/ko-cli.mjs does not load (a syntax error, a missing file, or a script it imports that is missing or damaged), so bin/ is not refreshed from it and nothing is approved: the hooks and the owner\'s commands would stop working. Fix it in the working copy, stage it, and approve again.',
    );
  });
});

test('refreshBin killed at any moment leaves bin/ whole: one tree\'s scripts or the other\'s, or no bin/ at all, never a mix', async () => {
  const repo = makeRepo();
  try {
    const trees = ['one', 'two'].map((version) => {
      writeScripts(repo, version, ` ${'x'.repeat(200_000)}`);
      return treeOfIndex(repo);
    });
    const module = new URL('../../assets/scripts/ko-state.mjs', import.meta.url).href;
    // The kill is timed from the first COMPLETED refresh, so under any load at least one bin/ exists
    // and every kill falls inside a later refresh.
    const loop = `const { refreshBin } = await import(${JSON.stringify(module)}); const trees = ${JSON.stringify(trees)};
      refreshBin(${JSON.stringify(repo.root)}, trees[1]); process.stdout.write('refreshed\\n'); for (let i = 0; ; i += 1) refreshBin(${JSON.stringify(repo.root)}, trees[i % 2]);`;
    const versions = new Set();
    for (let round = 0; round < 15; round += 1) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', loop], { env: testEnv(), stdio: ['ignore', 'pipe', 'inherit'] });
      await new Promise((resolve) => child.stdout.once('data', resolve));
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 400)));
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
      if (!existsSync(binOf(repo.root))) continue;
      const files = binFiles(repo.root);
      const version = versionOf(files['gate.mjs']);
      versions.add(version);
      assert.deepEqual(Object.keys(files), ASSET_NAMES);
      assert.ok(Object.values(files).every((text) => versionOf(text) === version), 'every file is of the same tree');
    }
    assert.ok(versions.size > 0);
    refreshBin(repo.root, trees[0]);
    assert.deepEqual(readdirSync(stateDir(repo.root)), ['bin'], 'what a kill left beside bin/ is removed at the next refresh');
  } finally {
    repo.cleanup();
  }
});

test('an accepted record names a commit the gate let through by its full id and holds { tree, base }; absent reads as null; any other shape is a StateError', () => {
  withRepo((repo) => {
    const commit = 'e'.repeat(40);
    assert.equal(readAccepted(repo.root, commit), null);
    writeAccepted(repo.root, commit, INFLIGHT);
    assert.deepEqual(JSON.parse(readFileSync(join(stateDir(repo.root), 'accepted', `${commit}.json`), 'utf8')), INFLIGHT);
    assert.deepEqual(readAccepted(repo.root, commit), INFLIGHT);
    assert.deepEqual(readdirSync(join(stateDir(repo.root), 'accepted')), [`${commit}.json`], 'written by temporary file and rename');
    for (const id of ['', 'e'.repeat(39), 'E'.repeat(40), '../x', 7]) {
      assert.throws(() => writeAccepted(repo.root, id, INFLIGHT), { name: 'StateError', message: invalidCommitMessage }, String(id));
      assert.throws(() => readAccepted(repo.root, id), { name: 'StateError', message: invalidCommitMessage }, String(id));
    }
    assert.throws(() => writeAccepted(repo.root, commit, { tree: 'x', base: 'none' }), { name: 'StateError', message: shapeMessage(`accepted/${commit}.json`) });
    for (const value of [{}, { tree: INFLIGHT_TREE }, { ...INFLIGHT, more: 1 }]) {
      writeState(repo.root, `accepted/${commit}.json`, value);
      assert.throws(() => readAccepted(repo.root, commit), { name: 'StateError', message: shapeMessage(`accepted/${commit}.json`) }, JSON.stringify(value));
    }
  });
});

test('ownerCommand names the approved copy of ko.mjs in the shared state, quoted for a shell when it must be', () => {
  withRepo((repo) => {
    assert.equal(ownerCommand(repo.root, 'approve'), `node ${join(stateDir(repo.root), 'bin', 'ko.mjs')} approve`);
    const second = repo.addWorktree('side');
    assert.equal(ownerCommand(second, 'propose'), `node ${join(stateDir(repo.root), 'bin', 'ko.mjs')} propose`, 'the same copy from a linked worktree');
  });
});

test('a write whose directory is a file throws the fixed StateError, not the error of removing its temporary file', () => {
  withRepo((repo) => {
    mkdirSync(stateDir(repo.root), { recursive: true });
    writeFileSync(join(stateDir(repo.root), 'accepted'), 'a file where the directory goes\n');
    const name = `accepted/${'e'.repeat(40)}.json`;
    assert.throws(() => writeAccepted(repo.root, 'e'.repeat(40), INFLIGHT), { name: 'StateError', message: writeFailedMessage(name) });
  });
});

// approvalStanding's truth table (approvals are ordered; extended at the adjudication). D is the
// tree's digest; the points are the digests of what it builds on, B its base's tree and H the tree
// of the commit it builds on (HEAD, or for verify-branch HEAD's first parent), each null when it
// is none or cannot be computed; the list is approvals.json in append order. Against EVERY point
// that is approved, D must be equal to it or approved later.
test('approvalStanding: a digest is accepted when approved and, against each approved point it builds on, equal to it or approved later', () => {
  const [D, B, H, X] = ['d', 'b', 'h', 'x'].map((letter) => letter.repeat(64));
  const at = (digest) => ({ digest, approvedAt: 'x', branch: 'main' });
  const rows = [
    // [approvals, points, standing, newer, why]
    [[], [B], 'unapproved', null, 'D never approved'],
    [[at(B)], [B], 'unapproved', null, 'only the base approved'],
    [[], [null], 'unapproved', null, 'never approved, base none or not computable'],
    [[at(D)], [D], 'approved', null, 'equal to the base digest'],
    [[at(D), at(B)], [D], 'approved', null, 'equal to the base digest, whatever the order'],
    [[at(B), at(D)], [B], 'approved', null, 'approved after the base digest'],
    [[at(D), at(B)], [B], 'older', B, 'approved before the base digest'],
    [[at(D), at(B), at(D)], [B], 'approved', null, 'approved again after the base digest: the latest approval counts'],
    [[at(B), at(D), at(B)], [B], 'older', B, 'the base digest approved again after it'],
    [[at(D), at(X)], [B], 'approved', null, 'the base digest never approved: no order'],
    [[at(D), at(B)], [null], 'approved', null, 'base none, or its digest not computable: no order'],
    [[at(D), at(H)], [D, H], 'older', H, 'equal to the base, but HEAD\'s digest was approved after it: going back on the branch'],
    [[at(D), at(H)], [null, H], 'older', H, 'no base digest, HEAD\'s approved after it'],
    [[at(H), at(D)], [D, H], 'approved', null, 'equal to the base and approved after HEAD\'s'],
    [[at(D), at(B), at(H)], [B, H], 'older', B, 'before both: the first point named'],
    [[at(B), at(D), at(H)], [B, H], 'older', H, 'after the base, before HEAD\'s'],
    [[at(B), at(H), at(D)], [B, H], 'approved', null, 'after both'],
    [[at(D), at(X)], [D, H], 'approved', null, 'HEAD\'s digest never approved: no order from it'],
    [[at(D)], [D, D], 'approved', null, 'base and HEAD both equal to it'],
    [[at(D), at(B)], [null, null], 'approved', null, 'no point computable (an orphan, a tree from before the install)'],
  ];
  for (const [approvals, points, standing, newer, why] of rows) {
    assert.deepEqual(approvalStanding(approvals, D, () => points), { standing, newer }, why);
  }
  let asked = false;
  assert.deepEqual(approvalStanding([at(B)], D, () => { asked = true; return [B]; }), { standing: 'unapproved', newer: null });
  assert.equal(asked, false, 'the points are computed only for an approved digest');
});

test('readApprovals keeps a digest approved more than once, every record in the order written', () => {
  withRepo((repo) => {
    const digests = [
      { digest: DIGEST, approvedAt: '1', branch: 'main' }, { digest: 'b'.repeat(64), approvedAt: '2', branch: 'main' }, { digest: DIGEST, approvedAt: '3', branch: 'main' },
    ];
    writeState(repo.root, 'approvals.json', { digests });
    assert.deepEqual(readApprovals(repo.root), digests);
  });
});
