import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workloadSettings, seedWorkload, workloadTransport } from '../scripts/measure-full-runtime/incremental-workload.mjs';
import { socketPathFor } from '../src/runtime/socket.ts';

test('workload transport uses the explicit direct owned directory without a nested suffix', () => {
  const directory = mkdtempSync(join(tmpdir(), 'p808-transport-'));
  try {
    // The registered local TMPDIR is deliberately too long for a socket. This
    // selection test verifies no truncation or nested random transport is added.
    const selected = process.env.PI_FULL_RUNTIME_TRANSPORT_DIR ?? directory;
    if (Buffer.byteLength(join(selected, 'pi-server.sock')) <= 103) {
      const transport = workloadTransport('/bulk', { PI_FULL_RUNTIME_TRANSPORT_DIR: selected });
      assert.equal(transport.directory, selected);
      assert.equal(transport.socketPath, join(selected, 'pi-server.sock'));
    } else {
      assert.throws(() => workloadTransport('/bulk', { PI_FULL_RUNTIME_TRANSPORT_DIR: selected }), /Socket path is too long/);
    }
    assert.throws(() => workloadTransport('/bulk', { PI_FULL_RUNTIME_TRANSPORT_DIR: 'relative' }), /absolute/);
    assert.throws(() => workloadTransport('/bulk', { PI_FULL_RUNTIME_TRANSPORT_DIR: join(directory, 'missing') }), /ENOENT/);
    const file = join(directory, 'file'); writeFileSync(file, '');
    assert.throws(() => workloadTransport('/bulk', { PI_FULL_RUNTIME_TRANSPORT_DIR: file }), /directory/);
    const alias = join(directory, 'alias'); symlinkSync(directory, alias);
    assert.throws(() => workloadTransport('/bulk', { PI_FULL_RUNTIME_TRANSPORT_DIR: alias }), /alias/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('workload transport preserves default selection and enforces socket bytes at the exact boundary', () => {
  assert.deepEqual(workloadTransport('/bulk', {}), { directory: '/bulk/s', socketPath: '/bulk/s/pi-server.sock' });
  const directory = '/' + 'a'.repeat(87);
  assert.equal(Buffer.byteLength(socketPathFor(directory)), 103);
  assert.throws(() => socketPathFor(directory + 'a'), /104 > 103/);
  assert.throws(() => socketPathFor('/' + '\u00e9'.repeat(45)), /106 > 103/);
  assert.throws(() => workloadTransport(directory + '/bulk', {}), /Socket path is too long/);
});

test('incremental qualification rejects short windows and invalid workload identities', () => {
  assert.equal(workloadSettings({}), undefined);
  const enabled = { PI_INCREMENTAL_WORKLOAD: '1' };
  assert.equal(workloadSettings(enabled)!.durationMs, 600000);
  for (const override of [
    { PI_INCREMENTAL_DURATION_MS: '599999' }, { PI_INCREMENTAL_DURATION_MS: 'NaN' },
    { PI_INCREMENTAL_HISTORY: '100' }, { PI_INCREMENTAL_GROUP: '47' },
    { PI_INCREMENTAL_CLIENTS: '2' }, { PI_FULL_RUNTIME_MATRIX_ONLY: '1' },
  ]) assert.throws(() => workloadSettings({ ...enabled, ...override }));
  for (const history of [4416, 10000]) for (const clients of [1, 5, 10]) for (const group of [48, 96, 192]) {
    assert.deepEqual(workloadSettings({ ...enabled, PI_INCREMENTAL_HISTORY: String(history), PI_INCREMENTAL_CLIENTS: String(clients), PI_INCREMENTAL_GROUP: String(group) }),
      { history, clients, group, durationMs: 600000, baseline: 'eec7b3e256a7548bbf67f69cd468f12eb3b91dc8' });
  }
});

test('seeded native workload has exact durable history, group logs and expected result bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'p808-seed-'));
  try {
    const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root, settings: workloadSettings({ PI_INCREMENTAL_WORKLOAD: '1' })! });
    assert.equal(readdirSync(join(manifest.durable, 'attempts')).length, 4416);
    assert.equal(manifest.tasks.length, 48);
    let bytes = 0;
    for (const task of manifest.tasks) {
      const log = readFileSync(join(root, 'pi-better-subagents/runs', task.id, 'output.log'));
      bytes += log.length;
      assert.equal(log.length, task.bytes);
      const event = JSON.parse(log.toString());
      const meta = JSON.parse(readFileSync(join(root, 'pi-better-subagents/runs', task.id, 'meta.json'), 'utf8'));
      assert.equal(meta.sessionId, '808-group');
      assert.equal(event.message.content[0].text, task.finalText);
      assert.equal(event.message.usage.cost.total, task.costUSD);
    }
    assert.equal(bytes, manifest.seededLogBytes);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
