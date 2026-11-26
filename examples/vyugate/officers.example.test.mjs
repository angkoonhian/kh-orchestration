import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { matchesGlob, readOfficers } from '../../assets/scripts/extension.mjs';
import { officersOfTree } from '../../assets/scripts/ko-officers.mjs';
import { makeRepo } from '../../scripts/lib/test-repo.mjs';
import { headTree } from './officer-test-support.mjs';

const TEXT = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'officers.example.json'), 'utf8');
const OFFICERS_PATH = '.claude/kh-orchestration/officers.json';

const repos = [];
afterEach(() => {
  while (repos.length > 0) repos.pop().cleanup();
});

test('the plugin reads the example officers file', () => {
  const read = readOfficers(TEXT);
  assert.notEqual(read, null);
  assert.deepEqual(read.officerCandidates.filter(({ path }) => path.startsWith('scripts/')).map(({ id, path }) => [id, path]), [
    ['docs-with-logic', 'scripts/officers/docs-with-logic.mjs'],
    ['migrations-append-only', 'scripts/officers/migrations-append-only.py'],
  ]);
});

test('the runner accepts the example as committed in a tree, every key present with a valid value', () => {
  const repo = makeRepo({ files: { [OFFICERS_PATH]: TEXT } });
  repos.push(repo);
  const loaded = officersOfTree(repo.root, headTree(repo));
  assert.equal(loaded.problem, undefined);
  assert.equal(loaded.baseBranch, 'main');
  assert.deepEqual(loaded.officers.map(({ id, rule }) => [id, rule]), [['docs-with-logic', 'V8'], ['migrations-append-only', 'V11']]);
  for (const officer of loaded.officers) {
    assert.deepEqual(Object.keys(officer).sort(), ['appliesTo', 'argv', 'id', 'options', 'rule', 'timeoutSeconds']);
    assert.equal(officer.timeoutSeconds, 60);
  }
});

test('the protected globs of the example cover both scripts the officers run', () => {
  const { protected: globs, officers } = JSON.parse(TEXT);
  for (const officer of officers) assert.ok(globs.some((glob) => matchesGlob(glob, officer.argv[1])), officer.id);
});

test('the V8 placeholders are plain valid globs the owner replaces, and the V11 options name the vyugate file', () => {
  const [docs, migrations] = JSON.parse(TEXT).officers;
  assert.deepEqual(docs.options, { logic: ['PLACEHOLDER-logic-directory/**'], docs: ['PLACEHOLDER-docs-directory/**'] });
  assert.deepEqual(migrations.appliesTo, [migrations.options.file]);
  assert.equal(migrations.options.file, 'products/vision/backend/src/vyugate_api/db.py');
});
