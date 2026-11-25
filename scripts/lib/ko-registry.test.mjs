import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KH_HARNESS_DIR, siblingAbsentMessage } from './test-repo.mjs';
import { MINOR_WORDING_PROBLEM, NOT_A_RULE_HEADING, canonicalRegistry, duplicateIdMessage, parseRegistry } from '../../assets/scripts/ko-registry.mjs';

const FIXTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'contract-1', 'RULES.md'), 'utf8');
const lf = (text) => text.replace(/\r\n/g, '\n');
const crlf = (text) => lf(text).replace(/\n/g, '\r\n');
const ids = (parsed) => parsed.rules.map((rule) => rule.id);

const agentRule = (extra = '') => `## A1 — an agent rule\n- why: a reason\n- enforced-by: officer\n- pointer: tools/officers/a1.mjs\n- approval: agent\n${extra}`;
const registry = (...rules) => `# Rules\n\nPreamble text.\n\n${rules.join('\n')}`;

test('the contract fixture reads as three rules with the keys the document states and no problem', () => {
  const parsed = parseRegistry(FIXTURE);
  assert.deepEqual(ids(parsed), ['R1', 'V8', 'R3']);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.rules.map((rule) => rule.title), [
    'Every database query is scoped to the current tenant', 'Every migration has a down step', 'Keep each rule to one sentence',
  ]);
  assert.deepEqual(parsed.rules[0].keys, {
    why: 'a cross-tenant read is a data breach, not a bug', enforcedby: 'test', pointer: 'tests/tenant.test.mjs',
    verify: 'npm test -- tenant', priority: 'high', status: 'active', lastverified: '2026-11-25', approval: 'owner',
  });
  assert.deepEqual(parsed.rules[1].keys, { why: 'a migration that cannot be reversed blocks a rollback', enforcedby: 'officer', pointer: 'tools/officers/v8.mjs', approval: 'agent' });
  assert.deepEqual(parsed.rules[2].keys, { enforcedby: 'none' });
  assert.deepEqual(parsed.rules.map((rule) => rule.startLine), [8, 18, 24]);
  assert.ok(parsed.preamble.includes('a heading inside an HTML comment is not a rule'));
});

// Each row: [name, text, rule ids kh-harness reads, problem lines].
const TABLE = [
  ['empty text', '', [], []],
  ['no rule at all', '# Rules\n\nProse only.\n', [], []],
  ['heading inside an HTML comment', '<!--\n## X1 — hidden\n- enforced-by: test\n-->\n## R1 — shown\n- enforced-by: test\n', ['R1'], []],
  ['comment opened and closed on the heading line', '## R1 — shown <!-- note -->\n- enforced-by: test\n', ['R1'], []],
  ['unterminated comment is text, not a comment', '<!-- never closed\n## R1 — shown\n- enforced-by: test\n', ['R1'], []],
  ['heading inside a fenced code block still starts a rule (the contract has no fences)', '```\n## F1 — in a fence\n- enforced-by: test\n```\n', ['F1'], []],
  ['em dash separator', '## R1 — rule\n', ['R1'], []],
  ['en dash separator', '## R1 – rule\n', ['R1'], []],
  ['hyphen separator', '## R1 - rule\n', ['R1'], []],
  ['mixed run of dashes', '## R1 —-– rule\n', ['R1'], []],
  ['white space alone as separator', '## R1 rule text\n', ['R1'], []],
  ['dash with no white space after it is part of the rule text', '## R1 —rule\n', ['R1'], []],
  ['heading with no id', '## — no id here\n- enforced-by: test\n## R2 — ok\n', ['R2'], [1]],
  ['bare level-2 marker', '##\n- enforced-by: test\n## R2 — ok\n', ['R2'], [1]],
  ['level-2 marker with a trailing space only', '## \n## R2 — ok\n', ['R2'], [1]],
  ['id that does not start with a letter', '## 9R — nope\n## R2 — ok\n', ['R2'], [1]],
  ['id with every allowed character', '## a_b.c-9 — ok\n', ['a_b.c-9'], []],
  ['a lone dash after the id is the rule text, white space alone being the separator', '## R1 —\n## R2 — ok\n', ['R1', 'R2'], []],
  ['level-1 and level-3 headings are not level-2 headings', '# T\n### R1 — deep\n#### R2 — deeper\n## R3 — rule\n', ['R3'], []],
  ['no space after the hashes is not a heading', '##R1 — squashed\n', [], []],
  ['duplicate id is reported and ignored', '## R1 — first\n- enforced-by: test\n## R1 — second\n- enforced-by: none\n## R2 — other\n', ['R1', 'R2'], [3]],
  ['duplicate id inside a comment is not reported', '## R1 — first\n<!-- ## R1 — hidden -->\n', ['R1'], []],
  ['CRLF line endings', '## R1 — rule\r\n- enforced-by: test\r\n\r\n## R2 — rule\r\n- why: x\r\n', ['R1', 'R2'], []],
  ['CRLF with a bad heading', '## R1 — rule\r\n##\r\n## R2 — rule\r\n', ['R1', 'R2'], [2]],
  ['byte order mark before the first heading', '﻿## R1 — rule\n## R2 — rule\n', ['R2'], []],
  ['byte order mark before a bad heading', '﻿##\n## R2 — rule\n', ['R2'], []],
  ['keys in odd case and with extra spaces', '## R1 — rule\n-   Enforced_By :   Test  \n*  enforcedBy:   none\n- WHY :x\n- Pointer:\n- LAST-verified: 2026-01-01\n', ['R1'], []],
  ['star and dash bullets', '## R1 — rule\n* why: star\n- verify: dash\n', ['R1'], []],
  ['indented bullet', '## R1 — rule\n  - why: nested\n', ['R1'], []],
  ['a bullet that is not key: value', '## R1 — rule\n- just a note\n- not a key: but has colon spaced\n- why: ok\n', ['R1'], []],
  ['unknown keys', '## R1 — rule\n- colour: blue\n- why: ok\n', ['R1'], []],
  ['a repeated key keeps the last value', '## R1 — rule\n- why: one\n- why: two\n', ['R1'], []],
  ['lines under a bad heading belong to no rule', '## R1 — rule\n- why: mine\n##\n- why: not mine\n', ['R1'], [3]],
  ['lines under a duplicate belong to no rule', '## R1 — rule\n- why: mine\n## R1 — again\n- why: not mine\n', ['R1'], [3]],
  ['trailing text after the last rule', '## R1 — rule\n- why: x\n\nclosing prose, no newline', ['R1'], []],
  ['no final newline', '## R1 — rule\n- why: x', ['R1'], []],
  ['blank lines and prose between rules', 'intro\n\n## R1 — a\n\nprose\n\n## R2 — b\n', ['R1', 'R2'], []],
];

const SIBLING_PROBLEM_LINE = /^line (\d+): heading is not|^duplicate id \S+ at line (\d+)/;

async function sibling() {
  const path = join(KH_HARNESS_DIR, 'assets', 'scripts', 'harness-redact.mjs');
  if (!existsSync(path)) assert.fail(siblingAbsentMessage(KH_HARNESS_DIR));
  return import(pathToFileURL(path).href);
}

test('every table row and the fixture keep every byte: the preamble and the blocks, joined, are the input with LF endings', () => {
  for (const [name, text] of [['the fixture', FIXTURE], ...TABLE]) {
    const parsed = parseRegistry(text);
    assert.equal(parsed.preamble + parsed.rules.map((rule) => rule.block).join(''), lf(text), name);
    for (const rule of parsed.rules) assert.ok(rule.block.startsWith('## '), `${name}: a block starts at its heading`);
  }
});

test('rule ids and problem lines of each table row are what the contract says', () => {
  for (const [name, text, expectedIds, problemLines] of TABLE) {
    const parsed = parseRegistry(text);
    assert.deepEqual(ids(parsed), expectedIds, name);
    assert.deepEqual(parsed.problems.map((problem) => problem.line), problemLines, name);
  }
});

test('a heading that starts no rule and a repeated id are reported with fixed text and 1-based lines', () => {
  const parsed = parseRegistry('## R1 — a\n##\n## R1 — b\n');
  assert.deepEqual(parsed.problems, [
    { line: 2, text: NOT_A_RULE_HEADING },
    { line: 3, text: duplicateIdMessage('R1') },
  ]);
  assert.equal(NOT_A_RULE_HEADING, 'this level-2 heading is not "## <id> <separator> <rule>", so it starts no rule.');
  assert.equal(duplicateIdMessage('R1'), 'the id R1 is already used by an earlier rule, so this rule is ignored.');
});

test('a rule block runs from its heading to the next rule heading, and the preamble is what precedes the first', () => {
  const parsed = parseRegistry('intro\n## R1 — a\n- why: x\n##\nstill R1\n## R2 — b\n');
  assert.equal(parsed.preamble, 'intro\n');
  assert.equal(parsed.rules[0].block, '## R1 — a\n- why: x\n##\nstill R1\n');
  assert.equal(parsed.rules[1].block, '## R2 — b\n');
  assert.deepEqual(parsed.rules[0].keys, { why: 'x' });
  assert.deepEqual(parsed.rules.map((rule) => rule.startLine), [2, 6]);
});

test('CRLF input parses to the same result as LF input', () => {
  for (const [name, text] of [['the fixture', FIXTURE], ...TABLE]) {
    assert.deepEqual(parseRegistry(crlf(text)), parseRegistry(lf(text)), name);
    assert.equal(canonicalRegistry(parseRegistry(crlf(text))), canonicalRegistry(parseRegistry(lf(text))), name);
  }
});

test('the parser reads the same rules as kh-harness: same ids, titles, lines, keys and reported lines', async () => {
  const { parseRules } = await sibling();
  for (const [name, text] of [['the fixture', FIXTURE], ...TABLE]) {
    const mine = parseRegistry(text);
    const theirs = parseRules(text);
    assert.deepEqual(ids(mine), theirs.rules.map((rule) => rule.id), name);
    assert.deepEqual(mine.rules.map((rule) => rule.title), theirs.rules.map((rule) => rule.rule), name);
    assert.deepEqual(mine.rules.map((rule) => rule.startLine), theirs.rules.map((rule) => rule.line), name);
    mine.rules.forEach((rule, index) => {
      const read = theirs.rules[index];
      for (const [key, field] of [['why', 'why'], ['pointer', 'pointer'], ['verify', 'verify'], ['status', 'status'], ['lastverified', 'lastVerified']]) {
        const expected = key === 'status' ? rule.keys.status?.toLowerCase() ?? 'active' : (rule.keys[key] || null);
        if (key === 'status' && !['active', 'superseded'].includes(expected)) continue;
        if (key === 'lastverified' && rule.keys[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(rule.keys[key])) continue;
        assert.equal(read[field], expected, `${name}: ${rule.id} ${key}`);
      }
    });
    const theirLines = theirs.problems.flatMap((problem) => {
      const m = problem.match(SIBLING_PROBLEM_LINE);
      return m ? [Number(m[1] ?? m[2])] : [];
    });
    assert.deepEqual(mine.problems.map((problem) => problem.line), theirLines, name);
  }
});

test('the canonical form is the same for the same registry and differs for any change a person must approve', () => {
  const canonical = (text) => canonicalRegistry(parseRegistry(text));
  const base = registry(agentRule(), '## R2 — owner rule\n- enforced-by: test\n- pointer: tests/a.mjs\n');
  assert.equal(canonical(base), canonical(base));
  const changes = {
    'a byte of an owner rule': base.replace('tests/a.mjs', 'tests/b.mjs'),
    'the title of an owner rule': base.replace('owner rule', 'owner rules'),
    'a byte of the preamble': base.replace('Preamble text.', 'Preamble text!'),
    'a rule removed': registry(agentRule()),
    'a rule added': `${base}\n## R3 — new\n- enforced-by: none\n`,
    'a rule renamed': base.replace('## A1', '## A9'),
    'the pointer of an agent rule': base.replace('a1.mjs', 'b1.mjs'),
    'the enforced-by of an agent rule': base.replace('- enforced-by: officer', '- enforced-by: test'),
    'the approval of an agent rule': base.replace('- approval: agent', '- approval: owner'),
    'a trailing byte': `${base}\n`,
    'a second pointer line in an agent rule': base.replace('- approval: agent', '- pointer: other.mjs\n- approval: agent'),
  };
  for (const [name, text] of Object.entries(changes)) assert.notEqual(canonical(text), canonical(base), name);
});

test('only the title and the values of why, verify and priority are free in an approval: agent rule; every other byte is covered', () => {
  const canonical = (text) => canonicalRegistry(parseRegistry(text));
  const base = registry(agentRule('- verify: npm test\n- priority: normal\n'), '## R2 — owner rule\n- enforced-by: none\n');
  const same = {
    'title': base.replace('an agent rule', 'a reworded agent rule'),
    'title with the separator characters in it': base.replace('an agent rule', 'a — b – c - d -- e'),
    'why': base.replace('a reason', 'another reason'),
    'verify': base.replace('npm test', 'npm run check'),
    'priority': base.replace('priority: normal', 'priority: high'),
    'a free value re-spaced and reworded (its `- verify:` prefix as written)': base.replace('- verify: npm test', '- verify:    npm run check  '),
    'an empty free value': base.replace('a reason', ''),
  };
  for (const [name, text] of Object.entries(same)) assert.equal(canonical(text), canonical(base), name);
  const changes = {
    'a status line added': base.replace('- approval: agent', '- approval: agent\n- status: superseded'),
    'a last-verified line added': base.replace('- approval: agent', '- approval: agent\n- last-verified: 2026-01-01'),
    'a second why line added': base.replace('- approval: agent', '- approval: agent\n- why: more'),
    'a free line removed': base.replace('- verify: npm test\n', ''),
    'a comment added': base.replace('- approval: agent', '- approval: agent\n<!-- note -->'),
    'prose added': base.replace('- approval: agent', '- approval: agent\n\nsome prose'),
    'a blank line added': base.replace('- approval: agent', '- approval: agent\n'),
    'a pointer re-spaced (covered byte for byte)': base.replace('- pointer: tools', '- pointer:  tools'),
    'an enforced-by re-spaced': base.replace('- enforced-by: officer', '*   Enforced_By :   officer  '),
    'a pointer bullet changed': base.replace('- pointer:', '* pointer:'),
    'the order of lines': base.replace('- enforced-by: officer\n- pointer: tools/officers/a1.mjs\n', '- pointer: tools/officers/a1.mjs\n- enforced-by: officer\n'),
    'the dash before the title': base.replace('## A1 — an agent rule', '## A1 - an agent rule'),
    'the id': base.replace('## A1', '## A2'),
    'a free key prefix respelled': base.replace('- verify:', '- Verify:'),
  };
  for (const [name, text] of Object.entries(changes)) assert.notEqual(canonical(text), canonical(base), name);
});

test('an agent rule with two why lines has both free', () => {
  const canonical = (text) => canonicalRegistry(parseRegistry(text));
  const two = registry(agentRule('- why: second\n'));
  assert.equal(canonical(two.replace('a reason', 'x').replace('second', 'y')), canonical(two));
  assert.notEqual(canonical(two), canonical(registry(agentRule())));
});

const CONSTRUCTS = {
  'an unclosed comment': '<!-- hides the rest',
  'a comment opened as <!-->': '<!-->',
  'a comment closer': 'text -->',
  'a lone carriage return': 'text\r## V9 — fake',
  'a line separator': 'text ## V9 — fake',
  'a paragraph separator': 'text ## V9 — fake',
};

test('a free part holding a comment marker, a carriage return or U+2028/U+2029 is a reported problem at its line', () => {
  for (const [name, construct] of Object.entries(CONSTRUCTS)) {
    for (const [where, text, line] of [
      ['a why value', `## A1 — t\n- why: ${construct}\n- approval: agent\n`, 2],
      ['a verify value', `## A1 — t\n- approval: agent\n- Verify: ${construct}\n`, 3],
      ['a priority value', `# T\n## A1 — t\n- approval: agent\n- priority: ${construct}\n`, 4],
    ]) {
      const parsed = parseRegistry(text);
      assert.deepEqual(parsed.problems, [{ line, text: MINOR_WORDING_PROBLEM }], `${name} in ${where}`);
    }
  }
  for (const construct of ['<!-- hides the rest', '<!-->', 'text -->']) {
    assert.deepEqual(parseRegistry(`## A1 — ${construct}\n- approval: agent\n`).problems, [{ line: 1, text: MINOR_WORDING_PROBLEM }], `${construct} in a title`);
  }
  for (const separator of ['\r', '\u2028', '\u2029']) {
    assert.deepEqual(parseRegistry(`## A1 — text${separator}## V9 — fake\n- approval: agent\n`).problems, [{ line: 1, text: NOT_A_RULE_HEADING }], 'a heading with a CR, U+2028 or U+2029 in it starts no rule');
  }
  assert.equal(MINOR_WORDING_PROBLEM, 'the wording of a rule with "approval: agent" may not contain "<!--", "-->", a control character, a line or paragraph separator, or a zero-width or bidi character.');
});

const CHARACTER_CLASSES = {
  'a backspace': '\b', 'an escape': '\x1b', 'a vertical tab': '\v', 'a form feed': '\f', 'a NUL': '\0', 'a DEL': '\x7f',
  'a NEL': '\u0085', 'a C1 control': '\u009f', 'a zero-width space': '\u200b', 'a right-to-left mark': '\u200f',
  'a bidi override': '\u202e', 'a bidi isolate': '\u2066', 'a word joiner': '\u2060', 'a byte order mark mid-value': '\ufeff',
};

test('a free part holding a control, zero-width or bidi character is a reported problem at its line, in a why value and in a title', () => {
  for (const [name, character] of Object.entries(CHARACTER_CLASSES)) {
    assert.deepEqual(parseRegistry(`## A1 — t\n- why: a${character}b\n- approval: agent\n`).problems, [{ line: 2, text: MINOR_WORDING_PROBLEM }], `${name} in a why value`);
    assert.deepEqual(parseRegistry(`\n## A1 — a${character}b\n- approval: agent\n`).problems, [{ line: 2, text: MINOR_WORDING_PROBLEM }], `${name} in a title`);
  }
  assert.deepEqual(parseRegistry('## A1 — t\x1b[8m\n- why: \b\b\b\b\bstatus: superseded\n- approval: agent\n').problems.map((problem) => problem.line), [1, 2]);
});

test('a tab and ordinary non-ASCII text are allowed in a free part', () => {
  const text = '## A1 — café 日本語 \u{1F600}\n- why:\tcafé 日本語 \u{1F600}\n- verify: naïve\ttext\n- approval: agent\n';
  assert.deepEqual(parseRegistry(text).problems, []);
});

test('the same constructs are no problem in an owner rule or in a line of an agent rule that is not free, and on a new line of an agent rule they change the form', () => {
  const canonical = (text) => canonicalRegistry(parseRegistry(text));
  const base = registry(agentRule());
  for (const [name, construct] of Object.entries(CONSTRUCTS)) {
    assert.deepEqual(parseRegistry(`## O1 — t\n- why: ${construct}\n- approval: owner\n`).problems, [], `${name} in an owner rule`);
    assert.deepEqual(parseRegistry(base.replace('- approval: agent', `- approval: agent\n${construct}`)).problems, [], `${name} on a new line`);
    assert.notEqual(canonical(base.replace('- approval: agent', `- approval: agent\n${construct}`)), canonical(base), `${name} on a new line`);
  }
  const fake = base.replace('- approval: agent', '- approval: agent\n<!-->\n## V9 — fake\n-->');
  assert.notEqual(canonical(fake), canonical(base));
});

test('only a rule with exactly one approval line whose value is agent is an agent rule; every other rule contributes its whole block', () => {
  const canonical = (text) => canonicalRegistry(parseRegistry(text));
  const reworded = (rule) => rule.replace('a reason', 'another reason');
  const owner = {
    'no approval line': agentRule().replace('- approval: agent\n', ''),
    'approval: owner': agentRule().replace('approval: agent', 'approval: owner'),
    'approval twice, both agent': agentRule('- approval: agent\n'),
    'approval: agent then owner': agentRule('- Approval: owner\n'),
    'approval: owner then agent': agentRule().replace('- approval: agent', '- approval: owner\n- approval: agent'),
    'approval in another spelling is the same key': agentRule('- APPROVAL: owner\n'),
    'a value that is not exactly agent': agentRule().replace('approval: agent', 'approval: Agent'),
    'a value with more text': agentRule().replace('approval: agent', 'approval: agent please'),
  };
  for (const [name, rule] of Object.entries(owner)) {
    assert.notEqual(canonical(registry(reworded(rule))), canonical(registry(rule)), name);
  }
  assert.equal(canonical(registry(reworded(agentRule()))), canonical(registry(agentRule())), 'a true agent rule, for contrast');
  const hidden = agentRule().replace('- approval: agent', '<!-- - approval: owner -->\n- approval: agent');
  assert.equal(canonical(registry(reworded(hidden))), canonical(registry(hidden)), 'an approval line inside a comment is not read');
});

test('a rule cannot be confused with another rule, with the preamble, or with a different split of the same bytes', () => {
  const canonical = (text) => canonicalRegistry(parseRegistry(text));
  const a = canonical('## R1 — a\n## R2 — b\n');
  const b = canonical('## R1 — a\n\n## R2 — b\n');
  const c = canonical('x\n## R1 — a\n## R2 — b\n');
  assert.equal(new Set([a, b, c]).size, 3);
  const asOwner = canonical(registry(agentRule().replace('- approval: agent\n', '')));
  const asAgent = canonical(registry(agentRule()));
  assert.notEqual(asOwner, asAgent);
  const forged = '## R1 — a\n- why: x\n';
  assert.notEqual(canonical(forged), canonical('## R1 — a\n- why: x\n\0'));
});
