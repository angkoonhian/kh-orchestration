// ko-contract.mjs: the gate relies on contract 1 only when kh-harness's verifier, given this
// plugin's own entry, finds no problem and no warning and the probe is denied
// (CONTRACT.md, "What a plugin must check before relying on contract 1").
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_MODULE, KIT_VERSION, installKhHarness, installedScript, isolateProcessEnv, makeRepo, registerExtension } from './test-repo.mjs';
import {
  EXTENSION_ID, PROBE_PAYLOAD, contractHolds, extensionUnreadableMessage, noStampMessage, ownEntry,
} from '../../assets/scripts/ko-contract.mjs';
import { MESSAGES, preToolUse } from '../../assets/scripts/extension.mjs';
import { lfSha256 } from '../../assets/scripts/verify-contract-1.mjs';

isolateProcessEnv();
// The probe runs kh-harness's real hook: its session log and markers go to this run's directories.
const hookDirs = realpathSync(mkdtempSync(join(tmpdir(), 'ko-contract-hook-')));
process.env.KH_DATA_DIR = join(hookDirs, 'data');
process.env.HK_MARKER_DIR = join(hookDirs, 'markers');

const repos = [];
after(() => {
  for (const repo of repos) repo.cleanup();
  rmSync(hookDirs, { recursive: true, force: true });
});

function installed() {
  const repo = makeRepo({ files: { 'a.txt': 'x\n' } });
  repos.push(repo);
  installKhHarness(repo.root);
  const entry = registerExtension(repo.root);
  return { root: repo.root, entry };
}

const editJson = (path, change) => {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  change(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

test('ownEntry is the entry apply writes: the installed extension, its stamp\'s version, its LF hash, onFailure block', () => {
  const { root, entry } = installed();
  assert.equal(EXTENSION_ID, 'kh-orchestration');
  const own = ownEntry(root);
  assert.deepEqual(own, {
    id: 'kh-orchestration', version: KIT_VERSION, module: EXTENSION_MODULE, sha256: lfSha256(readFileSync(join(root, EXTENSION_MODULE))), onFailure: 'block',
  });
  assert.deepEqual(own, entry);
});

test('ownEntry takes the version from the stamp line, so a module stamped by another kit names that kit', () => {
  const { root } = installed();
  writeFileSync(join(root, EXTENSION_MODULE), installedScript('extension.mjs').replace(`kh-orchestration ${KIT_VERSION}.`, 'kh-orchestration 9.8.7-rc.1.'));
  assert.equal(ownEntry(root).version, '9.8.7-rc.1');
});

test('ownEntry throws fixed text for an extension that is missing, not a file, or carries no stamp line', () => {
  const { root } = installed();
  writeFileSync(join(root, EXTENSION_MODULE), readFileSync(join(root, EXTENSION_MODULE), 'utf8').split('\n').slice(1).join('\n'));
  assert.throws(() => ownEntry(root), { message: noStampMessage });
  rmSync(join(root, EXTENSION_MODULE));
  assert.throws(() => ownEntry(root), { message: extensionUnreadableMessage });
  mkdirSync(join(root, EXTENSION_MODULE));
  assert.throws(() => ownEntry(root), { message: extensionUnreadableMessage });
});

test('PROBE_PAYLOAD is a PreToolUse Bash call of git commit --no-verify, and the extension blocks it as a skipped gate', () => {
  const { root } = installed();
  assert.deepEqual(PROBE_PAYLOAD, {
    session_id: 'kh-orchestration-probe', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'git commit --no-verify -m probe' }, tool_use_id: 'kh-orchestration-probe',
  });
  assert.ok(Object.isFrozen(PROBE_PAYLOAD) && Object.isFrozen(PROBE_PAYLOAD.tool_input));
  assert.deepEqual(preToolUse({ ...PROBE_PAYLOAD, cwd: root }), { decision: 'block', message: MESSAGES.noVerify });
});

test('contractHolds is ok on a fresh install with the entry registered', () => {
  const { root } = installed();
  assert.deepEqual(contractHolds(root), { ok: true });
});

test('contractHolds reports the verifier\'s problem when the registration gains "async": true', () => {
  const { root } = installed();
  editJson(join(root, '.claude/settings.json'), (settings) => {
    settings.hooks.PreToolUse[0].hooks[0].async = true;
  });
  assert.deepEqual(contractHolds(root), {
    ok: false, problems: ['.claude/settings.json does not register .claude/scripts/dispatch-pre-tool.mjs on PreToolUse for every tool call, as apply writes it'],
  });
});

test('contractHolds reports disableAllHooks in settings.local.json', () => {
  const { root } = installed();
  writeFileSync(join(root, '.claude/settings.local.json'), '{ "disableAllHooks": true }\n');
  assert.deepEqual(contractHolds(root), { ok: false, problems: ['.claude/settings.local.json sets disableAllHooks to a value other than false'] });
});

test('contractHolds reports an extensions file that lacks the entry', () => {
  const { root } = installed();
  writeFileSync(join(root, '.claude/kh-harness/extensions.json'), '[]\n');
  assert.deepEqual(contractHolds(root), { ok: false, problems: ['.claude/kh-harness/extensions.json does not list the extension kh-orchestration as expected'] });
});

test('contractHolds runs the probe: an entry script that exits 0 silently, re-hashed into the contract file, is a problem', () => {
  const { root } = installed();
  const entryScript = '.claude/scripts/dispatch-pre-tool.mjs';
  writeFileSync(join(root, entryScript), 'process.exit(0);\n');
  editJson(join(root, '.claude/kh-harness/contract.json'), (contract) => {
    contract.files[entryScript] = lfSha256(readFileSync(join(root, entryScript)));
  });
  assert.deepEqual(contractHolds(root), { ok: false, problems: ['the installed entry script did not print the deny contract 1 describes for the extension kh-orchestration'] });
});

test('contractHolds turns a throw into a problem with fixed text: the extension missing or unstamped', () => {
  const { root } = installed();
  writeFileSync(join(root, EXTENSION_MODULE), 'export function preToolUse() { return { decision: \'block\', message: \'x\' }; }\n');
  assert.deepEqual(contractHolds(root), { ok: false, problems: [noStampMessage] });
  rmSync(join(root, EXTENSION_MODULE));
  assert.deepEqual(contractHolds(root), { ok: false, problems: [extensionUnreadableMessage] });
});

test('contractHolds on a directory that holds no install reports a problem, never throws', () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'ko-contract-empty-')));
  try {
    assert.deepEqual(contractHolds(empty), { ok: false, problems: [extensionUnreadableMessage] });
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
