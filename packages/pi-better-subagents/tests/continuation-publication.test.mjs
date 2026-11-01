import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'continuation-publication-'));
process.env.TMPDIR = root;
register(new URL('./pi_host_stub_hooks.mjs', import.meta.url));
const { default: betterSubagents } = await import('../index.ts');
const { baseDir, listMetas } = await import('../registry.ts');
const { processExists, killProcessTree } = await import('../spawn.ts');
const { readConversationLease } = await import('../continuation.ts');

// Pi is an external process boundary. A real long-lived child ensures a launch
// publication error cannot be hidden by a child that happened to finish first.
const bin = join(root, 'bin');
mkdirSync(bin);
const executable = join(bin, 'pi');
writeFileSync(executable, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n');
chmodSync(executable, 0o755);
const oldPath = process.env.PATH;
process.env.PATH = `${bin}:${oldPath ?? ''}`;
const workspace = join(root, 'workspace');
mkdirSync(workspace);

async function eventually(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
}

test('retention publication failure terminates and finalizes the already spawned child', async () => {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    events: new EventEmitter(),
    registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, appendEntry() {},
    on: (event, handler) => handlers.set(event, handler), sendMessage() {},
  };
  const ctx = { cwd: workspace, model: { provider: 'test', id: 'model' }, hasUI: false,
    isIdle: () => true, ui: { notify() {}, setWidget() {} },
    sessionManager: { getSessionId: () => 'publication-owner', getBranch: () => [] } };
  betterSubagents(pi);
  try {
    // Real filesystem refusal at the feature's retention publication boundary.
    mkdirSync(baseDir(), { recursive: true });
    writeFileSync(join(baseDir(), 'retained'), 'not a directory');
    await assert.rejects(tools.get('subagent_spawn').execute('publication', {
      prompt: 'Keep running until stopped.', cwd: workspace, clean: true, sandbox: false,
      callback: false, retain_session: true,
    }, undefined, undefined, ctx), /EEXIST|ENOTDIR/);
    const attempts = listMetas();
    assert.equal(attempts.length, 1, 'the published attempt remains discoverable after failure');
    const attempt = attempts[0];
    assert.equal(await eventually(() => !processExists(attempt.pid)), true,
      'launch failure must stop its already-created child');
    assert.equal(await eventually(() => listMetas().every(meta => meta.status !== 'running')), true,
      'exit finalization must remain registered even when retention publication fails');
    assert.equal(readConversationLease(attempt.sessionId), undefined,
      'the stopped child leaves no conversation writer lease');
  } finally {
    for (const meta of listMetas()) {
      if (processExists(meta.pid)) killProcessTree(meta.pid, 'SIGKILL');
    }
    handlers.get('session_shutdown')?.({}, ctx);
    process.env.PATH = oldPath;
    rmSync(root, { recursive: true, force: true });
  }
});
