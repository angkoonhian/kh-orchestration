// The commit gate's entry: the script git's pre-commit, pre-merge-commit and reference-transaction
// hooks run from the copy in <git-common-dir>/kh-orchestration/bin/ (decision 18, further amended),
// so it never depends on the files of the tree being committed. The judgement is ko-gate.mjs's;
// for reference-transaction it reads the updates from standard input.
//
// Its main ALWAYS runs: there is no "am I the main module" test, which a symlink anywhere on the
// path made false, turning the gate into a silent exit 0. The hook allows only on exit 0 AND the
// token below on standard output, printed only on an allow; every other text goes to standard
// error. ko-gate.mjs and its siblings are imported dynamically and checked for what this file
// uses, so a missing, damaged or other-version sibling is a refusal with the literal text below.
// Only node: built-ins could be imported here, and none is needed.

const ALLOWED_TOKEN = 'kh-orchestration: allowed';
// Literals only: when this is printed, nothing beside the gate could be loaded. The owner's
// commands run from this same bin/, so the repair is kh-orchestration's apply, run from the plugin,
// which copies the approved tree's scripts into bin/ again.
const UNLOADABLE = 'kh-orchestration: the gate could not decide: a script in <git-common-dir>/kh-orchestration/bin/ is missing, out of date or cannot be loaded. The commit is refused.\n'
  + 'Next: ask the owner to run, in their own terminal outside Claude Code: node <kh-orchestration>/scripts/apply.mjs <repository> --yes\n';
const UNEXPECTED = 'kh-orchestration: the gate could not decide: an unexpected error stopped the check. The commit is refused.\n'
  + 'Next: node .claude/kh-orchestration/scripts/ko.mjs status\n';

process.exitCode = 1;
let gate;
try {
  gate = await import('./ko-gate.mjs');
  if (typeof gate.runGate !== 'function' || typeof gate.REASONS?.allowed !== 'string' || typeof gate.REASONS.updateAllowed !== 'string') gate = undefined;
} catch {
  gate = undefined;
}

try {
  if (gate === undefined) {
    process.stderr.write(UNLOADABLE);
  } else {
    const decision = gate.runGate(process.argv.slice(2), process.cwd());
    const shaped = decision !== null && typeof decision === 'object' && typeof decision.allow === 'boolean'
      && typeof decision.reason === 'string' && typeof decision.next === 'string';
    if (!shaped) {
      process.stderr.write(UNEXPECTED);
    } else if (decision.allow) {
      // Said only when nothing was checked: the off switch and an exemption.
      if (decision.reason !== gate.REASONS.allowed && decision.reason !== gate.REASONS.updateAllowed) process.stderr.write(`kh-orchestration: ${decision.reason}\n`);
      process.stdout.write(`${ALLOWED_TOKEN}\n`);
      process.exitCode = 0;
    } else {
      process.stderr.write(`kh-orchestration: ${decision.reason}\nNext: ${decision.next}\n`);
    }
  }
} catch {
  process.exitCode = 1;
  process.stderr.write(UNEXPECTED);
}
