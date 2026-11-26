import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeRepo, testEnv } from '../../scripts/lib/test-repo.mjs';
import { headCommit, headTree, runOfficer } from './officer-test-support.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'migrations-append-only.py');
const FILE = 'db.py';
const DEFAULT_FILE = 'products/vision/backend/src/vyugate_api/db.py';
const HAS_PYTHON = spawnSync('python3', ['--version'], { env: testEnv() }).status === 0;

const SCHEMAS = 'SCHEMA_V1 = """CREATE TABLE a (id int);"""\nSCHEMA_V2 = """ALTER TABLE a ADD b int;"""\nSCHEMA_V3 = """ALTER TABLE a ADD c int;"""\n';
const listOf = (...elements) => `MIGRATIONS = [\n${elements.map((element) => `    ${element},\n`).join('')}]\n`;
const BASE = SCHEMAS + listOf('SCHEMA_V1', 'SCHEMA_V2');

const repos = [];
afterEach(() => {
  while (repos.length > 0) repos.pop().cleanup();
});

// Commits `base` (when not null) as the base, then `current` (null removes the file) as the tree, and runs the officer.
function run({ base = BASE, current, options = { file: FILE, name: 'MIGRATIONS' }, values = {}, file = FILE }) {
  const repo = makeRepo();
  repos.push(repo);
  if (base !== null) {
    repo.write(file, base);
    repo.commitAll('base');
  }
  const baseId = headCommit(repo);
  if (current === null) repo.git('rm', '-q', file);
  else repo.write(file, current);
  repo.commitAll('current');
  return runOfficer(repo, ['python3', SCRIPT], {
    changed: [file],
    values: { KO_OPTIONS: JSON.stringify(options), KO_BASE: baseId, KO_TREE: headTree(repo), ...values },
  });
}

const fails = (config, expected) => {
  const result = run(config);
  assert.equal(result.status, 1);
  assert.equal(result.output, expected);
};
const passes = (config, expected) => {
  const result = run(config);
  assert.equal(result.status, 0);
  if (expected !== undefined) assert.equal(result.output, expected);
};

const unreadable = (where, reason, name = 'MIGRATIONS') => `V11: ${name} in ${FILE} ${where} could not be read: ${reason}.\n`;
const differs = (index, base, tree) => `V11: element ${index} of MIGRATIONS differs from the base; an applied migration may not be changed, removed, reordered or preceded by a new one, so append at the end. Base: ${base} Tree: ${tree}\n`;

describe('V11 migrations-append-only', { skip: HAS_PYTHON ? false : 'python3 is not on PATH; the V11 officer needs it' }, () => {
  test('a base list that is an exact prefix of the current list passes', () => {
    passes({ current: BASE }, `V11: MIGRATIONS in ${FILE} keeps its 2 elements of the base and has 0 appended.\n`);
    passes({ current: SCHEMAS + listOf('SCHEMA_V1', 'SCHEMA_V2', 'SCHEMA_V3') }, `V11: MIGRATIONS in ${FILE} keeps its 2 elements of the base and has 1 appended.\n`);
  });

  test('reformatting, comments and a trailing comma do not matter', () => {
    passes({ current: `${SCHEMAS}MIGRATIONS = [SCHEMA_V1,   # first\n    SCHEMA_V2]\n` });
  });

  test('an annotated assignment is read', () => {
    const annotated = (...names) => `${SCHEMAS}MIGRATIONS: list[str] = [${names.join(', ')}]\n`;
    passes({ base: annotated('SCHEMA_V1'), current: annotated('SCHEMA_V1', 'SCHEMA_V2') });
    fails({ base: annotated('SCHEMA_V1', 'SCHEMA_V2'), current: annotated('SCHEMA_V1', 'SCHEMA_V3') }, differs(1, 'SCHEMA_V2', 'SCHEMA_V3'));
  });

  test('string literal elements are compared by value', () => {
    passes({ base: listOf("'a'", "'b'"), current: listOf('"a"', "'b'", "'c'") });
    fails({ base: listOf("'a'", "'b'"), current: listOf("'a'", "'x'") }, differs(1, "'b'", "'x'"));
  });

  test('an element edited in place fails, naming its index', () => {
    fails({ current: SCHEMAS + listOf('SCHEMA_V1', 'SCHEMA_V3') }, differs(1, 'SCHEMA_V2', 'SCHEMA_V3'));
  });

  test('an element removed fails, naming the first index that is gone', () => {
    fails({ current: SCHEMAS + listOf('SCHEMA_V1') }, differs(1, 'SCHEMA_V2', 'nothing'));
  });

  test('elements reordered fail, naming the first index that moved', () => {
    fails({ current: SCHEMAS + listOf('SCHEMA_V2', 'SCHEMA_V1') }, differs(0, 'SCHEMA_V1', 'SCHEMA_V2'));
  });

  test('an element inserted before the end fails, naming its index', () => {
    fails({ current: SCHEMAS + listOf('SCHEMA_V1', 'SCHEMA_V3', 'SCHEMA_V2') }, differs(1, 'SCHEMA_V2', 'SCHEMA_V3'));
  });

  test('an element is shown on one line cut to 80 characters', () => {
    const long = `'${'x'.repeat(100)}'`;
    fails({ base: listOf(long), current: listOf("'y'") }, differs(0, `${long.slice(0, 80)}...`, "'y'"));
    fails({ base: listOf('"""a\n   b"""'), current: listOf("'y'") }, differs(0, '"""a b"""', "'y'"));
  });

  test('a name whose string was edited in place fails, naming the name', () => {
    const edited = SCHEMAS.replace('ADD b int', 'ADD b bigint') + listOf('SCHEMA_V1', 'SCHEMA_V2');
    fails({ current: edited }, 'V11: SCHEMA_V2 (element 1 of MIGRATIONS) was edited: the value assigned to it is not the same as at the base.\n');
  });

  test('a name assigned twice, or not at all, in either version fails, naming the name', () => {
    const twice = (where) => `V11: SCHEMA_V1 (element 0 of MIGRATIONS) is not assigned exactly once at module level ${where}.\n`;
    fails({ current: `SCHEMA_V1 = 'x'\n${BASE}` }, twice('in the tree'));
    fails({ base: `SCHEMA_V1 = 'a'\nSCHEMA_V1 = 'b'\nSCHEMA_V2 = """ALTER TABLE a ADD b int;"""\n${listOf('SCHEMA_V1', 'SCHEMA_V2')}`, current: BASE }, twice('at the base'));
    fails({ current: BASE.replace(/SCHEMA_V1 = .*\n/, '') }, twice('in the tree'));
    fails({ base: listOf('SCHEMA_V1'), current: listOf('SCHEMA_V1') }, twice('at the base'));
  });

  test('KO_BASE none, and the file absent at the base, pass: there is nothing to compare', () => {
    passes({ current: BASE, values: { KO_BASE: 'none' } }, `V11: nothing to compare: there is no base commit.\n`);
    passes({ base: null, current: BASE }, `V11: nothing to compare: ${FILE} did not exist at the base.\n`);
  });

  test('the file removed in the tree fails', () => {
    fails({ current: null }, `V11: ${FILE} exists at the base and not in the tree: the migrations file was removed.\n`);
  });

  test('a syntax error in either version fails, naming which', () => {
    fails({ current: `${BASE}MIGRATIONS = [\n` }, `V11: ${FILE} in the tree has a syntax error.\n`);
    fails({ base: 'def (:\n', current: BASE }, `V11: ${FILE} at the base has a syntax error.\n`);
  });

  test('a missing assignment fails as unreadable, in either version', () => {
    fails({ current: 'OTHER = []\n' }, unreadable('in the tree', 'it is not assigned at module level'));
    fails({ base: 'OTHER = []\n', current: BASE }, unreadable('at the base', 'it is not assigned at module level'));
  });

  test('a second module-level assignment fails as unreadable', () => {
    fails({ current: `${BASE}MIGRATIONS = [SCHEMA_V1, SCHEMA_V2]\n` }, unreadable('in the tree', 'it is assigned more than once at module level'));
    fails({ current: `${BASE}MIGRATIONS += [SCHEMA_V3]\n` }, unreadable('in the tree', 'it is assigned more than once at module level'));
    fails({ current: `${BASE}if True:\n    MIGRATIONS = []\n` }, unreadable('in the tree', 'it is assigned more than once at module level'));
  });

  describe('a value that is not a plain list literal fails as unreadable', () => {
    const cases = {
      'a call': 'list((SCHEMA_V1, SCHEMA_V2))',
      'a comprehension': '[n for n in (SCHEMA_V1, SCHEMA_V2)]',
      'a + expression': '[SCHEMA_V1] + [SCHEMA_V2]',
      'a tuple': '(SCHEMA_V1, SCHEMA_V2)',
      'a name': 'OTHER',
    };
    for (const [label, value] of Object.entries(cases)) {
      test(label, () => {
        fails({ current: `${SCHEMAS}OTHER = [SCHEMA_V1, SCHEMA_V2]\nMIGRATIONS = ${value}\n` }, unreadable('in the tree', 'its value is not a plain list literal'));
        fails({ base: `${SCHEMAS}OTHER = []\nMIGRATIONS = ${value}\n`, current: BASE }, unreadable('at the base', 'its value is not a plain list literal'));
      });
    }
    test('a starred element', () => {
      fails({ current: `${SCHEMAS}MIGRATIONS = [SCHEMA_V1, *[SCHEMA_V2]]\n` }, unreadable('in the tree', 'its list has a starred element'));
    });
  });

  test('the defaults are the vyugate file and the name MIGRATIONS', () => {
    const at = (names) => `${SCHEMAS}MIGRATIONS = [${names}]\n`;
    const config = { base: at('SCHEMA_V1'), file: DEFAULT_FILE, options: {} };
    passes({ ...config, current: at('SCHEMA_V1, SCHEMA_V2') });
    const result = run({ ...config, current: at('SCHEMA_V2') });
    assert.equal(result.status, 1);
    assert.equal(result.output, `V11: element 0 of MIGRATIONS differs from the base; an applied migration may not be changed, removed, reordered or preceded by a new one, so append at the end. Base: SCHEMA_V1 Tree: SCHEMA_V2\n`);
  });

  test('another name is read from the options', () => {
    const list = (names) => `${SCHEMAS}STEPS = [${names}]\n`;
    fails({ base: list('SCHEMA_V1'), current: list('SCHEMA_V2'), options: { file: FILE, name: 'STEPS' } }, differs(0, 'SCHEMA_V1', 'SCHEMA_V2').replace('MIGRATIONS', 'STEPS'));
  });

  describe('malformed input fails with exit 1 and fixed text', () => {
    const badOptions = 'V11: KO_OPTIONS must be a JSON object whose only keys are file and name, each a non-empty string, name being a Python identifier. Fix the officer\'s options in officers.json.\n';
    test('KO_OPTIONS unusable', () => {
      for (const values of [{ KO_OPTIONS: '{' }, { KO_OPTIONS: '[]' }, { KO_OPTIONS: undefined }, { KO_OPTIONS: '{"file":""}' }, { KO_OPTIONS: '{"name":"a b"}' }, { KO_OPTIONS: '{"name":1}' }, { KO_OPTIONS: '{"other":"x"}' }]) {
        fails({ current: BASE, values }, badOptions);
      }
    });
    test('KO_BASE or KO_TREE not an object id', () => {
      fails({ current: BASE, values: { KO_BASE: 'main' } }, 'V11: KO_BASE is not a full commit id.\n');
      fails({ current: BASE, values: { KO_BASE: undefined } }, 'V11: KO_BASE is not a full commit id.\n');
      fails({ current: BASE, values: { KO_TREE: 'HEAD' } }, 'V11: KO_TREE is not a full tree id.\n');
    });
    test('an object id git does not know', () => {
      fails({ current: BASE, values: { KO_TREE: '0'.repeat(40) } }, 'V11: git could not read the repository.\n');
    });
  });
});
