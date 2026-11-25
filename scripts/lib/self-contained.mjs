// Test-only helper: the ways a source file can reach another file. The hook
// extension must import `node:` built-ins only, so a test asserts that this
// finds nothing in it. The check reads the text, comments and strings
// included, so it errs toward finding too much: a comment that looks like an
// import is a finding, and the fix is to reword it.

const NODE_LITERAL = /^\s*(['"])node:[^'"`\n]*\1\s*[,)]/;

// Each finding is a short fixed description; an empty list means self-contained.
export function reachesOtherFiles(source) {
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
