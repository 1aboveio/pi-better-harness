import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

// Match the installed SDK's context: there is no ctx.tools. Active tools can
// change on session_start when the task guard installs and activates adapters.
function run(t, scenario) {
  const root = mkdtempSync(join(tmpdir(), 'child-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plan = { model: 'openai/test', tools: ['read', 'bash'], providers: [], modelGroups: [], declarations: [], fingerprints: [] };
  const planPath = join(root, 'plan.json'); writeFileSync(planPath, JSON.stringify(plan));
  const source = `
    import preflight from ${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../child-preflight.mjs', import.meta.url))).href)};
    const hooks = new Map(); let active = [];
    const pi = { on: (event, handler) => hooks.set(event, handler), getActiveTools: () => active,
      getAllTools: () => [{ name: 'read' }, { name: 'bash' }] };
    preflight(pi);
    const selected = { provider: 'openai', id: 'test', api: 'openai-responses' };
    const ctx = { model: selected, modelRegistry: { getAvailable: () => ${scenario === 'missing-model' ? '[]' : '[selected]'} } };
    await hooks.get('session_start')({}, ctx);
    active = ${JSON.stringify(scenario === 'inactive-tool' ? ['read'] : ['read', 'bash'])};
    await hooks.get('before_agent_start')({}, ctx);
    process.stdout.write('request permitted');
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, PI_SUBAGENT_PREFLIGHT: planPath }, encoding: 'utf8', timeout: 10000,
  });
}

test('supported SDK context checks tools after the guard activates them', t => {
  const result = run(t, 'valid'); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /request permitted/);
});
test('registered but inactive tools fail before a request', t => {
  const result = run(t, 'inactive-tool'); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /requested tool bash is unavailable/);
  assert.doesNotMatch(result.stdout, /request permitted/);
});
test('selected physical model without credentials fails even when ctx.model matches', t => {
  const result = run(t, 'missing-model'); assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Selected child model openai\/test is not available/);
  assert.doesNotMatch(result.stdout, /request permitted/);
});
