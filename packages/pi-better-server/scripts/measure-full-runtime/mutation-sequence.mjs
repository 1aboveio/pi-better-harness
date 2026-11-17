import assert from 'node:assert/strict';
import { reconcileWorkload, workloadCounterDelta, mutationExpectation } from './incremental-workload.mjs';

export function mutationSequence(manifest) {
  const id = manifest.tasks[0]?.id;
  assert.ok(id, 'Mutation sequence requires a fixture task');
  return [
    { key: 'theme', command: { kind: 'theme', theme: 'dark' } },
    { key: 'same-settings', command: { kind: 'same-settings' } },
    { key: 'append', command: { kind: 'append', id, cents: 2, text: `appended ${id}` } },
    { key: 'checkpoint-eviction', capability: 'evict' },
    { key: 'append-after-eviction', requires: 'checkpoint-eviction', command: { kind: 'append', id, cents: 3, text: `after eviction ${id}` } },
    { key: 'checkpoint-restart', capability: 'restart' },
    { key: 'append-after-restart', requires: 'checkpoint-restart', command: { kind: 'append', id, cents: 4, text: `after restart ${id}` } },
    { key: 'replace-log', command: { kind: 'replace-log', id, cents: 5, text: `replacement ${id}` } },
    { key: 'truncate-log', command: { kind: 'truncate-log', id } },
    { key: 'delete-log', command: { kind: 'delete-log', id } },
  ];
}

/** Fixture-owned controls only; no retries, deadlines, production RPCs or service lifecycle here. */
export async function runMutationSequence({ manifest, client, write, observe, recovery = {}, evidenceScope, onState = () => {} }) {
  assert.ok(['component', 'runtime'].includes(evidenceScope), 'Explicit evidence scope required');
  const steps = mutationSequence(manifest).map(step => ({ ...step, status: 'notRun' }));
  const state = { evidenceScope, nativeQualification: 'notRun', complete: false, steps };
  await onState(state);
  for (const step of steps) {
    if (step.requires && steps.find(value => value.key === step.requires)?.status !== 'completed') {
      step.reason = 'Required checkpoint action did not execute'; await onState(state); continue;
    }
    const control = step.capability ? recovery[step.capability] : undefined;
    if (step.capability && (control?.scope !== evidenceScope || typeof control?.run !== 'function')) {
      step.status = 'missing-capability'; step.reason = `No ${evidenceScope} fixture-owned ${step.capability} control; no production RPC invented`;
      await onState(state); continue;
    }
    step.status = 'running'; await onState(state);
    try {
      step.before = await client.request('runtime_get_metrics');
      if (step.capability) {
        const previousSnapshot = await client.get({ cwd: manifest.cwd, limit: 1 });
        const receipt = await control.run();
        step.control = { action: receipt?.action, scope: receipt?.scope, ...(receipt?.physical ? { physical: receipt.physical } : {}) };
        assert.equal(receipt?.action, step.capability, 'Recovery receipt must identify the performed fixture action');
        assert.equal(receipt?.scope, evidenceScope, 'Recovery receipt scope changed');
        if (evidenceScope === 'runtime') {
          const physical = receipt?.physical;
          assert.ok(physical && ['managerPid','beforeThreadId','afterThreadId'].every(key => Number.isSafeInteger(physical[key]) && physical[key] > 0), 'Runtime recovery requires actual manager and thread identities');
          if (step.capability === 'restart') assert.notEqual(physical.beforeThreadId,physical.afterThreadId,'Restart must replace the physical reader');
          else assert.equal(physical.beforeThreadId,physical.afterThreadId,'Eviction must retain the same physical reader');
        }
        if (step.capability === 'restart') {
          assert.ok(receipt.client, 'Restart must return the fixture client for the recovered reader'); client = receipt.client;
        }
        step.after = await client.request('runtime_get_metrics');
        if (step.capability === 'evict') {
          assert.ok(step.before.checkpoints?.hotDisplay > 0 || step.before.checkpoints?.hotHealth > 0, 'Eviction must start with actual retained parser state');
          assert.equal(step.after.checkpoints?.hotDisplay, 0, 'Eviction must actually clear display parser state');
          assert.equal(step.after.checkpoints?.hotHealth, 0, 'Eviction must actually clear health parser state');
        } else if (evidenceScope === 'runtime') {
          const nextSnapshot = await client.get({ cwd: manifest.cwd, limit: 1 });
          assert.ok(previousSnapshot.instanceId && nextSnapshot.instanceId && previousSnapshot.instanceId !== nextSnapshot.instanceId, 'Runtime restart must have an actual new read instance');
        }
        // Do not serialize clients or pretend reset counters are ordinary deltas.
        step.accounting = 'recovery'; step.delta = null;
      } else {
        const expected = mutationExpectation(manifest.tasks.find(task => task.id === step.command.id), step.command);
        const receipt = await write(step.command);
        step.receipt = receipt;
        assert.equal(receipt.kind, step.command.kind);
        if (step.command.id) assert.equal(receipt.id, step.command.id);
        assert.deepEqual(receipt.expected, expected, 'Writer receipt must match requested source mutation, not invent a final result');
        if (receipt.expected) {
          const task = manifest.tasks.find(value => value.id === receipt.id);
          assert.ok(task, 'Receipt must belong to the exact fixture task');
          Object.assign(task, receipt.expected);
        }
        await observe(step.command, receipt, step.before, client);
        step.after = await client.request('runtime_get_metrics');
        step.delta = workloadCounterDelta(step.before, step.after); step.accounting = 'mutation';
        const delta = step.delta;
        if (['theme', 'same-settings'].includes(step.command.kind)) {
          assert.equal(delta.logs.bytes, 0); assert.equal(delta.projections.logProjections, 0);
          if (step.command.kind === 'same-settings') assert.equal(receipt.beforeDigest, receipt.afterDigest);
        } else {
          assert.equal(delta.projections.logProjections, 1, 'Only the changed fixture log may be projected');
          const event = ['append', 'replace-log'].includes(step.command.kind) ? 1 : 0;
          assert.equal(delta.logs.displayFolded, event); assert.equal(delta.logs.healthFolded, event);
          const bytes = step.command.kind === 'append' ? receipt.appendedBytes : receipt.afterBytes;
          assert.ok(delta.logs.bytes >= bytes && delta.logs.bytes <= bytes + (event ? 256 : 0), 'Log bytes must stay within actual content plus existing identity probe budget');
        }
      }
      step.final = await reconcileWorkload(client, manifest.cwd, manifest);
      step.status = 'completed';
    } catch (error) {
      step.status = 'failed'; step.error = String(error);
      try { await onState(state); } catch (reportingError) { step.reportingError = String(reportingError); }
      throw error;
    }
    await onState(state);
  }
  state.complete = steps.every(step => step.status === 'completed');
  await onState(state);
  return state;
}
