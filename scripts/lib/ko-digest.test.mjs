import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolateProcessEnv, makeRepo } from './test-repo.mjs';
import { MINOR_WORDING_PROBLEM, canonicalRegistry, parseRegistry } from '../../assets/scripts/ko-registry.mjs';
import { agentRuleChanges, digestOfTree, invalidRulesMessage, notUtf8Message, officersUnreadableMessage, readFailedMessage } from '../../assets/scripts/ko-digest.mjs';
import { PROTECTED_FILES, PROTECTED_PREFIXES, isProtected, officerScriptsOf } from '../../assets/scripts/extension.mjs';

isolateProcessEnv();

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'scripts', 'extension.mjs');
const RULES = 'docs/harness/RULES.md';
const OFFICERS = '.claude/kh-orchestration/officers.json';
const SETTINGS = '.claude/settings.json';
const sha = (data) => createHash('sha256').update(data).digest('hex');

const agentRule = (id = 'A1', why = 'a reason') => `## ${id} — an agent rule\n- why: ${why}\n- enforced-by: officer\n- pointer: tools/officers/a1.mjs\n- approval: agent\n`;
const ownerRule = (id = 'R1', why = 'a reason') => `## ${id} — an owner rule\n- why: ${why}\n- enforced-by: test\n- pointer: tests/r1.test.mjs\n`;
const registry = (...rules) => `# Rules\n\nPreamble.\n\n${rules.join('\n')}`;
const officers = (...argvs) => JSON.stringify({
  schema: 1, baseBranch: 'main',
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

test('extension.mjs has no import specifier that does not start with node:', () => {
  const source = readFileSync(EXTENSION, 'utf8');
  const specifiers = [...source.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm), ...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g), ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
  assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith('node:')), []);
});

test('the protected prefixes and files are the brief\'s lists', () => {
  assert.deepEqual(PROTECTED_PREFIXES, ['.claude/kh-orchestration/scripts/', '.claude/kh-harness/', '.claude/scripts/']);
  assert.deepEqual(PROTECTED_FILES, [RULES, OFFICERS, SETTINGS]);
});

test('isProtected is true for a protected file, a path under a protected prefix and an officer script, and false otherwise', () => {
  const scripts = ['tools/officers/a1.mjs'];
  for (const path of [...PROTECTED_FILES, '.claude/scripts/x.sh', '.claude/kh-harness/deep/er/y.mjs', '.claude/kh-orchestration/scripts/gate.mjs', 'tools/officers/a1.mjs']) {
    assert.equal(isProtected(path, scripts), true, path);
  }
  for (const path of ['src/app.js', 'docs/harness/RULES.md.bak', 'docs/harness/rules.md', '.claude/Settings.json', '.claude/scripts', '.claude/scriptsx/a', '.claude/kh-orchestration/state.json', 'tools/officers/a1.mjs.orig']) {
    assert.equal(isProtected(path, scripts), false, path);
  }
});

test('officerScriptsOf gives the relative, non-option elements of every argv, and null for anything not of the shape', () => {
  assert.deepEqual(officerScriptsOf(officers(['node', './tools/a.mjs', '--flag', '-x', '/etc/passwd', '../up.mjs', 'a/../b.mjs', '', 'tools/a.mjs'], ['sh', 'run.sh'])), ['node', 'tools/a.mjs', 'sh', 'run.sh']);
  assert.deepEqual(officerScriptsOf(officers()), []);
  for (const text of ['', 'not json', 'null', '[]', '{}', '{"officers":{}}', '{"officers":[null]}', '{"officers":[{}]}', '{"officers":[{"argv":"node"}]}', '{"officers":[{"argv":["node",1]}]}']) {
    assert.equal(officerScriptsOf(text), null, text);
  }
});

test('the digest is the SHA-256 of the canonical text: sorted path NUL hash lines, with RULES.md by its canonical form', () => {
  withRepo({}, (repo) => {
    const files = baseFiles();
    const rulesHash = sha(canonicalRegistry(parseRegistry(files[RULES])));
    const lines = [
      [OFFICERS, sha(files[OFFICERS])], [SETTINGS, sha(files[SETTINGS])], [RULES, rulesHash], ['tools/officers/a1.mjs', sha(files['tools/officers/a1.mjs'])],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const result = digestOf(repo);
    assert.deepEqual(result, { digest: sha(lines.map(([path, hash]) => `${path}\0${hash}\n`).join('')), paths: lines.map(([path]) => path) });
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
  withRepo({ [OFFICERS]: officers(['node', 'tools/officers/a1.mjs', 'tools', 'missing.mjs', '--flag']) }, (repo) => {
    assert.deepEqual(digestOf(repo).paths, ['.claude/kh-orchestration/officers.json', '.claude/settings.json', 'docs/harness/RULES.md', 'tools/officers/a1.mjs']);
  });
});

test('CRLF and LF script bytes digest differently, since the hash is of the blob\'s bytes', () => {
  withRepo({}, (repo) => {
    const lfDigest = digestAfter(repo, 'tools/officers/a1.mjs', 'a\nb\n');
    assert.notEqual(digestAfter(repo, 'tools/officers/a1.mjs', 'a\r\nb\r\n').digest, lfDigest.digest);
  });
});

test('a symlink at a protected path is hashed as its link target, so changing the target changes the digest', () => {
  withRepo({}, (repo) => {
    rmSync(join(repo.root, SETTINGS));
    symlinkSync('one.json', join(repo.root, SETTINGS));
    repo.commitAll('link');
    const first = digestOf(repo);
    assert.ok(first.paths.includes(SETTINGS));
    rmSync(join(repo.root, SETTINGS));
    symlinkSync('two.json', join(repo.root, SETTINGS));
    repo.commitAll('retarget');
    assert.notEqual(digestOf(repo).digest, first.digest);
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
    assert.deepEqual(digestOfTree(repo.root, '0'.repeat(40)), { problem: readFailedMessage('git failed to read the file.') });
  });
  withRepo({}, (repo) => {
    repo.git('rm', '-q', RULES);
    repo.write(`${RULES}/inner`, 'x\n');
    repo.commitAll('directory at a protected path');
    assert.deepEqual(digestOf(repo), { problem: readFailedMessage(`${RULES} is in the tree but is not a file.`) });
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
