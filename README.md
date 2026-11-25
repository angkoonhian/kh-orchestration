# kh-orchestration

A Claude Code plugin that refuses any commit or merge commit whose exact tree has not passed the repository's officers (its own checks).
The files that decide what "passing" means change only with the owner's approval.
It installs a few scripts and two git hooks into a repository; nothing is bundled and nothing stays running.
It needs the kh-harness plugin, version 0.3.0 or later, installed in the same repository.
Run its tests with `npm test` (Node 22 or later, no dependencies).
