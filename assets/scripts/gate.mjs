// The commit gate: the script git's pre-commit and pre-merge-commit hooks run
// (decision 18), from the copy in <git-common-dir>/kh-orchestration/bin/, so it
// never depends on the files of the tree being committed. It is the final
// authority: a commit goes ahead only when `judge` allows it, and any failure
// of the gate itself is a refusal with fixed text, never a pass.
//
// The siblings are imported dynamically so that one missing from bin/ is a
// refusal with this file's own text; only node: built-ins are imported here.
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOOKS = ['pre-commit', 'pre-merge-commit'];
const EXTENSION = '.claude/kh-orchestration/scripts/extension.mjs';
// git file modes of a regular file; a link (120000) or a submodule (160000) is not one.
const FILE_MODES = ['100644', '100755'];
const NAMED_AT_MOST = 10;
const BIN = dirname(fileURLToPath(import.meta.url));
// COMMANDS.approve of extension.mjs, for the one refusal made when that table could not be loaded:
// approve refreshes bin/ from the approved tree (decision 19). A test holds the two equal.
export const REFRESH_COMMAND = 'node .claude/kh-orchestration/scripts/ko.mjs approve';

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
  contract: (problem) => `kh-harness contract 1 does not hold in this working directory, so the extension that guards the commit gate may not be running: ${sentence(problem)} Repair the install outside Claude Code, then commit again.`,
  undigestable: (problem) => `The protected files of this tree cannot be checked: ${sentence(problem)} Fix it, stage the fix, and run the officers.`,
  unapproved: (digest) => `The protected files of this tree (digest ${digest.slice(0, 12)}) are not approved. The owner reviews and approves them in their own terminal.`,
  noVerdict: (tree, base) => `No verdict is recorded for this tree (${shortId(tree)}) against its base (${shortId(base)}). Run the officers on the staged tree.`,
  digestDiffers: 'The verdict for this tree records other protected files than the tree holds, so it is not trusted. Run the officers again.',
  otherOfficers: 'The verdict for this tree lists other officers than the tree\'s officers file, so it is not trusted. Run the officers again.',
  failing: (ids) => `These officers did not pass on this tree: ${namedList(ids)}. Fix what they report, stage the fix, and run the officers again.`,
  allowed: 'This tree has a passing verdict against its base and its protected files are approved.',
  couldNotDecide: (reason) => `the gate could not decide: ${sentence(reason)} The commit is refused.`,
  siblingMissing: (bin) => `a script beside the gate in ${bin} is missing or cannot be loaded; the owner's approve copies them there again from the approved tree`,
  notAHook: 'it was not started as the pre-commit or pre-merge-commit hook',
  notARepository: 'the working directory is not inside a git working tree',
  unexpected: 'an unexpected error stopped the check',
});

let ko = null;
try {
  const [git, state, digest, officers, verdict, contract, extension] = await Promise.all([
    import('./ko-git.mjs'), import('./ko-state.mjs'), import('./ko-digest.mjs'), import('./ko-officers.mjs'),
    import('./ko-verdict.mjs'), import('./ko-contract.mjs'), import('./extension.mjs'),
  ]);
  ko = { git, state, digest, officers, verdict, contract, extension };
} catch {
  // ko stays null: main refuses with REASONS.siblingMissing, judge throws.
}

function loaded() {
  if (ko === null) throw new Error(REASONS.siblingMissing(BIN));
  return ko;
}

// A word the shell reads as itself: as it is when it holds nothing the shell would act on, else in single quotes.
const shellWord = (text) => (/^[A-Za-z0-9._/@+=,:-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`);

// The owner's command to exempt `branch`, run with the copy of ko.mjs in bin/: a tree without the
// install has no .claude/kh-orchestration/scripts/ko.mjs to run.
export function exemptCommand(root, branch) {
  const script = join(loaded().state.stateDir(root), 'bin', 'ko.mjs');
  return `node ${shellWord(script)} exempt ${shellWord(branch)} --reason "<why>"`;
}

const allow = (reason) => ({ allow: true, reason, next: '' });
const refuse = (reason, next) => ({ allow: false, reason, next });

// 2. An exemption names a branch exactly; a detached HEAD (branch null) is never exempt.
function exemptionOf(root, branch) {
  if (branch === null) return null;
  return loaded().state.readExemptions(root).find((entry) => entry.name === branch) ?? null;
}

// 3. The install is present in the tree when its officers file can be used and its extension is a
// file there: the officers say what passing means, and the extension is what guards the gate in
// the next session. The rest of the install is covered by the digest, which step 6 makes the owner's.
function installOf(root, tree) {
  const { officers, git } = loaded();
  const read = officers.officersOfTree(root, tree);
  if (read.problem !== undefined) return { problem: read.problem };
  const entry = git.treeEntry(root, tree, EXTENSION);
  if (entry === null || entry.type !== 'blob' || !FILE_MODES.includes(entry.mode)) return { problem: REASONS.extensionAbsent };
  return { officers: read.officers };
}

// 6. Whether the owner approved this digest.
const approved = (root, digest) => loaded().state.readApprovals(root).some((entry) => entry.digest === digest);

// 7. The verdict's refusal, or null when it passes. Named: the tree's officers the verdict shows
// no pass or skip for. When there are none and it still does not pass, its list is in another
// order or holds officers the tree does not name.
function verdictRefusal(root, { tree, base }, digest, officers) {
  const { verdict: verdicts, extension } = loaded();
  const verdict = verdicts.readVerdict(root, tree, base);
  if (verdict === null) return refuse(REASONS.noVerdict(tree, base), extension.COMMANDS.run);
  if (verdict.digest !== digest) return refuse(REASONS.digestDiffers, extension.COMMANDS.run);
  if (verdicts.passing(verdict, officers)) return null;
  const passed = new Set(verdict.officers.filter((entry) => entry.result === 'pass' || entry.result === 'skipped').map((entry) => entry.id));
  const failed = officers.map((officer) => officer.id).filter((id) => !passed.has(id));
  return refuse(failed.length > 0 ? REASONS.failing(failed) : REASONS.otherOfficers, extension.COMMANDS.run);
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
  const { state, contract, digest: digests, extension } = loaded();
  const { COMMANDS } = extension;
  if (state.isOff(root)) return allow(REASONS.off);
  const exemption = exemptionOf(root, branch);
  if (exemption !== null) return allow(REASONS.exempt(branch, exemption.reason));
  const install = installOf(root, tree);
  if (install.problem !== undefined) {
    return branch === null
      ? refuse(REASONS.noInstallDetached(install.problem), 'git switch -c <branch>')
      : refuse(REASONS.noInstall(install.problem), exemptCommand(root, branch));
  }
  const holds = contract.contractHolds(root);
  if (!holds.ok) return refuse(REASONS.contract(holds.problems[0]), COMMANDS.status);
  const digest = digests.digestOfTree(root, tree);
  if (digest.problem !== undefined) return refuse(REASONS.undigestable(digest.problem), COMMANDS.run);
  if (!approved(root, digest.digest)) return refuse(REASONS.unapproved(digest.digest), COMMANDS.approve);
  return verdictRefusal(root, { tree, base }, digest.digest, install.officers) ?? allow(REASONS.allowed);
}

// The fixed text of a failure: the message of a StateError or a GitError, which is fixed text, and
// for anything else a fixed sentence, since its message is not.
function failureReason(error) {
  return error instanceof ko.state.StateError || error instanceof ko.git.GitError ? error.message : REASONS.unexpected;
}

// The hook's judgement of the index: the tree git is about to commit (a hook's GIT_INDEX_FILE
// names the index of a partial commit), its base from the tree's own officers file, its branch.
function decide(args) {
  const { git, officers } = ko;
  if (args.length !== 1 || !HOOKS.includes(args[0])) return refuse(REASONS.couldNotDecide(REASONS.notAHook), ko.extension.COMMANDS.status);
  const root = git.repoRoot(process.cwd());
  if (root === null) return refuse(REASONS.couldNotDecide(REASONS.notARepository), ko.extension.COMMANDS.status);
  const tree = git.indexTree(root);
  const branch = git.currentBranch(root);
  const read = officers.officersOfTree(root, tree);
  const base = read.problem === undefined ? git.baseOf(root, read.baseBranch) : null;
  return judge(root, { tree, base, branch });
}

// The one handler: any throw is a refusal with fixed text, so the gate never passes because it failed.
function main(args) {
  let decision;
  if (ko === null) {
    decision = refuse(REASONS.couldNotDecide(REASONS.siblingMissing(BIN)), REFRESH_COMMAND);
  } else {
    try {
      decision = decide(args);
    } catch (error) {
      decision = refuse(REASONS.couldNotDecide(failureReason(error)), ko.extension.COMMANDS.status);
    }
  }
  if (!decision.allow) {
    process.stderr.write(`kh-orchestration: ${decision.reason}\nNext: ${decision.next}\n`);
    process.exitCode = 1;
  } else if (decision.reason !== REASONS.allowed) {
    process.stderr.write(`kh-orchestration: ${decision.reason}\n`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
