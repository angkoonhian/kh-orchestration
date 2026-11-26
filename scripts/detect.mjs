#!/usr/bin/env node
// kh-orchestration's detect (Task 9): `node <kh-orchestration>/scripts/detect.mjs <repository> [--json]`.
// Reports, without writing anything or executing any of the repository's code, what is installed
// in the repository <repository> is in, what the commit gate sees there (ko.mjs status's report),
// and what apply --yes would do. --json prints the same as one object. Exit 0 reported, 1 refused
// (no repository), 2 usage. The logic is scripts/lib/install.mjs's.
import { TEXT, detect, detectLines, parseArguments, print, refuse, runCommand, usageError } from './lib/install.mjs';

function main(argv) {
  const args = parseArguments(argv, ['--json']);
  if (args.help) {
    print([`usage: ${TEXT.usage('detect')}`]);
    return 0;
  }
  if (args.usage !== undefined) return usageError('detect', args.usage);
  const report = detect(args.repo);
  if (report.refusal !== undefined) {
    if (!args.flags.has('--json')) return refuse([report.refusal]);
    process.stdout.write(`${JSON.stringify({ schema: 1, root: null, refusal: report.refusal }, null, 2)}\n`);
    return 1;
  }
  if (args.flags.has('--json')) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else print(detectLines(report));
  return 0;
}

runCommand('detect', main);
