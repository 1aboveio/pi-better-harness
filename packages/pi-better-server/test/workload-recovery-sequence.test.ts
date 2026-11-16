import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mutationSequence, runMutationSequence } from '../scripts/measure-full-runtime/mutation-sequence.mjs';
import { seedWorkload, mutateWorkload, reconcileTask } from '../scripts/measure-full-runtime/incremental-workload.mjs';
import { WorkReadModel } from '../src/runtime/read-model.ts';
import { parseRun } from '../src/runtime/domain/parse.mjs';
const { openStore } = await import(new URL('../src/runtime/domain/subagents/shared-operation-coordinator/index.domain.mjs', import.meta.url).href);

function fixture(group = 48) {
  const root = mkdtempSync(join(tmpdir(), 'p808-sequence-'));
  const manifest = seedWorkload({ root, agent: join(root, 'agent'), cwd: root,
    settings: { history: 0, group, clients: 1, durationMs: 600000, baseline: '' } });
  writeFileSync(join(manifest.agent, 'settings.json'), JSON.stringify({ theme: 'light' }));
  openStore({ path: join(manifest.agent, 'operation-coordinator.sqlite') }).close();
  return { root, manifest };
}

test('plan selects exact fixture identities and independent faults after capability-gated recovery', () => {
  const f = fixture();
  try {
    const plan = mutationSequence(f.manifest);
    assert.deepEqual(plan.map(step => step.key), ['theme', 'same-settings', 'append', 'checkpoint-eviction', 'append-after-eviction', 'checkpoint-restart', 'append-after-restart', 'replace-log', 'truncate-log', 'delete-log']);
    assert.ok(plan.filter(step => step.command?.id).every(step => step.command!.id === f.manifest.tasks[0]!.id));
    assert.equal(plan[4]!.requires, 'checkpoint-eviction'); assert.equal(plan[6]!.requires, 'checkpoint-restart');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const recoveryAvailable of [false, true]) test(`component file/projection sequence with recovery controls=${recoveryAvailable} preserves honest final-source reconciliation`, async t => {
  const f = fixture(96), { manifest } = f;
  const create = () => new WorkReadModel(manifest.agent, 'component-reader', { baseDir: join(f.root, 'pi-better-subagents'), durableDir: manifest.durable, intervalMs: 60000 });
  let model = create(), state: any;
  const controls: string[] = [], writes: string[] = [];
  const client = { request: async (type: string) => { assert.equal(type, 'runtime_get_metrics'); return structuredClone(model.metrics); }, get: async (scope: any) => model.snapshot(scope) };
  try {
    await model.reconcile();
    const recovery = recoveryAvailable ? {
      evict: { scope: 'component', run: async () => {
        controls.push('evict'); (model as any).parseStates.clear(); (model as any).healthStates.clear();
        return { action: 'evict', scope: 'component' };
      } },
      restart: { scope: 'component', run: async () => {
        controls.push('restart'); await model.close(); model = create(); await model.reconcile();
        return { action: 'restart', scope: 'component', client };
      } },
    } : {};
    let failure: unknown;
    try { await runMutationSequence({ manifest, client, evidenceScope: 'component', recovery,
      write: async command => { writes.push(command.kind); return mutateWorkload(manifest, command); },
      observe: async command => {
        if (command.id) model.fileHint(join(manifest.runs, command.id), 'output.log');
        await model.reconcile();
      }, onState: value => { state = value; },
    }); } catch (error) { failure = error; }
    assert.equal(state.steps.at(-1).key, 'delete-log');
    const deleted = model.snapshot({ id: manifest.tasks[0]!.id, detail: true }).rows[0] as any;
    t.diagnostic(JSON.stringify({ observation: 'component-only deleted source reconciliation', step: 'delete-log',
      projectedComplete: deleted.display?.coverage?.complete, diagnostics: deleted.detail.parsed.diagnostics,
      state: state.steps.at(-1).status, error: state.steps.at(-1).error }));
    if (deleted.display?.coverage?.complete === true) {
      // Reject the current false claim without making a future source fix fail.
      assert.match(String(failure), /Missing source cannot claim complete log coverage/);
      assert.equal(state.steps.at(-1).status, 'failed'); assert.equal(state.complete, false);
    } else {
      assert.equal(failure, undefined); assert.equal(state.steps.at(-1).status, 'completed');
      assert.equal(state.steps.at(-1).final.results[0].sourceCompleteness, 'unavailable');
      assert.equal(state.steps.at(-1).final.results[0].costUSD, null);
    }
    assert.equal(state.nativeQualification, 'notRun');
    assert.deepEqual(writes.slice(-3), ['replace-log', 'truncate-log', 'delete-log']);
    assert.equal(state.steps.find((step: any) => step.key === 'replace-log').final.results[0].costUSD, 0.05);
    assert.equal(state.steps.find((step: any) => step.key === 'truncate-log').final.results[0].sourceCompleteness, 'empty');
    if (recoveryAvailable) {
      assert.deepEqual(controls, ['evict', 'restart']);
      for (const key of ['checkpoint-eviction', 'checkpoint-restart']) {
        const step = state.steps.find((step: any) => step.key === key);
        assert.equal(step.status, 'completed'); assert.equal(step.accounting, 'recovery'); assert.equal(step.delta, null);
      }
      assert.ok(state.steps.find((step: any) => step.key === 'checkpoint-restart').after.checkpoints.restores > 0, 'Derived reader reopen must actually restore persisted checkpoints');
      const final = state.steps.find((step: any) => step.key === 'append-after-restart').final.results[0];
      assert.equal(final.costUSD, 0.10); assert.equal(final.input, 36); assert.equal(final.output, 46);
    } else {
      assert.deepEqual(controls, []);
      for (const key of ['checkpoint-eviction', 'checkpoint-restart']) assert.equal(state.steps.find((step: any) => step.key === key).status, 'missing-capability');
      for (const key of ['append-after-eviction', 'append-after-restart']) assert.equal(state.steps.find((step: any) => step.key === key).status, 'notRun');
    }
    assert.ok(readFileSync(join(manifest.runs, manifest.tasks[1]!.id, 'output.log')).length > 0, 'unrelated authoritative sibling source remains intact');
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('recovery receipt cannot claim eviction unless actual parser caches were emptied', async () => {
  const f = fixture(); let state: any;
  const model = new WorkReadModel(f.manifest.agent, 'receipt-component', { baseDir: join(f.root, 'pi-better-subagents'), durableDir: f.manifest.durable, intervalMs: 60000 });
  const client = { request: async () => structuredClone(model.metrics), get: async (scope: any) => model.snapshot(scope) };
  try {
    await model.reconcile();
    await assert.rejects(runMutationSequence({ manifest: f.manifest, client, evidenceScope: 'component',
      write: async command => mutateWorkload(f.manifest, command), observe: async () => { await model.reconcile(); },
      recovery: { evict: { scope: 'component', run: async () => ({ action: 'evict', scope: 'component' }) } },
      onState: value => { state = value; },
    }), /Eviction must actually clear display parser state/);
    assert.equal(state.steps[3].key, 'checkpoint-eviction'); assert.equal(state.steps[3].status, 'failed');
    assert.ok(model.metrics.checkpoints.hotDisplay > 0);
    assert.ok(state.steps.slice(4).every((step: any) => step.status === 'notRun'));
  } finally { await model.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('failed writer stops once and preserves original failure separately from reporting failure', async () => {
  const f = fixture(), error = new Error('original-writer-failure'); let state: any, calls = 0;
  try {
    await assert.rejects(runMutationSequence({ manifest: f.manifest, evidenceScope: 'component',
      client: { request: async () => ({}) }, write: async () => { calls++; throw error; }, observe: async () => {},
      onState: value => { state = value; if (value.steps[0].status === 'failed') throw new Error('reporting-failure'); },
    }), value => value === error);
    assert.equal(calls, 1); assert.match(state.steps[0].error, /original-writer-failure/);
    assert.match(state.steps[0].reportingError, /reporting-failure/);
    assert.ok(state.steps.slice(1).every((step: any) => step.status === 'notRun'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('real missing-file parser diagnostics reconcile as unavailable, never a complete zero bill', () => {
  const f = fixture();
  try {
    const task = f.manifest.tasks[0]!;
    Object.assign(task, mutateWorkload(f.manifest, { kind: 'delete-log', id: task.id }).expected);
    const directory = join(f.manifest.runs, task.id);
    const result = reconcileTask(task, { meta: JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8')),
      detail: { parsed: parseRun(task.id, { logPath: join(directory, 'output.log') }) } }, f.root);
    assert.equal(result.sourceCompleteness, 'unavailable'); assert.equal(result.costUSD, null);
    assert.equal(result.input, null); assert.equal(result.output, null);
    assert.ok(result.diagnostics.some((message: string) => message.includes('ENOENT')));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
