import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reachesOtherFiles } from './self-contained.mjs';
import { PROTECTED_FILES, PROTECTED_PREFIXES, compileGlob, isProtected, readOfficers } from '../../assets/scripts/extension.mjs';

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'scripts', 'extension.mjs');
const officersText = (argvs, extra = {}) => JSON.stringify({
  schema: 1, baseBranch: 'main', protected: [],
  officers: argvs.map((argv, index) => ({ id: `o${index}`, rule: 'A1', argv, appliesTo: ['**'], timeoutSeconds: 60, options: {} })),
  ...extra,
});

test('extension.mjs reaches no file but node: built-ins', () => {
  assert.deepEqual(reachesOtherFiles(readFileSync(EXTENSION, 'utf8')), []);
});

test('the self-containment check finds every way to reach another file, and passes node: imports', () => {
  const bad = [
    "import x from '../y.mjs';", "import x from './y.mjs'", "import { a } from 'pkg';", "export { a } from '../y.mjs';", "export * from './y.mjs';",
    "import './side.mjs';", "/* c */ import x from '../y.mjs';", "import(`./x.mjs`)", "import(name)", "await import('./x.mjs')", "import('node:fs' + x)",
    "import { createRequire } from 'node:module'; const r = createRequire(import.meta.url); r('./x');", "const x = require('./x');",
    "import {\n  a,\n  b,\n} from '../y.mjs';", "import /* from 'node:fs' */ x from './evil.mjs';", "import { a /* from \"node:fs\" */ } from './evil.mjs';",
    "import /* c */ ('./evil.mjs')", "const u = 'http://x'; import y from './evil.mjs';", "const u = \"//\"; export * from './evil.mjs';",
  ];
  for (const source of bad) assert.notDeepEqual(reachesOtherFiles(source), [], source);
  const good = [
    "import { createHash } from 'node:crypto';", "import fs, { x } from \"node:fs\";", "import 'node:fs';", "export { a } from 'node:path';", "await import('node:fs');",
    "import {\n  a,\n} from 'node:path';\nexport const x = 1;", '// the word import in a comment\nexport const y = 2;', "/* import x from './y.mjs' */ import fs from 'node:fs';", "// import('./x.mjs')\nimport fs from 'node:fs';",
    "const u = 'http://x'; import fs from 'node:fs';",
  ];
  for (const source of good) assert.deepEqual(reachesOtherFiles(source), [], source);
});

test('the protected prefixes and files are the brief\'s lists', () => {
  assert.deepEqual(PROTECTED_PREFIXES, ['.claude/kh-orchestration/scripts/', '.claude/kh-harness/', '.claude/scripts/']);
  assert.deepEqual(PROTECTED_FILES, ['docs/harness/RULES.md', '.claude/kh-orchestration/officers.json', '.claude/settings.json']);
});

test('a compiled glob: **/ matches zero or more directories, a trailing /** what is under the directory, a lone ** everything; * and ? never cross /', () => {
  const table = [
    ['src/a.js', 'src/a.js', true], ['src/a.js', 'src/b.js', false], ['src/*.js', 'src/a.js', true], ['src/*.js', 'src/deep/a.js', false],
    ['**/*.py', 'a.py', true], ['**/*.py', 'x/a.py', true], ['**/*.py', 'x/y/a.py', true], ['**/*.py', 'a.pyc', false], ['**/*.py', 'xa.py/b', false],
    ['src/**/a.js', 'src/a.js', true], ['src/**/a.js', 'src/x/y/a.js', true], ['src/**/a.js', 'srcx/a.js', false], ['src/**/a.js', 'src/xa.js', false],
    ['lib/**', 'lib/a', true], ['lib/**', 'lib/a/b', true], ['lib/**', 'lib', false], ['lib/**', 'libx/a', false],
    ['**', 'x', true], ['**', 'a/b/c', true], ['**', '.hidden/x', true], ['**/a.js', '.hidden/a.js', true], ['**/x', 'ax', false],
    ['a?c', 'abc', true], ['a?c', 'a/c', false], ['a?c', 'ac', false], ['*', 'a/b', false], ['*', 'ab', true], ['a.b', 'aXb', false], ['a.b', 'a.b', true],
    ['a+b', 'a+b', true], ['a(b)', 'a(b)', true], ['a.js', 'A.js', false], ['x/*/y', 'x/m/y', true], ['x/*/y', 'x/m/n/y', false], ['a$b', 'a$b', true],
  ];
  for (const [glob, path, expected] of table) assert.equal(compileGlob(glob)(path), expected, `${glob} ${path}`);
});

test('compiling a glob twice gives the same matcher, so a hot path does not compile again', () => {
  assert.equal(compileGlob('a/**'), compileGlob('a/**'));
});

test('an invalid glob makes the officers file unreadable: empty, absolute, a .., . or empty segment, a trailing /, or [ ] { } \\', () => {
  for (const glob of ['', '/abs/x', '../x', 'a/../x', './x', 'a/./b', '.', '..', 'a//b', 'docs/', '/', 'a[b]', 'a]', '{a,b}', 'a}', 'a\\b']) {
    assert.equal(readOfficers(officersText([['node', 'a.mjs']], { protected: [glob] })), null, JSON.stringify(glob));
  }
  for (const glob of ['a', 'a/b.js', '**', '**/*.py', 'lib/**', 'a.b/c?', '.hidden/**']) {
    assert.notEqual(readOfficers(officersText([['node', 'a.mjs']], { protected: [glob] })), null, glob);
  }
});

test('isProtected is true for a protected file, a path under a protected prefix, an officer script and a protected glob, and false otherwise', () => {
  const scripts = ['tools/officers/a1.mjs'];
  const globs = ['config/**', 'package.json'];
  for (const path of [...PROTECTED_FILES, '.claude/scripts/x.sh', '.claude/kh-harness/deep/er/y.mjs', '.claude/kh-orchestration/scripts/gate.mjs', 'tools/officers/a1.mjs', 'config/a/b.yml', 'package.json']) {
    assert.equal(isProtected(path, scripts, globs), true, path);
  }
  for (const path of ['src/app.js', 'docs/harness/RULES.md.bak', 'docs/harness/rules.md', '.claude/Settings.json', '.claude/scripts', '.claude/scriptsx/a', '.claude/kh-orchestration/state.json', 'tools/officers/a1.mjs.orig', 'config', 'sub/package.json']) {
    assert.equal(isProtected(path, scripts, globs), false, path);
  }
});

test('readOfficers gives candidates from argv elements and from the value after = of an option, normalised, and the protected globs', () => {
  const read = (argv) => readOfficers(officersText([argv]))?.officerCandidates.map((candidate) => candidate.path);
  assert.deepEqual(read(['node', './scripts/../scripts/check.mjs']), ['node', 'scripts/check.mjs']);
  assert.deepEqual(read(['x', 'scripts/./check.mjs', 'scripts//check.mjs', '././scripts/check.mjs']), ['x', 'scripts/check.mjs', 'scripts/check.mjs', 'scripts/check.mjs']);
  assert.deepEqual(read(['node', '--import=./scripts/check.mjs', '--flag', '-x', '--a=b=c']), ['node', 'scripts/check.mjs', 'b=c']);
  assert.deepEqual(read(['node', 'scripts/']), ['node', 'scripts']);
  assert.deepEqual(read(['node', '../up.mjs', '/etc/passwd', '..', 'a/../../b', '', '.', '--out=/abs']), ['node']);
  assert.deepEqual(read(['a\\b.mjs']), ['a\\b.mjs']);
  const parsed = readOfficers(officersText([['node', 'a.mjs']], { protected: ['config/**'] }));
  assert.deepEqual(parsed.protectedGlobs, ['config/**']);
  assert.deepEqual(parsed.officerCandidates, [
    { id: 'o0', element: 'node', path: 'node' }, { id: 'o0', element: 'a.mjs', path: 'a.mjs' },
  ]);
});

test('readOfficers is null for anything not of the shape: not JSON, schema not exactly 1, protected absent or not valid globs, officers or argv malformed', () => {
  const good = JSON.parse(officersText([['node', 'a.mjs']]));
  assert.notEqual(readOfficers(JSON.stringify(good)), null);
  const variants = {
    'not json': 'not json', empty: '', 'null': 'null', array: '[]',
    'schema 2': { ...good, schema: 2 }, 'schema string': { ...good, schema: '1' }, 'schema absent': { ...good, schema: undefined },
    'protected absent': { ...good, protected: undefined }, 'protected not array': { ...good, protected: 'a' }, 'protected element not string': { ...good, protected: [1] },
    'officers absent': { ...good, officers: undefined }, 'officers object': { ...good, officers: {} }, 'officer null': { ...good, officers: [null] },
    'argv absent': { ...good, officers: [{ id: 'o' }] }, 'argv empty': { ...good, officers: [{ id: 'o', argv: [] }] },
    'argv not strings': { ...good, officers: [{ id: 'o', argv: ['node', 1] }] }, 'id absent': { ...good, officers: [{ argv: ['node'] }] },
  };
  for (const [name, value] of Object.entries(variants)) {
    assert.equal(readOfficers(typeof value === 'string' ? value : JSON.stringify(value)), null, name);
  }
});
