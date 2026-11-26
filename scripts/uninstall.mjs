#!/usr/bin/env node
// kh-orchestration's uninstall (Task 9): `node <kh-orchestration>/scripts/uninstall.mjs <repository> [--yes] [--state]`.
// Removes what apply recorded in the repository <repository> is in, in the reverse of apply's
// order, each only if it is what was written; what the owner changed is kept and reported. The
// shared state directory goes only with --state. A dry run unless --yes, and --yes is the owner's
// alone (decision 13): it refuses inside a Claude Code session, since removing the hooks switches
// the commit gate off. Exit 0 done, 1 refused, 2 usage. The logic is scripts/lib/install.mjs's.
import { TEXT, applyUninstall, parseArguments, print, refuse, runCommand, uninstallLines, uninstallPlan, usageError } from './lib/install.mjs';

const OWNER_VARIABLES = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'];

function main(argv) {
  const args = parseArguments(argv, ['--yes', '--state']);
  if (args.help) {
    print([`usage: ${TEXT.usage('uninstall')}`]);
    return 0;
  }
  if (args.usage !== undefined) return usageError('uninstall', args.usage);
  const dryRun = !args.flags.has('--yes');
  const state = args.flags.has('--state');
  const planned = uninstallPlan(args.repo, { state });
  if (planned.refusals.length > 0) return refuse(planned.refusals);
  const variable = OWNER_VARIABLES.find((name) => process.env[name] !== undefined);
  if (!dryRun && variable !== undefined) return refuse([{ text: TEXT.ownerOnly(variable), next: `${TEXT.uninstallCommand(planned.root, state)}, in the owner's own terminal` }]);
  print(uninstallLines(planned, { dryRun }));
  if (planned.actions.length === 0) return 0;
  if (dryRun) {
    print([TEXT.uninstallDryEnd(TEXT.uninstallCommand(planned.root, state))]);
    return 0;
  }
  applyUninstall(planned.root, planned);
  print([TEXT.uninstalled(planned.root)]);
  return 0;
}

runCommand('uninstall', main);
