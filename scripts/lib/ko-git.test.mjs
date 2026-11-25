import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRepo } from './test-repo.mjs';
import {
  SPAWN_FAILED, baseOf, changedPaths, commonDir, currentBranch, git, gitFailedMessage, headTree, indexTree,
  listTree, readBlob, repoRoot, tidy,
} from '../../assets/scripts/ko-git.mjs';

function withRepo(options, body) {
  const repo = makeRepo(options);
  try {
    return body(repo);
  } finally {
    repo.cleanup();
  }
}

const head = (repo) => repo.git('rev-parse', 'HEAD').stdout.trim();

test('git runs without a shell, feeds input, and never prompts or pages', () => {
  withRepo({}, (repo) => {
    const hashed = git(repo.root, ['hash-object', '--stdin'], { input: 'hello\n' });
    assert.deepEqual(hashed, { status: 0, stdout: 'ce013625030ba8dba906f756967f9e9ca394464a\n', stderr: '' });
    const env = git(repo.root, ['-c', 'alias.show-env=!env', 'show-env']).stdout.split('\n');
    assert.ok(env.includes('GIT_TERMINAL_PROMPT=0'));
    assert.ok(env.includes('GIT_OPTIONAL_LOCKS=0'));
    assert.ok(env.includes('GIT_PAGER=cat'));
    assert.equal(git(repo.root, ['no-such-subcommand']).status !== 0, true);
  });
});

test('git returns a non-zero status and fixed text when the command cannot start', () => {
  const result = git(join(tmpdir(), 'ko-no-such-directory'), ['status']);
  assert.deepEqual(result, { status: 127, stdout: '', stderr: SPAWN_FAILED });
});

test('repoRoot is the worktree top level from a subdirectory, and null outside a repository', () => {
  withRepo({ files: { 'sub/a.txt': 'a\n' } }, (repo) => {
    assert.equal(repoRoot(join(repo.root, 'sub')), repo.root);
    const second = repo.addWorktree('side');
    assert.equal(repoRoot(second), second);
  });
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ko-test-')));
  try {
    assert.equal(repoRoot(outside), null);
    assert.equal(repoRoot(join(outside, 'missing')), null);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('commonDir is absolute and the same from a linked worktree', () => {
  withRepo({}, (repo) => {
    const second = repo.addWorktree('side');
    assert.equal(commonDir(repo.root), join(repo.root, '.git'));
    assert.equal(commonDir(second), commonDir(repo.root));
  });
});

test('commonDir throws the fixed message outside a repository', () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ko-test-')));
  try {
    assert.throws(() => commonDir(outside), { message: gitFailedMessage('locate the git directory') });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('indexTree writes the staged tree, and headTree is the committed one', () => {
  withRepo({ files: { 'a.txt': 'a\n' } }, (repo) => {
    const committed = headTree(repo.root);
    assert.equal(committed, repo.git('rev-parse', 'HEAD^{tree}').stdout.trim());
    assert.equal(indexTree(repo.root), committed);
    repo.write('b.txt', 'b\n');
    repo.git('add', 'b.txt');
    const staged = indexTree(repo.root);
    assert.notEqual(staged, committed);
    assert.equal(repo.git('cat-file', '-t', staged).stdout.trim(), 'tree');
    assert.equal(repo.git('ls-tree', '--name-only', staged).stdout, 'a.txt\nb.txt\n');
  });
});

test('headTree is null and currentBranch is the branch name on an unborn HEAD', () => {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'ko-test-')));
  try {
    assert.equal(git(container, ['init', '-q', '-b', 'trunk']).status, 0);
    assert.equal(headTree(container), null);
    assert.equal(currentBranch(container), 'trunk');
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test('currentBranch is null on a detached HEAD', () => {
  withRepo({}, (repo) => {
    assert.equal(currentBranch(repo.root), 'main');
    repo.git('checkout', '-q', '--detach');
    assert.equal(currentBranch(repo.root), null);
  });
});

test('baseOf is the merge base on a feature branch', () => {
  withRepo({ files: { 'a.txt': 'a\n' } }, (repo) => {
    const fork = head(repo);
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write('f.txt', 'f\n');
    repo.commitAll('feature work');
    repo.git('checkout', '-q', 'main');
    repo.write('m.txt', 'm\n');
    repo.commitAll('main moves on');
    repo.git('checkout', '-q', 'feature');
    assert.equal(baseOf(repo.root, 'main'), fork);
  });
});

test('baseOf is HEAD on the base branch', () => {
  withRepo({}, (repo) => {
    repo.write('m.txt', 'm\n');
    repo.commitAll('more');
    assert.equal(baseOf(repo.root, 'main'), head(repo));
  });
});

test('baseOf is HEAD when the base branch does not exist', () => {
  withRepo({}, (repo) => {
    repo.git('checkout', '-q', '-b', 'feature');
    assert.equal(baseOf(repo.root, 'trunk'), head(repo));
  });
});

test('baseOf is none on an unborn HEAD', () => {
  const container = realpathSync(mkdtempSync(join(tmpdir(), 'ko-test-')));
  try {
    git(container, ['init', '-q', '-b', 'main']);
    assert.equal(baseOf(container, 'main'), 'none');
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test('baseOf is the merge base on a detached HEAD', () => {
  withRepo({}, (repo) => {
    const fork = head(repo);
    repo.git('checkout', '-q', '--detach');
    repo.write('d.txt', 'd\n');
    repo.commitAll('detached work');
    assert.equal(baseOf(repo.root, 'main'), fork);
  });
});

test('baseOf is none when the branch shares no history with the base branch', () => {
  withRepo({}, (repo) => {
    repo.git('checkout', '-q', '--orphan', 'island');
    repo.write('i.txt', 'i\n');
    repo.commitAll('island');
    assert.equal(baseOf(repo.root, 'main'), 'none');
  });
});

test('changedPaths lists both paths of a rename and the paths of an added and a deleted file', () => {
  withRepo({ files: { 'old.txt': 'same content\nmore\n', 'gone.txt': 'g\n', 'keep.txt': 'k\n' } }, (repo) => {
    const base = head(repo);
    repo.git('mv', 'old.txt', 'new.txt');
    repo.git('rm', '-q', 'gone.txt');
    repo.write('added.txt', 'a\n');
    repo.git('add', '-A');
    assert.deepEqual(changedPaths(repo.root, base, indexTree(repo.root)).sort(), ['added.txt', 'gone.txt', 'new.txt', 'old.txt']);
  });
});

test('changedPaths with base none lists every path in the tree', () => {
  withRepo({ files: { 'a.txt': 'a\n', 'd/e.txt': 'e\n' } }, (repo) => {
    assert.deepEqual(changedPaths(repo.root, 'none', headTree(repo.root)), ['a.txt', 'd/e.txt']);
  });
});

test('changedPaths returns names with spaces, quotes and non-ASCII characters exactly', () => {
  const names = ['with space.txt', 'quote"d.txt', 'café/naïve ✓.txt'];
  withRepo({}, (repo) => {
    const base = head(repo);
    for (const name of names) repo.write(name, 'x\n');
    repo.git('add', '-A');
    const tree = indexTree(repo.root);
    assert.deepEqual(changedPaths(repo.root, base, tree).sort(), [...names].sort());
    assert.deepEqual(changedPaths(repo.root, 'none', tree).sort(), [...names].sort());
  });
});

test('changedPaths throws the fixed message for an object that is not a tree', () => {
  withRepo({}, (repo) => {
    assert.throws(() => changedPaths(repo.root, head(repo), 'not-a-tree'), { message: gitFailedMessage('list the changed paths') });
    assert.throws(() => changedPaths(repo.root, 'none', 'not-a-tree'), { message: gitFailedMessage('list the changed paths') });
  });
});

test('tidy is true for a clean working directory', () => {
  withRepo({ files: { 'a.txt': 'a\n' } }, (repo) => {
    assert.deepEqual(tidy(repo.root), { tidy: true, unstaged: [], untracked: [] });
  });
});

test('tidy lists an unstaged edit and an unstaged deletion', () => {
  withRepo({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' } }, (repo) => {
    repo.write('a.txt', 'changed\n');
    rmSync(join(repo.root, 'b.txt'));
    const result = tidy(repo.root);
    assert.equal(result.tidy, false);
    assert.deepEqual(result.unstaged.sort(), ['a.txt', 'b.txt']);
    assert.deepEqual(result.untracked, []);
  });
});

test('tidy lists an untracked file, even with an odd name, and not an ignored file', () => {
  withRepo({ files: { '.gitignore': 'ignored.log\n' } }, (repo) => {
    repo.write('ignored.log', 'x\n');
    repo.write('new file é.txt', 'x\n');
    const result = tidy(repo.root);
    assert.equal(result.tidy, false);
    assert.deepEqual(result.untracked, ['new file é.txt']);
    assert.deepEqual(result.unstaged, []);
  });
});

test('tidy ignores what is staged and committed', () => {
  withRepo({}, (repo) => {
    repo.write('s.txt', 's\n');
    repo.git('add', 's.txt');
    assert.equal(tidy(repo.root).tidy, true);
  });
});

test('readBlob returns the exact bytes of a file in a tree, and null for an absent path or a directory', () => {
  withRepo({}, (repo) => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x41]);
    writeFileSync(join(repo.root, 'bin.dat'), bytes);
    repo.write('d/empty.txt', '');
    repo.commitAll('files');
    const tree = headTree(repo.root);
    assert.deepEqual(readBlob(repo.root, tree, 'bin.dat'), bytes);
    assert.equal(readBlob(repo.root, tree, 'd/empty.txt').length, 0);
    assert.equal(readBlob(repo.root, tree, 'missing.txt'), null);
    assert.equal(readBlob(repo.root, tree, 'd'), null);
  });
});

test('readBlob reads from the tree, not the working directory', () => {
  withRepo({ files: { 'a.txt': 'committed\n' } }, (repo) => {
    const tree = headTree(repo.root);
    repo.write('a.txt', 'edited\n');
    assert.equal(readBlob(repo.root, tree, 'a.txt').toString(), 'committed\n');
  });
});

test('listTree lists the files under a prefix, all files for an empty prefix, and none for an absent one', () => {
  withRepo({ files: { 'a.txt': 'a\n', 'docs/x.md': 'x\n', 'docs/deep/y.md': 'y\n', 'other/z.md': 'z\n' } }, (repo) => {
    const tree = headTree(repo.root);
    assert.deepEqual(listTree(repo.root, tree, 'docs/'), ['docs/deep/y.md', 'docs/x.md']);
    assert.deepEqual(listTree(repo.root, tree, ''), ['a.txt', 'docs/deep/y.md', 'docs/x.md', 'other/z.md']);
    assert.deepEqual(listTree(repo.root, tree, 'nothing/'), []);
    assert.throws(() => listTree(repo.root, 'not-a-tree', ''), { message: gitFailedMessage('list the tree') });
  });
});
