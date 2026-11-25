// The verdict: the record that every officer ran on one exact tree (decision 5),
// kept in `verdicts/<tree>-<base>.json` under the shared state directory. The
// commit gate relies on it, so it is never trusted past what `readVerdict` checks.
import { agentRuleChanges, digestOfTree } from './ko-digest.mjs';
import { changedPaths } from './ko-git.mjs';
import { runOfficers } from './ko-officers.mjs';
import { StateError, readState, verdictName, writeState } from './ko-state.mjs';

const RESULTS = ['pass', 'fail', 'skipped', 'timeout', 'error'];
const isString = (value) => typeof value === 'string';
const isStringOrNull = (value) => value === null || typeof value === 'string';

const resultHasShape = (entry) => entry !== null && typeof entry === 'object'
  && isString(entry.id) && isStringOrNull(entry.rule) && RESULTS.includes(entry.result)
  && (entry.exitCode === null || Number.isInteger(entry.exitCode)) && typeof entry.seconds === 'number' && isString(entry.output);

/**
 * Runs the officers on a tree and returns `{ verdict }`, or `{ problem }` when
 * the digest cannot be trusted (then no officer is started and there is no
 * verdict). `baseTree` is the tree of `base`, or null when `base` is `none`;
 * `officers` come from `officersOfTree` for the same tree; `waivers` are
 * recorded as given. Throws what `agentRuleChanges` and `changedPaths` throw.
 */
export async function produceVerdict(root, { tree, base, baseTree, branch, officers, waivers, kitVersion }) {
  const digest = digestOfTree(root, tree);
  if (digest.problem !== undefined) return { problem: digest.problem };
  const startedAt = new Date().toISOString();
  const changes = agentRuleChanges(root, baseTree, tree);
  const results = await runOfficers(root, { officers, base, tree, changed: changedPaths(root, base, tree) });
  return {
    verdict: {
      schema: 1, tree, base, branch, digest: digest.digest, officers: results, agentRuleChanges: changes, waivers, startedAt, finishedAt: new Date().toISOString(), kitVersion,
    },
  };
}

// Throws a StateError for a tree or base that is not a full object id (or `none` for the base).
export function writeVerdict(root, verdict) {
  writeState(root, verdictName(verdict.tree, verdict.base), verdict);
}

/**
 * The verdict recorded for a tree and a base, or null. Null when the file is
 * absent, is not JSON, has a schema other than 1, names a tree or base other
 * than its file name, or has the wrong shape. Null is the safe direction for
 * this one file: the gate treats no verdict as a refusal and asks for a new
 * run, whereas a record that cannot be trusted and was believed would let a
 * commit through. Throws a StateError only for a tree or base that cannot be
 * part of a file name.
 */
export function readVerdict(root, tree, base) {
  const name = verdictName(tree, base);
  let verdict;
  try {
    verdict = readState(root, name, null);
  } catch (error) {
    if (error instanceof StateError) return null;
    throw error;
  }
  const valid = verdict !== null && typeof verdict === 'object' && verdict.schema === 1 && verdict.tree === tree && verdict.base === base
    && isStringOrNull(verdict.branch) && isString(verdict.digest) && Array.isArray(verdict.officers) && verdict.officers.every(resultHasShape)
    && Array.isArray(verdict.agentRuleChanges) && Array.isArray(verdict.waivers)
    && isString(verdict.startedAt) && isString(verdict.finishedAt) && isString(verdict.kitVersion);
  return valid ? verdict : null;
}

/**
 * Whether a verdict shows every officer passing. `officers` is the list read from
 * the SAME tree: the verdict's officer ids must equal its ids in order, and every
 * result must be `pass` or `skipped`. A repository with no officers passes.
 */
export function passing(verdict, officers) {
  return verdict.officers.length === officers.length
    && verdict.officers.every((entry, index) => entry.id === officers[index].id && (entry.result === 'pass' || entry.result === 'skipped'));
}
