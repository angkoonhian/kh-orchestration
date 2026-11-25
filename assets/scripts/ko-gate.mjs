// The commit gate's judgement (decision 17, amended after Task 6's review): `judge`, `runGate`
// and every text the gate prints. gate.mjs, the entry the hooks run, calls runGate; tests import
// this file, never gate.mjs, whose main always runs.
//
// STATED LIMIT: git reads the index again after the hook returns. runGate computes the index tree
// a second time just before it allows and refuses a change, but a change made in the instant
// between the gate's exit and git's re-read is not seen by the hook. verify-branch is the remedy:
// the head then has no verdict for its tree.
import { join } from 'node:path';
import { COMMANDS } from './extension.mjs';
import { contractHolds } from './ko-contract.mjs';
import { digestOfTree } from './ko-digest.mjs';
import { GitError, baseOf, currentBranch, filesNotInIndex, indexTree, repoRoot, treeEntry, workingDifferences } from './ko-git.mjs';
import { OFFICERS } from './ko-digest.mjs';
import { officersOfTree } from './ko-officers.mjs';
import { StateError, isOff, readApprovals, readExemptions, stateDir } from './ko-state.mjs';
import { passing, readVerdict } from './ko-verdict.mjs';

const HOOKS = ['pre-commit', 'pre-merge-commit'];
const EXTENSION = '.claude/kh-orchestration/scripts/extension.mjs';
// git file modes of a regular file; a link (120000) or a submodule (160000) is not one.
const FILE_MODES = ['100644', '100755'];
const NAMED_AT_MOST = 10;
// What this session's hooks run from the working directory (amended decision 17): kh-harness's
// files and settings and this plugin's scripts. Their working copies must equal the tree.
const LIVE_PATHS = ['.claude/settings.json', '.claude/kh-harness', '.claude/scripts', '.claude/kh-orchestration/scripts'];
const REASON_SHOWN_AT_MOST = 200;
// C0 and C1 controls, DEL, and the zero-width and bidi characters: what can make a terminal show
// other text than the record holds.
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// An exemption's recorded reason as it is printed: without what a terminal would act on, and cut.
function shownReason(reason) {
  const plain = reason.replace(UNSHOWABLE, '');
  return plain.length > REASON_SHOWN_AT_MOST ? `${plain.slice(0, REASON_SHOWN_AT_MOST - 1)}…` : plain;
}
const shortId = (id) => (id === 'none' ? 'none' : id.slice(0, 12));
// A problem from another module, ended as a sentence once.
const sentence = (text) => `${text.replace(/\.$/, '')}.`;

function namedList(ids) {
  const named = ids.slice(0, NAMED_AT_MOST).join(', ');
  return ids.length > NAMED_AT_MOST ? `${named} and ${ids.length - NAMED_AT_MOST} more` : named;
}

// Every text the gate prints, with values substituted.
export const REASONS = Object.freeze({
  off: 'kh-orchestration is switched off for this repository, so this commit is not checked.',
  exempt: (branch, reason) => `The branch ${branch} is exempt from the commit gate (${reason}), so this commit is not checked.`,
  noInstall: (problem) => `This tree holds no usable kh-orchestration install, so the commit gate refuses it: ${sentence(problem)} Commit with the install in place, or ask the owner to exempt this branch in their own terminal.`,
  noInstallDetached: (problem) => `This tree holds no usable kh-orchestration install, so the commit gate refuses it: ${sentence(problem)} Only a branch can be exempt and HEAD is detached: switch to a branch, then ask the owner to exempt it.`,
  extensionAbsent: `${EXTENSION} is not a file in this tree.`,
  officersAbsent: `${OFFICERS} is not a file in this tree.`,
  officersProblem: (problem) => `The officers file ${OFFICERS} in this tree cannot be used, so the commit gate refuses it: ${sentence(problem)} Fix the file and stage it; the owner approves the change.`,
  liveDiffers: (path) => `The working copy of ${path} differs from this tree, and the working copy is what this session's hooks run. Restore it, or stage it for the owner to approve, then commit again.`,
  liveUntracked: (path) => `${path} is in the working directory but not in this tree, beside the files this session's hooks run. Remove it, or stage it for the owner to approve, then commit again.`,
  contract: (problem) => `kh-harness contract 1 does not hold in this working directory, so the extension that guards the commit gate may not be running: ${sentence(problem)} Repair the install outside Claude Code, then commit again.`,
  undigestable: (problem) => `The protected files of this tree cannot be checked: ${sentence(problem)} Fix it, stage the fix, and run the officers.`,
  unapproved: (digest) => `The protected files of this tree (digest ${digest.slice(0, 12)}) are not approved. The owner reviews and approves them in their own terminal.`,
  noVerdict: (tree, base) => `No verdict is recorded for this tree (${shortId(tree)}) against its base (${shortId(base)}). Run the officers on the staged tree.`,
  digestDiffers: 'The verdict for this tree records other protected files than the tree holds, so it is not trusted. Run the officers again.',
  otherOfficers: 'The verdict for this tree lists other officers than the tree\'s officers file, so it is not trusted. Run the officers again.',
  failing: (ids) => `These officers did not pass on this tree: ${namedList(ids)}. Fix what they report, stage the fix, and run the officers again.`,
  allowed: 'This tree has a passing verdict against its base and its protected files are approved.',
  couldNotDecide: (reason) => `the gate could not decide: ${sentence(reason)} The commit is refused.`,
  notAHook: 'it was not started as the pre-commit or pre-merge-commit hook',
  notARepository: 'the working directory is not inside a git working tree',
  unexpected: 'an unexpected error stopped the check',
  indexChanged: 'The index changed while the gate ran, so the tree git would commit is not the one judged. Run the officers again on the staged tree.',
});

// A word the shell reads as itself: as it is when it holds nothing the shell would act on, else in single quotes.
const shellWord = (text) => (/^[A-Za-z0-9._/@+=,:-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

// The owner's command to exempt `branch`, run with the copy of ko.mjs in bin/: a tree without the
// install has no .claude/kh-orchestration/scripts/ko.mjs to run.
export function exemptCommand(root, branch) {
  const script = join(stateDir(root), 'bin', 'ko.mjs');
  return `node ${shellWord(script)} exempt ${shellWord(branch)} --reason "<why>"`;
}

const allow = (reason) => ({ allow: true, reason, next: '' });
const refuse = (reason, next) => ({ allow: false, reason, next });

// 2. An exemption names a branch exactly; a detached HEAD (branch null) is never exempt.
function exemptionOf(root, branch) {
  if (branch === null) return null;
  return readExemptions(root).find((entry) => entry.name === branch) ?? null;
}

// 3. The install is present in the tree when its officers file is a file there and its extension
// is a regular file there: the officers say what passing means, and the extension is what guards
// the gate in the next session. The rest of the install is covered by the digest, which step 6
// makes the owner's. An officers file that is there but unusable is a problem of that file, not a
// missing install, so it is reported as such and no exemption is offered.
const isFile = (entry) => entry !== null && entry.type === 'blob' && FILE_MODES.includes(entry.mode);
function installOf(root, tree) {
  if (!isFile(treeEntry(root, tree, OFFICERS))) return { absent: REASONS.officersAbsent };
  if (!isFile(treeEntry(root, tree, EXTENSION))) return { absent: REASONS.extensionAbsent };
  const read = officersOfTree(root, tree);
  if (read.problem !== undefined) return { problem: read.problem };
  return { officers: read.officers };
}

// 4b. The live files equal the tree: the contract check reads the working copy, the digest
// approves the tree, and this ties the two together. Refused: a working copy under LIVE_PATHS that
// differs from the tree in bytes or mode, and any file there the index does not hold, untracked or
// ignored. (The index tree is the tree being committed, so "not in the index" is "not in the tree".)
function liveRefusal(root, tree) {
  const differing = workingDifferences(root, tree, LIVE_PATHS)[0];
  if (differing !== undefined) return refuse(REASONS.liveDiffers(differing), `git restore -- ${shellWord(differing)}`);
  const extra = filesNotInIndex(root, LIVE_PATHS)[0];
  if (extra !== undefined) return refuse(REASONS.liveUntracked(extra), `git add -- ${shellWord(extra)}`);
  return null;
}

// 6. Whether the owner approved this digest. Approval is by content: an approval's `branch` is a
// record of where it was given, and a digest approved anywhere is approved on every branch.
const approved = (root, digest) => readApprovals(root).some((entry) => entry.digest === digest);

// 7. The verdict's refusal, or null when it passes. Named: the tree's officers the verdict shows
// no pass or skip for. When there are none and it still does not pass, its list is in another
// order or holds officers the tree does not name.
function verdictRefusal(root, { tree, base }, digest, officers) {
  const verdict = readVerdict(root, tree, base);
  if (verdict === null) return refuse(REASONS.noVerdict(tree, base), COMMANDS.run);
  if (verdict.digest !== digest) return refuse(REASONS.digestDiffers, COMMANDS.run);
  if (passing(verdict, officers)) return null;
  const passed = new Set(verdict.officers.filter((entry) => entry.result === 'pass' || entry.result === 'skipped').map((entry) => entry.id));
  const failed = officers.map((officer) => officer.id).filter((id) => !passed.has(id));
  return refuse(failed.length > 0 ? REASONS.failing(failed) : REASONS.otherOfficers, COMMANDS.run);
}

/**
 * Decision 17's checks, in order, stopping at the first that decides:
 * `{ allow, reason, next }`, `next` the exact command to run ('' on an allow).
 * `tree` is the tree being committed, `base` its base (decision 7) or null
 * when the tree's officers file cannot be read (step 3 then refuses), and
 * `branch` the current branch or null for a detached HEAD. Throws what the
 * state and git helpers throw (a StateError for a damaged approvals or
 * exemptions file): the caller refuses on a throw.
 */
export function judge(root, { tree, base, branch }) {
  if (isOff(root)) return allow(REASONS.off);
  const exemption = exemptionOf(root, branch);
  if (exemption !== null) return allow(REASONS.exempt(branch, shownReason(exemption.reason)));
  const install = installOf(root, tree);
  if (install.absent !== undefined) {
    return branch === null
      ? refuse(REASONS.noInstallDetached(install.absent), 'git switch -c <branch>')
      : refuse(REASONS.noInstall(install.absent), exemptCommand(root, branch));
  }
  if (install.problem !== undefined) return refuse(REASONS.officersProblem(install.problem), COMMANDS.status);
  const holds = contractHolds(root);
  if (!holds.ok) return refuse(REASONS.contract(holds.problems[0]), COMMANDS.status);
  const live = liveRefusal(root, tree);
  if (live !== null) return live;
  const digest = digestOfTree(root, tree);
  if (digest.problem !== undefined) return refuse(REASONS.undigestable(digest.problem), COMMANDS.run);
  if (!approved(root, digest.digest)) return refuse(REASONS.unapproved(digest.digest), COMMANDS.approve);
  return verdictRefusal(root, { tree, base }, digest.digest, install.officers) ?? allow(REASONS.allowed);
}

// The fixed text of a failure: the message of a StateError or a GitError, which is fixed text, and
// for anything else a fixed sentence, since its message is not.
function failureReason(error) {
  return error instanceof StateError || error instanceof GitError ? error.message : REASONS.unexpected;
}

/**
 * The hook's judgement of the index: the tree git is about to commit (a hook's GIT_INDEX_FILE
 * names the index of a partial commit), its base from the tree's own officers file, its branch;
 * then, when judge allows on the checks, the index tree once more, refused if it changed. `args`
 * is the hook name alone. `readTree` reads the index tree; a test passes one that changes the
 * index between the two reads. Never throws: any throw is a refusal with fixed text.
 */
export function runGate(args, cwd, readTree = indexTree) {
  try {
    if (args.length !== 1 || !HOOKS.includes(args[0])) return refuse(REASONS.couldNotDecide(REASONS.notAHook), COMMANDS.status);
    const root = repoRoot(cwd);
    if (root === null) return refuse(REASONS.couldNotDecide(REASONS.notARepository), COMMANDS.status);
    const tree = readTree(root);
    const branch = currentBranch(root);
    const read = officersOfTree(root, tree);
    const base = read.problem === undefined ? baseOf(root, read.baseBranch) : null;
    const decision = judge(root, { tree, base, branch });
    if (decision.reason === REASONS.allowed && readTree(root) !== tree) return refuse(REASONS.indexChanged, COMMANDS.run);
    return decision;
  } catch (error) {
    return refuse(REASONS.couldNotDecide(failureReason(error)), COMMANDS.status);
  }
}
