import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';
import { WorkQueryExecutor } from '../src/runtime/query-executor.ts';
import { createLocalWorkClient } from '../src/runtime/local-client.ts';

const load = (name: string) => import(new URL(`../src/runtime/domain/background-service/${name}.domain.mjs`, import.meta.url).href);

test('public durable status and list complete through private shared-host read transport without a native runtime', { timeout: 10000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'background-public-read-'));
  const lease = acquireMutationStore(root);
  const owner = { kind: 'parent-session' as const, workspace: root, sessionId: 'component-parent' };
  const id = 'bgs_00000000000000000001';
  lease.store.registerOperation({ operationId: 'component-op', taskId: id, launchToken: 'component-token', owner,
    observer: { kind: 'local-supervisor', version: '1' } });
  lease.store.recordTerminalOutcome({ operationId: 'component-op', eventId: 'component-terminal', owner,
    outcome: 'succeeded', evidence: [{ kind: 'terminal-record', ref: join(root, 'terminal') }] });
  const [{ registerTools }, { createObservedWaitHost }, { closeBackgroundObservation }] = await Promise.all([
    load('tools'), load('observed-waits'), load('work-observation'),
  ]);
  const executor = new WorkQueryExecutor(root, 'private-component', { budgetBuffer: lease.budget.buffer,
    modelOptions: { baseDir: join(root, 'raw'), durableDir: join(root, 'archive'), supervisorDirectory: join(root, 'supervisor'), intervalMs: 60000 } });
  const events = new EventEmitter(), tools = new Map<string, any>();
  const pi: any = { events, on() {}, registerTool(definition: any) { tools.set(definition.name, definition); } };
  events.on('pi-better-runtime:connect', request => request.accept(createLocalWorkClient(executor, root)));
  const host = createObservedWaitHost(pi, { sharedStore: lease.store, storePath: join(root, 'operation-coordinator.sqlite'),
    supervisorDirectory: join(root, 'supervisor'), serverOwnedResults: true, pollMs: 0,
    enterControl: () => lease.budget.enter('control') });
  const ctx: any = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => owner.sessionId,
    getBranch: () => [], getEntries: () => [] }, isIdle: () => true };
  registerTools(pi, undefined, () => undefined, { resumeLocal: false });
  host.start(ctx);
  const started = Date.now();
  const run = (name: string, params: any) => tools.get(name).execute('component-read', params, undefined, undefined, ctx);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        const status = await run('bg_task_status', { id });
        assert.match(status.content[0].text, /succeeded/);
        const list = await run('bg_task_list', {});
        assert.match(list.content[0].text, new RegExp(id));
        assert.ok(Date.now() - started < 5000);
        t.diagnostic(JSON.stringify({ elapsedMs: Date.now() - started, lanes: lease.budget.metrics().lanes }));
      })(),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('public component read exceeded original 5000ms boundary')), 5000); }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
    closeBackgroundObservation(pi); host.close(); await executor.close(); lease.release();
    rmSync(root, { recursive: true, force: true });
  }
});
