import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isolateProcessEnv, makeRepo, testEnv } from './test-repo.mjs';
import { MINOR_WORDING_PROBLEM, canonicalRegistry, parseRegistry } from '../../assets/scripts/ko-registry.mjs';
import { agentRuleChanges, digestOfTree, globDirectoryMessage, invalidRulesMessage, linkMessage, objectMismatchMessage, notUtf8Message, officersUnreadableMessage, readFailedMessage, treeNotIdMessage } from '../../assets/scripts/ko-digest.mjs';
import { notBlobMessage } from '../../assets/scripts/ko-git.mjs';

isolateProcessEnv();

const RULES = 'docs/harness/RULES.md';
const OFFICERS = '.claude/kh-orchestration/officers.json';
const SETTINGS = '.claude/settings.json';
const MODE = '100644';
const sha = (data) => createHash('sha256').update(data).digest('hex');

const agentRule = (id = 'A1', why = 'a reason') => `## ${id} — an agent rule\n- why: ${why}\n- enforced-by: officer\n- pointer: tools/officers/a1.mjs\n- approval: agent\n`;
const ownerRule = (id = 'R1', why = 'a reason') => `## ${id} — an owner rule\n- why: ${why}\n- enforced-by: test\n- pointer: tests/r1.test.mjs\n`;
const registry = (...rules) => `# Rules\n\nPreamble.\n\n${rules.join('\n')}`;
const officers = (...argvs) => officersWith({}, ...argvs);
const officersWith = (extra, ...argvs) => JSON.stringify({
  schema: 1, baseBranch: 'main', protected: [], ...extra,
  officers: argvs.map((argv, index) => ({ id: `o${index}`, rule: 'A1', argv, appliesTo: ['**'], timeoutSeconds: 60, options: {} })),
});
const baseFiles = () => ({
  [RULES]: registry(ownerRule(), agentRule()),
  [OFFICERS]: officers(['node', 'tools/officers/a1.mjs']),
  [SETTINGS]: '{}\n',
  'tools/officers/a1.mjs': 'export default 1;\n',
  'src/app.js': 'one\n',
});

function withRepo(files, body) {
  const repo = makeRepo({ files: { ...baseFiles(), ...files } });
  try {
    return body(repo);
  } finally {
    repo.cleanup();
  }
}

const treeOf = (repo) => repo.git('rev-parse', 'HEAD^{tree}').stdout.trim();
const digestOf = (repo) => digestOfTree(repo.root, treeOf(repo));
// Changes a file, commits, and returns the digest of the new tree.
const digestAfter = (repo, path, text) => {
  repo.write(path, text);
  repo.commitAll('change');
  return digestOf(repo);
};

test('the digest is the SHA-256 of the canonical text: sorted path NUL mode NUL object-id lines, with RULES.md by the hash of its canonical form', () => {
  withRepo({}, (repo) => {
    const files = baseFiles();
    const rulesHash = sha(canonicalRegistry(parseRegistry(files[RULES])));
    const oid = (path) => repo.git('rev-parse', `HEAD:${path}`).stdout.trim();
    const lines = [
      [OFFICERS, oid(OFFICERS)], [SETTINGS, oid(SETTINGS)], [RULES, rulesHash], ['tools/officers/a1.mjs', oid('tools/officers/a1.mjs')],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const result = digestOf(repo);
    assert.deepEqual(result, { digest: sha(lines.map(([path, hash]) => `${path}\0${MODE}\0${hash}\n`).join('')), paths: lines.map(([path]) => path) });
    assert.deepEqual(result.paths, ['.claude/kh-orchestration/officers.json', '.claude/settings.json', 'docs/harness/RULES.md', 'tools/officers/a1.mjs']);
  });
});

test('the digest is the same from a linked worktree and does not change with a working-directory or index edit', () => {
  withRepo({}, (repo) => {
    const before = digestOf(repo);
    const linked = repo.addWorktree('other');
    assert.deepEqual(digestOfTree(linked, treeOf(repo)), before);
    repo.write(RULES, 'changed in the working directory\n');
    repo.write(OFFICERS, 'not json');
    repo.write('tools/officers/a1.mjs', 'edited\n');
    assert.deepEqual(digestOf(repo), before);
    repo.git('add', '-A');
    assert.deepEqual(digestOf(repo), before);
    rmSync(join(repo.root, SETTINGS));
    assert.deepEqual(digestOf(repo), before);
  });
});

test('the digest changes when any protected file, an officer script named in argv, or a file under a protected prefix changes or appears', () => {
  const changes = [
    [RULES, registry(ownerRule('R1', 'another reason'), agentRule())],
    [OFFICERS, officers(['node', 'tools/officers/a1.mjs'], ['true'])],
    [SETTINGS, '{"a":1}\n'],
    ['tools/officers/a1.mjs', 'export default 2;\n'],
    ['.claude/scripts/new.sh', 'echo\n'],
    ['.claude/kh-harness/scripts/x.mjs', 'x\n'],
    ['.claude/kh-orchestration/scripts/gate.mjs', 'x\n'],
  ];
  for (const [path, text] of changes) {
    withRepo({}, (repo) => {
      const before = digestOf(repo);
      const after = digestAfter(repo, path, text);
      assert.notEqual(after.digest, before.digest, path);
    });
  }
});

test('the digest does not change with a file that is neither protected nor named in argv, nor with an argv element that is not a file in the tree', () => {
  withRepo({}, (repo) => {
    const before = digestOf(repo);
    assert.deepEqual(digestAfter(repo, 'src/app.js', 'two\n'), before);
    assert.deepEqual(digestAfter(repo, 'tools/other.mjs', 'x\n'), before);
  });
  withRepo({ [OFFICERS]: officers(['node', 'tools/officers/a1.mjs', 'missing.mjs', '--flag']) }, (repo) => {
    assert.deepEqual(digestOf(repo).paths, ['.claude/kh-orchestration/officers.json', '.claude/settings.json', 'docs/harness/RULES.md', 'tools/officers/a1.mjs']);
  });
});

test('CRLF and LF script bytes digest differently, since the hash is of the blob\'s bytes', () => {
  withRepo({}, (repo) => {
    const lfDigest = digestAfter(repo, 'tools/officers/a1.mjs', 'a\nb\n');
    assert.notEqual(digestAfter(repo, 'tools/officers/a1.mjs', 'a\r\nb\r\n').digest, lfDigest.digest);
  });
});

const commitLink = (repo, path, target) => {
  rmSync(join(repo.root, path), { recursive: true, force: true });
  mkdirSync(join(repo.root, path, '..'), { recursive: true });
  symlinkSync(target, join(repo.root, path));
};

test('a symlink or submodule at, above or under a protected path is a problem, so a link cannot hide what it points at', () => {
  const cases = {
    'docs is a link': (repo) => { repo.write('rd/harness/RULES.md', registry(ownerRule())); repo.git('rm', '-rq', 'docs'); commitLink(repo, 'docs', 'rd'); return 'docs'; },
    'RULES.md is a link': (repo) => { repo.git('rm', '-q', RULES); commitLink(repo, RULES, '../../elsewhere.md'); return RULES; },
    'settings.json is a link': (repo) => { repo.git('rm', '-q', SETTINGS); commitLink(repo, SETTINGS, 'other.json'); return SETTINGS; },
    '.claude/kh-harness is a link': (repo) => { repo.write('vendor/kh/x.mjs', 'x\n'); commitLink(repo, '.claude/kh-harness', '../vendor/kh'); return '.claude/kh-harness'; },
    '.claude/scripts is a link': (repo) => { repo.write('vendor/kh/x.mjs', 'x\n'); commitLink(repo, '.claude/scripts', '../vendor/kh'); return '.claude/scripts'; },
    'a link under a protected prefix': (repo) => { commitLink(repo, '.claude/scripts/run.sh', '../../src/app.js'); return '.claude/scripts/run.sh'; },
    '.claude is a link': (repo) => { repo.git('rm', '-rq', '.claude'); repo.write('dot/settings.json', '{}\n'); commitLink(repo, '.claude', 'dot'); return '.claude'; },
    'an officer script is a link': (repo) => { repo.git('rm', '-q', 'tools/officers/a1.mjs'); commitLink(repo, 'tools/officers/a1.mjs', '../../src/app.js'); return 'tools/officers/a1.mjs'; },
    'a directory above an officer script is a link': (repo) => {
      repo.write(OFFICERS, officers(['node', 'scripts/check.mjs'])); repo.write('lib/check.mjs', 'x\n'); commitLink(repo, 'scripts', 'lib'); return 'scripts';
    },
    'a directory above a spelled-out officer script is a link': (repo) => {
      repo.write(OFFICERS, officers(['node', './x/../scripts/./check.mjs'])); repo.write('lib/check.mjs', 'x\n'); commitLink(repo, 'scripts', 'lib'); return 'scripts';
    },
    'a file matching a protected glob is a link': (repo) => {
      repo.write(OFFICERS, officersWith({ protected: ['config/**'] }, ['node', 'tools/officers/a1.mjs'])); commitLink(repo, 'config/app.yml', '../src/app.js'); return 'config/app.yml';
    },
  };
  for (const [name, build] of Object.entries(cases)) {
    withRepo({}, (repo) => {
      const path = build(repo);
      repo.commitAll('link');
      assert.deepEqual(digestOf(repo), { problem: linkMessage(path) }, name);
    });
  }
});

test('a gitlink at a protected prefix is a problem', () => {
  withRepo({}, (repo) => {
    const commit = repo.git('rev-parse', 'HEAD').stdout.trim();
    assert.equal(repo.git('update-index', '--add', '--cacheinfo', `160000,${commit},.claude/scripts`).status, 0);
    assert.equal(repo.git('commit', '-q', '-m', 'gitlink').status, 0);
    assert.deepEqual(digestOf(repo), { problem: linkMessage('.claude/scripts') });
  });
});

test('a link that is not at, above or under anything covered is no problem and is not hashed', () => {
  withRepo({}, (repo) => {
    const before = digestOf(repo);
    commitLink(repo, 'other/link', '../src/app.js');
    repo.commitAll('link');
    assert.deepEqual(digestOf(repo), before);
  });
});

test('every officer-argv spelling of a script is covered: normalised, doubled or dotted separators, an option value', () => {
  const spellings = ['./scripts/../scripts/check.mjs', 'scripts/./check.mjs', 'scripts//check.mjs', '././scripts/check.mjs', '--import=./scripts/check.mjs', 'scripts/check.mjs'];
  for (const spelling of spellings) {
    withRepo({ 'scripts/check.mjs': 'one\n', [OFFICERS]: officers(['node', spelling]) }, (repo) => {
      const before = digestOf(repo);
      assert.ok(before.paths.includes('scripts/check.mjs'), spelling);
      assert.notEqual(digestAfter(repo, 'scripts/check.mjs', 'two\n').digest, before.digest, spelling);
    });
  }
  withRepo({ 'scripts/check.mjs': 'one\n', [OFFICERS]: officers(['node', '../scripts/check.mjs', '/scripts/check.mjs', 'scripts\\check.mjs', 'nothing.mjs', '.']) }, (repo) => {
    assert.deepEqual(digestOf(repo).paths, ['.claude/kh-orchestration/officers.json', '.claude/settings.json', 'docs/harness/RULES.md']);
  });
});

test('an argv element naming a directory is neither a problem nor covered; a glob covers it', () => {
  const commands = [['pytest', 'tests'], ['ruff', 'check', 'tests'], ['node', '--test', 'tests/'], ['eslint', '.']];
  for (const argv of commands) {
    withRepo({ 'tests/x.py': 'one\n', [OFFICERS]: officers(argv) }, (repo) => {
      const before = digestOf(repo);
      assert.deepEqual(before.paths, ['.claude/kh-orchestration/officers.json', '.claude/settings.json', 'docs/harness/RULES.md'], argv.join(' '));
      assert.deepEqual(digestAfter(repo, 'tests/x.py', 'two\n'), before, argv.join(' '));
    });
  }
  withRepo({ 'tests/x.py': 'one\n', [OFFICERS]: officersWith({ protected: ['tests/**'] }, ['pytest', 'tests']) }, (repo) => {
    assert.ok(digestOf(repo).paths.includes('tests/x.py'));
  });
});

test('a link at or above the fixed directories of a protected glob is a problem, and never beyond a **', () => {
  const cases = {
    'lib -> real, lib/**': (repo) => { repo.write('real/x.mjs', 'x\n'); commitLink(repo, 'lib', 'real'); return 'lib'; },
    'scripts -> real, scripts/officers/*.mjs': (repo) => { repo.write('real/officers/a.mjs', 'x\n'); commitLink(repo, 'scripts', 'real'); return 'scripts'; },
    'scripts/officers -> ../real': (repo) => { repo.write('real/a.mjs', 'x\n'); commitLink(repo, 'scripts/officers', '../real'); return 'scripts/officers'; },
  };
  const globs = { 'lib -> real, lib/**': ['lib/**'], 'scripts -> real, scripts/officers/*.mjs': ['scripts/officers/*.mjs'], 'scripts/officers -> ../real': ['scripts/officers/*.mjs'] };
  for (const [name, build] of Object.entries(cases)) {
    withRepo({ [OFFICERS]: officersWith({ protected: globs[name] }, ['node', 'tools/officers/a1.mjs']) }, (repo) => {
      const path = build(repo);
      repo.commitAll('link');
      assert.deepEqual(digestOf(repo), { problem: linkMessage(path) }, name);
    });
  }
  withRepo({ [OFFICERS]: officersWith({ protected: ['**/*.py'] }, ['node', 'tools/officers/a1.mjs']), 'setup.py': 'one\n', 'assets/a.png': 'x\n' }, (repo) => {
    commitLink(repo, 'docs/img', '../assets');
    repo.commitAll('link');
    const before = digestOf(repo);
    assert.ok(before.paths.includes('setup.py'));
    assert.notEqual(digestAfter(repo, 'setup.py', 'two\n').digest, before.digest);
  });
});

test('a protected glob with no wildcard that names a directory in the tree is a problem saying to write dir/**', () => {
  withRepo({ 'lib/x.mjs': 'x\n', [OFFICERS]: officersWith({ protected: ['lib'] }, ['node', 'tools/officers/a1.mjs']) }, (repo) => {
    assert.deepEqual(digestOf(repo), { problem: globDirectoryMessage('lib') });
    assert.match(globDirectoryMessage('lib'), /lib\/\*\*/);
  });
  withRepo({ 'package.json': '{}\n', [OFFICERS]: officersWith({ protected: ['package.json', 'absent'] }, ['node', 'tools/officers/a1.mjs']) }, (repo) => {
    assert.ok(digestOf(repo).paths.includes('package.json'));
  });
});

test('the file mode is covered: removing the executable bit of a covered script changes the digest', () => {
  withRepo({}, (repo) => {
    chmodSync(join(repo.root, 'tools/officers/a1.mjs'), 0o755);
    repo.commitAll('executable');
    const before = digestOf(repo);
    chmodSync(join(repo.root, 'tools/officers/a1.mjs'), 0o644);
    repo.commitAll('not executable');
    assert.notEqual(digestOf(repo).digest, before.digest);
  });
});

test('bytes that do not hash to their object id are a problem: a forged loose object for officers.json or RULES.md', () => {
  for (const path of [RULES, OFFICERS]) {
    withRepo({}, (repo) => {
      const approvedText = baseFiles()[path];
      const forgedText = path === RULES ? registry(ownerRule('R1', 'forged'), agentRule()) : officers(['node', 'tools/officers/a1.mjs'], ['true']);
      repo.write(path, forgedText);
      repo.commitAll('forged');
      const oid = repo.git('rev-parse', `HEAD:${path}`).stdout.trim();
      const object = join(repo.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
      rmSync(object);
      const body = Buffer.from(approvedText);
      writeFileSync(object, deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])));
      assert.deepEqual(digestOf(repo), { problem: objectMismatchMessage(path) }, path);
    });
  }
});

test('every file matching a protected glob is covered; one that does not match is not', () => {
  withRepo({ 'config/a.yml': 'a\n', 'config/deep/b.yml': 'b\n', 'src/c.yml': 'c\n', [OFFICERS]: officersWith({ protected: ['config/**', 'package.json'] }, ['node', 'tools/officers/a1.mjs']), 'package.json': '{}\n' }, (repo) => {
    const before = digestOf(repo);
    assert.deepEqual(before.paths.filter((path) => !path.startsWith('.claude') && !path.startsWith('docs')), ['config/a.yml', 'config/deep/b.yml', 'package.json', 'tools/officers/a1.mjs']);
    assert.notEqual(digestAfter(repo, 'config/deep/b.yml', 'b2\n').digest, before.digest);
    assert.notEqual(digestAfter(repo, 'package.json', '{"a":1}\n').digest, before.digest);
    const next = digestOf(repo);
    assert.deepEqual(digestAfter(repo, 'src/c.yml', 'c2\n'), next);
  });
});

test('a tree that is not a full object id is a problem, whatever git would make of it', () => {
  withRepo({}, (repo) => {
    for (const tree of ['HEAD', 'main', '--help', 'HEAD^{tree}', 'abc', 'A'.repeat(40), `${treeOf(repo)}x`, '', '-r']) {
      assert.deepEqual(digestOfTree(repo.root, tree), { problem: treeNotIdMessage }, tree);
    }
  });
});

test('a byte-order mark in RULES.md is kept: the digest differs with and without it', () => {
  withRepo({}, (repo) => {
    const plain = digestOf(repo);
    const withBom = digestAfter(repo, RULES, `﻿${registry(ownerRule(), agentRule())}`);
    assert.notEqual(withBom.digest, plain.digest);
  });
});

test('a replace ref cannot make a changed tree digest as the approved one', () => {
  withRepo({}, (repo) => {
    const approved = digestOf(repo);
    const oldBlob = repo.git('rev-parse', `HEAD:${SETTINGS}`).stdout.trim();
    repo.write(SETTINGS, '{"changed":true}\n');
    repo.commitAll('change settings');
    const newBlob = repo.git('rev-parse', `HEAD:${SETTINGS}`).stdout.trim();
    assert.equal(repo.git('replace', '-f', newBlob, oldBlob).status, 0);
    const after = digestOf(repo);
    assert.notDeepEqual(after, approved);
  });
});

test('a tree with 2,000 files under a protected prefix is digested in a bounded time, since it needs a fixed number of git calls', () => {
  const files = {};
  for (let index = 0; index < 2000; index++) files[`.claude/scripts/f${index}.sh`] = `echo ${index}\n`;
  withRepo(files, (repo) => {
    const started = Date.now();
    const result = digestOf(repo);
    // A generous bound, not a measurement: two git calls per file took about 6 s for these; a fixed number takes well under 1 s.
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
    assert.equal(result.paths.length, 2004);
  });
});

test('rewording an approval: agent rule leaves the digest unchanged; editing an owner rule changes it', () => {
  withRepo({}, (repo) => {
    const before = digestOf(repo);
    assert.deepEqual(digestAfter(repo, RULES, registry(ownerRule(), agentRule('A1', 'a different reason'))), before);
    assert.notEqual(digestAfter(repo, RULES, registry(ownerRule('R1', 'a different reason'), agentRule())).digest, before.digest);
  });
});

test('an absent RULES.md or settings.json contributes nothing and is no problem', () => {
  withRepo({}, (repo) => {
    repo.git('rm', '-q', RULES, SETTINGS);
    repo.commitAll('remove');
    assert.deepEqual(digestOf(repo).paths, ['.claude/kh-orchestration/officers.json', 'tools/officers/a1.mjs']);
  });
});

test('a RULES.md with a reported problem gives a problem naming its first problem\'s line and text', () => {
  withRepo({ [RULES]: `${registry(ownerRule())}\n##\n` }, (repo) => {
    const parsed = parseRegistry(repo.git('show', `HEAD:${RULES}`).stdout);
    assert.equal(parsed.problems.length, 1);
    assert.deepEqual(digestOf(repo), { problem: invalidRulesMessage(parsed.problems[0].line, parsed.problems[0].text) });
  });
  withRepo({ [RULES]: registry(agentRule('A1', 'a <!-- hidden')) }, (repo) => {
    const result = digestOf(repo);
    assert.equal(result.problem, invalidRulesMessage(6, MINOR_WORDING_PROBLEM));
  });
  assert.match(invalidRulesMessage(7, 'x'), /^docs\/harness\/RULES\.md line 7: x/);
});

test('a RULES.md that is not valid UTF-8 gives a problem', () => {
  withRepo({}, (repo) => {
    writeFileSync(join(repo.root, RULES), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    repo.commitAll('bad bytes');
    assert.deepEqual(digestOf(repo), { problem: notUtf8Message });
  });
});

test('an absent officers.json, and one not of the expected shape, give a problem', () => {
  withRepo({}, (repo) => {
    repo.git('rm', '-q', OFFICERS);
    repo.commitAll('remove');
    assert.deepEqual(digestOf(repo), { problem: officersUnreadableMessage });
  });
  for (const text of ['not json', '{"officers":[{"argv":"node"}]}']) {
    withRepo({ [OFFICERS]: text }, (repo) => {
      assert.deepEqual(digestOf(repo), { problem: officersUnreadableMessage });
    });
  }
});

test('a failed read becomes a problem, never a digest without the file: an unknown tree, and a protected path that is a directory', () => {
  withRepo({}, (repo) => {
    assert.deepEqual(digestOfTree(repo.root, 'f'.repeat(40)), { problem: readFailedMessage('git failed to list the tree.') });
  });
  withRepo({}, (repo) => {
    repo.git('rm', '-q', RULES);
    repo.write(`${RULES}/inner`, 'x\n');
    repo.commitAll('directory at a protected path');
    assert.deepEqual(digestOf(repo), { problem: notBlobMessage(RULES) });
  });
});

test('agentRuleChanges lists a reworded agent rule and nothing for an owner rule, an added or removed rule, or an unchanged tree', () => {
  withRepo({}, (repo) => {
    const base = treeOf(repo);
    const commitRules = (text) => {
      repo.write(RULES, text);
      repo.commitAll('rules');
      return treeOf(repo);
    };
    const reworded = commitRules(registry(ownerRule(), agentRule('A1', 'a different reason')));
    assert.deepEqual(agentRuleChanges(repo.root, base, reworded), [{ id: 'A1', change: 'reworded' }]);
    assert.deepEqual(agentRuleChanges(repo.root, base, base), []);
    assert.deepEqual(agentRuleChanges(repo.root, null, reworded), []);
    const ownerEdit = commitRules(registry(ownerRule('R1', 'edited'), agentRule()));
    assert.deepEqual(agentRuleChanges(repo.root, base, ownerEdit), []);
    const added = commitRules(registry(ownerRule(), agentRule('A2'), agentRule()));
    assert.deepEqual(agentRuleChanges(repo.root, base, added), []);
    assert.deepEqual(agentRuleChanges(repo.root, added, base), []);
    const becameOwner = commitRules(registry(ownerRule(), agentRule().replace('approval: agent', 'approval: owner')));
    assert.deepEqual(agentRuleChanges(repo.root, base, becameOwner), []);
    const edited = commitRules(registry(ownerRule(), agentRule().replace('enforced-by: officer', 'enforced-by: test')));
    assert.deepEqual(agentRuleChanges(repo.root, base, edited), [], 'an edited covered line changes the digest, so it is not listed');
    const spaced = commitRules(`${registry(ownerRule(), agentRule())}\n\n`);
    assert.deepEqual(agentRuleChanges(repo.root, base, spaced), [], 'blank lines are covered too');
    const two = commitRules(registry(agentRule('A1', 'x'), agentRule('A2', 'y')));
    const twoReworded = commitRules(registry(agentRule('A1', 'x2'), agentRule('A2', 'y2')));
    assert.deepEqual(agentRuleChanges(repo.root, two, twoReworded), [{ id: 'A1', change: 'reworded' }, { id: 'A2', change: 'reworded' }]);
  });
});

test('agentRuleChanges treats an absent RULES.md in either tree as no rules', () => {
  withRepo({}, (repo) => {
    const base = treeOf(repo);
    repo.git('rm', '-q', RULES);
    repo.commitAll('remove');
    assert.deepEqual(agentRuleChanges(repo.root, base, treeOf(repo)), []);
    assert.deepEqual(agentRuleChanges(repo.root, treeOf(repo), base), []);
  });
});

test('agentRuleChanges throws a fixed message when the RULES.md of either tree is not the blob its id names, so a forged base cannot hide a rewording', () => {
  withRepo({}, (repo) => {
    const base = treeOf(repo);
    repo.write(RULES, registry(ownerRule(), agentRule('A1', 'a different reason')));
    repo.commitAll('reword');
    const head = treeOf(repo);
    assert.deepEqual(agentRuleChanges(repo.root, base, head), [{ id: 'A1', change: 'reworded' }]);
    const forge = (text, otherTree) => {
      const oid = repo.git('rev-parse', `${otherTree}:${RULES}`).stdout.trim();
      const object = join(repo.root, '.git', 'objects', oid.slice(0, 2), oid.slice(2));
      rmSync(object);
      const body = Buffer.from(text);
      writeFileSync(object, deflateSync(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])));
    };
    forge(registry(ownerRule(), agentRule('A1', 'a different reason')), base);
    assert.throws(() => agentRuleChanges(repo.root, base, head), { message: objectMismatchMessage(RULES) });
    
  });
});
