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
//
// The gate starts only approved bytes, in a clean environment (after Task 6's third and fourth
// re-reviews).
// - The hooks run under `sh -p`, call no command by name, and start node through env -i with an
//   allowlist (PATH, HOME, TMPDIR, the locale and the GIT_* variables git exports to a hook), so
//   no NODE_*, LD_*, DYLD_* or shell function reaches this process. Every git call runs with
//   core.fsmonitor off, and none reads working-tree content (no filter or monitor runs).
// - The live files are compared with the tree in this process, byte for byte, as git blobs.
// - The only repository code the gate starts is kh-harness's entry script in the contract probe,
//   from a private copy of the approved tree's blobs, outside the repository, never the working
//   copy; the project env may not set NODE_*, LD_* or DYLD_*.
// STATED LIMIT: that private copy is written to a temporary directory the same user can write. A
// background process that rewrites it while the probe runs can make the probe run other bytes than
// the approved ones. It cannot change that commit's outcome: the approvals and the verdict are read
// into memory before the probe starts, and the probe only adds a refusal.
// STATED LIMIT: the shared state is not tamper-proof. Code an agent manages to run OUTSIDE the gate
// (a script on disk, a command git runs from configuration before the hook, such as core.fsmonitor
// inside git commit itself) can write a verdict or an approval. The extension blocks the one-line
// ways, and verify-branch, which re-runs the officers, is the remedy.
import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, constants, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { COMMANDS, shellWord } from './extension.mjs';
import { contractHolds } from './ko-contract.mjs';
import { OFFICERS, digestOfTree, hashesTo, objectMismatchMessage } from './ko-digest.mjs';
import { GitError, baseOf, currentBranch, indexTree, listEntries, ownIndexEntry, readBlobs, repoRoot, treeEntry, treeOfCommitId } from './ko-git.mjs';
import { officersOfTree } from './ko-officers.mjs';
import { FILE_MODES, StateError, isOff, ownerCommand, readApprovals, readExemptions, readInflight, removeInflight, removeStaleInflight, stageInstall, writeAccepted, writeInflight } from './ko-state.mjs';
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
const NAMED_AT_MOST = 10;
// What this session's hooks run from the working directory (amended decision 17): kh-harness's
// files and settings and this plugin's scripts. Their working copies must equal the tree.
const LIVE_FILE = '.claude/settings.json';
const LIVE_DIRS = ['.claude/kh-harness', '.claude/scripts', '.claude/kh-orchestration/scripts'];
// Directories a live path is reached through; each must be a real directory, not a link.
const LIVE_ANCESTORS = ['.claude', '.claude/kh-orchestration', ...LIVE_DIRS];
const isLive = (path) => path === LIVE_FILE || LIVE_DIRS.some((dir) => path.startsWith(`${dir}/`));
// The most a live file may hold (kh-harness's own cap on a listed script): larger is refused unread.
const MAX_LIVE_BYTES = 4 * 1024 * 1024;
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
const MAX_SETTINGS_BYTES = 1024 * 1024;
// Project env names that would load code into every hook process of a session.
const LOADER_ENV = /^(?:NODE_|LD_|DYLD_)/i;
const REASON_SHOWN_AT_MOST = 200;
// C0 and C1 controls, DEL, the line and paragraph separators, and the zero-width and bidi
// characters: what can make a terminal show other text than the record holds. The one definition
// (ko.mjs uses it too).
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
// Text shown in full (a name, a path, a diff): every such character but TAB and newline written as
// \u{…}, so what is shown cannot differ from what is meant, and two names never look the same.
export const visible = (text) => text.replace(UNSHOWABLE, (char) => (char === '\t' || char === '\n' ? char : `\\u{${char.codePointAt(0).toString(16)}}`));
// Text without what a terminal would act on: ko.mjs records a reason in this form.
export const plainText = (text) => text.replace(UNSHOWABLE, '');
// Recorded or repository text as it is printed (an exemption's reason, a path, an officer's
// output line): without what a terminal would act on, and cut at 200 characters. ko.mjs prints
// through it too.
export function shownText(text) {
  const plain = plainText(text);
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
  liveTooLarge: (path) => `${path} is larger than 4 MiB, more than the gate compares; a live file of that size is not part of an install. Remove it from the tree, then commit again.`,
  projectEnv: (file, key) => `${file} sets ${key} under env, which would load code into every hook process of the session. Remove it outside Claude Code, then commit again.`,
  probeDirInside: 'the temporary directory for the private copy of the approved tree lies inside the repository; set TMPDIR to a directory outside it',
  probeDirRelative: 'TMPDIR names a relative path, so the place of the private copy of the approved tree depends on the directory git runs in; set TMPDIR to an absolute directory outside the repository',
  probeDirUnusable: 'the temporary directory for the private copy of the approved tree (TMPDIR, or /tmp when it is not set) does not exist or cannot be written; set TMPDIR to a directory outside the repository that can',
  liveDiffers: (path) => `The working copy of ${path} differs from the tree being committed, and the working copy is what this session's hooks run. Stage it for the owner to approve, or restore it as below, then commit again.`,
  liveDiffersKept: (path) => `The working copy of ${path} differs from the tree being committed, and it is kh-orchestration's or shared with other plugins, so an older copy must not be put back beside the others. Stage the whole install as below so the owner can approve it, or have the owner run kh-orchestration's apply again, then commit again.`,
  liveLineEndingsKept: (path) => `The working copy of ${path} differs from the tree being committed only in its line endings (core.autocrlf or a text attribute), and it is kh-orchestration's or shared with other plugins. Add the line .claude/** -text to .gitattributes, then stage the whole install as below for the owner to approve, or have the owner run apply again.`,
  liveLineEndings: (path) => `The working copy of ${path} differs from the tree being committed only in its line endings: this checkout converts them (core.autocrlf or a text attribute), and the working copy is what this session's hooks run. Add the line .claude/** -text to .gitattributes, check the file out again as below, then commit again.`,
  liveMode: (path) => `The working copy of ${path} differs from the tree being committed only in its executable bit: this checkout does not keep file modes (core.fileMode false, or a filesystem without them), and the working copy is what this session's hooks run. Set the bit as the tree has it, as below, then commit again.`,
  liveStagedElsewhere: (path) => `${path} is staged with a change this partial commit leaves out, so its working copy, which this session's hooks run, differs from the tree being committed. Commit without a path list, or restore it, then commit again.`,
  liveUntracked: (path) => `${path} is in the working directory beside the files this session's hooks run but is not in the tree being committed (an editor's swap file or a .DS_Store looks like this too). Add it as below so the owner can approve it, or remove it if it does not belong, then commit again.`,
  liveUntrackedKept: (path) => `${path} is in the working directory beside the files this session's hooks run but is not in the tree being committed, and it is kh-orchestration's or shared with other plugins. Add it as below so the owner can approve it, then commit again.`,
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


// The owner's command to exempt `branch`: like every owner command, the copy of ko.mjs in bin/.
export const exemptCommand = (root, branch) => ownerCommand(root, `exempt ${shellWord(branch)} --reason "<why>"`);

const allow = (reason) => ({ allow: true, reason, next: '' });
const refuse = (reason, next) => ({ allow: false, reason, next });

// 2. An exemption names a branch exactly; a detached HEAD (branch null) is never exempt. ko.mjs
// reads it through this too.
export function exemptionOf(root, branch) {
  if (branch === null) return null;
  return readExemptions(root).find((entry) => entry.name === branch) ?? null;
}

// 3. The install is present in the tree when its officers file is a file there and its extension
// is a regular file there: the officers say what passing means, and the extension is what guards
// the gate in the next session. The rest of the install is covered by the digest, which step 6
// makes the owner's. An officers file that is there but unusable is a problem of that file, not a
// missing install, so it is reported as such and no exemption is offered. `{ officers }`,
// `{ absent }` or `{ problem }`; status reports it.
const isFile = (entry) => entry !== null && entry.type === 'blob' && FILE_MODES.includes(entry.mode);
export function installOf(root, tree) {
  if (!isFile(treeEntry(root, tree, OFFICERS))) return { absent: REASONS.officersAbsent };
  if (!isFile(treeEntry(root, tree, EXTENSION))) return { absent: REASONS.extensionAbsent };
  const read = officersOfTree(root, tree);
  if (read.problem !== undefined) return { problem: read.problem };
  return { officers: read.officers };
}

// 4. The live files equal the tree: the contract check reads the working copy, the digest
// approves the tree, and this ties the two together. Compared here, in this process, never through
// a git command that reads the working tree (a clean filter or a monitor configured outside the tree
// could make git report what it likes). Every tree file under the live paths must be a regular
// working file (lstat, never followed) whose bytes hash, as a git blob, to the tree's object id,
// with the executable bit as the tree's mode says; every directory is listed directly, and a file
// there the tree lacks is refused. Line endings count: a checkout that converts them differs.
// `{ bytes, executable }` of a regular file at `path`, never through a link at it; `{ differs }`
// for anything else and `{ tooLarge }` past 4 MiB. ko.mjs reads kh-harness's contract file with it.
export function readNoFollow(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { differs: true };
    if (stat.size > MAX_LIVE_BYTES) return { tooLarge: true };
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const count = readSync(fd, bytes, read, bytes.length - read, read);
      if (count === 0) break;
      read += count;
    }
    return { bytes: bytes.subarray(0, read), executable: (stat.mode & 0o100) !== 0 };
  } catch {
    return { differs: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const lstatOrNull = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

// Every path under `dir` that is not a directory, relative to `root`: files, links and anything
// else, never following a link.
function listedUnder(root, dir) {
  const found = [];
  const walk = (relative) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = `${relative}/${name}`;
      if (lstatSync(join(root, path)).isDirectory()) walk(path);
      else found.push(path);
    }
  };
  walk(dir);
  return found;
}

// Whether no message may suggest removing or restoring `path` (after Task 9's review and
// re-review): kh-harness's extensions file, shared by every plugin that registers an extension, and
// every file kh-orchestration's installer writes: all of its install folder, and whatever else the
// working copy's manifest records when it parses. Restoring an older copy of one puts it
// beside newer siblings: an old entry beside a new extension.mjs blocks every tool call.
const SHARED_FILES = ['.claude/kh-harness/extensions.json'];
const MANIFEST = '.claude/kh-orchestration.manifest.json';
const INSTALL_FOLDER = '.claude/kh-orchestration/';
function keptByAnInstaller(root, path) {
  if (SHARED_FILES.includes(path) || path.startsWith(INSTALL_FOLDER)) return true;
  const read = readNoFollow(join(root, MANIFEST));
  try {
    const files = JSON.parse(read.bytes?.toString('utf8'))?.files;
    return Array.isArray(files) && files.some((file) => file?.path === path);
  } catch {
    return false;
  }
}
// The next step for an installer's file that differs: stage the WHOLE install for the owner's
// approval (after Task 9's second re-review: one file staged alone could be split from its partner
// by a later git restore), or have the owner's apply write it again (the repair line ko.mjs and
// status print; a test holds them).
const KEPT_NEXT = `${stageInstall(null)}, or ask the owner to run, in their own terminal outside Claude Code: node <kh-orchestration>/scripts/apply.mjs <repository> --yes`;

// A differing path's refusal: staged in the repository's own index with other content than the
// tree's means a partial commit leaves it out, and restoring or removing it would lose the change.
// `how` says a working copy differs only in its line endings ('lineEndings') or its executable bit
// ('mode'): a checkout that converts line endings or keeps no modes, which restoring does not mend.
function differsRefusal(root, path, entry, how) {
  const staged = ownIndexEntry(root, path);
  if (staged !== null && (entry === undefined || staged.oid !== entry.oid || staged.mode !== entry.mode)) return refuse(REASONS.liveStagedElsewhere(path), 'git commit');
  const word = shellWord(path);
  if (entry === undefined) return refuse(keptByAnInstaller(root, path) ? REASONS.liveUntrackedKept(path) : REASONS.liveUntracked(path), `git add -- ${word}`);
  if (how === 'mode') return refuse(REASONS.liveMode(path), `chmod ${entry.mode === '100755' ? '+x' : '-x'} -- ${word}`);
  if (keptByAnInstaller(root, path)) return refuse(how === 'lineEndings' ? REASONS.liveLineEndingsKept(path) : REASONS.liveDiffersKept(path), KEPT_NEXT);
  if (how === 'lineEndings') return refuse(REASONS.liveLineEndings(path), `git checkout -- ${word}`);
  return refuse(REASONS.liveDiffers(path), `git restore -- ${word}`);
}

// Whether `bytes` are the blob `oid` with every line ending turned into CR LF, as a checkout with
// core.autocrlf or a text attribute writes it.
const CRLF = Buffer.from('\r\n');
const LF = Buffer.from('\n');
function convertedFrom(oid, bytes) {
  if (!bytes.includes(CRLF)) return false;
  const parts = [];
  let at = 0;
  for (let found = bytes.indexOf(CRLF, at); found !== -1; found = bytes.indexOf(CRLF, at)) {
    parts.push(bytes.subarray(at, found), LF);
    at = found + CRLF.length;
  }
  parts.push(bytes.subarray(at));
  return hashesTo(oid, Buffer.concat(parts));
}

function liveRefusal(root, live) {
  for (const dir of LIVE_ANCESTORS) {
    const stat = lstatOrNull(join(root, dir));
    if (stat !== null && !stat.isDirectory()) return keptByAnInstaller(root, dir) ? refuse(REASONS.liveDiffersKept(dir), KEPT_NEXT) : refuse(REASONS.liveDiffers(dir), `git restore -- ${shellWord(dir)}`);
  }
  const inTree = new Map(live.map((entry) => [entry.path, entry]));
  for (const entry of live) {
    const read = entry.type === 'blob' && FILE_MODES.includes(entry.mode) ? readNoFollow(join(root, entry.path)) : { differs: true };
    if (read.tooLarge) return refuse(REASONS.liveTooLarge(entry.path), COMMANDS.status);
    if (read.differs) return differsRefusal(root, entry.path, entry);
    if (!hashesTo(entry.oid, read.bytes)) return differsRefusal(root, entry.path, entry, convertedFrom(entry.oid, read.bytes) ? 'lineEndings' : undefined);
    if (read.executable !== (entry.mode === '100755')) return differsRefusal(root, entry.path, entry, 'mode');
  }
  const present = [
    ...(lstatOrNull(join(root, LIVE_FILE)) === null ? [] : [LIVE_FILE]),
    ...LIVE_DIRS.filter((dir) => lstatOrNull(join(root, dir))?.isDirectory()).flatMap((dir) => listedUnder(root, dir)),
  ];
  const extra = present.find((path) => !inTree.has(path));
  return extra === undefined ? null : differsRefusal(root, extra, undefined);
}

// 7a. The project env (amended decision 17, rule 5): neither settings file may set NODE_*, LD_* or
// DYLD_* under env. A file that cannot be read is left to checkContract1, which refuses it.
function projectEnvRefusal(root) {
  for (const file of SETTINGS_FILES) {
    const read = readNoFollow(join(root, file));
    if (read.bytes === undefined || read.bytes.length > MAX_SETTINGS_BYTES) continue;
    let value;
    try {
      value = JSON.parse(read.bytes.toString('utf8'));
    } catch {
      continue;
    }
    const env = value !== null && typeof value === 'object' ? value.env : undefined;
    if (env === null || typeof env !== 'object') continue;
    const key = Object.keys(env).find((name) => LOADER_ENV.test(name));
    if (key !== undefined) return refuse(REASONS.projectEnv(file, key), COMMANDS.status);
  }
  return null;
}

// 7b. Contract 1 with the probe run on a private copy of the approved tree's live files (rule 4):
// each blob read from the object store, verified against its id, written with its mode into a
// fresh 0700 directory under the system's temporary directory, which is removed however this
// ends, a throw included. `{ holds }` (contractHolds's answer), or `{ problem }` when TMPDIR is
// relative, the directory cannot be made or lies inside the repository, or a blob does not hash to
// its id. Throws what readBlobs throws.
function contractOnPrivateCopy(root, live) {
  const base = tmpdir();
  if (!isAbsolute(base)) return { problem: REASONS.probeDirRelative };
  let dir;
  try {
    dir = mkdtempSync(join(realpathSync(base), 'ko-probe-'));
  } catch {
    return { problem: REASONS.probeDirUnusable };
  }
  try {
    const real = realpathSync(dir);
    const repository = realpathSync(root);
    if (real === repository || real.startsWith(`${repository}${sep}`)) return { problem: REASONS.probeDirInside };
    const blobs = readBlobs(root, live.map((entry) => entry.oid));
    for (const entry of live) {
      const bytes = blobs.get(entry.oid);
      if (!hashesTo(entry.oid, bytes)) return { problem: objectMismatchMessage(entry.path) };
      const target = join(dir, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
      chmodSync(target, entry.mode === '100755' ? 0o700 : 0o600);
    }
    return { holds: contractHolds(root, { probeRoot: dir }) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 6. Whether the owner approved this digest. Approval is by content: an approval's `branch` is a
// record of where it was given, and a digest approved anywhere is approved on every branch.
const approved = (root, digest) => readApprovals(root).some((entry) => entry.digest === digest);

// The tree's entries under the live paths, sorted by path.
const liveEntries = (root, tree) => listEntries(root, tree).filter((entry) => isLive(entry.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

// Step 4 alone, as status reports it: the gate's refusal for the first live file whose working
// copy differs from `tree`, or null when they are equal.
export const liveFilesRefusal = (root, tree) => liveRefusal(root, liveEntries(root, tree));

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
 *   1 off switch, 2 exempt branch, 3 install in the tree, 4 live files equal the tree (compared
 *   in this process), 5 RULES.md and the digest, 6 digest approved, 7 contract 1: the project env
 *   (no NODE_*, LD_*, DYLD_*), checkContract1 on the working directory, then the probe on a
 *   private copy of the approved tree (the one step that runs repository code, and only approved
 *   bytes), 8 a passing verdict for this tree and base.
 * runGate then adds 9 (the index tree unchanged) and 10 (the in-flight record, then the token).
 * The approvals and the verdict are read into memory BEFORE the probe runs, and judged on those
 * copies: the probe starts the repository's entry script, and nothing its process writes to the
 * shared state may change the outcome.
 * `tree` is the tree being committed, `base` its base (decision 7) or null when the tree's
 * officers file cannot be read (step 3 then refuses), and `branch` the current branch or null for
 * a detached HEAD. With `honourSwitches` false, steps 1 and 2 decide nothing: verify-branch asks
 * whether a tree passes, not whether a commit of it would be checked. With `probe` false, step 7
 * is checkContract1 alone and nothing from the repository runs (verify-branch --no-run). Throws what the state and
 * git helpers throw (a StateError for a damaged state file): the caller refuses on a throw.
 */
export function judge(root, { tree, base, branch }, { honourSwitches = true, probe = true } = {}) {
  if (honourSwitches) {
    if (isOff(root)) return allow(REASONS.off);
    const exemption = exemptionOf(root, branch);
    if (exemption !== null) return allow(REASONS.exempt(branch, shownText(exemption.reason)));
  }
  const install = installOf(root, tree);
  if (install.absent !== undefined) {
    return branch === null
      ? refuse(REASONS.noInstallDetached(install.absent), 'git switch -c <branch>')
      : refuse(REASONS.noInstall(install.absent), exemptCommand(root, branch));
  }
  if (install.problem !== undefined) return refuse(REASONS.officersProblem(install.problem), COMMANDS.status);
  const live = liveEntries(root, tree);
  const liveProblem = liveRefusal(root, live);
  if (liveProblem !== null) return liveProblem;
  const digest = digestOfTree(root, tree);
  if (digest.problem !== undefined) return refuse(REASONS.undigestable(digest.problem), COMMANDS.run);
  if (!approved(root, digest.digest)) return refuse(REASONS.unapproved(digest.digest), ownerCommand(root, 'approve'));
  const verdict = readVerdict(root, tree, base);
  const envProblem = projectEnvRefusal(root);
  if (envProblem !== null) return envProblem;
  const { holds, problem } = probe ? contractOnPrivateCopy(root, live) : { holds: contractHolds(root, { probe: false }) };
  if (problem !== undefined) return refuse(REASONS.couldNotDecide(problem), COMMANDS.status);
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
  writeInflight(root, pid, { tree, base });
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

const movesBranch = (update) => update.ref === 'HEAD' || update.ref.startsWith('refs/heads/');

// Whether a branch or HEAD update keeps to the recorded tree: a deletion (the null id) is not a
// commit and passes; anything else must be a commit whose tree is `tree`. A symbolic update
// (`ref:refs/heads/x`) or any non-commit is refused.
function keepsTree(root, update, tree) {
  if (!movesBranch(update)) return true;
  if (NULL_ID.test(update.next)) return true;
  return OBJECT_ID.test(update.next) && treeOfCommitId(root, update.next) === tree;
}

// The reference-transaction hook's judgement, in the `prepared` state of git process `pid`'s
// update: allowed only when every branch or HEAD it moves names a commit of the recorded tree.
// Other refs (ORIG_HEAD, AUTO_MERGE, tags, remotes) are not judged. The record is removed on a
// refusal, and once a transaction that moves a branch or HEAD is allowed: the commit's own update
// has then been judged, and a later update by the same process has no record to pass. On that
// allow, each commit it puts on a branch or HEAD is recorded as accepted with the tree and base
// judged (accepted/<commit>.json), for status and verify-branch; a record that cannot be written
// refuses the transaction.
function judgeUpdate(root, pid, input) {
  let judged;
  try {
    judged = readInflight(root, pid);
  } catch (error) {
    // A record that is not a readable file (a directory, a dangling symlink) is never "no record".
    removeInflight(root, pid);
    throw error;
  }
  if (judged === null) return refuse(REASONS.noRecord, COMMANDS.run);
  const updates = parseUpdates(input);
  const decision = updates === null
    ? refuse(REASONS.couldNotDecide(REASONS.unreadableUpdates), COMMANDS.status)
    : updates.every((update) => keepsTree(root, update, judged.tree)) ? allow(REASONS.updateAllowed) : refuse(REASONS.treeSwapped, COMMANDS.run);
  const landing = decision.allow ? [...new Set(updates.filter((update) => movesBranch(update) && !NULL_ID.test(update.next)).map((update) => update.next))] : [];
  try {
    for (const commit of landing) writeAccepted(root, commit, judged);
  } finally {
    if (!decision.allow || updates?.some(movesBranch)) removeInflight(root, pid);
  }
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
