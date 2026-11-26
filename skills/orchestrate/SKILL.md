---
name: orchestrate
description: Use when a person asks to "run the checks", "run the officers", "is this branch ready to merge", "verify the branch", or "why was my commit refused" in a repository where kh-orchestration is installed, or asks what it enforces.
---

# orchestrate

kh-orchestration refuses any commit whose exact staged tree has not passed the repository's checks (its officers), and any change to the protected files that the owner has not approved. Nothing depends on this skill being used: the commit hooks enforce it, and sessions in a repository where it is installed on this machine are told the rules at their start.

Every command below is the working copy's `ko.mjs`, run from anywhere in the repository:

    node <repository>/.claude/kh-orchestration/scripts/ko.mjs <command>

- `run`: runs the officers on the staged tree. A commit needs a passing run of exactly what is staged, so run it again after any change.
- `verify-branch`: checks that the branch's head passes, before merging. Say what it printed; do not call a branch ready unless it said so.
- `status`: shows the switch, the branch, the verdicts and, under "Problems", what will refuse a commit and the next command for each.

When a commit is refused, read the refusal: it names the command to run next.

These are the owner's alone, run in their own terminal outside Claude Code, and you must never run them: `approve`, `propose`, `waive`, `exempt`, `off`, `on`, and the plugin's `apply` and `uninstall --yes`. When one is needed, tell the person the exact command and ask them to run it. Do not edit the protected files unless `status` shows this worktree is open for proposals.
