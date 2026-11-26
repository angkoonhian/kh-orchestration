// The command line (Task 7): every command of ko.mjs, the one command people and agents type.
// ko.mjs is the entry and calls `main`; this file runs nothing when imported, so tests and the
// session brief (Task 10, which calls `statusOf`) can import it.
//
// Agents run `run`, `status`, `verify-branch` and `unexempt` (which only tightens), from the
// working copy. The owner alone runs `approve`, `propose`, `waive`, `exempt`, `off` and `on`:
// - each refuses, before doing anything else, when CLAUDECODE or CLAUDE_CODE_SESSION_ID is set in
//   this process's environment (decision 13); no argument can say otherwise;
// - each acts only when this file is the copy in <git-common-dir>/kh-orchestration/bin/, the one
//   refreshed from the approved tree in the guarded directory (after Task 7's review): an unstaged
//   edit to the working copy's scripts must never run with the owner's authority.
// That guards against a skipped step, not against an agent set on cheating.
//
// status and verify-branch --no-run execute nothing from the repository: contract 1 is judged by
// checkContract1 alone, without the probe.
//
// Exit codes: 0 done, 1 refused or failing, 2 usage. Every message is fixed text with values
// substituted (TEXT below), and names the next command: an agent's from the one COMMANDS table,
// an owner's through ko-state's ownerCommand. A refusal goes to standard error as
// `kh-orchestration: <reason>` and `Next: <command>`; a report goes to standard output. Any throw
// is caught in `main` and printed as fixed text.
//
// The state files are read, changed and written with no lock: each owner command keeps its read
// and its write adjacent, and two owner commands at once may still lose one update.
import { accessSync, constants, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMANDS, shellWord } from './extension.mjs';
import { STAMP, contractHolds, ownEntry } from './ko-contract.mjs';
import { agentRuleChanges, digestOfTree, hashesTo } from './ko-digest.mjs';
import { REASONS, baseDigestOf, exemptionOf, installOf, judge, liveFilesRefusal, plainText, readNoFollow, shownText, visible } from './ko-gate.mjs';
import {
  GitError, baseOf, changedPaths, commonDir, currentBranch, git, gitFailedMessage, headBaseOf, headCommit, headTree, hiddenEntries, indexTree, isPinned, listEntries, pinTree, repoRoot, tidy, treeOfCommit, unpinTree,
} from './ko-git.mjs';
import { HOOK_NAMES, hookParts, hookText, hostedParts } from './ko-hooks.mjs';
import { officersOfTree } from './ko-officers.mjs';
import {
  RULE_ID, StateError, appendJournal, approvalStanding, binEntriesOf, isOff, listInflight, ownerCommand, readAccepted, readApprovals, readExemptions, readProposals, readWaivers,
  refreshBin, removeStaleInflight, stateDir, switchOff, switchOn, verdictName, writeState,
} from './ko-state.mjs';
import { passing, produceVerdict, readVerdict, writeVerdict } from './ko-verdict.mjs';
import { checkContract1 } from './verify-contract-1.mjs';

// The variables a Claude Code session sets (decision 13): an owner's command refuses while either is
// set. The installer's writing runs (apply --yes, uninstall --yes) read the same list.
export const OWNER_VARIABLES = Object.freeze(['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID']);
const NAMED_AT_MOST = 10;
const OUTPUT_LINES = 10;
const MAX_REASON = 500;
const MIN_GIT = [2, 30];
const REFERENCE_HOOK = 'reference-transaction';
const CONTRACT_FILE = '.claude/kh-harness/contract.json';
const HARNESS_LOG = '.claude/scripts/harness-log.mjs';
const SCRIPTS = '.claude/kh-orchestration/scripts';
// What recordExternalEvent needs listed in the contract file (CONTRACT.md, step 2): the log, and
// the seal that expires an event's data.
const LOG_FILES = [HARNESS_LOG, '.claude/scripts/harness-seal.mjs'];
// Bounds on the session-log event, well inside kh-harness's 16,384 bytes.
const EVENT_OFFICERS = 50;
const EVENT_ID_CHARACTERS = 64;
const MAX_HOOK_BYTES = 64 * 1024;
// Where this file runs from: the owner's commands act only when it is bin/.
const HERE = dirname(fileURLToPath(import.meta.url));

const short = (id) => (id === null ? 'none' : id === 'none' ? 'none' : id.slice(0, 12));
const sentence = (text) => `${text.replace(/\.$/, '')}.`;
// A name (a branch, a path, an id) as it is shown: every invisible or control character written
// as \u{…}, so two names never look the same, then cut at 200 characters.
const shownName = (text) => shownText(visible(text));
function named(items) {
  const shown = items.slice(0, NAMED_AT_MOST).map(shownName).join(', ');
  return items.length > NAMED_AT_MOST ? `${shown} and ${items.length - NAMED_AT_MOST} more` : shown;
}
const withReason = (entries, label) => entries.map((entry) => `${shownName(entry[label])} (${shownText(entry.reason)})`).join(', ');
const branchWords = (branch) => (branch === null ? 'a detached HEAD' : shownName(branch));
const KO = COMMANDS.status.slice(0, -' status'.length);
// A command only the owner runs, as a next line a session may read (after Task 9's review).
export const askOwner = (command) => `ask the owner to run, in their own terminal outside Claude Code: ${command}`;
// The repair for a missing or damaged bin/: kh-orchestration's apply, from the plugin, the owner's
// to run. ko.mjs and gate.mjs can only print literals, so they print it for the word <repository>;
// a test holds the three texts to this one.
export const repairCommand = (rootWord) => askOwner(`node <kh-orchestration>/scripts/apply.mjs ${rootWord} --yes`);
const APPLY = (root) => repairCommand(shellWord(root));
// The one rule for an agent's command ko.mjs prints: the working copy's ko.mjs by its absolute
// path, quoted for a shell, so it runs from whatever directory the person is in (a subdirectory, a
// linked worktree). COMMANDS stays root-relative for the gate's own texts, which a hook prints
// with its working directory at the worktree's top, and for the extension's.
export const agentCommand = (root, words) => `node ${shellWord(join(root, SCRIPTS, 'ko.mjs'))} ${words}`;
const AGENT_WORDS = new Map(Object.values(COMMANDS).map((command) => [command, command.slice(KO.length + 1)]));
// A next line from the gate's texts, in that rule when it is one of COMMANDS.
const localNext = (root, next) => (AGENT_WORDS.has(next) ? agentCommand(root, AGENT_WORDS.get(next)) : next);
// A command line holding words the person typed: pasteable when they hold no character a terminal
// hides; otherwise shown with those characters written as \u{…}, to be typed, never pasted.
function commandLine(prefix, words) {
  if (words.every((word) => plainText(word) === word)) return `${prefix} ${words.map(shellWord).join(' ')}`;
  return TEXT.typeIt(`${prefix} ${words.map(visible).join(' ')}`);
}
const ownerLine = (root, words) => commandLine(ownerCommand(root, '').trimEnd(), words);
// How officers change the tree they run on, said in both texts that refuse their verdict.
const OFFICER_CHANGES = 'an officer that fixes files, a lint --fix say, does this, and so does one that writes a file git does not ignore';

export const USAGE = `usage: ${KO} <command>
  run                              run the officers on the staged tree and record the verdict
  status [--json]                  what the commit gate sees in this worktree
  verify-branch [--no-run]         whether HEAD's tree passed the gate's checks (runs the officers first unless --no-run)
  unexempt <branch>                end a branch's exemption
The owner's commands, run in their own terminal outside Claude Code, from the approved copy:
node <git-common-dir>/kh-orchestration/bin/ko.mjs <command>
  approve                          approve the protected files of the staged tree (asks for the word approve)
  propose                          open this worktree for edits to the protected files until the next approve
  waive <rule> --reason <text>     waive an officer's rule on the current branch
  exempt <branch> --reason <text>  let a branch's commits through the gate unchecked
  off | on                         switch the commit gate off or on for this repository
`;

// Every text ko.mjs prints, with values substituted.
export const TEXT = Object.freeze({
  noCommand: 'No command was given.',
  unknownCommand: (word) => `${shownName(word)} is not a ko.mjs command.`,
  unexpectedArgument: (command, word) => `${command} does not take ${shownName(word)}.`,
  missingOperand: (command, what) => `${command} needs ${what}.`,
  reasonMissing: (command) => `${command} needs --reason <text>, saying why in a few words.`,
  reasonEmpty: 'The reason holds no text once control characters are removed. Say why in a few words.',
  reasonTooLong: `The reason is longer than ${MAX_REASON} characters. Say why in fewer words.`,
  badRule: (rule) => `${shownName(rule)} is not a rule id: a letter, then letters, digits, _, . or -, at most 64 characters, as RULES.md writes it.`,
  badBranch: (name) => `${shownName(name)} is not a branch name git accepts (git check-ref-format --branch), written as the short name.`,

  notARepository: 'This directory is not inside a git working tree.',
  ownerOnly: (command, variable) => `ko.mjs ${command} is the owner's to run in their own terminal, outside Claude Code: ${variable} is set here, so this is a Claude Code session. Nothing was changed.`,
  notFromBin: (command) => `ko.mjs ${command} acts only from this repository's approved copy, the ko.mjs in its shared state's bin/ named below; this is another copy, whose scripts nobody approved here. Nothing was changed.`,
  typeIt: (line) => `${line} (type it yourself, writing each \\u{…} as the character it names: a terminal does not show them, so a pasted line could differ from what you read)`,
  failed: (reason) => `ko.mjs could not finish: ${sentence(reason)}`,
  unexpected: 'an unexpected error stopped it',
  filterDriver: (name, key) => `The git filter driver ${shownName(name)} is configured (${shownName(key)}). A clean filter can make a working tree that differs from the index look tidy, and the officers run on the working tree, so they are not run here. Remove the driver from the configuration file shown below; only lfs is allowed.`,
  untidy: (paths) => `The working tree differs from the index, so the officers would not run on the tree a commit would hold. Stage the files meant to be committed, and add the others (a .claude/settings.local.json, say) to .gitignore: ${named(paths)}.`,
  hiddenEntries: (paths) => `The index flags these files assume-unchanged or skip-worktree (a sparse checkout flags its files so), so git does not compare them with the working tree and the officers could pass on other files than a commit would hold: ${named(paths)}. Clear the flags, then run the officers.`,
  cannotRun: (problem) => `The officers cannot be run on this tree: ${sentence(problem)}`,
  treeChanged: (paths) => `The working tree changed while the officers ran, so no verdict is recorded: they did not pass on the tree a commit would hold (${OFFICER_CHANGES}). Stage what they changed if it is wanted, add a file they write to .gitignore, restore the rest, then run the officers again. Changed: ${named(paths)}.`,
  treeChangedHead: (paths) => `The working tree changed while the officers ran, so no verdict is recorded: they did not pass on HEAD's tree as it is (${OFFICER_CHANGES}). Commit what they changed if it is wanted, add a file they write to .gitignore, discard the rest, then verify again. Changed: ${named(paths)}.`,

  runHeader: (tree, base) => `Officers on the staged tree ${short(tree)} against the base ${short(base)}:`,
  verifyHeader: (where, tree, base) => `verify-branch on ${where}: HEAD's tree ${short(tree)} against the base ${short(base)}.`,
  noOfficers: '  (the tree names no officers)',
  officerLine: (entry) => `  ${shownName(entry.id)}  ${entry.result}  ${entry.seconds.toFixed(1)} s`,
  outputLine: (line) => `    | ${shownText(line)}`,
  agentChanges: (changes) => (changes.length === 0
    ? 'Rules marked approval: agent reworded since the base: none.'
    : `Rules marked approval: agent reworded since the base: ${named(changes.map((change) => change.id))}.`),
  waivers: (branch, waivers) => (branch === null
    ? 'Waivers: none, HEAD is detached.'
    : `Waivers in force on ${shownName(branch)}: ${waivers.length === 0 ? 'none' : withReason(waivers, 'rule')}.`),
  exemption: (branch, exemption) => (exemption === null
    ? `Exemption: none for ${branchWords(branch)}.`
    : `Exemption in force: ${shownName(exemption.name)} (${shownText(exemption.reason)}); the gate lets its commits through unchecked.`),
  passingApproved: (tree) => `Passing: the staged tree ${short(tree)} may be committed; its protected files are approved.`,
  passingUnapproved: (digest) => `Passing, but the protected files of this tree (digest ${short(digest)}) are not approved, so the commit gate refuses it until the owner approves them in their own terminal.`,
  passingOlder: (digest) => `Passing, but the protected files of this tree (digest ${short(digest)}) are an earlier approved version than the base's, so the commit gate refuses it until the owner approves them again in their own terminal.`,
  failing: (ids) => `Failing: these officers did not pass: ${named(ids)}. Fix what they report, stage the fix, and run the officers again.`,

  noHead: 'HEAD names no commit yet, so there is no branch head to verify.',
  stagedChanges: 'The index holds changes HEAD does not, so the working tree is not HEAD\'s tree and the officers cannot run on it. Commit or stash them first.',
  untidyHead: (paths) => `The working tree differs from HEAD, so the officers would not run on HEAD's tree. Commit or stash: ${named(paths)}.`,
  headRecorded: 'HEAD\'s commit is recorded as accepted by the gate; it is judged against the base the gate used.',
  headNotRecorded: 'No record of HEAD\'s commit passing the gate (it predates the install, or git never ran the hooks for it: a rebase, a cherry-pick or the like); it is judged against the base computed from HEAD and the base branch.',
  noRaceHook: 'Note: the reference-transaction hook is not installed, so a change to the index in the instant after the gate allows a commit is not caught when it is committed; this check is the remedy, run it before merging.',
  verified: 'Pass: HEAD\'s tree has a passing verdict against its base, its protected files are approved and contract 1 holds.',
  notVerified: (reason) => `Fail: ${reason}`,

  approveUndigestable: (problem) => `The protected files of the staged tree cannot be approved: ${sentence(problem)}`,
  approveHeader: (tree, digest, branch) => `Approving the protected files of the staged tree ${short(tree)} (digest ${short(digest)}) on ${branchWords(branch)}.`,
  coveredFiles: (count) => `The ${count} files the digest covers:`,
  coveredFile: (path) => `  ${visible(path)}`,
  baselineBranch: (tree, at, branch) => `Changes to them since the last approval on ${branchWords(branch)} (${shownText(at)}, tree ${short(tree)}):`,
  baselineMergeBase: (tree, at, commit, branch) => `No approval on ${branchWords(branch)} records its tree; changes to them since the approved tree whose digest is the merge base's (merge base ${short(commit)}; approved ${shownText(at)}, tree ${short(tree)}):`,
  baselineAny: (tree, at, approvedOn, branch) => `Neither ${branchWords(branch)} nor its merge base has an approval that records its tree; changes to them since the most recent approved tree (on ${branchWords(approvedOn)}, ${shownText(at)}, tree ${short(tree)}):`,
  noChange: '  (none: the files are as that approval left them)',
  newlyCovered: (paths) => `Newly covered, their content unchanged since that tree: ${named(paths)}.`,
  noEarlierApproval: 'No earlier approval records a tree to compare with, so read these files in full before approving.',
  earlierTreeGone: (tree, branch) => `The tree of the last approval on ${branchWords(branch)} (${short(tree)}) is no longer in the object store.`,
  alreadyApproved: 'This digest is approved already; approving again records it once more, refreshes bin/ from this tree and closes this worktree for proposals.',
  approvesOlder: (digest, baseDigest) => `These protected files (digest ${short(digest)}) are an earlier approved state, approved before the base's (digest ${short(baseDigest)}), so the commit gate refuses them: going back to an older version of the checks needs approving again. Approving records a new approval, later than the base's.`,
  prompt: 'Type approve and press Enter to approve; anything else cancels: ',
  notApproved: 'Nothing was approved: the answer was not the word approve.',
  pinFailed: 'The approved tree could not be pinned with a ref under refs/kh-orchestration/approved/, so it could be pruned later and nothing is approved (bin/ already holds its scripts; the gate refuses them until approved). Check that the git directory can be written, then approve again.',
  noAnswer: 'Nothing was approved: no answer could be read (standard input is closed or empty).',
  approved: (digest, tree) => `Approved: digest ${short(digest)} of tree ${short(tree)}. bin/ now holds this tree's scripts, and this worktree is closed for proposals.`,
  approvedNext: (runCommand) => `${runCommand}, then git commit`,

  proposed: (path) => `This worktree (${shownName(path)}) is open for proposals: a session here may edit the protected files, though never .claude/settings.local.json or the git directory. The next approve closes it.`,
  alreadyProposed: (path) => `This worktree (${shownName(path)}) is open for proposals already. The next approve closes it.`,
  waiveDetached: 'HEAD is detached; a waiver applies to a branch. Switch to the branch first.',
  waived: (rule, branch) => `Rule ${rule} is waived on ${shownName(branch)}; its officer sees the waiver in KO_WAIVERS from the next run.`,
  exempted: (branch) => `The branch ${shownName(branch)} is exempt: the commit gate lets its commits through unchecked.`,
  exemptions: (list) => `Exempt branches: ${list.length === 0 ? 'none' : withReason(list, 'name')}.`,
  unexempted: (branch) => `The branch ${shownName(branch)} is no longer exempt.`,
  notExempt: (branch) => `The branch ${shownName(branch)} was not exempt; nothing changed.`,
  off: (onCommand) => `kh-orchestration is switched off for this repository: no commit is checked until it is switched on with ${onCommand}.`,
  on: 'kh-orchestration is switched on for this repository: every commit is checked.',

  statusHeader: (root) => `kh-orchestration status of ${shownName(root)}`,
  problemsHeader: 'Problems:',
  noProblems: 'No problems found.',
  offProblem: (onCommand) => `kh-orchestration is switched off: no commit is checked. The owner switches it on with ${onCommand}.`,
  exemptHere: (branch, reason) => `This branch, ${shownName(branch)}, is exempt (${shownText(reason)}): the commit gate lets its commits through unchecked.`,
  noInstall: (problem) => `The staged tree holds no usable install: ${sentence(problem)}`,
  installProblem: (problem) => `The officers file of the staged tree cannot be used: ${sentence(problem)}`,
  contractProblem: (problem) => `kh-harness contract 1 does not hold in this working directory: ${sentence(problem)}`,
  undigestable: (problem) => `The protected files of the staged tree cannot be checked: ${sentence(problem)}`,
  unapproved: (digest) => `The protected files of the staged tree (digest ${short(digest)}) are not approved.`,
  olderApproval: (digest) => `The protected files of the staged tree (digest ${short(digest)}) are an earlier approved version than the base's: the owner must approve again.`,
  indexFailing: (ids) => `The verdict for the staged tree is failing: ${named(ids)} did not pass.`,
  indexStale: 'The verdict for the staged tree records other officers or other protected files than the tree holds, so the gate does not trust it.',
  verdictDamaged: (name) => `The shared state file ${name} exists but is not a verdict kh-orchestration can use; the gate treats it as no verdict.`,
  headNoRecord: (tree, base) => `There is no record of HEAD's commit passing the gate and no passing verdict for its tree (${short(tree)}) against its base (${short(base)}): it predates the install, or git never ran the hooks for it (a rebase, a cherry-pick or the like). Run verify-branch before merging.`,
  headAcceptedUnverdicted: (tree, base) => `HEAD's commit is recorded as accepted by the gate, but no passing verdict for its tree (${short(tree)}) against that base (${short(base)}) is recorded now: the verdict file was removed or damaged. Run verify-branch before merging.`,
  binMissing: (bin) => `There is no ${shownName(bin)}/, so the hooks find no gate and every commit is refused.`,
  binNoGate: (bin) => `${shownName(bin)}/ holds no gate.mjs, so the hooks find no gate and every commit is refused.`,
  binBaselineApproved: (tree) => `the scripts of the last approved tree (${short(tree)})`,
  binBaselineHead: (tree) => `HEAD's tree (${short(tree)}), whose protected files have the last approved digest`,
  binBaselineBase: (branch, tree) => `the tree of the base branch ${shownName(branch)} (${short(tree)}), whose protected files have the last approved digest`,
  binBaselineWorking: 'the installed scripts of the working copy (nothing is approved yet)',
  binDiffers: (bin, baseline, names) => `${shownName(bin)}/ differs from ${baseline}: ${named(names)}. The hooks and the owner's commands run bin/; kh-orchestration's apply restores it from there.`,
  binUnverifiable: (digest) => `No tree whose protected files have the last approved digest (${short(digest)}) is in the object store, so bin/ cannot be checked against approved scripts. The owner can let bin/ hold kh-orchestration's own scripts with apply --yes --bin-from-plugin, keeping every approval, then approve again.`,
  hookMissing: (name, path) => `The ${name} hook is not installed at ${shownName(path)}, so git does not run the commit gate there.`,
  raceHookMissing: (path) => `The reference-transaction hook is not installed at ${shownName(path)}, so a change to the index in the instant after the gate allows a commit is not caught: verify-branch is then the remedy.`,
  hookMisplaced: (name, path) => `The ${name} hook at ${shownName(path)} holds kh-orchestration's line, but not where it runs first, so a command before it can skip the gate. Put the line directly after the #!/bin/sh line, with only blank or comment lines between.`,
  hookNotOurs: (name, path) => `The ${name} hook at ${shownName(path)} is not kh-orchestration's, so the commit gate may not run.`,
  hookDiffers: (name, path) => `The ${name} hook at ${shownName(path)} is not exactly the text kh-orchestration writes for the env and Node it names, so it may not run the gate as it should.`,
  hookNotExecutable: (name, path) => `The ${name} hook at ${shownName(path)} is not executable, so git skips it.`,
  hookProgramGone: (name, what, path) => `The ${name} hook starts ${what} as ${shownName(path)}, which no longer exists, so every commit is refused. Run kh-orchestration's apply again to record where it is now.`,
  hooksPath: (value, scope) => `core.hooksPath is set to ${shownName(value)} in the ${scope} git configuration, so git runs no hook from the repository's hooks directory and the commit gate is off for every commit.`,
  oldGit: (version) => `git ${shownName(version)} is older than 2.30, the oldest git kh-orchestration works with. Install git 2.30 or later.`,
  unknownGit: 'The version of git could not be read.',
  staleInflight: (pids) => `In-flight records of git processes that have ended are left: ${named(pids)}. The next gate run, approve or apply removes them.`,
});

// The next command after a filter-driver refusal: where each driver is set.
const FILTER_ORIGIN = 'git config --show-origin --get-regexp \'^filter\\.\'';

class UsageError {
  constructor(message) {
    this.message = message;
  }
}

// Output, kept apart so a report and a refusal read the same in every command.
function print(lines) {
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
}
function refusal(reason, next) {
  process.stderr.write(`kh-orchestration: ${reason}\nNext: ${next}\n`);
  return 1;
}
const nextLine = (next) => `Next: ${next}`;

function failureReason(error) {
  return error instanceof StateError || error instanceof GitError ? error.message : TEXT.unexpected;
}

// The version of the install this file belongs to, from its stamp line (decision 2).
function kitVersion() {
  try {
    const stamp = readFileSync(fileURLToPath(import.meta.url), 'utf8').match(STAMP);
    return stamp === null ? 'unstamped' : stamp[1];
  } catch {
    return 'unstamped';
  }
}

const statOrNull = (path) => {
  try {
    return statSync(path);
  } catch {
    return null;
  }
};
const runnable = (path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};
const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

// Whether this file runs from <state>/bin/, the approved copy.
function fromApprovedCopy(root) {
  const here = realOrNull(HERE);
  return here !== null && here === realOrNull(join(stateDir(root), 'bin'));
}

// A filter driver other than lfs configured at any level, `{ name, key }`, or null. Reads the
// configuration only (amended decision 17, rule 8): no working-tree content is read before it.
function foreignFilter(root) {
  const result = git(root, ['config', '-z', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$']);
  if (result.status === 1) return null;
  if (result.status !== 0) throw new GitError(gitFailedMessage('read the git configuration'));
  for (const entry of result.stdout.split('\0').filter((text) => text !== '')) {
    const key = entry.split('\n')[0];
    const name = key.slice('filter.'.length).replace(/\.(?:clean|smudge|process)$/, '');
    if (name !== 'lfs') return { name, key };
  }
  return null;
}

// The waivers in force on `branch`: none on a detached HEAD.
const waiversOf = (root, branch) => (branch === null ? [] : readWaivers(root).filter((entry) => entry.branch === branch));

// A reason as recorded: its control, zero-width and bidi characters removed, trimmed, at most MAX_REASON.
function cleanReason(command, reason) {
  if (reason === undefined) throw new UsageError(TEXT.reasonMissing(command));
  const clean = plainText(reason).trim();
  if (clean === '') throw new UsageError(TEXT.reasonEmpty);
  if (clean.length > MAX_REASON) throw new UsageError(TEXT.reasonTooLong);
  return clean;
}

// The officer lines of a verdict, with the first lines of each failure's output.
function officerLines(verdict) {
  if (verdict.officers.length === 0) return [TEXT.noOfficers];
  return verdict.officers.flatMap((entry) => {
    const lines = [TEXT.officerLine(entry)];
    if (entry.result === 'pass' || entry.result === 'skipped') return lines;
    return [...lines, ...entry.output.split('\n').filter((line) => line.trim() !== '').slice(0, OUTPUT_LINES).map(TEXT.outputLine)];
  });
}

// The officers of a verdict that did not pass: neither a pass nor a skip.
const failedIds = (verdict) => verdict.officers.filter((entry) => entry.result !== 'pass' && entry.result !== 'skipped').map((entry) => entry.id);

const verdictSummary = (verdict, isPassing) => ({
  tree: verdict.tree,
  base: verdict.base,
  branch: verdict.branch === null ? null : verdict.branch.slice(0, 200),
  digest: verdict.digest,
  passing: isPassing,
  officers: verdict.officers.slice(0, EVENT_OFFICERS).map((entry) => ({ id: entry.id.slice(0, EVENT_ID_CHARACTERS), result: entry.result, seconds: entry.seconds })),
  moreOfficers: Math.max(0, verdict.officers.length - EVENT_OFFICERS),
  agentRuleChanges: verdict.agentRuleChanges.slice(0, EVENT_OFFICERS).map((change) => String(change.id).slice(0, EVENT_ID_CHARACTERS)),
});

// One event in the session's kh-harness log (decision 14), only when CLAUDE_CODE_SESSION_ID is set
// and contract 1 holds by its files (checkContract1 hashes every file the contract file lists) and
// the contract file lists harness-log.mjs and harness-seal.mjs; only then is the installed
// harness-log.mjs imported. Anything else, a refusal from kh-harness (the log is off by default)
// included, records nothing and says nothing: the run journal is the record.
async function recordSessionEvent(root, data) {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (sessionId === undefined) return;
  try {
    const { problems, warnings } = checkContract1(root, ownEntry(root));
    if (problems.length > 0 || warnings.length > 0) return;
    const read = readNoFollow(join(root, CONTRACT_FILE));
    if (read.bytes === undefined) return;
    const files = JSON.parse(read.bytes.toString('utf8')).files;
    if (!LOG_FILES.every((path) => Object.hasOwn(files, path))) return;
    const { recordExternalEvent } = await import(pathToFileURL(join(root, HARNESS_LOG)).href);
    if (typeof recordExternalEvent === 'function') recordExternalEvent(root, sessionId, { source: 'kh-orchestration', type: 'verdict', data });
  } catch {
    // Nothing is recorded; the journal holds the run.
  }
}

// The paths the officers changed (after the whole-branch review): the untidy paths, and those in
// which the index tree now differs from `tree`, the tree they were run on; empty when neither
// changed. A file changed and put back while they ran is not seen (a stated limit).
function changedByOfficers(root, tree) {
  const now = indexTree(root);
  return [...new Set([...(now === tree ? [] : changedPaths(root, tree, now)), ...untidyPaths(root)])];
}

// Runs the officers on `tree` (the working tree equals it: the caller checked) and records the
// verdict and the journal line, unless the officers changed the working tree or the index: a
// verdict is for a tree the officers left as they found it, so then nothing is recorded.
// `{ verdict, isPassing }`, `{ verdict, changed }` (the paths) or `{ problem }`.
async function runAndRecord(root, { tree, base, branch, officers, command }) {
  const produced = await produceVerdict(root, { tree, base, branch, waivers: waiversOf(root, branch), kitVersion: kitVersion() });
  if (produced.problem !== undefined) return produced;
  const { verdict } = produced;
  const changed = changedByOfficers(root, tree);
  if (changed.length > 0) return { verdict, changed };
  writeVerdict(root, verdict);
  const isPassing = passing(verdict, officers);
  appendJournal(root, { at: verdict.finishedAt, command, ...verdictSummary(verdict, isPassing), waivers: verdict.waivers.map((entry) => entry.rule) });
  return { verdict, isPassing };
}

// The paths that make a tree untidy, unstaged first; empty when tidy. Run only after the filter check.
function untidyPaths(root) {
  const state = tidy(root);
  return state.tidy ? [] : [...state.unstaged, ...state.untracked];
}

// When the index hides entries from git's comparison with the working tree (hiddenEntries: an
// assume-unchanged or skip-worktree flag), the refusal naming them, with the commands that clear
// the flags of the first ten, then `then`; exit 1. Null when it hides none.
function hiddenRefusal(root, then) {
  const { assumed, skipped } = hiddenEntries(root);
  const paths = [...new Set([...assumed, ...skipped])];
  if (paths.length === 0) return null;
  const shown = new Set(paths.slice(0, NAMED_AT_MOST));
  const rootWord = shellWord(root);
  const clear = [['--no-assume-unchanged', assumed], ['--no-skip-worktree', skipped]]
    .map(([flag, list]) => [flag, list.filter((path) => shown.has(path))])
    .filter(([, list]) => list.length > 0)
    .map(([flag, list]) => commandLine(`git -C ${rootWord} update-index ${flag} --`, list));
  return refusal(TEXT.hiddenEntries(paths), `${clear.join(' && ')}, then ${then}`);
}

const treeExists = (root, tree) => {
  const type = git(root, ['cat-file', '-t', '--end-of-options', tree]);
  return type.status === 0 && type.stdout.trim() === 'tree';
};

// ---- run ----

async function run(root) {
  const filter = foreignFilter(root);
  if (filter !== null) return refusal(TEXT.filterDriver(filter.name, filter.key), FILTER_ORIGIN);
  const hidden = hiddenRefusal(root, agentCommand(root, 'run'));
  if (hidden !== null) return hidden;
  const untidy = untidyPaths(root);
  // Never a command that stages everything (after Task 9's re-review): an unignored
  // settings.local.json would go into the tree the owner approves.
  if (untidy.length > 0) return refusal(TEXT.untidy(untidy), `git -C ${shellWord(root)} add -- <each path meant to be committed>, then ${agentCommand(root, 'run')}`);
  const tree = indexTree(root);
  const branch = currentBranch(root);
  const read = officersOfTree(root, tree);
  if (read.problem !== undefined) return refusal(TEXT.cannotRun(read.problem), agentCommand(root, 'status'));
  const base = baseOf(root, read.baseBranch);
  const recorded = await runAndRecord(root, { tree, base, branch, officers: read.officers, command: 'run' });
  if (recorded.problem !== undefined) return refusal(TEXT.cannotRun(recorded.problem), agentCommand(root, 'status'));
  if (recorded.changed !== undefined) {
    print([TEXT.runHeader(tree, base), ...officerLines(recorded.verdict)]);
    return refusal(TEXT.treeChanged(recorded.changed), `git -C ${shellWord(root)} add -- <each changed path that is wanted>, then ${agentCommand(root, 'run')}`);
  }
  const { verdict, isPassing } = recorded;
  await recordSessionEvent(root, verdictSummary(verdict, isPassing));
  const lines = [TEXT.runHeader(tree, base), ...officerLines(verdict), TEXT.agentChanges(verdict.agentRuleChanges)];
  if (verdict.waivers.length > 0) lines.push(TEXT.waivers(branch, verdict.waivers));
  print(lines);
  if (!isPassing) {
    // The verdict was made from the tree's own officers, so at least one of them did not pass.
    print([TEXT.failing(failedIds(verdict)), nextLine(agentCommand(root, 'run'))]);
    return 1;
  }
  const standing = approvalStanding(readApprovals(root), verdict.digest, () => baseDigestOf(root, base));
  if (standing === 'approved') print([TEXT.passingApproved(tree), nextLine('git commit')]);
  else print([standing === 'older' ? TEXT.passingOlder(verdict.digest) : TEXT.passingUnapproved(verdict.digest), nextLine(ownerCommand(root, 'approve'))]);
  return 0;
}

// ---- status ----

// The value of `read`, or `fallback` after adding the problem it threw (fixed text) to `problems`.
function attempt(problems, root, read, fallback) {
  try {
    return read();
  } catch (error) {
    problems.push({ text: failureReason(error), next: agentCommand(root, 'status') });
    return fallback;
  }
}

// One hook as git would run it: present, ours (a kh-orchestration header for this hook), matching
// (byte for byte the text this kit writes for the version, env and Node the hook names, so an
// edited body is never "ok" by its header), executable, and the env and Node it names still there.
// A hook that is someone else's but holds exactly the line apply prints for it is `hosted`: it runs
// the gate (after Task 9's review), and is judged by the env and Node that line names.
function inspectHook(root, name) {
  const path = join(commonDir(root), 'hooks', name);
  const hook = { name, path, present: false, ours: false, hosted: false, misplaced: false, matches: false, executable: false, env: null, envExists: false, node: null, nodeExists: false };
  const stat = statOrNull(path);
  if (stat === null || !stat.isFile()) return hook;
  hook.present = true;
  hook.executable = runnable(path);
  const read = readNoFollow(path);
  const text = read.bytes === undefined || read.bytes.length > MAX_HOOK_BYTES ? '' : read.bytes.toString('utf8');
  const parts = hookParts(text);
  hook.ours = parts !== null && parts.hook === name;
  const hosted = hook.ours ? null : hostedParts(text, name);
  hook.hosted = hosted?.first === true;
  hook.misplaced = hosted?.first === false;
  const named = hook.hosted ? hosted : parts;
  if ((!hook.ours && !hook.hosted) || named.env === null) return hook;
  hook.env = named.env;
  hook.node = named.node;
  hook.envExists = runnable(named.env);
  hook.nodeExists = runnable(named.node);
  hook.matches = hook.ours && hookText(name, parts) === text;
  return hook;
}

function hookProblems(root, hook) {
  const apply = APPLY(root);
  if (!hook.present) return [hook.name === REFERENCE_HOOK ? { text: TEXT.raceHookMissing(hook.path), next: apply } : { text: TEXT.hookMissing(hook.name, hook.path), next: apply }];
  if (hook.misplaced) return [{ text: TEXT.hookMisplaced(hook.name, hook.path), next: apply }];
  if (!hook.ours && !hook.hosted) return [{ text: TEXT.hookNotOurs(hook.name, hook.path), next: apply }];
  const problems = [];
  if (hook.ours && !hook.matches) problems.push({ text: TEXT.hookDiffers(hook.name, hook.path), next: apply });
  if (!hook.executable) problems.push({ text: TEXT.hookNotExecutable(hook.name, hook.path), next: `chmod +x ${shellWord(hook.path)}` });
  if (hook.env !== null && !hook.envExists) problems.push({ text: TEXT.hookProgramGone(hook.name, 'env', hook.env), next: apply });
  if (hook.node !== null && !hook.nodeExists) problems.push({ text: TEXT.hookProgramGone(hook.name, 'Node', hook.node), next: apply });
  return problems;
}

const raceHookWorks = (hook) => hook.present && (hook.matches || hook.hosted) && hook.executable;

/**
 * Where bin/'s scripts should come from (after Task 9's second re-review), one answer for status and
 * for apply: `{ kind: 'tree', tree, from, branch }` for a tree holding the approved scripts — the
 * last approval's own tree (`from: 'approved'`; approve pins it with a ref), else HEAD's tree
 * ('head') or the base branch's ('base', with `branch`) when its protected-files digest is the last
 * approved digest, since the scripts are in the digest; `{ kind: 'shipped' }` when nothing is
 * approved; `{ kind: 'none', digest }` when approvals exist but no such tree is reachable;
 * `{ kind: 'unreadable', reason }` when the approvals cannot be read. Executes nothing.
 */
export function binSourceOf(root) {
  let approvals;
  try {
    approvals = readApprovals(root);
  } catch (error) {
    return { kind: 'unreadable', reason: failureReason(error) };
  }
  const last = approvals.at(-1);
  if (last === undefined) return { kind: 'shipped' };
  if (last.tree !== undefined && treeExists(root, last.tree)) return { kind: 'tree', tree: last.tree, from: 'approved', branch: null };
  let head = null;
  try {
    head = headTree(root);
  } catch {
    head = null;
  }
  const approved = (tree) => tree !== null && digestOfTree(root, tree).digest === last.digest;
  if (approved(head)) return { kind: 'tree', tree: head, from: 'head', branch: null };
  const branch = (head === null ? undefined : officersOfTree(root, head).baseBranch) ?? 'main';
  const named = git(root, ['rev-parse', '--verify', '-q', '--end-of-options', `refs/heads/${branch}^{tree}`]);
  const base = named.status === 0 ? named.stdout.trim() : null;
  if (base !== head && approved(base)) return { kind: 'tree', tree: base, from: 'base', branch };
  return { kind: 'none', digest: last.digest };
}

// bin/ against what it should hold, by binSourceOf: a tree's scripts; before any approval the
// working copy's installed scripts (status cannot read the plugin's own); nothing to compare with
// when no approved tree is reachable. `{ present, gate, baseline: { kind, tree, branch? }, digest?,
// differs, missing, extra }`.
function binOf(root, source) {
  const bin = join(stateDir(root), 'bin');
  const stat = statOrNull(bin);
  if (stat === null || !stat.isDirectory()) return { present: false, gate: false, baseline: null, differs: [], missing: [], extra: [] };
  const expected = new Map();
  let baseline;
  if (source.kind === 'tree') {
    baseline = { kind: source.from, tree: source.tree, ...(source.from === 'base' ? { branch: source.branch } : {}) };
    for (const entry of binEntriesOf(root, source.tree)) expected.set(basename(entry.path), (bytes) => hashesTo(entry.oid, bytes));
  } else if (source.kind !== 'shipped') {
    const present = readdirSync(bin).sort();
    return { present: true, gate: present.includes('gate.mjs'), baseline: { kind: 'none', tree: null }, digest: source.digest ?? null, differs: [], missing: [], extra: [] };
  } else {
    baseline = { kind: 'working', tree: null };
    const scripts = join(root, SCRIPTS);
    const names = statOrNull(scripts)?.isDirectory() ? readdirSync(scripts).filter((name) => name.endsWith('.mjs')) : [];
    for (const name of names) {
      const working = readNoFollow(join(scripts, name)).bytes;
      if (working !== undefined) expected.set(name, (bytes) => bytes.equals(working));
    }
  }
  const present = readdirSync(bin).sort();
  const differs = [];
  const missing = [];
  for (const [name, same] of [...expected].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!present.includes(name)) missing.push(name);
    else if (!same(readNoFollow(join(bin, name)).bytes ?? Buffer.alloc(0))) differs.push(name);
  }
  return { present: true, gate: present.includes('gate.mjs'), baseline, differs, missing, extra: present.filter((name) => !expected.has(name)) };
}

// The remedy is apply, run from the plugin: approve itself runs from bin/, so it cannot restore a
// bin/ that is missing or damaged.
function binProblems(root, bin) {
  const directory = join(stateDir(root), 'bin');
  const next = APPLY(root);
  if (!bin.present) return [{ text: TEXT.binMissing(directory), next }];
  if (bin.baseline.kind === 'none') return bin.digest === null ? [] : [{ text: TEXT.binUnverifiable(bin.digest), next: askOwner(`node <kh-orchestration>/scripts/apply.mjs ${shellWord(root)} --yes --bin-from-plugin`) }];
  if (!bin.gate) return [{ text: TEXT.binNoGate(directory), next }];
  const names = [...bin.differs, ...bin.missing, ...bin.extra].sort();
  if (names.length === 0) return [];
  const BASELINES = {
    approved: () => TEXT.binBaselineApproved(bin.baseline.tree),
    head: () => TEXT.binBaselineHead(bin.baseline.tree),
    base: () => TEXT.binBaselineBase(bin.baseline.branch, bin.baseline.tree),
    working: () => TEXT.binBaselineWorking,
  };
  const baseline = BASELINES[bin.baseline.kind]();
  return [{ text: TEXT.binDiffers(directory, baseline, names), next }];
}

// The effective core.hooksPath across every level, `{ value, scope }`, or null when it is not set.
function hooksPathOf(root) {
  const result = git(root, ['config', '--show-scope', '--get', 'core.hooksPath']);
  if (result.status === 1) return null;
  if (result.status !== 0) throw new GitError(gitFailedMessage('read the git configuration'));
  const line = result.stdout.replace(/\n$/, '');
  const tab = line.indexOf('\t');
  return { scope: line.slice(0, tab), value: line.slice(tab + 1) };
}

const UNSET_BY_SCOPE = { local: '--local', global: '--global', system: '--system', worktree: '--worktree' };
const hooksPathNext = (scope) => (Object.hasOwn(UNSET_BY_SCOPE, scope) ? `git config ${UNSET_BY_SCOPE[scope]} --unset core.hooksPath` : 'git config --show-origin --get core.hooksPath');

// `{ version, supported }` of the git that runs in `cwd`; version null when it cannot be read.
export function gitVersion(cwd) {
  const result = git(cwd, ['version']);
  const match = result.status === 0 ? result.stdout.match(/^git version (\d+)\.(\d+)(\S*)/) : null;
  if (match === null) return { version: null, supported: false };
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return { version: `${match[1]}.${match[2]}${match[3]}`, supported: major > MIN_GIT[0] || (major === MIN_GIT[0] && minor >= MIN_GIT[1]) };
}

// The verdict for `tree` against `base` as the gate reads it, `{ state, failed }`: 'passing' only
// when it passes for the tree's officers and records the tree's digest; 'damaged' when a file is
// there that readVerdict does not accept; 'none' when there is no file. `failed`: the officers it
// shows not passing.
function verdictState(root, tree, base, officers, digest) {
  const verdict = readVerdict(root, tree, base);
  if (verdict === null) return { state: statOrNull(join(stateDir(root), verdictName(tree, base))) === null ? 'none' : 'damaged', failed: [] };
  const isPassing = passing(verdict, officers) && verdict.digest === digest;
  return { state: isPassing ? 'passing' : 'failing', failed: isPassing ? [] : failedIds(verdict) };
}

// HEAD's commit as the gate saw it: `{ accepted, base }`, the base from its accepted record when
// the gate recorded one for this tree, else computed from the branch (headBaseOf); base null when
// HEAD's tree has no usable officers file and no record.
function headJudged(root, head, read) {
  const commit = headCommit(root);
  const record = commit === null ? null : readAccepted(root, commit);
  if (record !== null && record.tree === head) return { accepted: true, base: record.base };
  return { accepted: false, base: read.problem === undefined ? headBaseOf(root, read.baseBranch) : null };
}

/**
 * What the commit gate sees in this worktree, as one object (the shape `status --json` prints and
 * the session brief, Task 10, reads). Executes nothing from the repository. Never throws for a
 * damaged state file or a check that cannot be made: each becomes an entry of `problems`,
 * `{ text, next }`, and its field is null.
 */
export function statusOf(root) {
  const problems = [];
  const approveNext = ownerCommand(root, 'approve');
  const off = isOff(root);
  if (off) problems.push({ text: TEXT.offProblem(ownerCommand(root, 'on')), next: ownerCommand(root, 'on') });
  const branch = currentBranch(root);
  const tree = attempt(problems, root, () => indexTree(root), null);
  const head = attempt(problems, root, () => headTree(root), null);
  const approvals = attempt(problems, root, () => readApprovals(root), null);

  const read = tree === null ? null : officersOfTree(root, tree);
  const officers = read?.problem === undefined ? read?.officers ?? null : null;
  const base = officers === null ? null : attempt(problems, root, () => baseOf(root, read.baseBranch), null);

  let install = null;
  let liveFiles = null;
  let digest = null;
  let digestApproved = null;
  let verdict = 'none';
  if (tree !== null) {
    const found = attempt(problems, root, () => installOf(root, tree), null);
    if (found !== null) {
      install = { present: found.absent === undefined, problem: found.absent ?? found.problem ?? null };
      if (found.absent !== undefined) problems.push({ text: TEXT.noInstall(found.absent), next: agentCommand(root, 'status') });
      else if (found.problem !== undefined) problems.push({ text: TEXT.installProblem(found.problem), next: agentCommand(root, 'status') });
    }
    const differs = attempt(problems, root, () => liveFilesRefusal(root, tree), null);
    liveFiles = differs === null ? { equal: true, reason: null, next: null } : { equal: false, reason: differs.reason, next: differs.next };
    if (differs !== null) problems.push({ text: differs.reason, next: localNext(root, differs.next) });
    const digested = digestOfTree(root, tree);
    if (digested.problem !== undefined) {
      problems.push({ text: TEXT.undigestable(digested.problem), next: agentCommand(root, 'status') });
    } else {
      digest = digested.digest;
      const standing = approvals === null ? null : attempt(problems, root, () => approvalStanding(approvals, digest, () => (base === null ? null : baseDigestOf(root, base))), null);
      digestApproved = standing === null ? null : standing === 'approved';
      if (standing === 'unapproved') problems.push({ text: TEXT.unapproved(digest), next: approveNext });
      if (standing === 'older') problems.push({ text: TEXT.olderApproval(digest), next: approveNext });
    }
    if (officers !== null && base !== null && digest !== null) {
      const judged = attempt(problems, root, () => verdictState(root, tree, base, officers, digest), { state: 'none', failed: [] });
      verdict = judged.state;
      if (verdict === 'damaged') problems.push({ text: TEXT.verdictDamaged(verdictName(tree, base)), next: agentCommand(root, 'run') });
      if (verdict === 'failing') problems.push({ text: judged.failed.length > 0 ? TEXT.indexFailing(judged.failed) : TEXT.indexStale, next: agentCommand(root, 'run') });
    }
  }

  let headBase = null;
  let headAccepted = null;
  let headVerdict = null;
  if (head !== null) {
    const headRead = officersOfTree(root, head);
    const judged = attempt(problems, root, () => headJudged(root, head, headRead), { accepted: false, base: null });
    headAccepted = judged.accepted;
    headBase = judged.base;
    const headDigest = digestOfTree(root, head);
    headVerdict = headBase === null || headRead.problem !== undefined || headDigest.problem !== undefined
      ? 'none'
      : attempt(problems, root, () => verdictState(root, head, headBase, headRead.officers, headDigest.digest).state, 'none');
    if (headVerdict !== 'passing') {
      problems.push({ text: headAccepted ? TEXT.headAcceptedUnverdicted(head, headBase) : TEXT.headNoRecord(head, headBase), next: agentCommand(root, 'verify-branch') });
    }
  }

  const contract = contractHolds(root, { probe: false });
  for (const problem of contract.ok ? [] : contract.problems) problems.push({ text: TEXT.contractProblem(problem), next: agentCommand(root, 'status') });

  const here = realpathSync(root);
  const proposals = attempt(problems, root, () => readProposals(root), null);
  const exemptions = attempt(problems, root, () => readExemptions(root), null);
  const exemptionHere = exemptions?.find((entry) => entry.name === branch);
  if (exemptionHere !== undefined) problems.push({ text: TEXT.exemptHere(branch, exemptionHere.reason), next: commandLine(agentCommand(root, 'unexempt'), [branch]) });
  const waivers = attempt(problems, root, () => waiversOf(root, branch), null);
  const records = attempt(problems, root, () => listInflight(root), []);
  const inflight = { live: records.filter((record) => record.live).map((record) => record.pid), stale: records.filter((record) => !record.live).map((record) => record.pid) };
  if (inflight.stale.length > 0) problems.push({ text: TEXT.staleInflight(inflight.stale), next: agentCommand(root, 'status') });

  const bin = attempt(problems, root, () => binOf(root, binSourceOf(root)), null);
  if (bin !== null) problems.push(...binProblems(root, bin));
  const hooks = HOOK_NAMES.map((name) => inspectHook(root, name));
  for (const hook of hooks) problems.push(...hookProblems(root, hook));
  const hooksPath = attempt(problems, root, () => hooksPathOf(root), null);
  if (hooksPath !== null) problems.push({ text: TEXT.hooksPath(hooksPath.value, hooksPath.scope), next: hooksPathNext(hooksPath.scope) });
  const gitAt = gitVersion(root);
  if (gitAt.version === null) problems.push({ text: TEXT.unknownGit, next: 'git version' });
  else if (!gitAt.supported) problems.push({ text: TEXT.oldGit(gitAt.version), next: 'git version' });

  return {
    off,
    branch,
    base,
    tree,
    digestApproved,
    verdict,
    openForProposals: proposals === null ? null : proposals.includes(here),
    exemptions,
    waivers,
    headTree: head,
    headBase,
    headAccepted,
    headVerdict,
    install,
    contract: contract.ok ? { ok: true, problems: [] } : { ok: false, problems: contract.problems },
    liveFiles,
    digest,
    inflight,
    bin,
    hooks: hooks.map(({ name, present, ours, hosted, misplaced, matches, executable, env, envExists, node, nodeExists }) => ({ name, present, ours, hosted, misplaced, matches, executable, env, envExists, node, nodeExists })),
    hooksPath,
    git: gitAt,
    problems,
  };
}

const yesNo = (value, yes, no) => (value === null ? 'unknown (see the problems)' : value ? yes : no);

function statusLines(root, status) {
  const hookWord = (hook) => (!hook.present ? 'missing' : hook.misplaced ? 'holds the line, but not where it runs first' : !hook.ours && !hook.hosted ? 'not ours' : (hook.matches || hook.hosted) && hook.executable && hook.envExists && hook.nodeExists ? (hook.hosted ? 'ok (its line in a hook of another)' : 'ok') : 'broken');
  const EQUAL_TO = { approved: 'the last approved tree', head: 'HEAD\'s tree, of the approved digest', base: 'the base branch\'s tree, of the approved digest', working: 'the working copy' };
  const binWord = (bin) => (bin === null ? 'unknown' : !bin.present ? 'missing' : bin.baseline.kind === 'none' ? 'cannot be checked against an approved tree' : binProblems(root, bin).length === 0 ? `equal to ${EQUAL_TO[bin.baseline.kind]}` : 'differs');
  return [
    TEXT.statusHeader(root),
    `  switch: ${status.off ? 'off' : 'on'}`,
    `  branch: ${status.branch === null ? '(detached HEAD)' : shownName(status.branch)}; base: ${short(status.base)}; staged tree: ${short(status.tree)}; HEAD's tree: ${short(status.headTree)}`,
    `  install in the staged tree: ${status.install === null ? 'unknown' : status.install.present ? 'present' : 'absent'}`,
    `  contract 1 (by its files): ${status.contract.ok ? 'holds' : 'does not hold'}`,
    `  live files: ${status.liveFiles === null ? 'unknown' : status.liveFiles.equal ? 'equal to the staged tree' : 'differ from the staged tree'}`,
    `  digest: ${short(status.digest)}, ${yesNo(status.digestApproved, 'approved', 'not accepted by the gate (see the problems)')}`,
    `  verdict for the staged tree: ${status.verdict}; for HEAD's tree: ${status.headVerdict ?? '(no commit yet)'}${status.headAccepted ? ' (recorded as accepted by the gate)' : ''}`,
    `  this worktree: ${yesNo(status.openForProposals, 'open for proposals', 'closed for proposals')}`,
    `  ${status.exemptions === null ? 'Exempt branches: unknown (see the problems).' : TEXT.exemptions(status.exemptions)}`,
    `  ${status.waivers === null ? 'Waivers: unknown (see the problems).' : TEXT.waivers(status.branch, status.waivers)}`,
    `  in-flight records: ${status.inflight.live.length + status.inflight.stale.length === 0 ? 'none' : [...status.inflight.live.map((pid) => `${pid} (live)`), ...status.inflight.stale.map((pid) => `${pid} (stale)`)].join(', ')}`,
    `  bin/: ${binWord(status.bin)}`,
    `  hooks: ${status.hooks.map((hook) => `${hook.name} ${hookWord(hook)}`).join(', ')}`,
    `  core.hooksPath: ${status.hooksPath === null ? 'not set' : `${shownName(status.hooksPath.value)} (${status.hooksPath.scope})`}`,
    `  git: ${status.git.version ?? 'unknown'}`,
    ...(status.problems.length === 0 ? [TEXT.noProblems] : [TEXT.problemsHeader, ...status.problems.flatMap((problem) => [`  - ${problem.text}`, `    ${nextLine(problem.next)}`])]),
  ];
}

function status(root, { json }) {
  const result = statusOf(root);
  if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else print(statusLines(root, result));
  return 0;
}

// ---- verify-branch ----

// HEAD's tree judged by the gate's checks, the switches aside. Its base is the one the gate
// recorded when it accepted HEAD's commit, else the one computed from the branch. By default the
// officers run first (on a tidy tree that is HEAD's) and the probe runs as at a commit; with
// --no-run the existing verdict is read and nothing from the repository is executed.
async function verifyBranch(root, { noRun }) {
  const head = headTree(root);
  if (head === null) return refusal(TEXT.noHead, agentCommand(root, 'run'));
  const branch = currentBranch(root);
  const read = officersOfTree(root, head);
  const { accepted, base } = headJudged(root, head, read);
  if (!noRun) {
    const filter = foreignFilter(root);
    if (filter !== null) return refusal(TEXT.filterDriver(filter.name, filter.key), FILTER_ORIGIN);
    const hidden = hiddenRefusal(root, agentCommand(root, 'verify-branch'));
    if (hidden !== null) return hidden;
    const untidy = untidyPaths(root);
    if (untidy.length > 0) return refusal(TEXT.untidyHead(untidy), `git stash -u && ${agentCommand(root, 'verify-branch')}`);
    if (indexTree(root) !== head) return refusal(TEXT.stagedChanges, `git stash && ${agentCommand(root, 'verify-branch')}`);
    if (read.problem === undefined) {
      const recorded = await runAndRecord(root, { tree: head, base, branch, officers: read.officers, command: 'verify-branch' });
      if (recorded.problem !== undefined) return refusal(TEXT.cannotRun(recorded.problem), agentCommand(root, 'status'));
      if (recorded.changed !== undefined) {
        print([TEXT.verifyHeader(branchWords(branch), head, base), ...officerLines(recorded.verdict)]);
        const rootWord = shellWord(root);
        return refusal(TEXT.treeChangedHead(recorded.changed), `git -C ${rootWord} add -- <each changed path that is wanted> && git -C ${rootWord} commit, then ${agentCommand(root, 'verify-branch')}`);
      }
    }
  }
  const decision = judge(root, { tree: head, base, branch }, { honourSwitches: false, probe: !noRun });
  const verdict = base === null ? null : readVerdict(root, head, base);
  const changes = base === null ? [] : agentRuleChanges(root, treeOfCommit(root, base), head);
  const lines = [
    TEXT.verifyHeader(branchWords(branch), head, base),
    ...(verdict === null ? [] : officerLines(verdict)),
    TEXT.exemption(branch, exemptionOf(root, branch)),
    TEXT.waivers(branch, waiversOf(root, branch)),
    TEXT.agentChanges(changes),
    accepted ? TEXT.headRecorded : TEXT.headNotRecorded,
  ];
  if (!raceHookWorks(inspectHook(root, REFERENCE_HOOK))) lines.push(TEXT.noRaceHook);
  if (decision.reason === REASONS.allowed) {
    print([...lines, TEXT.verified]);
    return 0;
  }
  // The gate's `run` judges the index against the next commit's base, not HEAD's tree against its
  // own, so following it would loop: verify-branch without --no-run runs the officers on HEAD's tree.
  const next = decision.next === COMMANDS.run ? agentCommand(root, 'verify-branch') : localNext(root, decision.next);
  print([...lines, TEXT.notVerified(decision.reason), nextLine(next)]);
  return 1;
}

// ---- the owner's commands ----

// One line from standard input: what precedes the first newline (one CR before it dropped), or
// what was read before the end; null when nothing could be read. Read a byte at a time, so a
// terminal's line is taken as soon as Enter is pressed and nothing after it is consumed.
function readAnswer() {
  const bytes = [];
  const byte = Buffer.alloc(1);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let count;
    try {
      count = readSync(0, byte, 0, 1, null);
    } catch (error) {
      if (error.code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 20);
        continue;
      }
      return null;
    }
    if (count === 0) return bytes.length === 0 ? null : Buffer.from(bytes).toString('utf8');
    if (byte[0] === 10) return Buffer.from(bytes).toString('utf8').replace(/\r$/, '');
    if (bytes.length > 1024) return '';
    bytes.push(byte[0]);
  }
}

// The approved tree approve compares the staged tree with, in order (after Task 7's review): the
// last approval on this branch that records its tree; an approved tree whose digest is the digest
// of the merge base's tree; the most recent approved tree on any branch; none. `{ record, line,
// notes }`: the approval used (or null), the line saying which, and what was passed over.
function approvalBaseline(root, { tree, branch, approvals }) {
  const usable = (entry) => entry.tree !== undefined && treeExists(root, entry.tree);
  const notes = [];
  const ofBranch = approvals.filter((entry) => entry.branch === branch && entry.tree !== undefined).at(-1);
  if (ofBranch !== undefined) {
    if (treeExists(root, ofBranch.tree)) return { record: ofBranch, line: TEXT.baselineBranch(ofBranch.tree, ofBranch.approvedAt, branch), notes };
    notes.push(TEXT.earlierTreeGone(ofBranch.tree, branch));
  }
  const read = officersOfTree(root, tree);
  if (read.problem === undefined) {
    const base = baseOf(root, read.baseBranch);
    const baseTree = treeOfCommit(root, base);
    const baseDigest = baseTree === null ? undefined : digestOfTree(root, baseTree).digest;
    const match = baseDigest === undefined ? undefined : approvals.filter((entry) => entry.digest === baseDigest && usable(entry)).at(-1);
    if (match !== undefined) return { record: match, line: TEXT.baselineMergeBase(match.tree, match.approvedAt, base, branch), notes };
  }
  const any = approvals.filter(usable).at(-1);
  if (any !== undefined) return { record: any, line: TEXT.baselineAny(any.tree, any.approvedAt, any.branch, branch), notes };
  return { record: null, line: TEXT.noEarlierApproval, notes };
}

// What approve shows before it asks: the covered files, their diff against the baseline tree
// (tree to tree: no working file is read, no external diff or text conversion runs), and the
// paths newly covered though their content is unchanged, which no diff shows.
function approvalPreview(root, { tree, digest, branch }) {
  const approvals = readApprovals(root);
  const lines = [TEXT.approveHeader(tree, digest.digest, branch), TEXT.coveredFiles(digest.paths.length), ...digest.paths.map(TEXT.coveredFile)];
  const { record, line, notes } = approvalBaseline(root, { tree, branch, approvals });
  lines.push(...notes, line);
  if (record !== null) {
    const earlier = digestOfTree(root, record.tree);
    const paths = [...new Set([...digest.paths, ...(earlier.paths ?? [])])].sort();
    const diff = git(root, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--end-of-options', record.tree, tree, '--', ...paths]);
    if (diff.status !== 0) throw new GitError(gitFailedMessage('show the changes'));
    lines.push(diff.stdout === '' ? TEXT.noChange : visible(diff.stdout.replace(/\n$/, '')));
    if (earlier.paths !== undefined) {
      const before = new Set(earlier.paths);
      const was = new Map(listEntries(root, record.tree).map((entry) => [entry.path, entry]));
      const now = new Map(listEntries(root, tree).map((entry) => [entry.path, entry]));
      const newly = digest.paths.filter((path) => !before.has(path) && was.get(path)?.oid === now.get(path).oid && was.get(path)?.mode === now.get(path).mode);
      if (newly.length > 0) lines.push(TEXT.newlyCovered(newly));
    }
  }
  const read = officersOfTree(root, tree);
  const base = read.problem === undefined ? baseOf(root, read.baseBranch) : null;
  const baseDigest = base === null ? null : baseDigestOf(root, base);
  const standing = approvalStanding(approvals, digest.digest, () => baseDigest);
  if (standing === 'older') lines.push(TEXT.approvesOlder(digest.digest, baseDigest));
  else if (standing === 'approved') lines.push(TEXT.alreadyApproved);
  return lines;
}

function closeProposal(root, path) {
  const open = readProposals(root);
  if (open.includes(path)) writeState(root, 'proposals.json', { worktrees: open.filter((entry) => entry !== path) });
}

function approve(root) {
  const tree = indexTree(root);
  const digest = digestOfTree(root, tree);
  if (digest.problem !== undefined) return refusal(TEXT.approveUndigestable(digest.problem), agentCommand(root, 'status'));
  const branch = currentBranch(root);
  print(approvalPreview(root, { tree, digest, branch }));
  process.stdout.write(TEXT.prompt);
  const answer = readAnswer();
  process.stdout.write('\n');
  if (answer === null) return refusal(TEXT.noAnswer, ownerCommand(root, 'approve'));
  if (answer !== 'approve') return refusal(TEXT.notApproved, ownerCommand(root, 'approve'));
  try {
    // First: a tree whose scripts cannot make a working bin/ records nothing.
    refreshBin(root, tree);
  } catch (error) {
    if (error instanceof StateError) return refusal(error.message, ownerCommand(root, 'approve'));
    throw error;
  }
  // Then the tree is pinned, so it cannot be pruned (after Task 9's re-reviews): only once bin/ was
  // refreshed, and taken out again if the approval cannot then be recorded, unless an earlier
  // approval of the same digest had pinned it already.
  const pinnedBefore = isPinned(root, digest.digest);
  try {
    pinTree(root, digest.digest, tree);
  } catch (error) {
    if (error instanceof GitError) return refusal(TEXT.pinFailed, ownerCommand(root, 'approve'));
    throw error;
  }
  try {
    // Read and written together; no lock (see the header). Every approval is a new record at the
    // end, a digest approved again included (approvals are ordered: approvalStanding reads each
    // digest's latest), so the last record is always the tree bin/ was refreshed from.
    writeState(root, 'approvals.json', { digests: [...readApprovals(root), { digest: digest.digest, tree, approvedAt: new Date().toISOString(), branch }] });
  } catch (error) {
    if (!pinnedBefore) {
      try {
        unpinTree(root, digest.digest);
      } catch {
        // the approval's own failure is the one reported
      }
    }
    throw error;
  }
  closeProposal(root, realpathSync(root));
  removeStaleInflight(root);
  print([TEXT.approved(digest.digest, tree), nextLine(TEXT.approvedNext(agentCommand(root, 'run')))]);
  return 0;
}

function propose(root) {
  const path = realpathSync(root);
  const next = nextLine(ownerCommand(root, 'approve'));
  // Read and written together; no lock (see the header).
  const open = readProposals(root);
  if (open.includes(path)) {
    print([TEXT.alreadyProposed(path), next]);
    return 0;
  }
  writeState(root, 'proposals.json', { worktrees: [...open, path] });
  print([TEXT.proposed(path), next]);
  return 0;
}

function waive(root, { rule, reason }) {
  const branch = currentBranch(root);
  if (branch === null) return refusal(TEXT.waiveDetached, 'git switch <branch>');
  // Read and written together; no lock (see the header).
  const others = readWaivers(root).filter((entry) => !(entry.rule === rule && entry.branch === branch));
  const waivers = [...others, { rule, branch, reason, at: new Date().toISOString() }];
  writeState(root, 'waivers.json', { waivers });
  print([TEXT.waived(rule, branch), TEXT.waivers(branch, waivers.filter((entry) => entry.branch === branch)), nextLine(agentCommand(root, 'run'))]);
  return 0;
}

// A branch's short name as git accepts it: not an option, not `@`, not a refs/ path (an exemption
// is matched against the short name), and unchanged by git check-ref-format --branch (which would
// turn @{-1} into the branch it names).
function branchName(root, name) {
  const checked = git(root, ['check-ref-format', '--branch', name]);
  if (name.startsWith('-') || name === '@' || name.startsWith('refs/') || checked.status !== 0 || checked.stdout.replace(/\n$/, '') !== name) throw new UsageError(TEXT.badBranch(name));
  return name;
}

function exempt(root, { branch, reason }) {
  const name = branchName(root, branch);
  // Read and written together; no lock (see the header).
  const branches = [...readExemptions(root).filter((entry) => entry.name !== name), { name, reason, at: new Date().toISOString() }];
  writeState(root, 'exemptions.json', { branches });
  print([TEXT.exempted(name), TEXT.exemptions(branches), nextLine(commandLine(agentCommand(root, 'unexempt'), [name]))]);
  return 0;
}

function unexempt(root, { branch }) {
  // Read and written together; no lock (see the header).
  const before = readExemptions(root);
  const branches = before.filter((entry) => entry.name !== branch);
  if (branches.length === before.length) {
    print([TEXT.notExempt(branch), TEXT.exemptions(branches)]);
    return 0;
  }
  writeState(root, 'exemptions.json', { branches });
  print([TEXT.unexempted(branch), TEXT.exemptions(branches)]);
  return 0;
}

function off(root) {
  switchOff(root);
  const onCommand = ownerCommand(root, 'on');
  print([TEXT.off(onCommand), nextLine(onCommand)]);
  return 0;
}

function on(root) {
  switchOn(root);
  print([TEXT.on, nextLine(agentCommand(root, 'status'))]);
  return 0;
}

// ---- arguments ----

// Each command: whether it is the owner's, how many operands (and what they are called), which
// flags it takes, and whether it takes --reason.
const SPECS = {
  run: { operands: [], flags: [] },
  status: { operands: [], flags: ['--json'] },
  'verify-branch': { operands: [], flags: ['--no-run'] },
  unexempt: { operands: ['a branch name'], flags: [] },
  approve: { owner: true, operands: [], flags: [] },
  propose: { owner: true, operands: [], flags: [] },
  waive: { owner: true, operands: ['a rule id'], flags: [], reason: true },
  exempt: { owner: true, operands: ['a branch name'], flags: [], reason: true },
  off: { owner: true, operands: [], flags: [] },
  on: { owner: true, operands: [], flags: [] },
};

function parse(command, words) {
  const spec = SPECS[command];
  const operands = [];
  const flags = new Set();
  let reason;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (spec.reason && word === '--reason') {
      // Absent when --reason is the last word: then reasonMissing says what is needed.
      reason = words[index + 1];
      index += 1;
    } else if (spec.reason && word.startsWith('--reason=')) {
      reason = word.slice('--reason='.length);
    } else if (spec.flags.includes(word)) {
      flags.add(word);
    } else if (!word.startsWith('-') && operands.length < spec.operands.length) {
      operands.push(word);
    } else {
      throw new UsageError(TEXT.unexpectedArgument(command, word));
    }
  }
  if (operands.length < spec.operands.length) throw new UsageError(TEXT.missingOperand(command, spec.operands[operands.length]));
  return { operands, flags, reason: spec.reason ? cleanReason(command, reason) : undefined };
}

// The next line of the session refusal: the approved copy's command when the repository can be
// found, the working copy's otherwise (there is then no shared state to name).
function ownerNext(command) {
  const root = repoRoot(process.cwd());
  return `${root === null ? `${KO} ${command}` : ownerCommand(root, command)}, in the owner's own terminal`;
}

async function dispatch(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, ...words] = argv;
  if (command === undefined) throw new UsageError(TEXT.noCommand);
  if (!Object.hasOwn(SPECS, command)) throw new UsageError(TEXT.unknownCommand(command));
  const isOwners = SPECS[command].owner === true;
  if (isOwners) {
    // This process's own environment, never one passed in (after Task 7's review).
    const variable = OWNER_VARIABLES.find((name) => process.env[name] !== undefined);
    if (variable !== undefined) return refusal(TEXT.ownerOnly(command, variable), ownerNext(command));
  }
  const { operands, flags, reason } = parse(command, words);
  if (command === 'waive' && !RULE_ID.test(operands[0])) throw new UsageError(TEXT.badRule(operands[0]));
  const root = repoRoot(process.cwd());
  if (root === null) return refusal(TEXT.notARepository, `cd <the repository> && ${KO} ${command}`);
  if (isOwners && !fromApprovedCopy(root)) return refusal(TEXT.notFromBin(command), ownerLine(root, argv));
  switch (command) {
    case 'run': return run(root);
    case 'status': return status(root, { json: flags.has('--json') });
    case 'verify-branch': return verifyBranch(root, { noRun: flags.has('--no-run') });
    case 'unexempt': return unexempt(root, { branch: operands[0] });
    case 'approve': return approve(root);
    case 'propose': return propose(root);
    case 'waive': return waive(root, { rule: operands[0], reason });
    case 'exempt': return exempt(root, { branch: operands[0], reason });
    case 'off': return off(root);
    default: return on(root);
  }
}

/**
 * Runs one ko.mjs command, `argv` as typed after `ko.mjs`, in this process's working directory and
 * environment, and returns its exit code: 0 done, 1 refused or failing, 2 usage. Never throws: a
 * failure is printed as fixed text and is exit 1.
 */
export async function main(argv) {
  try {
    return await dispatch(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`kh-orchestration: ${error.message}\n${USAGE}`);
      return 2;
    }
    const root = repoRoot(process.cwd());
    return refusal(TEXT.failed(failureReason(error)), root === null ? COMMANDS.status : agentCommand(root, 'status'));
  }
}
