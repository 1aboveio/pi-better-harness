import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const runtime = fileURLToPath(new URL('../child-runtime.mjs', import.meta.url));
const preflight = fileURLToPath(new URL('../child-preflight.mjs', import.meta.url));
function fixture(t, script) {
  const root = mkdtempSync(join(tmpdir(), 'child-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'custom pi');
  writeFileSync(binary, script, { mode: 0o755 });
  return { root, binary };
}

test('shell launcher receives preflight, exact original arguments, environment and stdio', t => {
  const { binary } = fixture(t, '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "%s\\n" "$CHILD_RUNTIME_TEST"\nread line\nprintf "%s\\n" "$line" >&2\nexit 23\n');
  const result = spawnSync(process.execPath, [runtime, binary, '--print', 'prompt with spaces', '', '$literal'], {
    env: { ...process.env, CHILD_RUNTIME_TEST: 'inherited' }, input: 'stdin inherited\n', encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23, result.stderr);
  assert.equal(result.stdout, ['--extension', preflight, '--print', 'prompt with spaces', '', '$literal', 'inherited', ''].join('\n'));
  assert.equal(result.stderr, 'stdin inherited\n');
});

test('launcher spawn errors are reported as bootstrap failures', t => {
  const { root } = fixture(t, '#!/bin/sh\nexit 0\n');
  const result = spawnSync(process.execPath, [runtime, join(root, 'missing')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Subagent bootstrap failed:.*ENOENT/);
});

test('preflight module import failure prevents the selected launcher from starting', t => {
  const { root, binary } = fixture(t, '#!/bin/sh\necho launcher-started\n');
  const bootstrap = join(root, 'child-runtime.mjs');
  writeFileSync(bootstrap, readFileSync(runtime));
  writeFileSync(join(root, 'child-preflight.mjs'), "throw new Error('preflight import broken');\n");
  const result = spawnSync(process.execPath, [bootstrap, binary], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /preflight import broken/);
  assert.doesNotMatch(result.stdout, /launcher-started/);
});

test('launcher signal exits retain their signal', t => {
  const { binary } = fixture(t, '#!/bin/sh\nkill -TERM $$\n');
  const result = spawnSync(process.execPath, [runtime, binary], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, null, result.stderr);
  assert.equal(result.signal, 'SIGTERM');
});

for (const group of [false, true]) {
  test(group ? 'group termination reaches launcher descendants without a detached orphan' : 'direct bootstrap termination forwards to the launcher and waits for its exit', { timeout: 10000 }, async t => {
    const { root, binary } = fixture(t, '#!/bin/sh\nexec "$RUNTIME_TEST_NODE" "$RUNTIME_TEST_LAUNCHER"\n');
    const ready = join(root, 'ready');
    const stopped = join(root, 'stopped');
    const launcher = join(root, 'launcher.cjs');
    const descendantReady = join(root, 'descendant-ready');
    const descendantStopped = join(root, 'descendant-stopped');
    const descendantSource = `
      const { writeFileSync } = require('node:fs');
      process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(descendantStopped)}, 'stopped'); process.exit(0); });
      writeFileSync(${JSON.stringify(descendantReady)}, 'ready');
      setInterval(() => {}, 1000);
    `;
    writeFileSync(launcher, `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'inherit' });
      process.on('SIGTERM', () => { ${group ? '' : "child.kill('SIGTERM');"} child.on('exit', () => { writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); }); });
      writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `);
    const child = spawn(process.execPath, [runtime, binary], { detached: true, stdio: 'ignore',
      env: { ...process.env, RUNTIME_TEST_NODE: process.execPath, RUNTIME_TEST_LAUNCHER: launcher } });
    t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} });
    const exit = once(child, 'exit');
    for (let i = 0; i < 200 && !(existsSync(ready) && existsSync(descendantReady)); i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(ready) && existsSync(descendantReady), 'launcher and descendant started');
    const pids = JSON.parse(readFileSync(ready, 'utf8'));
    if (group) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
    assert.deepEqual(await exit, [0, null]);
    assert.equal(readFileSync(stopped, 'utf8'), 'stopped', 'bootstrap waits for launcher cleanup');
    assert.equal(readFileSync(descendantStopped, 'utf8'), 'stopped', 'termination reaches descendant');
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('real Pi executes mandatory preflight before the model request', { timeout: 30000 }, t => {
  const { root } = fixture(t, '#!/bin/sh\nexit 0\n');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const provider = join(root, 'provider.mjs');
  const requested = join(root, 'requested');
  writeFileSync(provider, `import { writeFileSync } from 'node:fs';
    export default pi => pi.registerProvider('bootstrap-test', {
      baseUrl: 'http://127.0.0.1:1', apiKey: 'test-only', api: 'bootstrap-test-api',
      models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }],
      streamSimple: () => { writeFileSync(${JSON.stringify(requested)}, 'requested'); throw new Error('TEST_MODEL_REQUEST'); }
    });`);
  const planPath = join(root, 'plan.json');
  for (const tools of [['read'], ['unavailable-tool']]) {
    rmSync(requested, { force: true });
    writeFileSync(planPath, JSON.stringify({ model: 'bootstrap-test/test', tools, providers: [], modelGroups: [], declarations: [], fingerprints: [] }));
    const result = spawnSync(process.execPath, [runtime, cli, '--no-extensions', '--extension', provider,
      '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-session', '--tools', 'read',
      '--model', 'bootstrap-test/test', '--print', 'test'], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: join(root, 'agent'), PI_SUBAGENT_PREFLIGHT: planPath,
        PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }, encoding: 'utf8', timeout: 12000,
    });
    assert.equal(result.error, undefined, result.stderr);
    if (tools[0] === 'read') assert.ok(existsSync(requested), `control reaches model: ${result.stderr}\n${result.stdout}`);
    else {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Subagent child preflight failed:.*requested tool unavailable-tool is unavailable/);
      assert.equal(existsSync(requested), false, 'failed preflight blocks the real Pi model stream');
    }
  }
});
