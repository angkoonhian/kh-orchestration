// Test-only helper: the ways a source file can reach another file. The hook
// extension must import `node:` built-ins only, so a test asserts that this
// finds nothing in it. The check reads the text, comments and strings
// included, so it errs toward finding too much: a comment that looks like an
// import is a finding, and the fix is to reword it.

const NODE_LITERAL = /^\s*(['"])node:[^'"`\n]*\1\s*[,)]/;

// The source with block and line comments blanked out. Strings and template literals are
// copied whole, so a `//` inside one is not a comment and hides nothing after it. A regular
// expression literal holding a quote can fool this; the text kept then is the more, never the less.
function withoutComments(source) {
  let out = '';
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    if (pair === '/*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      out += ' ';
    } else if (pair === '//') {
      while (index < source.length && source[index] !== '\n') index++;
    } else if (char === '"' || char === "'" || char === '`') {
      let end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
      out += source.slice(index, end + 1);
      index = end + 1;
    } else {
      out += char;
      index++;
    }
  }
  return out;
}

// Each finding is a short fixed description; an empty list means self-contained.
export function reachesOtherFiles(sourceText) {
  const source = withoutComments(sourceText);
  const findings = [];
  for (const match of source.matchAll(/\b(?:import|export)\b[^;]*?\bfrom\s*(['"])(.*?)\1/gs)) {
    if (!match[2].startsWith('node:')) findings.push(`a static import or re-export of ${match[2]}`);
  }
  for (const match of source.matchAll(/\bimport\s*(['"])(.*?)\1/g)) {
    if (!match[2].startsWith('node:')) findings.push(`a bare import of ${match[2]}`);
  }
  for (const match of source.matchAll(/\bimport\s*\(/g)) {
    if (!NODE_LITERAL.test(source.slice(match.index + match[0].length))) findings.push('a dynamic import whose argument is not a node: string literal');
  }
  if (/\bcreateRequire\b/.test(source)) findings.push('createRequire');
  if (/\brequire\s*\(/.test(source)) findings.push('require(');
  return findings;
}
