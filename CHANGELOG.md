# Changelog

All notable changes to kh-orchestration are recorded here, one section per
release headed by its version and date, with Added, Changed and Fixed lists
in the manner of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The headings are plain, without links, since no release is tagged yet. The
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

What the whole-branch review of stage 1 found, fixed.

### Added

- `ko.mjs unwaive <rule>` ends a waiver on the current branch; like
  `unexempt` it only tightens, so a session may run it.
- `ko.mjs propose --close` (the owner's) closes this worktree's proposal
  without approving; `propose` and `approve` drop the proposals of
  worktrees that no longer exist.
- A refused commit's hook prints one more line after its refusal: run
  kh-orchestration's `status` for the cause, or ask the owner to run its
  `apply`. `apply` rewrites installed hooks of the earlier text.

### Changed

- Approvals are ordered. A tree whose protected files are an older
  approved version than its base's, or than the commit it is made on, is
  refused until the owner approves them again: against each of those two
  digests it must be equal or approved later (one that is `none`, from
  before the install, or never approved sets no order). Approving a
  digest again records a new approval at the end of `approvals.json`, and
  `approve` says when the staged files are such an older version. The
  gate, `verify-branch` (measuring from `HEAD`'s first parent), `status`
  and `run` apply one rule. Not caught: a commit git never hooks on the
  base branch (a revert) moves the point the order is measured from, and
  a stale branch approved after the base tightened can replace the base's
  checks through a merge that takes its side (see the README).
- The gate's next lines name the working copy's `ko.mjs` by its absolute,
  shell-quoted path, so they run pasted from a subdirectory; the
  extension's messages say to run it from the repository's top directory.
- `verify-branch`, `run` and `status` run from `bin/` name `bin/`'s
  `ko.mjs` in their next lines; an owner command refused inside a session
  names the command as typed (`propose --close` keeps `--close`); in a
  sparse checkout `run` names `git sparse-checkout disable`. While the
  extension module and its entry disagree, the gate's refusal and
  `status` name the two-file repair, and apply says the extension is off
  until it is made.
- `exempt`, and `status` on a branch without the install, name `unexempt`
  through the approved copy in `bin/`, the one that runs there.
- `du` is a reading command for the extension (`du -sh .git`).
- apply's dry run lists the manifest among what it writes; `uninstall
  --yes` of a committed install prints the command that commits the
  removal and says what other worktrees keep until they take it.
- The session brief says every commit will be refused when `bin/` is
  missing.
- `run` removes the in-flight records of git processes that have ended,
  as the gate does, which is what `status` names as their next step.

### Fixed

- An officer that changed the working tree or the index as it ran (an
  autofixing lint) got a passing verdict for a tree it never passed on.
  `run` and `verify-branch` now check, after the officers, that the tree
  is still tidy and the index still holds the tree judged, and record no
  verdict otherwise, naming the changed paths; and that no officer flagged
  an index entry assume-unchanged or skip-worktree. A change made and put
  back during the run is a stated limit.
- Any earlier approval stayed valid for ever, so restoring an older
  officers file (`git checkout HEAD~1 -- …/officers.json`) passed the
  gate with checks the owner had since made stricter.
- An index entry flagged assume-unchanged or skip-worktree hid a failing
  staged file behind a passing working copy. `run` and `verify-branch`
  refuse while any is flagged, with the commands that clear the flags;
  the extension blocks `git update-index --assume-unchanged` and
  `--skip-worktree`.
- `apply --yes` with a changed `extension.mjs` kept the module beside its
  stale entry, so kh-harness went on blocking every tool call. It now
  takes the entry out (tool calls work; commits are refused) and prints
  the two-file restore from `HEAD` then `apply --yes`; `status` names the
  same repair first.
- Six tests failed when the temporary directory's path was long; the
  suite passes with one of 124 and of 171 characters.

## 0.1.0 - 2026-11-26

The first release: the officer runner, the commit gate and the approval
lock of the v1 design's stage 1. It needs kh-harness 0.3.0 or later
(contract 1) in the same repository, git 2.30 or later and Node 22 or
later, and has no dependencies.

### Added

- Officers. `.claude/kh-orchestration/officers.json` lists the repository's
  checks, each a command run without a shell that exits 0 to pass, with the
  rule it enforces, the globs it applies to, a time limit and options it
  reads from `KO_OPTIONS`. `apply` writes a first file holding a tool
  officer for each of `lint`, `typecheck` and `test` the root
  `package.json` has; the owner edits it from there, and its `protected`
  list names further files the approval covers.
- The verdict. `ko.mjs run` runs every officer on a tidy staged tree and
  records the result keyed by that tree and its base (the merge base with
  the base branch), with each failure's output, the waivers in force, the
  digest of the protected files and the minor rules changed since the
  base; it appends the same to a run journal and, inside a session where
  kh-harness's session log is enabled, to that log.
- The commit gate. `pre-commit` and `pre-merge-commit` hooks run the gate
  from the approved copy of the scripts in the git directory. It allows a
  commit only when the tree holds the install, the working copies of the
  files the session's hooks run equal the tree, the protected files'
  digest is approved, contract 1 holds and a passing verdict exists for
  that tree and base, and it executes nothing of the repository's before
  the approval is established. A
  `reference-transaction` hook refuses a branch update whose commit is not
  the tree the gate allowed, so the index cannot change between the gate
  and the commit. Every refusal names the command to run next.
- The approval lock. A digest over the protected files (the rules
  registry, the officers file and every script it names, the installed
  scripts, kh-harness's files and the project settings) must be one the
  owner approved with `approve`, which shows the diff since the last
  approval and asks for the word `approve`. Rules marked `approval: agent`
  may have their title and their `why`, `verify` and `priority` values
  reworded by an agent without approval, and each such change is listed
  for the owner.
- The hook extension, run by kh-harness before every tool call. It blocks
  the one-line ways round the gate from a session: skipping the hooks,
  `commit-tree`, configuration that redirects hooks, writes to the git
  directory, the owner's commands, and edits to the protected files other
  than `RULES.md` unless the owner opened the worktree with `propose`.
- The command line, `ko.mjs`: `run`, `status`, `verify-branch` and
  `unexempt` for agents; `approve`, `propose`, `waive`, `exempt`, `off` and
  `on` for the owner, in their own terminal, from the approved copy only.
  `verify-branch` catches a branch built where git runs no commit hook (a
  rebase, a cherry-pick): it fails until the officers pass on its head.
- `apply` (a dry run unless `--yes`), `detect` and `uninstall`. Every write
  is recorded in `.claude/kh-orchestration.manifest.json`; no file it did
  not write is overwritten, an existing git hook is left with the line to
  add printed, and `uninstall --yes --state` removes what `apply` wrote and
  the owner left unchanged, the hooks, the shared state and its refs, so
  the repository is as it was but for the commits made. The writing runs
  are the owner's and refuse inside a session. `apply --downgrade` lets an
  older kit replace a newer install, and `apply --bin-from-plugin` fills
  `bin/` with the plugin's own scripts, keeping every approval, when no
  approved tree is left to restore it from.
- The session brief, the plugin's `SessionStart` hook: each session in a
  repository where kh-orchestration is installed on this machine is told
  that commits are checked, how to run the officers, what only the owner
  does and what is wrong. The `orchestrate` skill answers the same
  questions by name.
- Two example officers for vyugate in `examples/vyugate/`, with their
  tests: V8, documentation changes with business logic, and V11, database
  migrations are append-only. `docs/ROLLOUT-vyugate.md` gives the owner's
  steps to install them.
- `scripts/lib/stage1-measures.test.mjs`: one end-to-end test for each of
  the design's measures of stage 1, driven only through the real commands.
