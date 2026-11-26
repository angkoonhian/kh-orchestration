# Installing kh-orchestration in vyugate

The owner's steps, in order, to install kh-orchestration 0.1.0 in `~/projects/vyugate` with its first two coded checks, V8 and V11.

Run every command here in your own terminal, **not inside Claude Code**: `apply --yes`, `uninstall --yes` and the owner's commands refuse wherever `CLAUDECODE` or `CLAUDE_CODE_SESSION_ID` is set, and the extension blocks them from a session. Paths are written as `~/projects/kh-harness`, `~/projects/kh-orchestration` and `~/projects/vyugate`. Where a tool prints a command with absolute paths, this document says "run the line it prints" and shows its shape, with `/home/you` standing for your home directory.

What this document assumes about vyugate (checked on 2026-11-26): its kh-harness install records kit 0.2.0, so it has no contract file yet; it has no CI, no git hooks and no `core.hooksPath`; its base branch is `main`, which agents never push (rule V3), so you do; its root `package.json` has `lint`, `typecheck` and `test` scripts; `docs/harness/RULES.md` holds rules V1 to V13, with V8 and V11 `enforced-by: review`; work happens in Orca worktrees (linked worktrees of the same repository).

Because vyugate has no CI, nothing checks a branch after it leaves your machine. `verify-branch`, run before every merge into `main` (step 8), is that check.

## 0. Prerequisites

1. Open a terminal that Claude Code did not start, and check it is clean:

   ```sh
   env | grep -E '^(CLAUDECODE|CLAUDE_CODE_SESSION_ID)='
   ```

   It should print nothing. If it prints a line, open another terminal.

2. Check the versions:

   ```sh
   git version
   node --version
   ```

   git must be 2.30 or later and Node 22 or later.

3. Check that no `core.hooksPath` is set, at any level:

   ```sh
   cd ~/projects/vyugate
   git config --show-origin --get core.hooksPath
   ```

   It should print nothing (exit status 1). If it prints a value, git ignores the repository's hooks and kh-orchestration's gate would never run: remove the setting from the file it names (for the global file, `git config --global --unset core.hooksPath`) before going on.

4. Commit or stash the work in progress in every worktree, and switch the main worktree to `main`:

   ```sh
   git -C ~/projects/vyugate status --short
   git -C ~/projects/vyugate worktree list
   git -C ~/projects/vyugate switch main
   ```

   `git status --short` must print nothing in `~/projects/vyugate`: `run` refuses a tree with unstaged or untracked files. If it shows `.claude/settings.local.json`, add that path to `.gitignore` (it is personal and must never be committed or approved).

## 1. Update kh-harness in vyugate to 0.3.0

kh-orchestration relies on kh-harness's contract 1, which kh-harness 0.2.0 did not have.

1. The dry run:

   ```sh
   node ~/projects/kh-harness/scripts/apply.mjs ~/projects/vyugate
   ```

   It prints its proposals and the diffs, then `Dry run — nothing written. Re-run with --yes to apply.` On `main` it also prints `note: --yes would be refused — refusing to apply on the default branch "main"…`; that is expected, and is why step 2 gives `--allow-default-branch`. Read what it proposes, in particular its "WHAT THE HOOKS EXECUTE" section.

2. Apply it:

   ```sh
   node ~/projects/kh-harness/scripts/apply.mjs ~/projects/vyugate --yes --allow-default-branch
   ```

   It prints a `wrote`, `patched` or `kept` line per file, among them `wrote .claude/kh-harness/contract.json`, and `kept docs/harness/RULES.md (modified since kh-harness wrote it — left as-is)`. If it exits 3 with "uncommitted changes", go back to step 0.4.

3. Check, review and commit:

   ```sh
   cd ~/projects/vyugate
   grep '"contract"' .claude/kh-harness/contract.json
   grep '"kitVersion"' .claude/kh-harness.manifest.json
   git status --short
   git diff
   git add -A
   git commit -m "chore(harness): update kh-harness to 0.3.0"
   ```

   The two greps print `"contract": 1,` and `"kitVersion": "0.3.0",`. `git status` lists changed and new files under `.claude/scripts/`, `.claude/kh-harness/`, `.claude/settings.json`, `HANDOFF.md` and `docs/harness/FAILURES.md`. No kh-orchestration hook exists yet, so this commit is not gated.

## 2. Install kh-orchestration: the dry run, then `--yes`

1. The dry run writes nothing:

   ```sh
   node ~/projects/kh-orchestration/scripts/apply.mjs ~/projects/vyugate
   ```

   It lists the actions: fourteen scripts under `.claude/kh-orchestration/scripts/`, `officers.json` ("base branch main, officers lint, typecheck, test"), `.gitattributes` with the line `.claude/** -text`, kh-orchestration's entry in `.claude/kh-harness/extensions.json`, `bin/` in `.git/kh-orchestration/`, and the three git hooks `pre-commit`, `pre-merge-commit` and `reference-transaction` in `.git/hooks/`. It ends with `Nothing was written. To apply, …`.

   If it refuses instead, it says why and what to run next. The likely ones: no contract file (step 1 was not done or not in this checkout), a `core.hooksPath` (step 0.3), git older than 2.30, a `.claude` that is a link.

2. Install:

   ```sh
   node ~/projects/kh-orchestration/scripts/apply.mjs ~/projects/vyugate --yes
   ```

   It prints the same actions, then:

   ```
   kh-orchestration 0.1.0 is installed in /home/you/projects/vyugate.
   Nothing is approved yet: the commit gate refuses every commit until the owner approves the protected files.
   1. Read what was installed: …
   2. Stage the install, so the tree holds what the gate checks (…): git -C /home/you/projects/vyugate add -- .claude/kh-orchestration .claude/kh-orchestration.manifest.json .claude/kh-harness/extensions.json .gitattributes
   3. Approve, in your own terminal outside Claude Code: cd /home/you/projects/vyugate && node /home/you/projects/vyugate/.git/kh-orchestration/bin/ko.mjs approve
   4. Run the officers on the staged tree: cd /home/you/projects/vyugate && node /home/you/projects/vyugate/.claude/kh-orchestration/scripts/ko.mjs run
   5. Commit: git -C /home/you/projects/vyugate commit
   ```

   and then what the digest locks for each officer. Keep this output: steps 3 and 6 run its lines. From this moment every commit in the repository, on every branch and in every worktree, goes through the gate (step 9).

## 3. Stage what it installed, and read it

Run the line step 2 of the output prints:

```sh
git -C ~/projects/vyugate add -- .claude/kh-orchestration .claude/kh-orchestration.manifest.json .claude/kh-harness/extensions.json .gitattributes
```

Then read what you are about to approve: `.claude/kh-orchestration/officers.json`, the scripts in `.claude/kh-orchestration/scripts/` (`ko.mjs` is the command line, `gate.mjs` and `ko-gate.mjs` the gate, `extension.mjs` what runs before every tool call), and `.claude/kh-harness/extensions.json`.

## 4. The two officers

1. Copy them into vyugate:

   ```sh
   cd ~/projects/vyugate
   mkdir -p scripts/officers
   cp ~/projects/kh-orchestration/examples/vyugate/docs-with-logic.mjs scripts/officers/
   cp ~/projects/kh-orchestration/examples/vyugate/migrations-append-only.py scripts/officers/
   ```

   `~/projects/kh-orchestration/examples/vyugate/README.md` says what each checks and what it does not.

2. Edit `.claude/kh-orchestration/officers.json` in your editor, from `~/projects/kh-orchestration/examples/vyugate/officers.example.json`: keep the three tool officers `apply` wrote, add the two rule officers, and set `protected` to `["scripts/officers/**"]`. The result has this shape:

   ```json
   {
     "schema": 1,
     "baseBranch": "main",
     "protected": ["scripts/officers/**"],
     "officers": [
       { "id": "lint", "rule": null, "argv": ["npm", "run", "lint"], "appliesTo": ["**"] },
       { "id": "typecheck", "rule": null, "argv": ["npm", "run", "typecheck"], "appliesTo": ["**"] },
       { "id": "test", "rule": null, "argv": ["npm", "run", "test"], "appliesTo": ["**"] },
       {
         "id": "docs-with-logic",
         "rule": "V8",
         "argv": ["node", "scripts/officers/docs-with-logic.mjs"],
         "appliesTo": ["**"],
         "timeoutSeconds": 60,
         "options": {
           "logic": ["products/*/backend/src/**", "products/*/frontend/src/**"],
           "docs": ["docs/**", "**/README.md"]
         }
       },
       {
         "id": "migrations-append-only",
         "rule": "V11",
         "argv": ["python3", "scripts/officers/migrations-append-only.py"],
         "appliesTo": ["products/vision/backend/src/vyugate_api/db.py"],
         "timeoutSeconds": 60,
         "options": { "file": "products/vision/backend/src/vyugate_api/db.py", "name": "MIGRATIONS" }
       }
     ]
   }
   ```

   **V8's two glob lists are your judgement, not this document's.** The `logic` and `docs` lists above are a SUGGESTION to start from: replace them with the directories that hold vyugate's business logic and architecture, and those that hold its documentation, before you approve. The example file's `PLACEHOLDER-…` globs match nothing, so left in place V8 never fails. `docs/**` includes `docs/harness/RULES.md`, so a branch that proposes a rule change counts as having updated the docs. The globs follow the plugin's rules: `**` only as a whole segment, `*` and `?` never cross `/`, and no `{}` or `[]`.

   What the lock covers, and what it does not:
   - `scripts/officers/**` in `protected` locks both scripts: changing either needs your approval.
   - The three tool officers run `npm run lint|typecheck|test`. The approval does **not** lock what those scripts are, because `package.json` is not protected. Adding `"package.json"` to `protected` would lock them, at a cost: every change to `package.json` (a dependency bump, a new script) would then need your `approve` before it could be committed. Either way, what npm runs from `node_modules` is not locked.
   - V11 runs `python3` found through `PATH` (`/usr/bin/python3` on this machine); the interpreter is not locked either.

## 5. V8 and V11 become `enforced-by: officer`

In `docs/harness/RULES.md`, change the two rules' `enforced-by` and `pointer` lines, leaving their headings and `why` lines as they are:

```
## V8 — A business-logic or architecture change updates the docs in the same branch
- why: …
- enforced-by: officer
- pointer: scripts/officers/docs-with-logic.mjs

## V11 — Database migrations are append-only
- why: …
- enforced-by: officer
- pointer: scripts/officers/migrations-append-only.py
```

Optionally, mark any rule you consider minor with a line `- approval: agent`. An agent may then reword that rule's title and change the values of its `why`, `verify` and `priority` lines (so its check command, and `normal` or `high`) and commit without you; every such change is listed in `run`'s output and in `verify-branch`'s report. Any other change to that rule (its `status`, `enforced-by`, `pointer` or `approval` line, any added line, removing it) still needs you. Rules without the line need you for any change. Marking a rule `approval: agent` is itself a change you approve.

## 6. Stage, approve, run the officers, commit

1. Stage your edits:

   ```sh
   cd ~/projects/vyugate
   git add -- .claude/kh-orchestration/officers.json scripts/officers docs/harness/RULES.md
   git status --short
   ```

   `git status --short` lists only staged files (`A` or `M` in the first column): the install, the two officers and `RULES.md`.

2. Approve: run the line step 3 of `apply`'s output printed. Its shape:

   ```sh
   cd /home/you/projects/vyugate && node /home/you/projects/vyugate/.git/kh-orchestration/bin/ko.mjs approve
   ```

   It prints `Approving the protected files of the staged tree … (digest …) on main.`, the files the digest covers (about forty), `No earlier approval records a tree to compare with, so read these files in full before approving.`, and asks `Type approve and press Enter to approve; anything else cancels:`. Type `approve` and press Enter. It answers `Approved: digest … of tree … bin/ now holds this tree's scripts, and this worktree is closed for proposals.`

3. Run the officers: run the line step 4 printed (`cd /home/you/projects/vyugate && node /home/you/projects/vyugate/.claude/kh-orchestration/scripts/ko.mjs run`). Expect:

   ```
   Officers on the staged tree … against the base …:
     lint  pass  …
     typecheck  pass  …
     test  pass  …
     docs-with-logic  pass  …
     migrations-append-only  skipped  …
   Rules marked approval: agent reworded since the base: none.
   Passing: the staged tree … may be committed; its protected files are approved.
   Next: git commit
   ```

   `migrations-append-only` is skipped because `db.py` did not change. If a tool officer fails, its first output lines are shown under it: fix the cause (or the officer), stage, and run again. If it says `Passing, but the protected files of this tree … are not approved`, something protected was staged after you approved: approve again.

4. Commit:

   ```sh
   git -C ~/projects/vyugate commit -m "chore: install kh-orchestration with the V8 and V11 officers"
   ```

   The commit lands. If it is refused, the message says why and names the command to run next.

## 7. Check it

```sh
cd ~/projects/vyugate
node .claude/kh-orchestration/scripts/ko.mjs status
node ~/projects/kh-orchestration/scripts/detect.mjs ~/projects/vyugate
```

`status` ends with `No problems found.`, and shows the hooks as `pre-commit ok, pre-merge-commit ok, reference-transaction ok` and `HEAD's tree: passing (recorded as accepted by the gate)`. `detect` ends with `Next: nothing: the install is complete and the commit gate is on`.

Then see a refusal, with a change V11 forbids:

```sh
sed -i 's/\[SCHEMA_V1, /[SCHEMA_V1_BROKEN, /' products/vision/backend/src/vyugate_api/db.py
git add products/vision/backend/src/vyugate_api/db.py
node .claude/kh-orchestration/scripts/ko.mjs run
git commit -m "trial: edit an applied migration"
git restore --staged --worktree products/vision/backend/src/vyugate_api/db.py
```

(If the list does not start with `SCHEMA_V1`, edit the first element by hand instead.) `run` exits 1 with `migrations-append-only  fail` and `V11: element 0 of MIGRATIONS differs from the base…` (and, with the suggested globs, `docs-with-logic  fail`, since a backend file changed without a doc). The commit is refused:

```
kh-orchestration: These officers did not pass on this tree: … migrations-append-only. Fix what they report, stage the fix, and run the officers again.
Next: node .claude/kh-orchestration/scripts/ko.mjs run
kh-orchestration: the commit gate did not allow this commit.
```

The last command puts the file back.

## 8. Everyday use

**What an agent sees.** Every Claude Code session in a vyugate worktree starts with a short brief: commits are checked, the `run` command to use, what only you do, and whether that worktree is open for proposals. An agent stages its change, runs `node .claude/kh-orchestration/scripts/ko.mjs run`, and commits. A session that skips this has its commit refused with the command to run. A session cannot skip the hooks, write to the git directory, run your commands or edit the protected files (other than `RULES.md`); when it needs one of those, it asks you.

**What you do when asked.** Run the owner's commands from the worktree concerned (they act on its branch and its staged tree), always through the approved copy in the shared git directory:

```sh
cd <the worktree>
node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs approve
node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs propose
node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs waive V8 --reason "<why, in a few words>"
node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs exempt <branch> --reason "<why>"
```

- `approve`: when a change touches a protected file (a rule, `officers.json`, an officer script, kh-harness's files, `.claude/settings.json`). Read the diff it shows before typing `approve`. The verdict the agent already took stays valid, so the agent then only commits.
- `propose`: when an agent should edit `officers.json` or an officer script itself. It opens that worktree, and only that one, until the next `approve` closes it. `.claude/settings.local.json` and the git directory stay closed.
- `waive V8 --reason …`: for a branch whose logic change really needs no doc change. It applies to the current branch from the next `run`, and the reason is shown in every verdict and in `verify-branch`'s report.
- `exempt <branch> --reason …`: lets that branch's commits through unchecked (step 9). `verify-branch` still fails such a branch.

**Before every merge into `main`.** In the branch's worktree, with a clean tree:

```sh
node .claude/kh-orchestration/scripts/ko.mjs verify-branch
```

It runs the officers on the branch's head and ends with `Pass: HEAD's tree has a passing verdict against its base, its protected files are approved and contract 1 holds.` (exit 0), or `Fail: …` with the next command. Its report lists any exemption, the waivers in force and every rule an agent reworded since the base. Then merge in the main worktree:

```sh
cd ~/projects/vyugate
git switch main
git merge --ff-only <branch>
```

When `main` has moved on since the branch was made, a fast-forward is not possible; make a merge commit through the gate instead:

```sh
git merge --no-ff --no-commit <branch>
node .claude/kh-orchestration/scripts/ko.mjs run
git commit --no-edit
```

Then push `main` yourself.

## 9. Other branches and worktrees

Once the install is committed on `main`, **every branch or worktree whose tree does not carry the install has every commit refused**, with:

```
kh-orchestration: This tree holds no usable kh-orchestration install, so the commit gate refuses it: .claude/kh-orchestration/officers.json is not a file in this tree. …
Next: node /home/you/projects/vyugate/.git/kh-orchestration/bin/ko.mjs exempt <branch> --reason "<why>"
```

The hooks and the shared state belong to the whole repository, so this includes the feature branch that is checked out now and every Orca worktree.

**Bring a branch across** by merging `main` into it, in that branch's worktree:

```sh
cd <the worktree>
git merge --no-commit main
node .claude/kh-orchestration/scripts/ko.mjs run
git commit --no-edit
```

Resolve any conflicts before `run`. When the branch has no commits of its own, the merge is a fast-forward and there is nothing to commit. (A plain `git merge main` is refused at its merge commit with `No verdict is recorded for this tree…` and leaves the merge in progress; `run` and `git commit --no-edit` then finish it the same way.) If the branch also changed a protected file, `run` says the digest is not approved: approve from that worktree, then commit. Alternatively, `git rebase main` brings the install in without a gated commit; the rebased head then has no verdict until the next commit through the gate, or until `verify-branch` runs the officers on it.

**Or exempt the branch**, for one that will not be merged or must be finished first:

```sh
node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs exempt <branch> --reason "<why>"
```

End the exemption with `node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs unexempt <branch>`. (The exemption's own "Next" line names the working copy's `ko.mjs`, which does not exist on a branch without the install; the copy in `bin/` runs the same `unexempt`.)

A new Orca worktree made from `main` after the install carries it from its first commit.

## 10. Upgrades

Always run the installers from your own terminal, and approve again when they change protected files.

- **kh-harness:** `node ~/projects/kh-harness/scripts/apply.mjs ~/projects/vyugate --yes --allow-default-branch`, then stage what it changed (`git status --short`), approve, `run` and commit. Its files under `.claude/scripts/`, `.claude/kh-harness/` and `.claude/settings.json` are protected, so the gate refuses the commit until you approve them.
- **kh-orchestration:** update `~/projects/kh-orchestration`, then `node ~/projects/kh-orchestration/scripts/apply.mjs ~/projects/vyugate` (the dry run) and `… --yes`. It says `The files this run changed are protected: the commit gate refuses every commit until the owner approves them again.` and prints the same five steps: run them. Other branches keep their older install, which is still approved, until they merge `main`.

## 11. Switching off, and uninstalling

To let every commit through unchecked for a while, and back:

```sh
node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs off
node ~/projects/vyugate/.git/kh-orchestration/bin/ko.mjs on
```

While it is off, each commit prints `kh-orchestration is switched off for this repository, so this commit is not checked.`, and sessions are told it is off. A commit made while it was off has no verdict: `status` names it, and `verify-branch` fails the branch until the officers pass on its head.

To uninstall, from the main worktree on `main`:

```sh
node ~/projects/kh-orchestration/scripts/uninstall.mjs ~/projects/vyugate
node ~/projects/kh-orchestration/scripts/uninstall.mjs ~/projects/vyugate --yes --state
git -C ~/projects/vyugate status --short
git -C ~/projects/vyugate add -A
git -C ~/projects/vyugate commit -m "chore: uninstall kh-orchestration"
```

The dry run lists what it would remove. `--yes --state` removes the scripts, the extension entry (and `extensions.json` if no other entry is left), the `.gitattributes` line, the three hooks, the shared state and the refs under `refs/kh-orchestration/`, and ends with `kh-orchestration is uninstalled from …`. It keeps what you changed and says so: your edited `officers.json`, and the manifest, which then records only what was kept. Delete those two yourself if you will not install again. Commits already made stay as they are, and other worktrees keep their committed copy of the install until they take in the removal (with no hooks left, their commits are not checked). The two officer scripts and your `RULES.md` edits are yours and stay.

## 12. When everything is blocked or refused

**Every tool call in a session is blocked**, with a message starting `kh-harness extension kh-orchestration: its module file does not match the sha256 recorded for it…` (or `…is missing`). The extension's entry and its module have come apart, usually after one of the two files was restored or checked out alone. In your terminal, for the worktree of that session:

```sh
node ~/projects/kh-orchestration/scripts/apply.mjs <the worktree> --yes
```

It writes the pair back as this plugin ships it; the next tool call is allowed. Do not `git restore` one of the two files alone. A block that starts `kh-harness: .claude/scripts/…` is kh-harness's own: run kh-harness's `apply --yes` (step 10).

**Every commit is refused.** Ask for the cause:

```sh
node .claude/kh-orchestration/scripts/ko.mjs status
```

Its `Problems:` list names each cause with its next command. The common ones: Node moved (an upgrade or an nvm switch: "starts Node as …, which no longer exists"), `bin/` missing or damaged, a `core.hooksPath` set, or kh-harness's contract not holding; the first three are mended by kh-orchestration's `apply --yes` from your terminal (the third after you unset it), the last by the installer named. To get urgent work committed meanwhile, `off`, then `on` again afterwards.

## 13. Known limits that matter in daily use

- **The shared state is not tamper-proof.** The verdicts and approvals are files in `.git/kh-orchestration/`. Sessions cannot write them in one line, but a determined agent running a script it wrote could. `verify-branch` without `--no-run` runs the officers again, which is why it comes before every merge.
- **What git never hooks is not blocked:** rebase, cherry-pick, revert, `git am`, fast-forward merges, stash and plumbing. Such a head has no verdict; `status` says so and `verify-branch` fails it until the officers pass on it.
- **A commit you make yourself with `--no-verify`** skips the gate; only sessions are stopped from doing that. Its head then fails `verify-branch` like any unhooked commit.
- **The approval locks the protected files, not everything an officer runs:** not the code it checks, not `node_modules`, `npm` or `python3`, not `package.json` unless you protect it.
- **V8 checks that some documentation path changed, not that the right one did.** V11 does not see a change made to the list after its literal (`MIGRATIONS.append(…)`), and treats every migration already on `main` as applied.
- **A clone of vyugate has no gate** until you run `apply --yes` in it: the hooks and the state live in the git directory, which a clone does not copy. `git push --mirror` (and a mirror clone) sends the refs under `refs/kh-orchestration/approved/`; an ordinary push does not.
- **Some harmless commands are blocked in a session:** inline code that mentions a guarded word (`node -e "…git commit -n…"`), test-name patterns behind a runner (`npx jest -t …`), `git commit --author "$A"` (glue it: `--author="$A"`), a `PATH=` or `HOME=` assignment in a line that also runs git, and any write into the git directory except `rm -f .git/index.lock`. Each message says what to do instead.
- **The extension does not see everything:** a script written to disk and then run, `eval`, variables holding flags, or an encoded payload piped to a shell. The gate, the digest and `verify-branch` are the backstop.
- **Each commit costs about 140 ms**, a rebase about 15 ms more per rebased commit, and each tool call about 10 ms.
