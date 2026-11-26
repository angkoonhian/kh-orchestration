// Test-only helper for the example officers' tests: runs an officer the way the runner does
// (decision 10), as a child process in the repository root with the five KO_ variables and no
// Claude Code session markers, and builds the base and tree ids with git.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { testEnv } from '../../scripts/lib/test-repo.mjs';

export const headCommit = (repo) => repo.git('rev-parse', 'HEAD').stdout.trim();
export const headTree = (repo) => repo.git('rev-parse', 'HEAD^{tree}').stdout.trim();

// `values` overrides the default KO_ variables; a value of undefined leaves that variable unset.
// `changed` is the list of changed paths, written NUL-separated outside the repository.
export function runOfficer(repo, argv, { changed = [], values = {} } = {}) {
  const changedFile = join(dirname(repo.root), 'changed');
  writeFileSync(changedFile, changed.join('\0'));
  const env = { ...testEnv(), KO_OPTIONS: '{}', KO_BASE: 'none', KO_TREE: headTree(repo), KO_CHANGED_FILE: changedFile, KO_WAIVERS: '[]', ...values };
  for (const name of Object.keys(env)) if (env[name] === undefined) delete env[name];
  const result = spawnSync(argv[0], argv.slice(1), { cwd: repo.root, env, encoding: 'utf8' });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}
