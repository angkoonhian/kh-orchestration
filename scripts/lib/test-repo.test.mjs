import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { makeRepo, installKhHarness, siblingAbsentMessage, spawnFailedMessage, testEnv, isolateProcessEnv, KH_HARNESS_DIR, KIT_VERSION } from './test-repo.mjs';

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

test('testEnv drops identity, config injection, editor and session variables and forbids prompts', () => {
  const planted = {
    GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x', GIT_AUTHOR_DATE: 'x',
    GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x', GIT_COMMITTER_DATE: 'x',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/x',
    GIT_CONFIG_PARAMETERS: "'core.hooksPath=/x'", GIT_EDITOR: 'vim',
    CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', GIT_TERMINAL_PROMPT: '1',
  };
  const saved = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, planted);
  try {
    const env = testEnv();
    for (const name of Object.keys(planted)) {
      if (name !== 'GIT_TERMINAL_PROMPT') assert.equal(env[name], undefined, name);
    }
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.notEqual(testEnv(), env);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a made repository ignores a hooks path injected through the environment', () => {
  const saved = { count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0 };
  Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/x' });
  let repo;
  try {
    repo = makeRepo();
    assert.equal(repo.git('config', '--get', 'core.hooksPath').status, 1);
  } finally {
    for (const [name, value] of [['GIT_CONFIG_COUNT', saved.count], ['GIT_CONFIG_KEY_0', saved.key], ['GIT_CONFIG_VALUE_0', saved.value]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    repo?.cleanup();
  }
});

// Runs body with TMPDIR pointing at an empty directory of its own and
// returns what the body left in it, so parallel test files cannot interfere.
function leftInPrivateTmp(body) {
  const savedTmp = process.env.TMPDIR;
  const priv = mkdtempSync(join(tmpdir(), 'ko-priv-'));
  process.env.TMPDIR = priv;
  try {
    body();
    return readdirSync(priv);
  } finally {
    if (savedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = savedTmp;
    rmSync(priv, { recursive: true, force: true });
  }
}

test('a command that cannot be started throws the fixed message and leaves nothing behind', () => {
  const savedPath = process.env.PATH;
  const left = leftInPrivateTmp(() => {
    process.env.PATH = '';
    try {
      assert.throws(() => makeRepo(), { message: spawnFailedMessage('git') });
    } finally {
      process.env.PATH = savedPath;
    }
  });
  assert.deepEqual(left, []);
});

test('a failed git init throws its message and leaves nothing behind', () => {
  const left = leftInPrivateTmp(() => {
    assert.throws(() => makeRepo({ baseBranch: 'bad..name' }), { message: /^git init failed: / });
  });
  assert.deepEqual(left, []);
});

test('isolateProcessEnv removes git location, identity and session variables from this process', () => {
  const planted = { GIT_DIR: '/x', GIT_WORK_TREE: '/x', GIT_INDEX_FILE: '/x', GIT_PREFIX: 'x/', GIT_AUTHOR_NAME: 'x', CLAUDECODE: '1' };
  const saved = Object.fromEntries(Object.keys(planted).map((name) => [name, process.env[name]]));
  Object.assign(process.env, planted);
  try {
    isolateProcessEnv();
    for (const name of Object.keys(planted)) assert.equal(process.env[name], undefined, name);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('testEnv drops GIT_PREFIX', () => {
  const saved = process.env.GIT_PREFIX;
  process.env.GIT_PREFIX = 'x/';
  try {
    assert.equal(testEnv().GIT_PREFIX, undefined);
  } finally {
    if (saved === undefined) delete process.env.GIT_PREFIX;
    else process.env.GIT_PREFIX = saved;
  }
});
