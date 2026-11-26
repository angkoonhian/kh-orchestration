// The installer (Task 9): what `apply`, `detect` and `uninstall` do, as functions the three
// commands in scripts/ call. It runs from the PLUGIN and imports only the plugin's own shipped
// copies in assets/scripts/, never a target's installed copies, which may be damaged or hostile.
// It executes nothing from the target repository: git reads it, and the only programs started are
// the plugin's own scripts (bin/'s pre-flight, the hooks' self-test) and /bin/sh.
//
// `plan(dir)` is the dry run, as data: `{ root, env, node, refusals, actions, conflicts, notes }`.
// Refusals and conflicts are `{ text, next }`, fixed text and the command to run next; an action is
// `{ kind, path, detail, ... }`, `detail` the line printed for it. It writes nothing (it copies what
// the contract check and the self-test need into temporary directories outside the repository).
// `applyPlan(root, planned)` performs the actions in order: (a) the fourteen scripts into
// .claude/kh-orchestration/scripts/; (b) officers.json when there is none; (c) the line
// `.claude/** -text` in .gitattributes; (d) the entry in kh-harness's extensions file; (e) the
// shared state directory and bin/, from the plugin's shipped scripts through ko-state's pre-flight;
// (f) the three git hooks into <git-common-dir>/hooks/, then the self-test; (g) stale in-flight
// records removed. The manifest is written after each write: before a file that did not exist is
// created (so a kill leaves it recorded), and after a file that existed is replaced (so a kill
// never makes an untouched old file look edited). Every write is whole, by temporary file and
// rename. A kill after any write leaves a state the next apply completes and uninstall cleans.
//
// What counts as kh-orchestration's own, and is therefore updated or removed: an installed script
// whose bytes are the ones this kit ships, or that carries the stamp line and either is not
// recorded or still hashes to what the manifest records (line endings aside); a git hook whose
// header names kh-orchestration and that hook (for uninstall: one byte for byte as recorded or as
// this kit writes it); the extensions entry whose id is kh-orchestration's. Anything else is the
// owner's, kept and reported.
//
// bin/ (amended decision 5 and the ledger's carry to Task 9). apply leaves bin/ as it is when it
// holds exactly the plugin's shipped scripts, or exactly the scripts of the last approval that
// records a tree (an intact approved copy, so an owner's approval is never undone by a re-run).
// Otherwise — no bin/, a file missing, damaged or extra — it replaces bin/ with the plugin's
// shipped scripts, through the same pre-flight approve uses; when an approval records a tree whose
// scripts are not the shipped ones, it says that the approved copy was replaced by the plugin's
// own, and that the owner approves again (after staging the installed scripts) to make bin/ the
// approved tree's.
import { spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTRIBUTES_FILE, ATTRIBUTES_LINE, MANIFEST_PATH, OFFICERS_PATH, RECORDED_PATHS, SCRIPTS_DIR, SCRIPT_NAMES, emptyManifest, readManifest, readRegular, sha256,
  writeManifest, writeWhole,
} from './manifest.mjs';
import { COMMANDS, PROTECTED_FILES, PROTECTED_PREFIXES, matchesGlob, readOfficers, shellWord } from '../../assets/scripts/extension.mjs';
import { OWNER_VARIABLES, TEXT as KO_TEXT, agentCommand, askOwner, gitVersion, statusOf } from '../../assets/scripts/ko-cli.mjs';
import { EXTENSION_ID, MODULE, STAMP, entryOf } from '../../assets/scripts/ko-contract.mjs';
import { hashesTo } from '../../assets/scripts/ko-digest.mjs';
import { REASONS } from '../../assets/scripts/ko-gate.mjs';
import { APPROVED_REFS, GitError, commonDir, currentBranch, git, headTree, repoRoot } from '../../assets/scripts/ko-git.mjs';
import { officersOfTree } from '../../assets/scripts/ko-officers.mjs';
import { digestOfTree } from '../../assets/scripts/ko-digest.mjs';
import { HOOK_NAMES, REFUSED_TEXT, hookLine, hookParts, hookText, hostedParts } from '../../assets/scripts/ko-hooks.mjs';
import {
  StateError, binEntriesOf, checkLoads, listInflight, ownerCommand, readApprovals, refreshBin, removeStaleInflight, replaceBin, stateDir, treeScripts,
} from '../../assets/scripts/ko-state.mjs';
import { checkContract1 } from '../../assets/scripts/verify-contract-1.mjs';

export { ATTRIBUTES_LINE, OFFICERS_PATH, SCRIPTS_DIR, SCRIPT_NAMES };

export const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const KIT_VERSION = JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version;
export const EXTENSIONS_PATH = '.claude/kh-harness/extensions.json';
const CONTRACT_PATH = '.claude/kh-harness/contract.json';
const ENV_CANDIDATES = ['/usr/bin/env', '/bin/env'];
const SHELL = '/bin/sh';
const MIN_GIT = '2.30';
// kh-harness's limits for the extensions file (CONTRACT.md, "The extensions file").
const EXTENSIONS_MAX_BYTES = 65536;
const ENTRIES_MAX = 8;
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_HOOK_BYTES = 64 * 1024;
const MAX_SMALL_FILE_BYTES = 1024 * 1024;
const SELF_TEST_TIMEOUT_MS = 30_000;
const SELF_TEST_HOOK = 'self-test';
const REFUSED_LINE = `${REFUSED_TEXT}\n`;
// The package scripts that become tool officers, in this order (amended decision 6).
const PACKAGE_OFFICERS = ['lint', 'typecheck', 'test'];
// The commands whose officers read package.json, which their argv does not name.
const PACKAGE_RUNNERS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun']);

/**
 * `bytes` as installed for kit `version`: one stamp line of decision 2 for that version, then the
 * file. A file that begins with a stamp line already (verify-contract-1.mjs, copied with one) has
 * that line replaced, so a version bump never stamps it twice.
 */
export function stampScript(bytes, version) {
  const text = bytes.toString('utf8');
  const stamp = text.match(STAMP);
  return Buffer.concat([Buffer.from(`// Generated by kh-orchestration ${version}. Do not edit.\n`), stamp === null ? bytes : bytes.subarray(Buffer.byteLength(stamp[0]))]);
}
let shipped;
/**
 * The fourteen scripts as this kit installs them, `[{ name, bytes }]` in SCRIPT_NAMES order: the
 * stamp line of decision 2, then the file of assets/scripts/ (verify-contract-1.mjs carries the
 * stamp already, decision 4).
 */
export function shippedScripts() {
  shipped ??= SCRIPT_NAMES.map((name) => ({ name, bytes: stampScript(readFileSync(join(PLUGIN_DIR, 'assets', 'scripts', name)), KIT_VERSION) }));
  return shipped;
}
const shippedBytes = (name) => shippedScripts().find((script) => script.name === name).bytes;

// The entry this kit writes in kh-harness's extensions file: ko-contract's, for the shipped extension.
const ownEntryShipped = () => entryOf(shippedBytes('extension.mjs'));

/** The absolute path the hooks start env by: the first of /usr/bin/env and /bin/env that is an executable file; null when neither is. Never found through PATH. */
export function envPath() {
  for (const path of ENV_CANDIDATES) {
    try {
      if (statSync(path).isFile()) {
        accessSync(path, constants.X_OK);
        return path;
      }
    } catch {
      // not this one
    }
  }
  return null;
}

const commandOf = (name, root, flags) => `node ${shellWord(join(PLUGIN_DIR, 'scripts', `${name}.mjs`))} ${shellWord(root)}${flags}`;
/** The repair and the install: this plugin's apply, by its real path, for `root`. */
export const applyCommand = (root) => commandOf('apply', root, ' --yes');
const detectCommand = (root) => commandOf('detect', root, '');
/** kh-harness's own apply, which only the owner knows the path of. */
export const khHarnessApply = (root) => `node <kh-harness>/scripts/apply.mjs ${shellWord(root)} --yes`;

const sentence = (text) => `${text.replace(/\.$/, '')}.`;
// Exactly what apply writes in the working tree, never .claude as a whole (after Task 9's review):
// .claude holds the owner's settings.local.json and whatever else they keep there.
const WRITTEN_PATHS = ['.claude/kh-orchestration', MANIFEST_PATH, EXTENSIONS_PATH, ATTRIBUTES_FILE];
const stageCommand = (root) => `git -C ${shellWord(root)} add -- ${WRITTEN_PATHS.join(' ')}`;
const USAGES = {
  apply: '<repository> [--yes] [--downgrade] [--bin-from-plugin]',
  detect: '<repository> [--json]',
  uninstall: '<repository> [--yes] [--state]',
};

// Every text the three commands print, with values substituted.
export const TEXT = Object.freeze({
  usage: (command) => `node ${shellWord(join(PLUGIN_DIR, 'scripts', `${command}.mjs`))} ${USAGES[command]}`,
  missingRepository: 'No repository was given.',
  unexpectedArgument: (word) => `${word} is not an argument this command takes.`,

  notADirectory: (dir) => `${dir} is not a directory.`,
  gitMissing: 'git could not be run, so nothing can be installed or checked.',
  oldGit: (version) => KO_TEXT.oldGit(version),
  notARepository: (dir) => `${dir} is not inside a git working tree, so there is nothing to install kh-orchestration into.`,
  manifestCorrupt: `${MANIFEST_PATH} exists but is not a manifest kh-orchestration writes, so what an earlier install wrote cannot be known and nothing is changed. Restore it from git, or remove it if no install is left.`,
  isLink: (path) => `${path} is a link or not a directory: kh-harness contract 1 is not available through a link, and kh-orchestration writes nothing through one.`,
  noContract: '.claude/kh-harness/contract.json is missing: kh-orchestration relies on kh-harness contract 1, so kh-harness 0.3.0 or later must be installed first.',
  wrongContract: (value) => `.claude/kh-harness/contract.json says contract ${value}; kh-orchestration works with kh-harness contract 1 only.`,
  contractWouldFail: (problem) => `kh-harness contract 1 would not hold for kh-orchestration's extension even once its entry is written: ${problem}. kh-orchestration relies on the extension, so nothing is installed.`,
  extensionsMalformed: (problem) => `${EXTENSIONS_PATH} cannot be used (${problem}), and kh-orchestration changes only an extensions file it can read. Repair it outside Claude Code: other plugins' entries may be in it too.`,
  extensionsFull: `${EXTENSIONS_PATH} lists ${ENTRIES_MAX} extensions already, the most kh-harness runs, and kh-orchestration never drops another plugin's entry to make room. Remove a plugin that registered one first.`,
  hooksPath: (value, scope, file) => `${KO_TEXT.hooksPath(value, scope)} It is set in ${file}. kh-orchestration changes no configuration of yours: unset it, then run apply again.`,
  commandLineConfig: 'the configuration given on the command line or through GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT',
  configUnreadable: 'The git configuration could not be read, so it is not known whether core.hooksPath turns the hooks off; nothing is written.',
  downgrade: (version) => `The install here is kh-orchestration ${version}, newer than this plugin's ${KIT_VERSION}: applying would replace it with an older kit. Run apply from kh-orchestration ${version} or later, or give --downgrade to mean it.`,
  downgradeScript: (path, version) => `replace ${path} (a downgrade, from kh-orchestration ${version} to ${KIT_VERSION})`,
  gitattributesNotFile: `${ATTRIBUTES_FILE} is not a regular file, so the line ${ATTRIBUTES_LINE} cannot be added to it.`,
  noEnv: `Neither ${ENV_CANDIDATES.join(' nor ')} is an executable file, and the hooks start Node through env by its absolute path, never through PATH.`,
  noShP: `${SHELL} does not accept -p, which the hooks use so that no function or startup file of the environment can change what they run.`,
  gateDidNotAnswer: 'the gate did not answer through the env and Node the hooks name',
  hookTextDiffers: 'an installed hook is not the text that was written',
  fastPathFailed: 'the reference-transaction hook did not let a ref update without an in-flight record through',
  binUnreadable: 'bin/ could not be read',
  selfTestFailed: (what) => `The hooks kh-orchestration would write could not start the commit gate here (${what}), so nothing is installed.`,
  selfTestRemoved: (what) => `The hooks just written could not start the commit gate (${what}), so they were removed: hooks that cannot run the gate would refuse every commit.`,
  writeFailed: (path) => `${path} could not be written; what was written before it is recorded in ${MANIFEST_PATH}.`,
  binShippedPreflight: (script) => `kh-orchestration's own ${script} does not load with this Node, so bin/ was not replaced. Reinstall the plugin, or run it with Node 22 or later.`,
  ownerOnly: (command, variable) => `${command} --yes is the owner's to run in their own terminal, outside Claude Code: ${variable} is set here, so this is a Claude Code session. Nothing was changed.`,
  askOwner,

  createScript: (path) => `write ${path} (new)`,
  updateScript: (path, version) => `update ${path} (from kh-orchestration ${version} to ${KIT_VERSION})`,
  createOfficers: (baseBranch, ids) => `write ${OFFICERS_PATH} (new): base branch ${baseBranch}, ${ids.length === 0 ? 'no officer' : `officers ${ids.join(', ')}`}, nothing in "protected"`,
  createAttributes: `write ${ATTRIBUTES_FILE} (new) holding the line ${ATTRIBUTES_LINE}`,
  appendAttributes: `add the line ${ATTRIBUTES_LINE} to ${ATTRIBUTES_FILE}`,
  addEntry: (created) => `add kh-orchestration's entry to ${EXTENSIONS_PATH}${created ? ' (new)' : ''}`,
  updateEntry: `update kh-orchestration's entry in ${EXTENSIONS_PATH}`,
  unregisterEntry: `remove kh-orchestration's entry from ${EXTENSIONS_PATH} while its extension.mjs is replaced, so kh-harness never runs a module whose hash the entry does not name (until it is written again, tool calls run unchecked by kh-orchestration and the gate refuses commits)`,
  createBin: (path) => `create ${path}/ from kh-orchestration ${KIT_VERSION}'s scripts`,
  replaceBin: (path, names) => `replace ${path}/ with kh-orchestration ${KIT_VERSION}'s scripts (it differs: ${names.join(', ')})`,
  writeHook: (path) => `write the git hook ${path} (new)`,
  rewriteHook: (path) => `rewrite the git hook ${path} (it names kh-orchestration but is not the exact text this version writes for this env and Node; any edit made in it is discarded)`,
  removeInflight: (pids) => `remove the in-flight records of git processes that have ended: ${pids.join(', ')}`,
  record: (what) => `record ${what} in ${MANIFEST_PATH} (already in place)`,

  scriptNotOurs: (path) => `${path} is kept as it is: it does not begin with kh-orchestration's stamp line, so kh-orchestration did not write it and never overwrites it. The path is kh-orchestration's own script's: move the file elsewhere to keep it, then run apply again.`,
  scriptEdited: (path) => `${path} is kept as it is: it was changed since kh-orchestration wrote it, and kh-orchestration never overwrites a change it did not make. To take this version, restore it (git checkout -- ${path}), then run apply again.`,
  hooksStopped: 'The git hooks are not written while an installed script is kept: the install is incomplete until the scripts above are kh-orchestration\'s.',
  extensionSkipped: `kh-orchestration's entry in ${EXTENSIONS_PATH} is not written while ${MODULE} is kept: the entry would register bytes kh-orchestration did not ship.`,
  hookConflict: (name, path, line) => `The ${name} hook at ${path} is not kh-orchestration's, so it is not written over. To run the commit gate from it, add this line directly after its first line:\n    ${line}`,
  hostedStale: (name, path, line) => `The ${name} hook at ${path} holds kh-orchestration's line for another env or Node, so the commit gate may not start from it. Replace that line with this one:\n    ${line}`,
  hostedNotExecutable: (name, path) => `The ${name} hook at ${path} holds kh-orchestration's line but is not executable, so git skips it.`,
  hostedRemains: (name, path) => `The ${name} hook at ${path} is not kh-orchestration's and is left as it is, but it still holds kh-orchestration's line, which refuses every commit once kh-orchestration is gone: remove that line from it by hand.`,

  baseBranchMain: 'officers.json names main as the base branch: the repository has a branch main.',
  baseBranchMaster: 'officers.json names master as the base branch: the repository has a branch master and no main.',
  baseBranchCurrent: (branch) => `officers.json names ${branch}, the current branch, as the base branch: the repository has no branch main or master. Change baseBranch in ${OFFICERS_PATH} before approving if another branch is the base.`,
  baseBranchNone: `officers.json names main as the base branch: the repository has no branch main or master and HEAD is detached. Change baseBranch in ${OFFICERS_PATH} before approving.`,
  officersFound: (ids) => `officers.json holds a tool officer for each of ${ids.join(', ')}, the scripts the root package.json has among ${PACKAGE_OFFICERS.join(', ')}, each run as npm run <name>.`,
  noOfficerScripts: `officers.json holds no officer: the root package.json has none of the scripts ${PACKAGE_OFFICERS.join(', ')}. Add officers before relying on the gate.`,
  noPackageJson: 'officers.json holds no officer: there is no root package.json. Add officers before relying on the gate.',
  packageJsonUnreadable: 'officers.json holds no officer: the root package.json could not be read as JSON. Add officers before relying on the gate.',
  restoreBin: (path, tree) => `restore ${path}/ from the scripts of the last approved tree (${tree.slice(0, 12)})`,
  restoreBinFromHead: (path, tree) => `restore ${path}/ from HEAD's tree (${tree.slice(0, 12)}), whose protected files have the last approved digest: the approved tree itself is no longer in the object store`,
  restoreBinFromBase: (path, branch, tree) => `restore ${path}/ from the tree of the base branch ${branch} (${tree.slice(0, 12)}), whose protected files have the last approved digest: the approved tree itself is no longer in the object store`,
  noApprovedSource: (digest) => `No tree whose protected files have the last approved digest (${digest.slice(0, 12)}) is in the object store, not the approved tree, HEAD's or the base branch's, so bin/ cannot be restored from approved scripts. The owner can let bin/ hold kh-orchestration's own scripts, keeping every approval, verdict and record, then approve again.`,
  approvedBinFails: (tree, reason) => `The scripts of the last approved tree (${tree.slice(0, 12)}) do not load here: ${reason} So bin/ is not restored from them, and nothing is written. The owner can let bin/ hold kh-orchestration's own scripts, keeping every approval, verdict and record, then approve again.`,
  scriptDoesNotLoad: (script) => `${script} does not load (a syntax error, a missing file, or a script it imports that is missing or damaged).`,
  binFromPluginAction: (path) => `replace ${path}/ with kh-orchestration ${KIT_VERSION}'s own scripts (--bin-from-plugin), keeping every approval, verdict and record`,
  binFromPlugin: `bin/ now holds kh-orchestration ${KIT_VERSION}'s own scripts, which nobody approved in this repository: the owner approves again (stage the install, then approve) to put an approved copy there.`,
  approvalsUnreadable: (reason) => `The approvals cannot be read (${reason.replace(/\.$/, '')}), so it is not known which scripts bin/ should hold; nothing is written.`,

  header: (root, dryRun) => `kh-orchestration ${KIT_VERSION} apply for ${root}${dryRun ? ' (dry run: nothing is written)' : ''}`,
  actionsHeader: 'Actions:',
  notesHeader: 'Notes:',
  conflictsHeader: 'Conflicts (the install is incomplete while they stand):',
  nothingToDo: (root) => `kh-orchestration ${KIT_VERSION} is installed in ${root} and up to date: nothing to do.`,
  dryRunEnd: (command) => `Nothing was written. To apply, ${askOwner(command)}`,
  incomplete: 'The install is incomplete: the conflicts above are left as they are, so git does not run the commit gate yet. Resolve them and run apply again.',
  installed: (root) => `kh-orchestration ${KIT_VERSION} is installed in ${root}.`,
  notApprovedYet: 'Nothing is approved yet: the commit gate refuses every commit until the owner approves the protected files.',
  approveAgain: 'The files this run changed are protected: the commit gate refuses every commit until the owner approves them again.',
  steps: (root, approve, run) => [
    `1. Read what was installed: ${OFFICERS_PATH} (the officers, and what else to lock under "protected") and the scripts in ${SCRIPTS_DIR}/.`,
    `2. Stage the install, so the tree holds what the gate checks: ${stageCommand(root)}`,
    `3. Approve, in your own terminal outside Claude Code: cd ${shellWord(root)} && ${approve}`,
    `4. Run the officers on the staged tree: cd ${shellWord(root)} && ${run}`,
    `5. Commit: git -C ${shellWord(root)} commit`,
  ],
  repaired: 'Nothing in the working tree changed: the hooks and bin/ are in place.',
  coverageHeader: 'What the digest locks, per officer (as the working copy\'s officers.json says):',
  coverageLine: ({ id, command, covered, notLocked }) => `  - ${id} (${command}): ${covered.length === 0 ? 'the digest covers no file of its own' : `the digest covers ${covered.join(', ')}`}${notLocked.map((text) => `; ${text}`).join('')}. What it runs beyond that (tools it installs, the code under test, anything not in "protected") is not locked.`,
  noOfficers: '  - officers.json names no officer: a commit then needs only the approval of the protected files.',
  officersUnreadable: `  - ${OFFICERS_PATH} is absent or not an officers file, so nothing can be said of what it locks.`,
  packageJsonNotLocked: `package.json is not protected: add it to "protected" in ${OFFICERS_PATH} to lock it`,
  directoryNotLocked: (path) => `the directory ${path} is not locked: add "${path}/**" to "protected" in ${OFFICERS_PATH} to lock it`,

  removeHook: (path) => `remove the git hook ${path}`,
  removeState: (path) => `remove the shared state directory ${path}/ (verdicts, approvals, exemptions, waivers, accepted records and bin/) and the refs under ${APPROVED_REFS} that pin approved trees`,
  removeEntry: (last) => (last ? `remove ${EXTENSIONS_PATH} (kh-orchestration's entry was its last)` : `remove kh-orchestration's entry from ${EXTENSIONS_PATH}`),
  removeAttributesLine: `remove the line ${ATTRIBUTES_LINE} from ${ATTRIBUTES_FILE}`,
  removeAttributesFile: `remove ${ATTRIBUTES_FILE} (kh-orchestration created it for the line ${ATTRIBUTES_LINE})`,
  removeFile: (path) => `remove ${path}`,
  removeManifest: `remove ${MANIFEST_PATH}`,
  keepManifest: `keep ${MANIFEST_PATH}, recording only what is kept`,
  keptHook: (path) => `kept: the git hook ${path} was changed since kh-orchestration wrote it, and it still starts the commit gate, which now refuses every commit: remove it (rm -- ${shellWord(path)}) or take kh-orchestration's lines out of it`,
  keptEdited: (path) => `kept: ${path} was changed since kh-orchestration wrote it`,
  keptNotOurs: (path) => `kept: ${path} does not begin with kh-orchestration's stamp line`,
  keptOfficers: `kept: ${OFFICERS_PATH} was changed since kh-orchestration wrote it, so it is the owner's work`,
  stateRemains: (path) => `The shared state directory ${path}/ remains (verdicts, approvals, exemptions, waivers, accepted records, bin/); uninstall --state removes it.`,
  nothingRecorded: (root) => `No kh-orchestration install is recorded in ${root} (there is no ${MANIFEST_PATH}).`,
  uninstallHeader: (root, dryRun) => `kh-orchestration ${KIT_VERSION} uninstall for ${root}${dryRun ? ' (dry run: nothing is removed)' : ''}`,
  keptHeader: 'Kept (the owner\'s now):',
  uninstallDryEnd: (command) => `Nothing was removed. To uninstall, ${askOwner(command)}`,
  uninstalled: (root) => `kh-orchestration is uninstalled from ${root}.`,
  nothingToRemove: 'Nothing to remove.',
  statusUnreadable: 'an unexpected error stopped it',
  stageAndApprove: (root) => `stage the install (${stageCommand(root)}), then ${askOwner(`cd ${shellWord(root)} && ${ownerCommand(root, 'approve')}`)}`,
  approveNext: (root) => askOwner(`cd ${shellWord(root)} && ${ownerCommand(root, 'approve')}`),
  allClear: 'nothing: the install is complete and the commit gate is on',
  unexpected: (command) => `${command} could not finish: an unexpected error stopped it. What was written before it is recorded in ${MANIFEST_PATH}.`,
  uninstallCommand: (root, state) => `${commandOf('uninstall', root, ' --yes')}${state ? ' --state' : ''}`,
});

// ---- the commands' arguments ----

/**
 * The arguments of `command` (apply, detect or uninstall): `{ help: true }` for --help or -h;
 * `{ repo, flags }` for one repository and flags from `allowed`; `{ usage }`, the reason, otherwise.
 */
export function parseArguments(argv, allowed) {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const words = argv.filter((word) => !allowed.includes(word));
  const unexpected = words.find((word) => word.startsWith('-')) ?? words[1];
  if (unexpected !== undefined) return { usage: TEXT.unexpectedArgument(unexpected) };
  if (words.length === 0) return { usage: TEXT.missingRepository };
  return { repo: words[0], flags: new Set(argv.filter((word) => allowed.includes(word))) };
}

/** Runs a command's `main` (argv → exit code) so that no failure prints anything but fixed text. */
export function runCommand(command, main) {
  // A reader that stops early (`| head`) is no failure of the command, and no trace.
  process.stdout.on('error', () => {});
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch {
    process.exitCode = 1;
    process.stderr.write(`kh-orchestration: ${TEXT.unexpected(command)}\nNext: ${TEXT.usage('detect')}\n`);
  }
}

/** Prints refusals as every command prints one, and returns the exit code 1. */
export function refuse(refusals) {
  for (const refusal of refusals) process.stderr.write(`kh-orchestration: ${refusal.text}\nNext: ${refusal.next}\n`);
  return 1;
}

/** Prints a usage error and returns the exit code 2. */
export function usageError(command, reason) {
  process.stderr.write(`kh-orchestration: ${reason}\nusage: ${TEXT.usage(command)}\n`);
  return 2;
}

export const print = (lines) => process.stdout.write(`${lines.join('\n')}\n`);

/**
 * The refusal of a writing run of `command` ('apply' or 'uninstall') in a Claude Code session, its
 * next line asking the owner to run `line`; null outside a session (after Task 9's review: both are
 * the owner's). Read from this process's own environment; the extension blocks the ways a session
 * could clear it (env -i, env -).
 */
export function ownerRefusal(command, line) {
  const variable = OWNER_VARIABLES.find((name) => process.env[name] !== undefined);
  return variable === undefined ? null : { text: TEXT.ownerOnly(command, variable), next: askOwner(line) };
}

// ---- small helpers ----

class InstallError extends Error {}

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRealDirectory = (path) => lstatOrNull(path)?.isDirectory() === true;
const branchExists = (root, name) => git(root, ['show-ref', '--verify', '-q', `refs/heads/${name}`]).status === 0;
const sameBytes = (a, b) => a !== undefined && b !== undefined && Buffer.compare(a, b) === 0;
const lfBytes = (bytes) => Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
// Whether bytes are what the manifest records for them: as written, or with CRLF read as LF.
const asRecorded = (bytes, recorded) => recorded !== undefined && (sha256(bytes) === recorded || sha256(lfBytes(bytes)) === recorded);
const stampOf = (bytes) => bytes.toString('utf8').match(STAMP)?.[1] ?? null;

/**
 * The repository `dir` is in: `{ root }`, or `{ refusal }` when it is not a directory, git cannot
 * be run or is older than 2.30, or it is not inside a working tree. `command` names the usage.
 */
function resolveRoot(dir, command) {
  const absolute = resolve(dir);
  let isDirectory;
  try {
    isDirectory = statSync(absolute).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) return { refusal: { text: TEXT.notADirectory(absolute), next: TEXT.usage(command) } };
  const version = gitVersion(absolute);
  if (version.version === null) return { refusal: { text: TEXT.gitMissing, next: 'git version' } };
  if (!version.supported) return { refusal: { text: TEXT.oldGit(version.version), next: 'git version' } };
  const root = repoRoot(absolute);
  if (root === null) return { refusal: { text: TEXT.notARepository(absolute), next: `git -C ${shellWord(absolute)} init` } };
  return { root };
}

const manifestNext = (root) => `git -C ${shellWord(root)} checkout -- ${MANIFEST_PATH}`;

// The effective core.hooksPath and where it is set, `{ value, scope, file }` (file null when it is
// not set in a file: the command line, standard input or a blob), null when it is not set, and
// undefined when the configuration cannot be read. The file is the one git names, an included
// file among them, so the unset command printed for it works there.
function hooksPathOrigin(root) {
  const result = git(root, ['config', '--show-scope', '--show-origin', '-z', '--get', 'core.hooksPath']);
  if (result.status === 1) return null;
  if (result.status !== 0) return undefined;
  const [scope, origin, value] = result.stdout.split('\0');
  return { scope, value, file: origin.startsWith('file:') ? resolve(root, origin.slice('file:'.length)) : null };
}

// Major, minor and patch of a version, compared in turn; versions that are not of that form are not compared (0).
function compareVersions(a, b) {
  const parse = (text) => /^(\d+)\.(\d+)\.(\d+)/.exec(text)?.slice(1).map(Number) ?? null;
  const [x, y] = [parse(a), parse(b)];
  if (x === null || y === null) return 0;
  return x.map((part, index) => Math.sign(part - y[index])).find((sign) => sign !== 0) ?? 0;
}

// ---- kh-harness's extensions file (CONTRACT.md, "The extensions file" and "Sharing the file") ----

const ENTRY_KEYS = ['id', 'version', 'module', 'sha256', 'onFailure'];
const isEntry = (entry) => isPlainObject(entry)
  && Object.keys(entry).length === ENTRY_KEYS.length && ENTRY_KEYS.every((key) => Object.hasOwn(entry, key))
  && typeof entry.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(entry.id)
  && typeof entry.version === 'string' && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(entry.version)
  && typeof entry.module === 'string' && entry.module.length <= 200 && /^\.claude\/[A-Za-z0-9._/-]+\.mjs$/.test(entry.module)
  && entry.module.split('/').every((segment) => segment !== '' && !segment.endsWith('.') && !segment.endsWith(' '))
  && typeof entry.sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)
  && (entry.onFailure === 'block' || entry.onFailure === 'allow');
const hasDuplicate = (values) => new Set(values).size !== values.length;

/**
 * The extensions file of `root` judged by the contract's rules, in its order: `{ state: 'absent' }`,
 * `{ state: 'malformed', problem }`, or `{ state: 'ok', text, entries }`. `.claude` and
 * `.claude/kh-harness` are checked to be real directories before this is called.
 */
function readExtensions(root) {
  const file = readRegular(join(root, EXTENSIONS_PATH), EXTENSIONS_MAX_BYTES);
  if (file.absent) return { state: 'absent' };
  if (file.unusable) {
    const stat = lstatOrNull(join(root, EXTENSIONS_PATH));
    return { state: 'malformed', problem: stat?.isFile() && stat.size > EXTENSIONS_MAX_BYTES ? `it is larger than ${EXTENSIONS_MAX_BYTES} bytes` : 'it is not a regular file' };
  }
  const text = file.bytes.toString('utf8');
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    return { state: 'malformed', problem: 'it is not JSON' };
  }
  if (!Array.isArray(list)) return { state: 'malformed', problem: 'it is not a JSON array' };
  if (list.length > ENTRIES_MAX) return { state: 'malformed', problem: `it lists more than ${ENTRIES_MAX} extensions` };
  if (hasDuplicate(list.flatMap((entry) => (typeof entry?.id === 'string' ? [entry.id] : [])))) return { state: 'malformed', problem: 'two entries share an id' };
  if (hasDuplicate(list.flatMap((entry) => (typeof entry?.module === 'string' ? [entry.module.toLowerCase()] : [])))) return { state: 'malformed', problem: 'two entries share a module' };
  const bad = list.findIndex((entry) => !isEntry(entry));
  if (bad !== -1) return { state: 'malformed', problem: `entry ${bad + 1} is not an extension entry as docs/CONTRACT.md describes one` };
  const underScripts = list.findIndex((entry) => entry.module.toLowerCase().startsWith('.claude/scripts/'));
  if (underScripts !== -1) return { state: 'malformed', problem: `entry ${underScripts + 1} names a module under .claude/scripts/, where the kit keeps its own hooks` };
  return { state: 'ok', text, entries: list };
}

// Where each element of a JSON array text starts and ends, `[{ start, end }]`. The text is known
// to parse as an array, so this only has to find the boundaries: strings are skipped whole.
function elementSpans(text) {
  const spans = [];
  let at = text.indexOf('[') + 1;
  const skipSpace = () => {
    while (at < text.length && ' \t\n\r'.includes(text[at])) at += 1;
  };
  const skipString = () => {
    at += 1;
    while (text[at] !== '"') at += text[at] === '\\' ? 2 : 1;
    at += 1;
  };
  const skipValue = () => {
    if (text[at] === '"') return skipString();
    if (text[at] !== '{' && text[at] !== '[') {
      while (at < text.length && !',]} \t\n\r'.includes(text[at])) at += 1;
      return undefined;
    }
    let depth = 0;
    do {
      if (text[at] === '"') {
        skipString();
        continue;
      }
      if (text[at] === '{' || text[at] === '[') depth += 1;
      if (text[at] === '}' || text[at] === ']') depth -= 1;
      at += 1;
    } while (depth > 0);
    return undefined;
  };
  skipSpace();
  if (text[at] === ']') return spans;
  for (;;) {
    skipSpace();
    const start = at;
    skipValue();
    spans.push({ start, end: at });
    skipSpace();
    if (text[at] !== ',') return spans;
    at += 1;
  }
}

const canonical = (list) => `${JSON.stringify(list, null, 2)}\n`;

/**
 * The extensions file's text with kh-orchestration's entry set to `entry`, or removed when `entry`
 * is null; null when no entry would be left (the file is then deleted). Every other entry keeps its
 * fields, its place and its bytes: a file in the form kh-harness's documentation shows is written
 * in that form again; any other text is changed only where kh-orchestration's entry stands.
 */
function extensionsTextWith(file, entry) {
  if (file.state === 'absent') return entry === null ? null : canonical([entry]);
  const index = file.entries.findIndex((listed) => listed.id === EXTENSION_ID);
  const next = file.entries.filter((listed) => listed.id !== EXTENSION_ID);
  if (entry !== null) {
    if (index === -1) next.push(entry);
    else next.splice(index, 0, entry);
  }
  if (next.length === 0) return null;
  if (file.text === canonical(file.entries)) return canonical(next);
  const { text } = file;
  const spans = elementSpans(text);
  const ours = JSON.stringify(entry);
  if (index !== -1 && entry !== null) return `${text.slice(0, spans[index].start)}${ours}${text.slice(spans[index].end)}`;
  if (index !== -1) {
    return index > 0
      ? `${text.slice(0, spans[index - 1].end)}${text.slice(spans[index].end)}`
      : `${text.slice(0, spans[0].start)}${text.slice(spans[1].start)}`;
  }
  if (spans.length === 0) return canonical(next);
  const last = spans.at(-1).end;
  return `${text.slice(0, last)}, ${ours}${text.slice(last)}`;
}

const sameEntry = (a, b) => ENTRY_KEYS.every((key) => a[key] === b[key]);

// ---- what is on disk, classified ----

/**
 * An installed script's state: `missing`; `current` (the shipped bytes); `older` (kh-orchestration's,
 * other bytes, `version` from its stamp: updated); `edited` (stamped, but changed since it was
 * recorded); `not-ours` (no stamp, or not a regular file).
 */
function scriptState(root, name, recorded) {
  const file = readRegular(join(root, SCRIPTS_DIR, name), MAX_SCRIPT_BYTES);
  if (file.absent) return { state: 'missing' };
  if (file.unusable) return { state: 'not-ours' };
  if (sameBytes(file.bytes, shippedBytes(name))) return { state: 'current', bytes: file.bytes };
  const version = stampOf(file.bytes);
  if (version === null) return { state: 'not-ours' };
  if (recorded === undefined || asRecorded(file.bytes, recorded)) return { state: 'older', version, bytes: file.bytes };
  return { state: 'edited', version, bytes: file.bytes };
}

/**
 * A git hook's state for this run's `env` and `node`: `missing`; `current` (the text this run
 * writes, executable); `ours` (its header names kh-orchestration and this hook: rewritten);
 * `hosted` (someone else's, holding exactly the line hookLine gives for these paths, executable:
 * it runs the gate); `hosted-other` (holding that line for other paths); `hosted-off` (holding it,
 * not executable); `not-ours`.
 */
function hookState(path, name, { env, node }) {
  const file = readRegular(path, MAX_HOOK_BYTES);
  if (file.absent) return { state: 'missing' };
  if (file.unusable) return { state: 'not-ours' };
  const text = file.bytes.toString('utf8');
  const executable = (file.mode & 0o111) === 0o111;
  if (text === hookText(name, { env, node, version: KIT_VERSION }) && executable) return { state: 'current', bytes: file.bytes };
  if (hookParts(text)?.hook === name) return { state: 'ours', bytes: file.bytes };
  const hosted = hostedParts(text, name);
  if (hosted === null) return { state: 'not-ours', bytes: file.bytes };
  if (hosted.env !== env || hosted.node !== node) return { state: 'hosted-other', bytes: file.bytes };
  return { state: executable ? 'hosted' : 'hosted-off', bytes: file.bytes };
}

// Whether a hook's bytes are exactly a text this kit writes, for the version, env and Node they name.
function isExactlyOurs(bytes, name) {
  const text = bytes.toString('utf8');
  const parts = hookParts(text);
  return parts !== null && parts.hook === name && parts.env !== null && hookText(name, parts) === text;
}

// The files of bin/ as `Map(name → bytes)`, or null when there is no bin/ directory.
function readBin(root) {
  const bin = join(stateDir(root), 'bin');
  if (!isRealDirectory(bin)) return null;
  return new Map(readdirSync(bin).map((name) => [name, readRegular(join(bin, name), MAX_SCRIPT_BYTES).bytes]));
}

const treeExists = (root, tree) => {
  const type = git(root, ['cat-file', '-t', '--end-of-options', tree]);
  return type.status === 0 && type.stdout.trim() === 'tree';
};

// The id of the tree a branch names, or null.
function branchTree(root, branch) {
  const result = git(root, ['rev-parse', '--verify', '-q', '--end-of-options', `refs/heads/${branch}^{tree}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * What bin/ should hold (after Task 9's review and re-review): `{ kind: 'shipped' }` before any
 * approval; `{ kind: 'tree', tree, detail }` for the scripts of a tree whose bytes are the approved
 * ones — the last approval's own tree when the object store still has it (approve pins it with a
 * ref), else HEAD's tree, else the base branch's, when its protected-files digest is the last
 * approved digest (the scripts are in the digest); `{ kind: 'none', digest }` when no such tree is
 * reachable; `{ kind: 'unreadable', reason }` when the approvals cannot be read.
 */
function binSource(root) {
  let approvals;
  try {
    approvals = readApprovals(root);
  } catch (error) {
    return { kind: 'unreadable', reason: error instanceof StateError ? error.message : TEXT.statusUnreadable };
  }
  const last = approvals.at(-1);
  if (last === undefined) return { kind: 'shipped' };
  if (last.tree !== undefined && treeExists(root, last.tree)) return { kind: 'tree', tree: last.tree, detail: (path) => TEXT.restoreBin(path, last.tree) };
  let head = null;
  try {
    head = headTree(root);
  } catch {
    head = null;
  }
  const approved = (tree) => tree !== null && digestOfTree(root, tree).digest === last.digest;
  if (approved(head)) return { kind: 'tree', tree: head, detail: (path) => TEXT.restoreBinFromHead(path, head) };
  const read = head === null ? null : officersOfTree(root, head);
  const branch = read?.baseBranch ?? 'main';
  const base = branchTree(root, branch);
  if (base !== head && approved(base)) return { kind: 'tree', tree: base, detail: (path) => TEXT.restoreBinFromBase(path, branch, base) };
  return { kind: 'none', digest: last.digest };
}

// Why the scripts of `tree` would not make a working bin/ (fixed text), or null when they would:
// read and verified from the object store, then loaded by the pre-flight in a temporary directory.
function treeFailsToLoad(root, tree) {
  try {
    checkLoads(treeScripts(root, tree), TEXT.scriptDoesNotLoad);
    return null;
  } catch (error) {
    return error instanceof StateError || error instanceof GitError ? error.message : TEXT.statusUnreadable;
  }
}

// The names in which `bin` differs from `expected` (a Map of name → test), sorted.
function binDifference(bin, expected) {
  const names = new Set([...bin.keys(), ...expected.keys()]);
  return [...names].filter((name) => !bin.has(name) || !expected.has(name) || !expected.get(name)(bin.get(name))).sort();
}

// ---- officers.json and what it locks ----

function baseBranchOf(root) {
  if (branchExists(root, 'main')) return { baseBranch: 'main', note: TEXT.baseBranchMain };
  if (branchExists(root, 'master')) return { baseBranch: 'master', note: TEXT.baseBranchMaster };
  const branch = currentBranch(root);
  return branch === null ? { baseBranch: 'main', note: TEXT.baseBranchNone } : { baseBranch: branch, note: TEXT.baseBranchCurrent(branch) };
}

// The officers.json apply writes, `{ bytes, ids, notes }` (amended decision 6).
function officersFile(root) {
  const { baseBranch, note } = baseBranchOf(root);
  const file = readRegular(join(root, 'package.json'), MAX_SMALL_FILE_BYTES);
  // The package's scripts, {} when it has none, null when package.json cannot be read as an object.
  let scripts = null;
  try {
    const value = JSON.parse(file.bytes?.toString('utf8'));
    if (isPlainObject(value)) scripts = isPlainObject(value.scripts) ? value.scripts : {};
  } catch {
    scripts = null;
  }
  const ids = scripts === null ? [] : PACKAGE_OFFICERS.filter((name) => Object.hasOwn(scripts, name));
  let found;
  if (file.absent) found = TEXT.noPackageJson;
  else if (scripts === null) found = TEXT.packageJsonUnreadable;
  else found = ids.length === 0 ? TEXT.noOfficerScripts : TEXT.officersFound(ids);
  const officers = ids.map((id) => ({ id, rule: null, argv: ['npm', 'run', id], appliesTo: ['**'] }));
  const value = { schema: 1, baseBranch, protected: [], officers };
  return { bytes: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), baseBranch, ids, notes: [note, found] };
}

// The kind of path an argv candidate names in the working copy: 'file', 'directory' or null.
function kindIn(root, path) {
  const stat = lstatOrNull(join(root, path));
  if (stat?.isFile()) return 'file';
  if (stat?.isDirectory()) return 'directory';
  return null;
}

/**
 * Per officer of the working copy's officers.json (amended decision 11's known limit): `{ id,
 * command, covered, notLocked }` — the files the digest covers for it beyond the fixed protected
 * paths (its scripts, and package.json when "protected" names it for a package runner), and what
 * it depends on that is not locked. Null when officers.json is absent or not an officers file.
 */
export function coverageOf(root) {
  const file = readRegular(join(root, OFFICERS_PATH), MAX_SMALL_FILE_BYTES);
  const text = file.bytes?.toString('utf8');
  const read = text === undefined ? null : readOfficers(text);
  if (read === null) return null;
  const isCovered = (path) => PROTECTED_FILES.includes(path) || PROTECTED_PREFIXES.some((prefix) => path.startsWith(prefix))
    || read.protectedGlobs.some((glob) => matchesGlob(glob, path));
  return JSON.parse(text).officers.map((officer) => {
    const candidates = read.officerCandidates.filter((candidate) => candidate.id === officer.id);
    const covered = [...new Set(candidates.filter((candidate) => kindIn(root, candidate.path) === 'file').map((candidate) => candidate.path))];
    const notLocked = [];
    if (PACKAGE_RUNNERS.has(posix.basename(officer.argv[0]))) {
      if (isCovered('package.json')) covered.push('package.json');
      else notLocked.push(TEXT.packageJsonNotLocked);
    }
    for (const candidate of candidates) {
      if (kindIn(root, candidate.path) === 'directory' && !notLocked.includes(TEXT.directoryNotLocked(candidate.path))) notLocked.push(TEXT.directoryNotLocked(candidate.path));
    }
    return { id: officer.id, command: officer.argv.join(' '), covered, notLocked };
  });
}

function coverageLines(root) {
  const coverage = coverageOf(root);
  if (coverage === null) return [TEXT.coverageHeader, TEXT.officersUnreadable];
  return [TEXT.coverageHeader, ...(coverage.length === 0 ? [TEXT.noOfficers] : coverage.map(TEXT.coverageLine))];
}

// ---- .gitattributes ----

const LINE_PRESENT = (text) => text.split('\n').some((line) => line.replace(/\r$/, '') === ATTRIBUTES_LINE);

// The patch apply makes, `{ kind, bytes }`, or null when the line is there already.
function attributesPatch(file) {
  if (file.absent) return { kind: 'create', bytes: Buffer.from(`${ATTRIBUTES_LINE}\n`) };
  const text = file.bytes.toString('utf8');
  if (LINE_PRESENT(text)) return null;
  return text === '' || text.endsWith('\n')
    ? { kind: 'append', bytes: Buffer.from(`${text}${ATTRIBUTES_LINE}\n`) }
    : { kind: 'append-after-newline', bytes: Buffer.from(`${text}\n${ATTRIBUTES_LINE}\n`) };
}

// .gitattributes without the line apply added, for the kind recorded: the exact text apply
// appended when the file still ends with it, else the last line that is the line; null when the
// file apply created would be left empty.
function attributesWithout(text, kind) {
  const appended = kind === 'append-after-newline' ? `\n${ATTRIBUTES_LINE}\n` : `${ATTRIBUTES_LINE}\n`;
  let rest;
  if (text.endsWith(appended) && (kind !== 'append' || text.length === appended.length || text[text.length - appended.length - 1] === '\n')) {
    rest = text.slice(0, -appended.length);
  } else {
    const lines = text.split('\n');
    const index = lines.findLastIndex((line) => line.replace(/\r$/, '') === ATTRIBUTES_LINE);
    lines.splice(index, 1);
    rest = lines.join('\n');
  }
  return kind === 'create' && rest === '' ? null : rest;
}

// ---- the checks made before anything is written ----

/**
 * What would still be wrong with contract 1 once kh-orchestration's entry is in: checkContract1,
 * run on a copy of the kh-harness install's files with the planned extensions file and the
 * shipped extension beside them, in a temporary directory outside the repository. Problems and
 * warnings, as one list.
 */
function contractAfter(root, entry, extensionsText) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ko-apply-contract-')));
  try {
    const copy = join(dir, 'repo');
    mkdirSync(join(copy, '.claude'), { recursive: true });
    for (const path of ['.claude/settings.json', '.claude/settings.local.json', '.claude/scripts', '.claude/kh-harness']) {
      if (lstatOrNull(join(root, path)) !== null) cpSync(join(root, path), join(copy, path), { recursive: true, verbatimSymlinks: true });
    }
    mkdirSync(join(copy, SCRIPTS_DIR), { recursive: true });
    writeFileSync(join(copy, MODULE), shippedBytes('extension.mjs'));
    if (isRealDirectory(join(copy, '.claude/kh-harness'))) {
      rmSync(join(copy, EXTENSIONS_PATH), { force: true, recursive: true });
      if (extensionsText !== null) writeFileSync(join(copy, EXTENSIONS_PATH), extensionsText);
    }
    const { problems, warnings } = checkContract1(copy, entry);
    return [...problems, ...warnings];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Runs the hooks as git would, in a scratch common directory outside the repository holding
 * `binFiles` as bin/: the shell takes -p; a hook of the same form under a name the gate does not
 * know starts env and Node as `env` and `node` and gets the gate's own refusal back; and the
 * reference-transaction text lets a ref update without an in-flight record through without
 * starting node. Null when all of that holds, else what failed (fixed text).
 */
function selfTest({ env, node, binFiles }) {
  if (spawnSync(SHELL, ['-p', '-c', 'exit 0'], { env: {}, timeout: SELF_TEST_TIMEOUT_MS }).status !== 0) return TEXT.noShP;
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ko-apply-self-test-')));
  try {
    mkdirSync(join(dir, 'hooks'));
    mkdirSync(join(dir, 'kh-orchestration', 'bin'), { recursive: true });
    for (const file of binFiles) writeFileSync(join(dir, 'kh-orchestration', 'bin', file.name), file.bytes);
    const run = (name, args) => {
      const path = join(dir, 'hooks', name);
      writeFileSync(path, hookText(name, { env, node, version: KIT_VERSION }), { mode: 0o755 });
      return spawnSync(path, args, { cwd: dir, env: {}, encoding: 'utf8', timeout: SELF_TEST_TIMEOUT_MS });
    };
    const answer = run(SELF_TEST_HOOK, []);
    const gateText = answer.stderr?.slice(0, -REFUSED_LINE.length) ?? '';
    const answered = answer.status === 1 && answer.stdout === '' && answer.stderr.endsWith(REFUSED_LINE)
      && gateText === `kh-orchestration: ${REASONS.couldNotDecide(REASONS.notAHook)}\nNext: ${COMMANDS.status}\n`;
    if (!answered) return TEXT.gateDidNotAnswer;
    for (const state of ['prepared', 'committed']) {
      const passed = run('reference-transaction', [state]);
      if (passed.status !== 0 || passed.stdout !== '' || passed.stderr !== '') return TEXT.fastPathFailed;
    }
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- plan ----

const refused = (root, refusals) => ({ root, refusals, actions: [], conflicts: [], notes: [] });

/**
 * The dry run of `apply` for the repository `dir` is in: `{ root, env, node, refusals, actions,
 * conflicts, notes }`. With a refusal there are no actions. Writes nothing.
 */
export function plan(dir, { downgrade = false, binFromPlugin = false } = {}) {
  const resolved = resolveRoot(dir, 'apply');
  if (resolved.refusal !== undefined) return refused(null, [resolved.refusal]);
  const { root } = resolved;
  const stop = (text, next) => refused(root, [{ text, next }]);
  const manifestRead = readManifest(root);
  if (manifestRead.state === 'corrupt') return stop(TEXT.manifestCorrupt, manifestNext(root));
  const manifest = manifestRead.manifest ?? null;
  for (const path of ['.claude', '.claude/kh-harness', '.claude/kh-orchestration', SCRIPTS_DIR]) {
    const stat = lstatOrNull(join(root, path));
    if (stat !== null && !stat.isDirectory()) return stop(TEXT.isLink(path), `ls -ld ${shellWord(join(root, path))}`);
  }
  const contract = readRegular(join(root, CONTRACT_PATH), EXTENSIONS_MAX_BYTES);
  if (contract.absent) return stop(TEXT.noContract, khHarnessApply(root));
  let contractNumber;
  try {
    contractNumber = JSON.parse(contract.bytes?.toString('utf8') ?? '')?.contract;
  } catch {
    contractNumber = undefined;
  }
  if (contractNumber !== undefined && contractNumber !== 1) return stop(TEXT.wrongContract(String(contractNumber)), khHarnessApply(root));
  const extensions = readExtensions(root);
  const extensionsNext = `cat ${shellWord(join(root, EXTENSIONS_PATH))}`;
  if (extensions.state === 'malformed') return stop(TEXT.extensionsMalformed(extensions.problem), extensionsNext);
  if (extensions.state === 'ok' && extensions.entries.length >= ENTRIES_MAX && !extensions.entries.some((entry) => entry.id === EXTENSION_ID)) return stop(TEXT.extensionsFull, extensionsNext);
  const hooksPath = hooksPathOrigin(root);
  if (hooksPath === undefined) return stop(TEXT.configUnreadable, 'git config --show-origin --get core.hooksPath');
  if (hooksPath !== null) {
    const next = hooksPath.file === null ? 'git config --show-origin --get core.hooksPath' : `git config --file ${shellWord(hooksPath.file)} --unset core.hooksPath`;
    return stop(TEXT.hooksPath(hooksPath.value, hooksPath.scope, hooksPath.file ?? TEXT.commandLineConfig), next);
  }
  const attributes = readRegular(join(root, ATTRIBUTES_FILE), MAX_SMALL_FILE_BYTES);
  if (attributes.unusable) return stop(TEXT.gitattributesNotFile, `ls -ld ${shellWord(join(root, ATTRIBUTES_FILE))}`);
  const env = envPath();
  if (env === null) return stop(TEXT.noEnv, `ls -l ${ENV_CANDIDATES.join(' ')}`);
  const node = process.execPath;

  const actions = [];
  const conflicts = [];
  const notes = [];
  const next = askOwner(applyCommand(root));
  const recordedFile = (path) => manifest?.files.find((file) => file.path === path)?.sha256;
  // An install of a newer kit is replaced only when the owner says so (after Task 9's review).
  const newer = [manifest?.kitVersion, ...SCRIPT_NAMES.map((name) => scriptState(root, name, recordedFile(`${SCRIPTS_DIR}/${name}`)).version)]
    .filter((version) => typeof version === 'string' && compareVersions(version, KIT_VERSION) > 0).sort(compareVersions).at(-1);
  if (newer !== undefined && !downgrade) return stop(TEXT.downgrade(newer), askOwner(`${applyCommand(root)} --downgrade`));

  // An extension.mjs about to be replaced while its entry is registered: the entry goes first and
  // comes back after the scripts (after Task 9's review), so a kill in between leaves the extension
  // off (the gate's contract check refuses commits) and never a registered module that does not
  // hash to its entry, which would block every tool call.
  const listedFirst = extensions.state === 'ok' ? extensions.entries.find((candidate) => candidate.id === EXTENSION_ID) : undefined;
  const unregister = listedFirst !== undefined && scriptState(root, 'extension.mjs', recordedFile(`${SCRIPTS_DIR}/extension.mjs`)).state === 'older';
  if (unregister) actions.push({ kind: 'extension-entry', path: EXTENSIONS_PATH, detail: TEXT.unregisterEntry, text: extensionsTextWith(extensions, null), entry: null, create: false });

  // (a) the scripts
  const kept = [];
  for (const { name, bytes } of shippedScripts()) {
    const path = `${SCRIPTS_DIR}/${name}`;
    const found = scriptState(root, name, recordedFile(path));
    if (found.state === 'missing') actions.push({ kind: 'file', path, detail: TEXT.createScript(path), bytes, create: true });
    else if (found.state === 'older') actions.push({ kind: 'file', path, detail: compareVersions(found.version, KIT_VERSION) > 0 ? TEXT.downgradeScript(path, found.version) : TEXT.updateScript(path, found.version), bytes, create: false });
    else if (found.state === 'current' && recordedFile(path) !== sha256(bytes)) actions.push({ kind: 'record', path, detail: TEXT.record(path), file: { path, sha256: sha256(bytes) } });
    if (found.state === 'edited' || found.state === 'not-ours') {
      kept.push(name);
      conflicts.push({ text: found.state === 'edited' ? TEXT.scriptEdited(path) : TEXT.scriptNotOurs(path), next });
    }
  }

  // (b) officers.json, only when there is none
  if (lstatOrNull(join(root, OFFICERS_PATH)) === null) {
    const officers = officersFile(root);
    actions.push({ kind: 'file', path: OFFICERS_PATH, detail: TEXT.createOfficers(officers.baseBranch, officers.ids), bytes: officers.bytes, create: true });
    notes.push(...officers.notes);
  }

  // (c) the .gitattributes line
  const patch = attributesPatch(attributes);
  if (patch !== null) actions.push({ kind: 'patch', path: ATTRIBUTES_FILE, detail: patch.kind === 'create' ? TEXT.createAttributes : TEXT.appendAttributes, patch: patch.kind, bytes: patch.bytes });

  // (d) the extension entry
  const entry = ownEntryShipped();
  const plannedText = extensionsTextWith(extensions, entry);
  if (kept.includes('extension.mjs')) {
    conflicts.push({ text: TEXT.extensionSkipped, next });
  } else {
    const listed = unregister ? undefined : listedFirst;
    if (listed === undefined) actions.push({ kind: 'extension-entry', path: EXTENSIONS_PATH, detail: TEXT.addEntry(extensions.state === 'absent'), text: plannedText, entry, create: true });
    else if (!sameEntry(listed, entry)) actions.push({ kind: 'extension-entry', path: EXTENSIONS_PATH, detail: TEXT.updateEntry, text: plannedText, entry, create: false });
    else if (manifest?.extensionEntry?.sha256 !== entry.sha256) actions.push({ kind: 'record', path: EXTENSIONS_PATH, detail: TEXT.record('kh-orchestration\'s extension entry'), extensionEntry: { id: EXTENSION_ID, sha256: entry.sha256 } });
  }

  // (e) the shared state directory and bin/: left as it is when it holds what it should (the
  // approved scripts, or before any approval the plugin's), else restored from that same source,
  // so a plugin copy never replaces what the owner approved unless the owner says so
  // (--bin-from-plugin, which keeps every approval). A restore from a tree comes first, before
  // anything else is written, and is refused in the dry run when that tree's scripts do not load.
  const binPath = join(stateDir(root), 'bin');
  const bin = readBin(root);
  const source = binSource(root);
  if (source.kind === 'unreadable') return stop(TEXT.approvalsUnreadable(source.reason), agentCommand(root, 'status'));
  const fromPluginNext = askOwner(`${applyCommand(root)} --bin-from-plugin`);
  const shippedExpected = new Map(shippedScripts().map((script) => [script.name, (bytes) => sameBytes(bytes, script.bytes)]));
  const expected = source.kind === 'tree'
    ? new Map(binEntriesOf(root, source.tree).map((entry) => [entry.path.slice(SCRIPTS_DIR.length + 1), (bytes) => bytes !== undefined && hashesTo(entry.oid, bytes)]))
    : shippedExpected;
  const differs = bin === null ? null : binDifference(bin, expected);
  const fromPlugin = () => {
    actions.push({ kind: 'state-copy', path: binPath, detail: TEXT.binFromPluginAction(binPath), tree: null });
    notes.push(TEXT.binFromPlugin);
  };
  if (source.kind === 'none') {
    if (binFromPlugin) fromPlugin();
    else if (bin === null || !bin.has('gate.mjs')) return stop(TEXT.noApprovedSource(source.digest), fromPluginNext);
  } else if (bin === null || differs.length > 0) {
    if (source.kind === 'shipped') {
      actions.push({ kind: 'state-copy', path: binPath, detail: bin === null ? TEXT.createBin(binPath) : TEXT.replaceBin(binPath, differs), tree: null });
    } else {
      const reason = treeFailsToLoad(root, source.tree);
      if (reason !== null && !binFromPlugin) return stop(TEXT.approvedBinFails(source.tree, reason), fromPluginNext);
      if (reason !== null) fromPlugin();
      else actions.unshift({ kind: 'state-copy', path: binPath, detail: source.detail(binPath), tree: source.tree });
    }
  } else if (manifest?.stateDir !== true) {
    actions.push({ kind: 'record', path: stateDir(root), detail: TEXT.record(stateDir(root)), stateDir: true });
  }

  // (f) the hooks: none while a script is kept; else each one that is not someone else's, and for
  // each that is, the line that runs the gate from it, until it holds that line (after Task 9's review)
  const hooks = join(commonDir(root), 'hooks');
  const hookActions = [];
  const hookConflicts = [];
  for (const name of HOOK_NAMES) {
    const path = join(hooks, name);
    const found = hookState(path, name, { env, node });
    const recorded = manifest?.gitHooks.find((hook) => hook.name === name)?.sha256;
    const line = hookLine(name, { env, node });
    if (found.state === 'missing') hookActions.push({ kind: 'git-hook', path, detail: TEXT.writeHook(path), name, create: true });
    else if (found.state === 'ours') hookActions.push({ kind: 'git-hook', path, detail: TEXT.rewriteHook(path), name, create: false });
    else if (found.state === 'current' && recorded !== sha256(found.bytes)) hookActions.push({ kind: 'record', path, detail: TEXT.record(path), gitHook: { name, sha256: sha256(found.bytes) } });
    else if (found.state === 'not-ours') hookConflicts.push({ text: TEXT.hookConflict(name, path, line), next });
    else if (found.state === 'hosted-other') hookConflicts.push({ text: TEXT.hostedStale(name, path, line), next });
    else if (found.state === 'hosted-off') hookConflicts.push({ text: TEXT.hostedNotExecutable(name, path), next: `chmod +x ${shellWord(path)}` });
  }
  if (kept.length > 0) {
    if (hookActions.some((action) => action.kind === 'git-hook') || hookConflicts.length > 0) conflicts.push({ text: TEXT.hooksStopped, next });
  } else {
    actions.push(...hookActions);
    conflicts.push(...hookConflicts);
  }

  // (g) in-flight records of git processes that have ended
  let stale = [];
  try {
    stale = listInflight(root).filter((record) => !record.live).map((record) => record.pid);
  } catch {
    stale = [];
  }
  if (stale.length > 0) actions.push({ kind: 'inflight', path: stateDir(root), detail: TEXT.removeInflight(stale), pids: stale });

  // Nothing is written while contract 1 would not hold once the entry is in (whether or not this
  // run writes it), or while the hooks would not start the gate.
  const problems = contractAfter(root, entry, plannedText);
  if (problems.length > 0) return refused(root, problems.map((problem) => ({ text: TEXT.contractWouldFail(problem), next: khHarnessApply(root) })));
  if (actions.some((action) => action.kind === 'git-hook')) {
    const failed = selfTest({ env, node, binFiles: shippedScripts() });
    if (failed === TEXT.noShP) return stop(TEXT.noShP, `${SHELL} -p -c 'exit 0'`);
    if (failed !== null) return stop(TEXT.selfTestFailed(failed), detectCommand(root));
  }
  return { root, env, node, refusals: [], actions, conflicts, notes };
}

// ---- applyPlan ----

// A file's or a hook's record set in the manifest, the list kept in the order a fresh install
// writes it, so two runs that end in the same install record it the same way.
function recordFile(manifest, record) {
  manifest.files = [...manifest.files.filter((file) => file.path !== record.path), record].sort((a, b) => RECORDED_PATHS.indexOf(a.path) - RECORDED_PATHS.indexOf(b.path));
}
function recordHook(manifest, record) {
  manifest.gitHooks = [...manifest.gitHooks.filter((hook) => hook.name !== record.name), record].sort((a, b) => HOOK_NAMES.indexOf(a.name) - HOOK_NAMES.indexOf(b.name));
}

/**
 * Performs `planned` (plan's result, with no refusal) in `root`, in order, recording each write in
 * the manifest. Returns `{ manifest, refusal }`: refusal null when every action was done, else the
 * fixed text of what stopped it (a write that failed; the self-test failing, after which the hooks
 * it found are removed). `onWrite` is called after every write; a throw from it ends the run there,
 * as a kill would (the tests' seam).
 */
export function applyPlan(root, planned, { onWrite } = {}) {
  const read = readManifest(root);
  const session = ownerRefusal('apply', applyCommand(root));
  if (session !== null) return { manifest: read.manifest ?? null, refusal: session };
  const manifest = read.state === 'ok' ? structuredClone(read.manifest) : emptyManifest(KIT_VERSION);
  const wrote = () => onWrite?.();
  const write = (path, action) => {
    try {
      action();
    } catch (error) {
      throw new InstallError(error instanceof StateError ? error.message : TEXT.writeFailed(path));
    }
    wrote();
  };
  const save = () => write(MANIFEST_PATH, () => {
    manifest.kitVersion = KIT_VERSION;
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeManifest(root, manifest);
  });
  if (planned.actions.length === 0) return { manifest: read.manifest ?? null, refusal: null };
  try {
    if (read.state === 'absent') save();
    const hooksWritten = [];
    for (const action of planned.actions) {
      // A file that did not exist is recorded first, so a kill after its write leaves it recorded.
      const recordFirst = action.create === true || action.kind === 'state-copy';
      const record = () => {
        if (action.kind === 'file') recordFile(manifest, { path: action.path, sha256: sha256(action.bytes) });
        else if (action.kind === 'patch') manifest.patches = [{ file: ATTRIBUTES_FILE, kind: action.patch, detail: ATTRIBUTES_LINE }];
        else if (action.kind === 'extension-entry') manifest.extensionEntry = action.entry === null ? null : { id: EXTENSION_ID, sha256: action.entry.sha256 };
        else if (action.kind === 'state-copy') manifest.stateDir = true;
        else if (action.kind === 'git-hook') recordHook(manifest, { name: action.name, sha256: sha256(Buffer.from(hookText(action.name, { env: planned.env, node: planned.node, version: KIT_VERSION }))) });
        else if (action.kind === 'record') {
          if (action.file !== undefined) recordFile(manifest, action.file);
          if (action.extensionEntry !== undefined) manifest.extensionEntry = action.extensionEntry;
          if (action.gitHook !== undefined) recordHook(manifest, action.gitHook);
          if (action.stateDir !== undefined) manifest.stateDir = true;
        }
      };
      if (recordFirst || action.kind === 'patch' || action.kind === 'record') {
        record();
        save();
      }
      if (action.kind === 'file') {
        write(action.path, () => {
          mkdirSync(dirname(join(root, action.path)), { recursive: true });
          writeWhole(join(root, action.path), action.bytes, 0o644);
        });
      } else if (action.kind === 'patch') {
        write(ATTRIBUTES_FILE, () => writeWhole(join(root, ATTRIBUTES_FILE), action.bytes, readRegular(join(root, ATTRIBUTES_FILE), MAX_SMALL_FILE_BYTES).mode ?? 0o644));
      } else if (action.kind === 'extension-entry') {
        write(EXTENSIONS_PATH, () => (action.text === null ? rmSync(join(root, EXTENSIONS_PATH), { force: true }) : writeWhole(join(root, EXTENSIONS_PATH), action.text, 0o644)));
      } else if (action.kind === 'state-copy') {
        if (action.tree === null) {
          write(action.path, () => replaceBin(root, shippedScripts(), TEXT.binShippedPreflight));
        } else {
          try {
            refreshBin(root, action.tree);
          } catch (error) {
            const reason = error instanceof StateError || error instanceof GitError ? error.message : TEXT.statusUnreadable;
            return { manifest, refusal: { text: TEXT.approvedBinFails(action.tree, sentence(reason)), next: askOwner(`${applyCommand(root)} --bin-from-plugin`) } };
          }
          wrote();
        }
      } else if (action.kind === 'git-hook') {
        write(action.path, () => {
          mkdirSync(dirname(action.path), { recursive: true });
          writeWhole(action.path, hookText(action.name, { env: planned.env, node: planned.node, version: KIT_VERSION }), 0o755);
        });
        hooksWritten.push(action);
      } else if (action.kind === 'inflight') {
        write(action.path, () => removeStaleInflight(root));
      }
      if (!recordFirst && (action.kind === 'file' || action.kind === 'extension-entry' || action.kind === 'git-hook')) {
        record();
        save();
      }
    }
    if (hooksWritten.length > 0) {
      const failed = hooksFailing(root, planned, hooksWritten.map((action) => action.name));
      if (failed !== null) {
        for (const name of HOOK_NAMES) {
          const path = join(commonDir(root), 'hooks', name);
          const file = readRegular(path, MAX_HOOK_BYTES);
          if (file.bytes !== undefined && hookParts(file.bytes.toString('utf8'))?.hook === name) {
            write(path, () => rmSync(path, { force: true }));
            manifest.gitHooks = manifest.gitHooks.filter((hook) => hook.name !== name);
            save();
          }
        }
        return { manifest, refusal: { text: TEXT.selfTestRemoved(failed), next: askOwner(applyCommand(root)) } };
      }
    }
  } catch (error) {
    if (!(error instanceof InstallError)) throw error;
    return { manifest, refusal: { text: error.message, next: detectCommand(root) } };
  }
  return { manifest, refusal: null };
}

// The self-test after the hooks are written: the hooks this run wrote (`names`) are the texts
// written, and they start the gate in bin/ as it now is. Null when they do, else what failed.
function hooksFailing(root, planned, names) {
  const hooks = join(commonDir(root), 'hooks');
  for (const name of names) {
    const file = readRegular(join(hooks, name), MAX_HOOK_BYTES);
    if (file.bytes?.toString('utf8') !== hookText(name, { env: planned.env, node: planned.node, version: KIT_VERSION })) return TEXT.hookTextDiffers;
  }
  const bin = readBin(root);
  if (bin === null || [...bin.values()].some((bytes) => bytes === undefined)) return TEXT.binUnreadable;
  return selfTest({ env: planned.env, node: planned.node, binFiles: [...bin].map(([name, bytes]) => ({ name, bytes })) });
}

// ---- the text apply prints ----

/** The lines of the plan, as the dry run and --yes print them before acting. */
export function planLines(planned, { dryRun }) {
  const lines = [TEXT.header(planned.root, dryRun)];
  if (planned.actions.length > 0) lines.push(TEXT.actionsHeader, ...planned.actions.map((action) => `  - ${action.detail}`));
  if (planned.notes.length > 0) lines.push(TEXT.notesHeader, ...planned.notes.map((note) => `  - ${note}`));
  if (planned.conflicts.length > 0) lines.push(TEXT.conflictsHeader, ...planned.conflicts.flatMap((conflict) => [`  - ${conflict.text}`, `    Next: ${conflict.next}`]));
  return lines;
}

/** What a finished `apply --yes` prints last: the owner's steps when the tree changed (decision 5). */
export function closingLines(root, planned) {
  const treeChanged = planned.actions.some((action) => ['file', 'patch', 'extension-entry'].includes(action.kind));
  if (!treeChanged) return [TEXT.installed(root), TEXT.repaired];
  let approvals = [];
  try {
    approvals = readApprovals(root);
  } catch {
    approvals = [];
  }
  return [
    TEXT.installed(root),
    approvals.length === 0 ? TEXT.notApprovedYet : TEXT.approveAgain,
    ...TEXT.steps(root, ownerCommand(root, 'approve'), agentCommand(root, 'run')),
    ...coverageLines(root),
  ];
}

// ---- uninstall ----

// The refs under refs/kh-orchestration/ (approve's pins of approved trees).
const approvedRefs = (root) => git(root, ['for-each-ref', '--format=%(refname)', APPROVED_REFS]).stdout.split('\n').filter((ref) => ref.startsWith(APPROVED_REFS));

/**
 * The dry run of `uninstall` for the repository `dir` is in: `{ root, refusals, actions, kept,
 * notes }`, the actions in the order they are done (the hooks, the state directory with `state`,
 * the extension entry, the .gitattributes line, the scripts, officers.json, the manifest). Only
 * what the manifest records, or what is byte for byte what this kit writes, is removed.
 */
export function uninstallPlan(dir, { state }) {
  const resolved = resolveRoot(dir, 'uninstall');
  if (resolved.refusal !== undefined) return { root: null, state, refusals: [resolved.refusal], actions: [], kept: [], notes: [] };
  const { root } = resolved;
  const read = readManifest(root);
  if (read.state === 'corrupt') return { root, state, refusals: [{ text: TEXT.manifestCorrupt, next: manifestNext(root) }], actions: [], kept: [], notes: [] };
  const actions = [];
  const kept = [];
  const notes = [];
  const statePath = stateDir(root);
  const stateAction = () => {
    if (lstatOrNull(statePath) === null && approvedRefs(root).length === 0) return;
    if (state) actions.push({ kind: 'state', path: statePath, detail: TEXT.removeState(statePath) });
    else notes.push(TEXT.stateRemains(statePath));
  };
  if (read.state === 'absent') {
    notes.push(TEXT.nothingRecorded(root));
    stateAction();
    return { root, state, refusals: [], actions, kept, notes };
  }
  const { manifest } = read;

  const hooks = join(commonDir(root), 'hooks');
  for (const name of HOOK_NAMES) {
    const path = join(hooks, name);
    const file = readRegular(path, MAX_HOOK_BYTES);
    const recorded = manifest.gitHooks.find((hook) => hook.name === name)?.sha256;
    if (file.bytes === undefined) continue;
    if (sha256(file.bytes) === recorded || isExactlyOurs(file.bytes, name)) actions.push({ kind: 'git-hook', path, detail: TEXT.removeHook(path), name });
    else if (hostedParts(file.bytes.toString('utf8'), name) !== null) notes.push(TEXT.hostedRemains(name, path));
    else if (recorded !== undefined) kept.push(TEXT.keptHook(path));
  }
  stateAction();

  const extensions = readExtensions(root);
  if (extensions.state === 'malformed' && manifest.extensionEntry !== null) {
    return { root, state, refusals: [{ text: TEXT.extensionsMalformed(extensions.problem), next: `cat ${shellWord(join(root, EXTENSIONS_PATH))}` }], actions: [], kept: [], notes: [] };
  }
  // The entry is kh-orchestration's by its id, whatever it names: it goes before the module it
  // names, so kh-harness never runs an entry whose module is gone (after Task 9's review).
  if (extensions.state === 'ok' && extensions.entries.some((entry) => entry.id === EXTENSION_ID)) {
    const text = extensionsTextWith(extensions, null);
    actions.push({ kind: 'extension-entry', path: EXTENSIONS_PATH, detail: TEXT.removeEntry(text === null), text });
  }

  const patch = manifest.patches[0];
  const attributes = readRegular(join(root, ATTRIBUTES_FILE), MAX_SMALL_FILE_BYTES);
  if (patch !== undefined && attributes.bytes !== undefined && LINE_PRESENT(attributes.bytes.toString('utf8'))) {
    const rest = attributesWithout(attributes.bytes.toString('utf8'), patch.kind);
    actions.push({ kind: 'patch', path: ATTRIBUTES_FILE, detail: rest === null ? TEXT.removeAttributesFile : TEXT.removeAttributesLine, text: rest, mode: attributes.mode });
  }

  const recordedFile = (path) => manifest.files.find((file) => file.path === path)?.sha256;
  for (const { name, bytes } of shippedScripts()) {
    const path = `${SCRIPTS_DIR}/${name}`;
    const file = readRegular(join(root, path), MAX_SCRIPT_BYTES);
    if (file.absent) continue;
    if (file.bytes !== undefined && (sameBytes(file.bytes, bytes) || asRecorded(file.bytes, recordedFile(path)))) actions.push({ kind: 'file', path, detail: TEXT.removeFile(path) });
    else if (file.bytes !== undefined && stampOf(file.bytes) !== null) kept.push(TEXT.keptEdited(path));
    else kept.push(TEXT.keptNotOurs(path));
  }
  const officers = readRegular(join(root, OFFICERS_PATH), MAX_SMALL_FILE_BYTES);
  const officersRecord = recordedFile(OFFICERS_PATH);
  if (officers.bytes !== undefined && officersRecord !== undefined) {
    if (sha256(officers.bytes) === officersRecord) actions.push({ kind: 'file', path: OFFICERS_PATH, detail: TEXT.removeFile(OFFICERS_PATH) });
    else kept.push(TEXT.keptOfficers);
  }
  actions.push({ kind: 'manifest', path: MANIFEST_PATH, detail: kept.length === 0 ? TEXT.removeManifest : TEXT.keepManifest });
  return { root, state, refusals: [], actions, kept, notes };
}

/**
 * Performs `planned` (uninstallPlan's result, with no refusal) in `root`, in order, and returns
 * `{ refusal }`: null when done, the session refusal (nothing removed) in a Claude Code session. The manifest
 * is rewritten after each removal, so a run stopped part way leaves a record the next uninstall
 * finishes from; it is removed last, or kept recording only what was kept. The two directories
 * kh-orchestration's files were in are removed when left empty. Never touches kh-harness's files.
 */
export function applyUninstall(root, planned) {
  const session = ownerRefusal('uninstall', TEXT.uninstallCommand(root, planned.state));
  if (session !== null) return { refusal: session };
  const read = readManifest(root);
  const manifest = read.state === 'ok' ? structuredClone(read.manifest) : null;
  const save = () => {
    if (manifest !== null) writeManifest(root, manifest);
  };
  for (const action of planned.actions) {
    if (action.kind === 'git-hook') {
      rmSync(action.path, { force: true });
      manifest.gitHooks = manifest.gitHooks.filter((hook) => hook.name !== action.name);
      save();
    } else if (action.kind === 'state') {
      rmSync(action.path, { recursive: true, force: true });
      for (const ref of approvedRefs(root)) git(root, ['update-ref', '-d', '--end-of-options', ref]);
      if (manifest !== null) manifest.stateDir = false;
      save();
    } else if (action.kind === 'extension-entry') {
      if (action.text === null) rmSync(join(root, EXTENSIONS_PATH), { force: true });
      else writeWhole(join(root, EXTENSIONS_PATH), action.text, 0o644);
      manifest.extensionEntry = null;
      save();
    } else if (action.kind === 'patch') {
      if (action.text === null) rmSync(join(root, ATTRIBUTES_FILE), { force: true });
      else writeWhole(join(root, ATTRIBUTES_FILE), action.text, action.mode);
      manifest.patches = [];
      save();
    } else if (action.kind === 'file') {
      rmSync(join(root, action.path), { force: true });
      manifest.files = manifest.files.filter((file) => file.path !== action.path);
      save();
    } else if (action.kind === 'manifest') {
      if (planned.kept.length === 0) rmSync(join(root, MANIFEST_PATH), { force: true });
    }
  }
  for (const path of [SCRIPTS_DIR, '.claude/kh-orchestration']) {
    const absolute = join(root, path);
    if (isRealDirectory(absolute) && readdirSync(absolute).length === 0) rmSync(absolute, { recursive: true, force: true });
  }
  return { refusal: null };
}

/** The lines of the uninstall plan. */
export function uninstallLines(planned, { dryRun }) {
  const lines = [TEXT.uninstallHeader(planned.root, dryRun)];
  lines.push(...planned.notes);
  if (planned.actions.length > 0) lines.push(TEXT.actionsHeader, ...planned.actions.map((action) => `  - ${action.detail}`));
  if (planned.kept.length > 0) lines.push(TEXT.keptHeader, ...planned.kept.map((text) => `  - ${text}`));
  if (planned.actions.length === 0) lines.push(TEXT.nothingToRemove);
  return lines;
}

// ---- the one next step ----

/**
 * The one next step for the install in `root` as it is found (after Task 9's review), given its
 * dry run `planned` and what the gate sees (`status`, null when it could not be read): what apply
 * still has to do; else staging the install and approving it while what apply wrote is not staged;
 * else the approval; else the first problem status reports; else nothing.
 */
function nextStep(root, planned, status) {
  if (planned.refusals.length > 0) return planned.refusals[0].next;
  if (planned.conflicts.length > 0) return planned.conflicts[0].next;
  if (planned.actions.length > 0) return askOwner(applyCommand(root));
  if (status === null) return agentCommand(root, 'status');
  const unstaged = git(root, ['ls-files', '-z', '--others', '--modified', '--exclude-standard', '--', ...WRITTEN_PATHS]);
  if (status.install?.present === false || unstaged.status !== 0 || unstaged.stdout !== '') return TEXT.stageAndApprove(root);
  if (status.digestApproved === false) return TEXT.approveNext(root);
  if (status.problems.length > 0) return status.problems[0].next;
  return TEXT.allClear;
}

/** apply's next step when it has nothing to do: nextStep with what the gate sees now. */
export function nextAfterApply(root, planned) {
  let status;
  try {
    status = statusOf(root);
  } catch {
    status = null;
  }
  return nextStep(root, planned, status);
}

// ---- detect ----

const SCRIPT_WORDS = { current: 'current', older: 'other bytes', edited: 'changed since kh-orchestration wrote it', 'not-ours': 'not kh-orchestration\'s', missing: 'missing' };
const HOOK_WORDS = {
  current: 'kh-orchestration\'s, current',
  ours: 'kh-orchestration\'s, not this version\'s exact text',
  hosted: 'not kh-orchestration\'s, but holds its line, so it runs the gate',
  'hosted-other': 'not kh-orchestration\'s, holding its line for another env or Node',
  'hosted-off': 'not kh-orchestration\'s, holding its line, but not executable',
  'not-ours': 'not kh-orchestration\'s',
  missing: 'missing',
};

/**
 * What `detect` reports for the repository `dir` is in, as one object (the shape `--json`
 * prints): `{ schema: 1, root, plugin, install, files, officers, gitattributes, extensionEntry,
 * hooks, coverage, status, statusError, apply }`, or `{ refusal }` when there is no repository.
 * Executes nothing from the repository: git reads it, and statusOf runs no probe.
 */
export function detect(dir) {
  const resolved = resolveRoot(dir, 'detect');
  if (resolved.refusal !== undefined) return { refusal: resolved.refusal };
  const { root } = resolved;
  const read = readManifest(root);
  const manifest = read.manifest ?? null;
  const recordedFile = (path) => manifest?.files.find((file) => file.path === path)?.sha256;
  const files = SCRIPT_NAMES.map((name) => {
    const path = `${SCRIPTS_DIR}/${name}`;
    const found = scriptState(root, name, recordedFile(path));
    return { path, state: found.state, version: found.bytes === undefined ? null : stampOf(found.bytes) };
  });
  const installedModule = readRegular(join(root, MODULE), MAX_SCRIPT_BYTES);
  const extensions = isRealDirectory(join(root, '.claude')) && isRealDirectory(join(root, '.claude/kh-harness')) ? readExtensions(root) : { state: 'absent' };
  const listed = extensions.state === 'ok' ? extensions.entries.find((entry) => entry.id === EXTENSION_ID) : undefined;
  const extensionEntry = extensions.state === 'malformed'
    ? { state: 'unusable', onFailure: null, problem: extensions.problem }
    : listed === undefined ? { state: 'absent', onFailure: null, problem: null } : { state: sameEntry(listed, ownEntryShipped()) ? 'matches' : 'differs', onFailure: listed.onFailure, problem: null };
  const env = envPath();
  let hooks = null;
  let status = null;
  let statusError = null;
  try {
    const hooksDir = join(commonDir(root), 'hooks');
    hooks = HOOK_NAMES.map((name) => ({ name, state: hookState(join(hooksDir, name), name, { env: env ?? '', node: process.execPath }).state }));
    status = statusOf(root);
  } catch (error) {
    statusError = error instanceof GitError || error instanceof StateError ? error.message : TEXT.statusUnreadable;
  }
  const attributes = readRegular(join(root, ATTRIBUTES_FILE), MAX_SMALL_FILE_BYTES);
  const planned = plan(root);
  return {
    schema: 1,
    root,
    plugin: { version: KIT_VERSION, dir: PLUGIN_DIR },
    install: {
      version: installedModule.bytes === undefined ? null : stampOf(installedModule.bytes),
      manifest: { state: read.state, kitVersion: manifest?.kitVersion ?? null, installedAt: manifest?.installedAt ?? null },
    },
    files,
    officers: { present: lstatOrNull(join(root, OFFICERS_PATH)) !== null },
    gitattributes: { line: attributes.bytes !== undefined && LINE_PRESENT(attributes.bytes.toString('utf8')) },
    extensionEntry,
    hooks,
    coverage: coverageOf(root),
    status,
    statusError,
    apply: {
      refusals: planned.refusals,
      conflicts: planned.conflicts,
      actions: planned.actions.map(({ kind, path, detail }) => ({ kind, path, detail })),
      notes: planned.notes,
    },
    next: nextStep(root, planned, status),
  };
}

const yesNo = (value) => (value === null ? 'unknown' : value ? 'yes' : 'no');

/** The lines `detect` prints for `report` (detect's result). */
export function detectLines(report) {
  const { root, install, status } = report;
  const lines = [`kh-orchestration detect for ${root} (plugin kh-orchestration ${report.plugin.version} at ${report.plugin.dir})`];
  const nothing = install.manifest.state === 'absent' && report.files.every((file) => file.state === 'missing');
  if (nothing) lines.push('Install: kh-orchestration is not installed here.');
  else lines.push(`Install: kh-orchestration ${install.version ?? 'unknown'} by its extension's stamp; manifest ${install.manifest.state === 'ok' ? `written by ${install.manifest.kitVersion} (installed ${install.manifest.installedAt})` : install.manifest.state === 'corrupt' ? 'unreadable' : 'absent'}.`);
  lines.push('Installed files:', ...report.files.map((file) => `  ${file.path}: ${SCRIPT_WORDS[file.state]}${file.state === 'older' || file.state === 'edited' ? ` (stamped ${file.version})` : ''}`));
  lines.push(`officers.json: ${report.officers.present ? 'present' : 'absent'}`);
  lines.push(`${ATTRIBUTES_FILE}: ${report.gitattributes.line ? 'holds' : 'lacks'} the line ${ATTRIBUTES_LINE}`);
  const entry = report.extensionEntry;
  lines.push(`Extension entry: ${entry.state === 'unusable' ? `the extensions file cannot be used (${entry.problem})` : entry.state === 'absent' ? 'absent' : `${entry.state === 'matches' ? 'present, as apply writes it' : 'present, not as apply writes it'} (onFailure ${entry.onFailure})`}`);
  if (report.hooks !== null) lines.push('Hooks:', ...report.hooks.map((hook) => `  ${hook.name}: ${HOOK_WORDS[hook.state]}`));
  lines.push(...(report.coverage === null ? [TEXT.coverageHeader, TEXT.officersUnreadable] : coverageLines(root)));
  if (status === null) {
    lines.push(`Status: could not be read (${sentence(report.statusError)})`);
  } else {
    lines.push(
      'Status (what the commit gate sees):',
      `  switch: ${status.off ? 'off' : 'on'}; contract 1 (by its files): ${status.contract.ok ? 'holds' : 'does not hold'}; digest of the staged tree approved: ${yesNo(status.digestApproved)}`,
      `  exempt branches: ${status.exemptions === null ? 'unknown' : status.exemptions.length === 0 ? 'none' : status.exemptions.map((item) => item.name).join(', ')}; waivers here: ${status.waivers === null ? 'unknown' : status.waivers.length === 0 ? 'none' : status.waivers.map((item) => item.rule).join(', ')}; this worktree open for proposals: ${yesNo(status.openForProposals)}`,
      `  git: ${status.git.version ?? 'unknown'}; core.hooksPath: ${status.hooksPath === null ? 'not set' : `${status.hooksPath.value} (${status.hooksPath.scope})`}`,
      ...(status.problems.length === 0 ? ['  No problems found.'] : ['  Problems:', ...status.problems.flatMap((problem) => [`  - ${problem.text}`, `    Next: ${problem.next}`])]),
    );
  }
  const { apply } = report;
  lines.push('What apply --yes would do:');
  if (apply.refusals.length > 0) lines.push(...apply.refusals.flatMap((refusal) => [`  - refuse: ${refusal.text}`, `    Next: ${refusal.next}`]));
  else if (apply.actions.length === 0 && apply.conflicts.length === 0) lines.push('  - nothing');
  lines.push(...apply.actions.map((action) => `  - ${action.detail}`), ...apply.conflicts.flatMap((conflict) => [`  - conflict: ${conflict.text}`, `    Next: ${conflict.next}`]));
  lines.push(`Next: ${report.next}`);
  return lines;
}
