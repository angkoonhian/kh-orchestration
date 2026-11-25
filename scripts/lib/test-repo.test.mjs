import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeRepo, installKhHarness, siblingAbsentMessage, KH_HARNESS_DIR, KIT_VERSION } from './test-repo.mjs';

test('a made repository has one commit on main', () => {
  const repo = makeRepo({ files: { 'a.txt': 'one\n' } });
  try {
    assert.equal(repo.git('rev-list', '--count', 'HEAD').stdout.trim(), '1');
    assert.equal(repo.git('branch', '--show-current').stdout.trim(), 'main');
    assert.equal(readFileSync(join(repo.root, 'a.txt'), 'utf8'), 'one\n');
  } finally {
    repo.cleanup();
  }
});

test('commitAll commits what write wrote', () => {
  const repo = makeRepo({ baseBranch: 'trunk' });
  try {
    repo.write('dir/b.txt', 'two\n');
    repo.commitAll('add b');
    assert.equal(repo.git('branch', '--show-current').stdout.trim(), 'trunk');
    assert.equal(repo.git('log', '-1', '--format=%s').stdout.trim(), 'add b');
    assert.equal(repo.git('status', '--porcelain').stdout, '');
  } finally {
    repo.cleanup();
  }
});

test('addWorktree returns a second root sharing the git directory', () => {
  const repo = makeRepo();
  try {
    const second = repo.addWorktree('side');
    assert.notEqual(second, repo.root);
    const common = (root) => {
      const out = repo.git('-C', root, 'rev-parse', '--git-common-dir').stdout.trim();
      return realpathSync(resolve(root, out));
    };
    assert.equal(common(second), common(repo.root));
  } finally {
    repo.cleanup();
  }
});

test('cleanup removes the repository and its worktrees', () => {
  const repo = makeRepo();
  const second = repo.addWorktree('side');
  repo.cleanup();
  assert.equal(existsSync(repo.root), false);
  assert.equal(existsSync(second), false);
});

test('installKhHarness leaves the contract file and a PreToolUse registration', () => {
  const repo = makeRepo();
  try {
    installKhHarness(repo.root);
    assert.ok(existsSync(join(repo.root, '.claude/kh-harness/contract.json')));
    const settings = JSON.parse(readFileSync(join(repo.root, '.claude/settings.json'), 'utf8'));
    assert.ok(Array.isArray(settings.hooks.PreToolUse) && settings.hooks.PreToolUse.length > 0);
  } finally {
    repo.cleanup();
  }
});

test('installKhHarness says where it looked when the sibling is absent', () => {
  const repo = makeRepo();
  const saved = process.env.KH_HARNESS_DIR;
  try {
    process.env.KH_HARNESS_DIR = join(repo.root, 'no-such-sibling');
    assert.throws(
      () => installKhHarness(repo.root),
      {
        message: siblingAbsentMessage(join(repo.root, 'no-such-sibling')),
      },
    );
  } finally {
    if (saved === undefined) delete process.env.KH_HARNESS_DIR;
    else process.env.KH_HARNESS_DIR = saved;
    repo.cleanup();
  }
});

test('KH_HARNESS_DIR names the sibling checkout and KIT_VERSION is this package version', () => {
  assert.ok(KH_HARNESS_DIR.endsWith('kh-harness'));
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(KIT_VERSION, pkg.version);
});
