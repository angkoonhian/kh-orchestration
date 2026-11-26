// The command line's entry: `node .claude/kh-orchestration/scripts/ko.mjs <command>`. The
// commands are ko-cli.mjs's; this file only starts them, so that nothing a person or a model reads
// is ever a stack trace. Its main ALWAYS runs (no "am I the main module" test, as for gate.mjs).
// ko-cli.mjs is imported dynamically: a sibling that is missing, damaged or of another version is
// reported with the literal text below. Only node: built-ins could be imported here, and none is
// needed (import.meta.dirname is Node's own).

// Literals only: when these are printed, nothing beside this file could be loaded or finished.
// Which copy failed decides the repair: the working copy is the session's to put right; the
// approved copy in <git-common-dir>/kh-orchestration/bin/ is restored by kh-orchestration's apply,
// the same command status and gate.mjs name (ko-cli's repairCommand; a test holds them together).
const FROM_BIN = import.meta.dirname.endsWith('/kh-orchestration/bin');
const UNLOADABLE = FROM_BIN
  ? 'kh-orchestration: ko.mjs could not start: the approved copy in <git-common-dir>/kh-orchestration/bin/ is missing a script, or one is damaged or of another version.\n'
    + 'Next: node <kh-orchestration>/scripts/apply.mjs <repository> --yes\n'
  : 'kh-orchestration: ko.mjs could not start: a script beside it in .claude/kh-orchestration/scripts/ is missing, damaged or of another version.\n'
    + 'Next: git status -- .claude/kh-orchestration/scripts\n';
const UNEXPECTED = 'kh-orchestration: ko.mjs could not finish: an unexpected error stopped it.\n'
  + 'Next: node .claude/kh-orchestration/scripts/ko.mjs status\n';

process.exitCode = 1;
// A reader that stops early (`| head`) is no failure of the command, and no trace.
process.stdout.on('error', () => {});
let cli;
try {
  cli = await import('./ko-cli.mjs');
  if (typeof cli.main !== 'function') cli = undefined;
} catch {
  cli = undefined;
}

if (cli === undefined) {
  process.stderr.write(UNLOADABLE);
} else {
  try {
    const code = await cli.main(process.argv.slice(2));
    process.exitCode = Number.isInteger(code) ? code : 1;
  } catch {
    process.exitCode = 1;
    process.stderr.write(UNEXPECTED);
  }
}
