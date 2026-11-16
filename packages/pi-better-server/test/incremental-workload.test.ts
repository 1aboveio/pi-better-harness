import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workloadSettings, seedWorkload } from '../scripts/measure-full-runtime/incremental-workload.mjs';

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
