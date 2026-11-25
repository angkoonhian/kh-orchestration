// Reader for a repository's rules registry, docs/harness/RULES.md. Written from
// the registry section of kh-harness's contract 1, not copied from kh-harness:
// the approval digest depends on exactly which text this reads as a rule.

export const NOT_A_RULE_HEADING = 'this level-2 heading is not "## <id> <separator> <rule>", so it starts no rule.';
export const MINOR_WORDING_PROBLEM = 'the wording of a rule with "approval: agent" may not contain "<!--", "-->", a carriage return, U+2028 or U+2029.';
export const duplicateIdMessage = (id) => `the id ${id} is already used by an earlier rule, so this rule is ignored.`;

// A level-2 heading is a line starting `## ` (or any white space) or `##` alone.
const LEVEL_TWO = /^##(\s|$)/;
// `## <id> <separator> <rule>`: the separator is a run of em dashes, en dashes
// or hyphens with white space on both sides, or white space alone.
const RULE_HEADING = /^##\s+([A-Za-z][\w.-]*)(?:\s+[—–-]+\s+|\s+)(\S.*)$/;
const KEY_LINE = /^\s*[-*]\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/;
const COMMENT = /<!--[\s\S]*?-->/g;
// The start of a key line, for finding where a free value begins.
const KEY_START = /^\s*[-*]\s*([A-Za-z][\w-]*)\s*:/;
const FREE_KEYS = new Set(['why', 'verify', 'priority']);
// Text that can change what a person or a model reading the raw file takes the rules to be.
const UNSAFE_WORDING = /<!--|-->|\r|\u2028|\u2029/;

const toLf = (text) => text.replace(/\r\n/g, '\n');

// Keys are matched without regard to case, `-` or `_`.
const normalKey = (key) => key.toLowerCase().replace(/[-_]/g, '');

// The lines that are read: every HTML comment blanked down to its newlines, so
// a line number stays the line number of the text.
const readableLines = (lf) => lf.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, '')).split('\n');

// The `key: value` bullets of some LF text, in order, as [normalised key, trimmed value].
function keyEntries(lf) {
  return readableLines(lf).flatMap((line) => {
    const match = line.match(KEY_LINE);
    return match ? [[normalKey(match[1]), match[2].trim()]] : [];
  });
}

/**
 * Reads registry text. Line endings are normalised to LF first; nothing else is
 * changed, so `preamble` and every `block`, joined in order, are the input.
 * A rule starts at a heading that matches the contract and runs to the next
 * such heading, so the lines of a heading that starts no rule, or of a repeated
 * id, stay in the block before them. `keys` holds the last value of each key
 * (keys named by `normalKey`); a key line sits in the rule above it only.
 * `startLine` and each problem's `line` are 1-based.
 */
export function parseRegistry(text) {
  const lf = toLf(text);
  const lines = readableLines(lf);
  const lineStarts = [];
  let offset = 0;
  for (const line of lf.split('\n')) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const problems = [];
  const seen = new Set();
  const rules = [];
  let current = null; // the rule whose key lines are being read, or null under a heading that starts none
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (LEVEL_TWO.test(line)) {
      current = null;
      const match = line.match(RULE_HEADING);
      if (!match) {
        problems.push({ line: index + 1, text: NOT_A_RULE_HEADING });
      } else if (seen.has(match[1])) {
        problems.push({ line: index + 1, text: duplicateIdMessage(match[1]) });
      } else {
        seen.add(match[1]);
        current = { id: match[1], title: match[2].trim(), startIndex: index, keys: {}, startLine: index + 1 };
        rules.push(current);
      }
      continue;
    }
    const key = current && line.match(KEY_LINE);
    if (key) current.keys[normalKey(key[1])] = key[2].trim();
  }
  const blockStart = (rule) => lineStarts[rule.startIndex];
  const built = rules.map((rule, position) => ({
    id: rule.id,
    title: rule.title,
    block: lf.slice(blockStart(rule), position + 1 < rules.length ? blockStart(rules[position + 1]) : lf.length),
    keys: rule.keys,
    startLine: rule.startLine,
  }));
  for (const rule of built) {
    if (!isAgentRule(keyEntries(rule.block))) continue;
    for (const part of freeParts(rule.block)) {
      if (UNSAFE_WORDING.test(rule.block.slice(part.start, part.end))) problems.push({ line: rule.startLine + part.line, text: MINOR_WORDING_PROBLEM });
    }
  }
  problems.sort((a, b) => a.line - b.line);
  return { preamble: lf.slice(0, rules.length ? blockStart(rules[0]) : lf.length), rules: built, problems };
}

// A rule that owner approval need not cover: exactly one `approval` line, whose
// value is exactly `agent`. Read from the block, so a repeated key is seen.
function isAgentRule(entries) {
  const approvals = entries.filter(([key]) => key === 'approval');
  return approvals.length === 1 && approvals[0][1] === 'agent';
}

// The free parts of an agent rule's block, as { line (0-based in the block), start, end }
// offsets into it: the title (after the id and its separator) and everything after the
// colon of each `why`, `verify` and `priority` line. A line a comment touches is not free,
// so what it hides stays covered.
function freeParts(block) {
  const raw = block.split('\n');
  const read = readableLines(block);
  const parts = [];
  let offset = 0;
  raw.forEach((line, index) => {
    const untouched = line === read[index];
    const lineEnd = offset + line.length;
    if (untouched && index === 0) {
      const heading = line.match(RULE_HEADING);
      if (heading) parts.push({ line: 0, start: lineEnd - heading[2].length, end: lineEnd });
    } else if (untouched) {
      const key = line.match(KEY_START);
      if (key && FREE_KEYS.has(normalKey(key[1]))) parts.push({ line: index, start: offset + key[0].length, end: lineEnd });
    }
    offset = lineEnd + 1;
  });
  return parts;
}

// The block with each free part removed.
function withoutFreeParts(block) {
  let kept = '';
  let from = 0;
  for (const part of freeParts(block)) {
    kept += block.slice(from, part.start);
    from = part.end;
  }
  return kept + block.slice(from);
}

// Canonical encoding: a sequence of sections, each `tag NUL length NUL payload
// NUL`, where length is the payload's length in UTF-16 units. The length makes
// the end of every payload certain, so no payload can pass for a section
// boundary, and a section's tag says what it is. Sections:
//   `preamble`: the preamble, whole.
//   `block`: a rule that is not an agent rule, its block byte for byte.
//   `agent`: an agent rule (decision 12). Its payload is the sections `id` and
//   `rest`, where `rest` is the block with its free parts cut out: the title,
//   and the value of each `why`, `verify` and `priority` line (the text after
//   its colon). Everything else is covered byte for byte, so adding, removing,
//   reordering or re-spacing any line, a `pointer`, `enforced-by` or `status`
//   line, a comment or prose, changes the form.
const section = (tag, payload) => `${tag}\0${payload.length}\0${payload}\0`;

/**
 * The text whose hash stands for the registry (decision 12). It does not check
 * `problems`: a caller that finds one refuses before it hashes.
 */
export function canonicalRegistry(parsed) {
  const sections = [section('preamble', parsed.preamble)];
  for (const rule of parsed.rules) {
    sections.push(isAgentRule(keyEntries(rule.block))
      ? section('agent', section('id', rule.id) + section('rest', withoutFreeParts(rule.block)))
      : section('block', rule.block));
  }
  return sections.join('');
}
