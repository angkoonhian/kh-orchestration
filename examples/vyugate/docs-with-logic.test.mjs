import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isValidGlob as pluginIsValidGlob, matchesGlob as pluginMatchesGlob } from '../../assets/scripts/extension.mjs';
import { makeRepo } from '../../scripts/lib/test-repo.mjs';
import { isValidGlob, matchesGlob, MESSAGES, waivedMessage } from './docs-with-logic.mjs';
import { runOfficer } from './officer-test-support.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'docs-with-logic.mjs');
const OPTIONS = { logic: ['src/**', 'db/*.sql'], docs: ['docs/**', 'README.md'] };

const repos = [];
afterEach(() => {
  while (repos.length > 0) repos.pop().cleanup();
});

function run({ changed, options = OPTIONS, values = {} }) {
  const repo = makeRepo();
  repos.push(repo);
  return runOfficer(repo, [process.execPath, SCRIPT], { changed, values: { KO_OPTIONS: JSON.stringify(options), ...values } });
}

describe('V8 docs-with-logic', () => {
  test('a changed logic path and no changed docs path fails, naming the logic paths and what to do', () => {
    const result = run({ changed: ['src/a.py', 'src/b/c.py', 'notes.txt'] });
    assert.equal(result.status, 1);
    assert.equal(result.output, MESSAGES.logicWithoutDocs(['src/a.py', 'src/b/c.py']));
    assert.equal(result.output, [
      'V8: a business-logic or architecture path changed and no documentation path did.',
      'Changed logic paths:',
      '  src/a.py',
      '  src/b/c.py',
      'Update a documentation path in this branch, or ask the owner for a waiver of V8 with a reason.',
      '',
    ].join('\n'));
  });

  test('a deleted logic path and a rename away from a logic path count as logic changes', () => {
    assert.equal(run({ changed: ['db/old.sql'] }).status, 1);
    assert.equal(run({ changed: ['src/old.py', 'lib/new.py'] }).status, 1);
  });

  test('a changed docs path passes', () => {
    const result = run({ changed: ['src/a.py', 'docs/guide/x.md'] });
    assert.equal(result.status, 0);
    assert.equal(result.output, MESSAGES.docsChanged);
  });

  test('a docs-only change, no logic change and no change at all pass', () => {
    assert.equal(run({ changed: ['README.md'] }).status, 0);
    assert.equal(run({ changed: ['other/x.py'] }).output, MESSAGES.noLogic);
    assert.equal(run({ changed: ['other/x.py'] }).status, 0);
    assert.equal(run({ changed: [] }).status, 0);
  });

  test('more than 20 logic paths are listed 20 at a time, then "and N more"', () => {
    const changed = Array.from({ length: 25 }, (_, index) => `src/f${String(index).padStart(2, '0')}.py`);
    const result = run({ changed });
    assert.equal(result.status, 1);
    assert.equal(result.output, MESSAGES.logicWithoutDocs(changed));
    assert.match(result.output, /^ {2}src\/f19\.py$/m);
    assert.doesNotMatch(result.output, /f20\.py/);
    assert.match(result.output, /^and 5 more\.$/m);
  });

  test('a waiver of V8 passes and prints its reason on one line with control characters visible', () => {
    const waivers = [{ rule: 'V9', reason: 'other' }, { rule: 'V8', reason: 'line one\nline two\u001b[0m' }];
    const result = run({ changed: ['src/a.py'], values: { KO_WAIVERS: JSON.stringify(waivers) } });
    assert.equal(result.status, 0);
    assert.equal(result.output, waivedMessage('line one\nline two\u001b[0m'));
    assert.equal(result.output, 'V8: waived by the owner. Reason: line one\\u000aline two\\u001b[0m\n');
  });

  test('format characters (bidi controls, zero-width, BOM) are shown as escapes in a reason and in a path', () => {
    const tricky = '\u202e\u2066\u200b\ufeff';
    const shown = '\\u202e\\u2066\\u200b\\ufeff';
    const waived = run({ changed: ['src/a.py'], values: { KO_WAIVERS: JSON.stringify([{ rule: 'V8', reason: `x${tricky}y` }]) } });
    assert.equal(waived.output, `V8: waived by the owner. Reason: x${shown}y\n`);
    const failed = run({ changed: [`src/a${tricky}.py`] });
    assert.match(failed.output, new RegExp(`^ {2}src/a${shown.replaceAll('\\', '\\\\')}\\.py$`, 'm'));
    assert.doesNotMatch(failed.output, /[\u202e\u2066\u200b\ufeff]/u);
  });

  test('a glob with a format character is shown as escapes in the bad-glob text', () => {
    const result = run({ changed: ['src/a'], options: { logic: ['src/\u202e/'], docs: ['docs/**'] } });
    assert.equal(result.output, MESSAGES.badGlob('src/\u202e/'));
    assert.doesNotMatch(result.output, /\u202e/u);
  });

  test('a waiver reason longer than 300 characters is cut to 300 and ends with "..."', () => {
    const result = run({ changed: ['src/a.py'], values: { KO_WAIVERS: JSON.stringify([{ rule: 'V8', reason: 'r'.repeat(400) }]) } });
    assert.equal(result.output, `V8: waived by the owner. Reason: ${'r'.repeat(300)}...\n`);
  });

  test('a waiver for another rule does not pass', () => {
    const result = run({ changed: ['src/a.py'], values: { KO_WAIVERS: JSON.stringify([{ rule: 'V11', reason: 'x' }]) } });
    assert.equal(result.status, 1);
  });

  test('a path with a control character is printed with it made visible', () => {
    const result = run({ changed: ['src/a\nb.py'] });
    assert.match(result.output, /^ {2}src\/a\\u000ab\.py$/m);
  });

  describe('malformed input fails with exit 1 and fixed text', () => {
    const bad = (label, config, expected) => test(label, () => {
      const result = run(config);
      assert.equal(result.status, 1);
      assert.equal(result.output, expected);
    });
    bad('KO_OPTIONS not JSON', { changed: ['src/a'], values: { KO_OPTIONS: '{' } }, MESSAGES.badOptions);
    bad('KO_OPTIONS unset', { changed: ['src/a'], values: { KO_OPTIONS: undefined } }, MESSAGES.badOptions);
    bad('KO_OPTIONS not an object', { changed: ['src/a'], options: ['src/**'] }, MESSAGES.badOptions);
    bad('logic missing', { changed: ['src/a'], options: { docs: ['docs/**'] } }, MESSAGES.badOptions);
    bad('docs not a list of strings', { changed: ['src/a'], options: { logic: ['src/**'], docs: [1] } }, MESSAGES.badOptions);
    bad('an unknown option key', { changed: ['src/a'], options: { ...OPTIONS, extra: [] } }, MESSAGES.badOptions);
    bad('an invalid logic glob', { changed: ['src/a'], options: { logic: ['src/'], docs: ['docs/**'] } }, MESSAGES.badGlob('src/'));
    bad('an invalid docs glob', { changed: ['src/a'], options: { logic: ['src/**'], docs: ['../docs/**'] } }, MESSAGES.badGlob('../docs/**'));
    bad('KO_CHANGED_FILE unset', { changed: [], values: { KO_CHANGED_FILE: undefined } }, MESSAGES.badChangedFile);
    bad('KO_CHANGED_FILE naming a missing file', { changed: [], values: { KO_CHANGED_FILE: '/nonexistent/ko-changed' } }, MESSAGES.badChangedFile);
    bad('KO_WAIVERS not JSON', { changed: ['src/a'], values: { KO_WAIVERS: 'x' } }, MESSAGES.badWaivers);
    bad('KO_WAIVERS not an array', { changed: ['src/a'], values: { KO_WAIVERS: '{}' } }, MESSAGES.badWaivers);
    bad('a waiver of the wrong shape', { changed: ['src/a'], values: { KO_WAIVERS: '[{"rule":"V8"}]' } }, MESSAGES.badWaivers);
    bad('KO_WAIVERS unset', { changed: ['src/a'], values: { KO_WAIVERS: undefined } }, MESSAGES.badWaivers);
  });
});

describe('the officer\'s copy of the glob matcher', () => {
  const GLOBS = [
    '**', '*', '?', 'a', 'a/b', 'a/*', 'a/**', '**/a', '**/*.py', 'a/**/b', 'src/**/a.js', '**/**', 'a/**/**/b', '*.md', 'docs/*.md',
    'a?c', '*/*', '.*', '**/.git/**', 'é*', '',
    '/a', 'a/', 'a//b', './a', 'a/./b', '../a', 'a/../b', 'a/..', 'a[b]', 'a{b}', 'a\\b', 'a**b', 'a/**b', '**b', 'a/b**', '*/**', 'x'.repeat(512), 'x'.repeat(513),
  ];
  const PATHS = [
    'a', 'a.py', 'x/a.py', 'a/b', 'a/b/c', 'a/c/b', 'a/x/y/b', 'src/a.js', 'src/x/y/a.js', 'src', 'README.md', 'docs/a.md', 'docs/x/a.md',
    'abc', 'a/', '.git/x', 'x/.git/y/z', '.hidden', 'élan', 'a b', 'b/a', 'x'.repeat(512),
  ];

  test('isValidGlob agrees with the plugin on every glob of the table', () => {
    for (const glob of GLOBS) assert.equal(isValidGlob(glob), pluginIsValidGlob(glob), JSON.stringify(glob));
  });

  test('matchesGlob agrees with the plugin on every valid glob and path of the table', () => {
    for (const glob of GLOBS.filter(pluginIsValidGlob)) {
      for (const path of PATHS) assert.equal(matchesGlob(glob, path), pluginMatchesGlob(glob, path), `${JSON.stringify(glob)} ${JSON.stringify(path)}`);
    }
  });
});
