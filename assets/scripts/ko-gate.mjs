// The commit gate's judgement (decision 17, amended after Task 6's review): `judge`, `runGate`
// and every text the gate prints. gate.mjs, the entry the hooks run, calls runGate; tests import
// this file, never gate.mjs, whose main always runs.
//
// The index race (decision 18, further amended). git reads the index again after pre-commit
// returns, so a change made while or just after the gate runs could be committed unjudged. runGate
// reads the index tree a second time before it allows, and on an allow records the tree for the git
// process that started the hook (inflight-<pid>.json). The reference-transaction hook then runs the
// gate in the `prepared` state of that process's ref update, and the update is refused unless every
// branch or HEAD it moves names a commit of exactly that tree. Where that hook is installed the race
// is closed. Where it is not (missing, not executable, or not ours), git skips it, and a change in
// the instant between the gate's exit and git's re-read remains a STATED LIMIT, with verify-branch
// as the remedy: the head then has no verdict for its tree.
import { join } from 'node:path';
import { COMMANDS } from './extension.mjs';
import { contractHolds } from './ko-contract.mjs';
import { digestOfTree } from './ko-digest.mjs';
import { readFileSync } from 'node:fs';
import { GitError, baseOf, currentBranch, filesNotInIndex, indexTree, repoRoot, stagedDifferences, treeEntry, treeOfCommitId, workingDifferences } from './ko-git.mjs';
import { OFFICERS } from './ko-digest.mjs';
import { officersOfTree } from './ko-officers.mjs';
import { StateError, isOff, readApprovals, readExemptions, readInflight, removeInflight, removeStaleInflight, stateDir, writeInflight } from './ko-state.mjs';
import { passing, readVerdict } from './ko-verdict.mjs';

const COMMIT_HOOKS = ['pre-commit', 'pre-merge-commit'];
const REFERENCE_HOOK = 'reference-transaction';
const PID = /^[1-9][0-9]{0,9}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NULL_ID = /^(?:0{40}|0{64})$/;
const TOKEN = /^\S+$/;
// A symbolic ref's value as the hook is given it: `ref:refs/heads/main`.
const SYMBOLIC = /^ref:\S+$/;
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
  liveDiffers: (path) => `The working copy of ${path} differs from the tree being committed, and the working copy is what this session's hooks run. Stage it for the owner to approve, or restore it as below, then commit again.`,
  liveStagedElsewhere: (path) => `${path} is staged with a change this partial commit leaves out, so its working copy, which this session's hooks run, differs from the tree being committed. Commit without a path list, or restore it, then commit again.`,
  liveUntracked: (path) => `${path} is in the working directory beside the files this session's hooks run but is not in the tree being committed (an editor's swap file or a .DS_Store looks like this too). Remove it as below, or add it and have the owner approve it, then commit again.`,
  contract: (problem) => `kh-harness contract 1 does not hold in this working directory, so the extension that guards the commit gate may not be running: ${sentence(problem)} Repair the install outside Claude Code, then commit again.`,
  undigestable: (problem) => `The protected files of this tree cannot be checked: ${sentence(problem)} Fix it, stage the fix, and run the officers.`,
  unapproved: (digest) => `The protected files of this tree (digest ${digest.slice(0, 12)}) are not approved. The owner reviews and approves them in their own terminal.`,
  noVerdict: (tree, base) => `No verdict is recorded for this tree (${shortId(tree)}) against its base (${shortId(base)}). Run the officers on the staged tree.`,
  digestDiffers: 'The verdict for this tree records other protected files than the tree holds, so it is not trusted. Run the officers again.',
  otherOfficers: 'The verdict for this tree lists other officers than the tree\'s officers file, so it is not trusted. Run the officers again.',
  failing: (ids) => `These officers did not pass on this tree: ${namedList(ids)}. Fix what they report, stage the fix, and run the officers again.`,
  allowed: 'This tree has a passing verdict against its base and its protected files are approved.',
  couldNotDecide: (reason) => `the gate could not decide: ${sentence(reason)} The commit is refused.`,
  notAHook: 'it was not started as the pre-commit, pre-merge-commit or reference-transaction hook with the id of the git process',
  updateAllowed: 'The branch update holds the tree the gate allowed.',
  treeSwapped: 'The tree being committed is not the tree the gate allowed for this git process. Run the command again; if this was a commit, stage what you mean to commit and run the officers first.',
  noRecord: 'No record of the tree the gate allowed is kept for this git process, so its branch update cannot be checked. Run the officers on the staged tree and commit again.',
  unreadableUpdates: 'the reference updates git sent the hook cannot be read',
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

// 4. The live files equal the tree: the contract check reads the working copy, the digest
// approves the tree, and this ties the two together. Refused: a working copy under LIVE_PATHS that
// differs from the tree in bytes or mode, and any file there the index does not hold, untracked or
// ignored. (The index tree is the tree being committed, so "not in the index" is "not in the tree".)
function liveRefusal(root, tree) {
  const differing = workingDifferences(root, tree, LIVE_PATHS)[0];
  if (differing !== undefined) {
    // Staged in the repository's own index but left out of this tree: a partial commit (`git commit
    // <path>`) while a live file has a staged change. Restoring the working copy would lose it.
    if (stagedDifferences(root, tree, [differing]).length > 0) return refuse(REASONS.liveStagedElsewhere(differing), 'git commit');
    return refuse(REASONS.liveDiffers(differing), `git restore -- ${shellWord(differing)}`);
  }
  const extra = filesNotInIndex(root, LIVE_PATHS)[0];
  if (extra !== undefined) return refuse(REASONS.liveUntracked(extra), `rm -- ${shellWord(extra)}`);
  return null;
}

// 6. Whether the owner approved this digest. Approval is by content: an approval's `branch` is a
// record of where it was given, and a digest approved anywhere is approved on every branch.
const approved = (root, digest) => readApprovals(root).some((entry) => entry.digest === digest);

// 8. The verdict's refusal, or null when it passes; `verdict` is the copy read before the probe. Named: the tree's officers the verdict shows
// no pass or skip for. When there are none and it still does not pass, its list is in another
// order or holds officers the tree does not name.
function verdictRefusal(verdict, { tree, base }, digest, officers) {
  if (verdict === null) return refuse(REASONS.noVerdict(tree, base), COMMANDS.run);
  if (verdict.digest !== digest) return refuse(REASONS.digestDiffers, COMMANDS.run);
  if (passing(verdict, officers)) return null;
  const passed = new Set(verdict.officers.filter((entry) => entry.result === 'pass' || entry.result === 'skipped').map((entry) => entry.id));
  const failed = officers.map((officer) => officer.id).filter((id) => !passed.has(id));
  return refuse(failed.length > 0 ? REASONS.failing(failed) : REASONS.otherOfficers, COMMANDS.run);
}

/**
 * Decision 17's checks in their final order (after Task 6's re-review), stopping at the first that
 * decides: `{ allow, reason, next }`, `next` the exact command to run ('' on an allow). Nothing from
 * the repository is EXECUTED before the owner's approval of those exact bytes is established:
 *   1 off switch, 2 exempt branch, 3 install in the tree, 4 live files equal the tree,
 *   5 RULES.md and the digest, 6 digest approved, 7 contract 1 (checkContract1, then the probe,
 *   the first step that runs repository code), 8 a passing verdict for this tree and base.
 * runGate then adds 9 (the index tree unchanged) and 10 (the in-flight record, then the token).
 * The approvals and the verdict are read into memory BEFORE the probe runs, and judged on those
 * copies: the probe starts the repository's entry script, and nothing its process writes to the
 * shared state may change the outcome.
 * `tree` is the tree being committed, `base` its base (decision 7) or null when the tree's
 * officers file cannot be read (step 3 then refuses), and `branch` the current branch or null for
 * a detached HEAD. Throws what the state and git helpers throw (a StateError for a damaged state
 * file): the caller refuses on a throw.
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
  const live = liveRefusal(root, tree);
  if (live !== null) return live;
  const digest = digestOfTree(root, tree);
  if (digest.problem !== undefined) return refuse(REASONS.undigestable(digest.problem), COMMANDS.run);
  if (!approved(root, digest.digest)) return refuse(REASONS.unapproved(digest.digest), COMMANDS.approve);
  const verdict = readVerdict(root, tree, base);
  const holds = contractHolds(root);
  if (!holds.ok) return refuse(REASONS.contract(holds.problems[0]), COMMANDS.status);
  return verdictRefusal(verdict, { tree, base }, digest.digest, install.officers) ?? allow(REASONS.allowed);
}

// The fixed text of a failure: the message of a StateError or a GitError, which is fixed text, and
// for anything else a fixed sentence, since its message is not.
function failureReason(error) {
  return error instanceof StateError || error instanceof GitError ? error.message : REASONS.unexpected;
}

// The hook's judgement of the index: the tree git is about to commit (a hook's GIT_INDEX_FILE
// names the index of a partial commit), its base from the tree's own officers file, its branch;
// then, when judge allows on the checks, the index tree once more, refused if it changed, and the
// tree recorded for git process `pid`. Any earlier record of `pid` is removed first, so a reused
// process id never inherits one; the off switch and an exemption judge no tree and record none.
function judgeIndex(root, pid, readTree) {
  removeInflight(root, pid);
  const tree = readTree(root);
  const branch = currentBranch(root);
  const read = officersOfTree(root, tree);
  const base = read.problem === undefined ? baseOf(root, read.baseBranch) : null;
  const decision = judge(root, { tree, base, branch });
  if (decision.reason !== REASONS.allowed) return decision;
  if (readTree(root) !== tree) return refuse(REASONS.indexChanged, COMMANDS.run);
  writeInflight(root, pid, tree);
  return decision;
}

// The updates of one reference transaction, `<old> <new> <ref>` per line, each value an object id
// or a symbolic `ref:<name>`, or null when a line is not of that form.
function parseUpdates(input) {
  const updates = [];
  for (const line of input.split('\n').filter((text) => text !== '')) {
    const parts = line.split(' ');
    if (parts.length !== 3 || !parts.slice(0, 2).every((value) => OBJECT_ID.test(value) || SYMBOLIC.test(value)) || !TOKEN.test(parts[2])) return null;
    updates.push({ next: parts[1], ref: parts[2] });
  }
  return updates;
}

// Whether a branch or HEAD update keeps to the recorded tree: a deletion (the null id) is not a
// commit and passes; anything else must be a commit whose tree is `tree`. A symbolic update
// (`ref:refs/heads/x`) or any non-commit is refused.
function keepsTree(root, update, tree) {
  if (update.ref !== 'HEAD' && !update.ref.startsWith('refs/heads/')) return true;
  if (NULL_ID.test(update.next)) return true;
  return OBJECT_ID.test(update.next) && treeOfCommitId(root, update.next) === tree;
}

// The reference-transaction hook's judgement, in the `prepared` state of git process `pid`'s
// update: allowed only when every branch or HEAD it moves names a commit of the recorded tree.
// Other refs (ORIG_HEAD, AUTO_MERGE, tags, remotes) are not judged. A refusal removes the record.
function judgeUpdate(root, pid, input) {
  let tree;
  try {
    tree = readInflight(root, pid);
  } catch (error) {
    // A record that is not a readable file (a directory, a dangling symlink) is never "no record".
    removeInflight(root, pid);
    throw error;
  }
  if (tree === null) return refuse(REASONS.noRecord, COMMANDS.run);
  const updates = parseUpdates(input);
  const decision = updates === null
    ? refuse(REASONS.couldNotDecide(REASONS.unreadableUpdates), COMMANDS.status)
    : updates.every((update) => keepsTree(root, update, tree)) ? allow(REASONS.updateAllowed) : refuse(REASONS.treeSwapped, COMMANDS.run);
  if (!decision.allow) removeInflight(root, pid);
  return decision;
}

/**
 * The gate as a hook runs it: `args` is the hook name and the id of the git process that started
 * the hook (`$PPID`). `pre-commit` and `pre-merge-commit` judge the index; `reference-transaction`
 * judges the updates on standard input against the tree recorded for that process. `readTree`
 * reads the index tree and `input` replaces standard input; tests pass them. Never throws: any
 * throw is a refusal with fixed text.
 */
export function runGate(args, cwd, { readTree = indexTree, input } = {}) {
  try {
    const [hook, pid] = args;
    if (args.length !== 2 || ![...COMMIT_HOOKS, REFERENCE_HOOK].includes(hook) || !PID.test(pid)) {
      return refuse(REASONS.couldNotDecide(REASONS.notAHook), COMMANDS.status);
    }
    const root = repoRoot(cwd);
    if (root === null) return refuse(REASONS.couldNotDecide(REASONS.notARepository), COMMANDS.status);
    // Records left by git processes that ended before their branch update (a failing commit-msg
    // hook, an empty message, nothing to commit) are removed on every run.
    removeStaleInflight(root);
    if (hook === REFERENCE_HOOK) return judgeUpdate(root, pid, input ?? readFileSync(0, 'utf8'));
    return judgeIndex(root, pid, readTree);
  } catch (error) {
    return refuse(REASONS.couldNotDecide(failureReason(error)), COMMANDS.status);
  }
}
