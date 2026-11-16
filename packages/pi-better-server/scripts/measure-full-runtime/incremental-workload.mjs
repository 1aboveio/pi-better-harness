import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { socketPathFor } from '../../src/runtime/socket.ts';

export const baseline = 'eec7b3e256a7548bbf67f69cd468f12eb3b91dc8';

export function workloadTransport(root, env = process.env) {
  const explicit = env.PI_FULL_RUNTIME_TRANSPORT_DIR;
  const directory = explicit ?? join(root, 's');
  if (explicit !== undefined) {
    assert.ok(isAbsolute(explicit), 'PI_FULL_RUNTIME_TRANSPORT_DIR must be an absolute existing owned directory');
    assert.equal(realpathSync(explicit), explicit, 'Workload transport must be canonical, not an alias');
    const info = statSync(explicit);
    assert.ok(info.isDirectory(), 'Workload transport must be a directory');
    if (process.getuid) assert.equal(info.uid, process.getuid(), 'Workload transport must be owned by the current user');
  }
  return { directory, socketPath: socketPathFor(directory) };
}

export function workloadSettings(env = process.env) {
  if (env.PI_INCREMENTAL_WORKLOAD !== '1') return undefined;
  const history = Number(env.PI_INCREMENTAL_HISTORY ?? 4416);
  const group = Number(env.PI_INCREMENTAL_GROUP ?? 48);
  const clients = Number(env.PI_INCREMENTAL_CLIENTS ?? 1);
  const durationMs = Number(env.PI_INCREMENTAL_DURATION_MS ?? 600000);
  assert.ok([4416, 10000].includes(history), 'History must be 4416 or 10000');
  assert.ok(Number.isSafeInteger(group) && group >= 48, 'Group must be an integer >= 48 (qualification requires 48, 96 and larger)');
  assert.ok([1, 5, 10].includes(clients), 'Clients must be 1, 5 or 10');
  assert.ok(Number.isSafeInteger(durationMs) && durationMs >= 600000, 'Each fixed-host workload must run at least 600000 ms');
  assert.notEqual(env.PI_FULL_RUNTIME_MATRIX_ONLY, '1', 'Mixed adapter smoke cannot qualify an incremental workload');
  return { history, group, clients, durationMs, baseline };
}

export function seedWorkload({ root, agent, cwd, settings }) {
  const durable = join(agent, 'subagents'), archives = join(durable, 'attempts');
  const runs = join(root, 'pi-better-subagents', 'runs');
  mkdirSync(archives, { recursive: true }); mkdirSync(runs, { recursive: true });
  const meta = (id, sessionId = id) => ({ id, cwd, sessionId, status: 'completed', startedAt: 1, endedAt: 2, callback: false,
    recipe: { version: 1, sessionId, cwd, sessionDir: join(durable, 'sessions') } });
  for (let i = 0; i < settings.history; i++) {
    const id = `sa_808_history_${i}`;
    writeFileSync(join(archives, `${id}.json`), JSON.stringify({ version: 1, meta: meta(id) }));
  }
  const tasks = [];
  for (let i = 0; i < settings.group; i++) {
    const id = `sa_808_group_${i}`, directory = join(runs, id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'meta.json'), JSON.stringify(meta(id, '808-group')));
    const finalText = `808 final result ${i}`;
    const event = { type: 'message_end', message: { role: 'assistant',
      content: [{ type: 'text', text: finalText }], usage: { input: 3, output: 7, cost: { total: 0.01 } } } };
    const bytes = JSON.stringify(event) + '\n';
    writeFileSync(join(directory, 'output.log'), bytes);
    tasks.push({ id, finalText, costUSD: 0.01, bytes: Buffer.byteLength(bytes) });
  }
  return { durable, tasks, history: settings.history, seededLogBytes: tasks.reduce((sum, task) => sum + task.bytes, 0) };
}

export async function reconcileWorkload(work, cwd, manifest) {
  const snapshot = await work.get({ cwd, active: false, limit: 1 });
  assert.equal(snapshot.status, 'ready', snapshot.reason);
  // The full-runtime fixture also creates unrelated real work. Count this fixture's
  // exact identities through detail queries, not a global count containing them.
  const results = [];
  for (const task of manifest.tasks) {
    const detail = await work.get({ id: task.id, detail: true });
    assert.equal(detail.status, 'ready', detail.reason);
    assert.equal(detail.rows.length, 1, `Missing exact task ${task.id}`);
    const row = detail.rows[0];
    assert.equal(row.meta.status, 'completed');
    assert.equal(row.detail.parsed.finalText, task.finalText);
    assert.equal(row.detail.parsed.usage.costUSD, task.costUSD);
    results.push({ id: task.id, finalText: row.detail.parsed.finalText, costUSD: row.detail.parsed.usage.costUSD });
  }
  const history = new Set();
  let cursor;
  do {
    const page = await work.get({ cwd, active: false, limit: 200, ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 'ready', page.reason);
    for (const row of page.rows) if (row.meta.id.startsWith('sa_808_history_')) {
      assert.equal(row.meta.status, 'completed');
      assert.ok(!history.has(row.meta.id), `Repeated historical row ${row.meta.id}`);
      history.add(row.meta.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(history.size, manifest.history);
  for (let i = 0; i < manifest.history; i++) assert.ok(history.has(`sa_808_history_${i}`));
  return { history: history.size, results };
}
