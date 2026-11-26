import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackgroundTools } from '../src/runtime/background-tools.ts';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';
import { WorkReadModel } from '../src/runtime/read-model.ts';

test('unchanged same-owner foreground polls reuse canonical recovery after the first observation', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'background-reconciliation-')));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const directory = join(root, 'background-tool-admission'); mkdirSync(directory, { mode: 0o700 });
  const load = (name: string) => import(new URL(`../src/runtime/domain/background-service/${name}.domain.mjs`, import.meta.url).href);
  const [{ readProcessStartTokenFresh }] = await Promise.all([load('process-identity')]);
  const start = readProcessStartTokenFresh(process.pid);
  if (!start) {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
    assert.fail('Native authenticated poll proof requires an actual process-start token; do not substitute a fixture token');
  }
  const lease = acquireMutationStore(root);
  const model = new WorkReadModel(root, 'same-owner', { baseDir: root, durableDir: join(root, 'durable'), intervalMs: 60000 });
  let service: Awaited<ReturnType<typeof createBackgroundTools>> | undefined;
  const polls: any[] = [];
  const invoke = async (branchIds: string[], sessionId = 'native') => {
    const id = randomUUID(), secret = randomBytes(32).toString('hex'), path = join(directory, `${id}.json`);
    writeFileSync(path, JSON.stringify({ version: 1, id, secretHash: createHash('sha256').update(secret).digest('hex'),
      instanceId: 'same-owner', key: randomUUID(), tool: '__background_poll', params: {}, parametersDigest: '',
      owner: { kind: 'parent-session', sessionId, workspace: root }, branchIds, projectTrusted: true, pid: process.pid, start }), { mode: 0o600 });
    const before = lease.store.getChangeRevision(), metrics = service!.metrics();
    try {
      const reply = await service!.handle({ type: 'runtime_background_tool', authority: { id, secret } });
      polls.push({ branchIds, before, after: lease.store.getChangeRevision(), reconciles: service!.metrics().reconciles - metrics.reconciles, scopeRevision: reply.revision });
      return reply;
    } finally { rmSync(path, { force: true }); }
  };
  try {
    await model.reconcile();
    service = await createBackgroundTools(root, 'same-owner', () => false, async scope => {
      await model.reconcile(false); return model.snapshot(scope);
    });
    await invoke(['anchor']);
    const initial = service.metrics().reconciles;
    assert.equal(initial, 1, 'the first canonical observation still performs recovery');
    for (let i = 0; i < 10; i++) await invoke(['anchor']);
    t.diagnostic(JSON.stringify({ phase: 'unchanged', polls }));
    assert.equal(service.metrics().reconciles - initial, 0);
    const views = Array.from({ length: 10 }, (_, i) => ['anchor', `foreground-${i}`]);
    for (const view of views) await invoke(view);
    const warmed = service.metrics(), sourceRevision = lease.store.getChangeRevision();
    assert.equal(warmed.reconciles - initial, views.length, 'each first branch observation must retain its recovery work');
    const repeated: any[] = [];
    for (let round = 0; round < 2; round++) for (const view of views) {
      await invoke(view); repeated.push(polls.at(-1));
    }
    t.diagnostic(JSON.stringify({ phase: 'alternating-warmed-views', sourceRevision, polls: repeated }));
    assert.equal(lease.store.getChangeRevision(), sourceRevision, 'unchanged polls must not induce source publications');
    assert.equal(service.metrics().reconciles - warmed.reconciles, 0, 'Unchanged same-owner foregrounds must not multiply canonical reconciliation');
    assert.equal(service.metrics().scopeRefreshes - warmed.scopeRefreshes, 0);
    lease.store.registerOperation({ operationId: 'changed-source', taskId: 'changed-task', launchToken: 'changed-token',
      owner: { kind: 'parent-session', sessionId: 'native', workspace: root }, observer: { kind: 'fixture', version: '1' } });
    assert.notEqual(lease.store.getChangeRevision(), sourceRevision);
    for (const view of views) await invoke(view);
    assert.equal(service.metrics().reconciles - warmed.reconciles, views.length, 'a genuine authority revision still refreshes each warmed view');
    const changed = service.metrics().reconciles;
    for (const view of views) await invoke(view);
    assert.equal(service.metrics().reconciles, changed, 'the new source observation is retained after its first application');
    const foreignSessions = Array.from({ length: 16 }, (_, i) => `unrelated-${i}`);
    for (const sessionId of foreignSessions) await invoke(['anchor'], sessionId);
    const warmedAll = service.metrics().reconciles;
    lease.store.recordTerminalOutcome({ operationId: 'changed-source', eventId: 'done', outcome: 'succeeded',
      owner: { kind: 'parent-session', sessionId: 'native', workspace: root }, reason: 'Finished' });
    for (const sessionId of foreignSessions) await invoke(['anchor'], sessionId);
    assert.equal(service.metrics().reconciles, warmedAll, 'a foreign terminal result cannot restart canonical recovery');
    await invoke(['anchor']);
    assert.equal(service.metrics().reconciles, warmedAll + 1, 'the affected parent observes the new revision');
    await invoke(['new-branch']);
    assert.equal(service.metrics().reconciles, warmedAll + 2, 'a genuinely new branch view must recover');
  } finally {
    await service?.close(); await model.close(); lease.release();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
