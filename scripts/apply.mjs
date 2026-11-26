#!/usr/bin/env node
// kh-orchestration's apply (Task 9): `node <kh-orchestration>/scripts/apply.mjs <repository> [--yes]`.
// Installs the plugin into the repository that <repository> is in (any directory of it, or of a
// linked worktree: the hooks and the shared state are the repository's), or repairs an install.
// A dry run unless --yes: it prints every action and writes nothing. --yes is the owner's alone
// (after Task 9's review): it refuses inside a Claude Code session. Exit 0 done or nothing to
// do, 1 refused or incomplete, 2 usage. The logic is scripts/lib/install.mjs's.
import { TEXT, applyCommand, applyPlan, closingLines, nextAfterApply, ownerRefusal, parseArguments, plan, planLines, print, refuse, runCommand, usageError } from './lib/install.mjs';

function main(argv) {
  const args = parseArguments(argv, ['--yes', '--downgrade', '--bin-from-plugin']);
  if (args.help) {
    print([`usage: ${TEXT.usage('apply')}`]);
    return 0;
  }
  if (args.usage !== undefined) return usageError('apply', args.usage);
  const planned = plan(args.repo, { downgrade: args.flags.has('--downgrade'), binFromPlugin: args.flags.has('--bin-from-plugin') });
  if (planned.refusals.length > 0) return refuse(planned.refusals);
  if (planned.actions.length === 0 && planned.conflicts.length === 0) {
    // Notes are printed whatever else there is (after Task 9's third re-review): a bin/ that cannot
    // be checked is said here, as status says it.
    const notes = planned.notes.length === 0 ? [] : [TEXT.notesHeader, ...planned.notes.map((note) => `  - ${note}`)];
    print([TEXT.nothingToDo(planned.root), ...notes, `Next: ${nextAfterApply(planned.root, planned)}`]);
    return 0;
  }
  const dryRun = !args.flags.has('--yes');
  const session = dryRun ? null : ownerRefusal('apply', applyCommand(planned.root));
  if (session !== null) return refuse([session]);
  print(planLines(planned, { dryRun }));
  if (dryRun) {
    print([TEXT.dryRunEnd(applyCommand(planned.root))]);
    return 0;
  }
  const result = applyPlan(planned.root, planned);
  if (result.refusal !== null) return refuse([result.refusal]);
  if (planned.conflicts.length > 0) {
    print([TEXT.incomplete]);
    return 1;
  }
  print(closingLines(planned.root, planned));
  return 0;
}

runCommand('apply', main);
