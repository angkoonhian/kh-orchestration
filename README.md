# kh-orchestration

A Claude Code plugin that refuses any commit or merge commit whose exact tree has not passed the repository's officers (its own checks).
The files that decide what "passing" means change only with the owner's approval.
It installs a few scripts and three git hooks into a repository; nothing is bundled and nothing stays running.
It needs the kh-harness plugin, version 0.3.0 or later, installed in the same repository.
Run its tests with `npm test` (Node 22 or later, no dependencies), and the slow ones (the real commit race, over 40 timed runs) with `npm run test:slow`.

## What it puts in your repository

`node <kh-orchestration>/scripts/apply.mjs <repository>` shows everything first and writes nothing; the owner runs it again with `--yes`, in their own terminal.

- In the working tree, to be committed: `.claude/kh-orchestration/` (the scripts and `officers.json`), `.claude/kh-orchestration.manifest.json` (the record of what was written), an entry in `.claude/kh-harness/extensions.json`, and the line `.claude/** -text` in `.gitattributes`.
- In the git directory, never committed: the `pre-commit`, `pre-merge-commit` and `reference-transaction` hooks, and the shared state in `.git/kh-orchestration/` (verdicts, approvals, exemptions, waivers, accepted records, and `bin/`, the approved copy of the scripts the hooks run).
- Refs under `refs/kh-orchestration/approved/`, one per approval, each naming the approved tree so that `git gc` and `git prune` keep it. They are not branches or tags, so an ordinary push or clone leaves them out, but `git push --mirror` and a mirror clone send them.

`node <kh-orchestration>/scripts/uninstall.mjs <repository> --yes` removes what apply wrote and kept unchanged; with `--state` it also removes the shared state and the refs under `refs/kh-orchestration/`.
