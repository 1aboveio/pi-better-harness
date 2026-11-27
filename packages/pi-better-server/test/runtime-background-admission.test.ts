import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createBackgroundTools } from '../src/runtime/background-tools.ts';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';
import { RuntimeResultSupervision } from '../src/runtime/result-supervision.ts';
test('fixed Background adapter fences new admissions, accepts exact replay and recovers interrupted receipts', { timeout: 30000 }, async t => {
    const root = realpathSync(mkdtempSync('/tmp/bg-admit-')), previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const directory = join(root, 'background-tool-admission');
    mkdirSync(directory, { mode: 0o700 });
    const load = (name: string) => import(`../src/runtime/domain/background-service/${name}.domain.mjs`);
    const [{ registerTools }, { backgroundDigest, backgroundParametersDigest }, { readAdmissionStartToken }] = await Promise.all([load('tools'), load('managed-authority'), load('process-identity')]);
    const supervision = new RuntimeResultSupervision(root, 'instance');
    const ports: Map<string, any> = (globalThis as any)[Symbol.for('pi-better-server:result-supervision-ports-v1')] ??= new Map();
    ports.set(root, { status() { supervision.reconcile(); return { hostId: supervision.hostId, epoch: supervision.epoch, reason: supervision.reason }; } });
    const definitions = new Map<string, any>();
    registerTools({ events: new EventEmitter(), on() { }, registerTool(definition: any) { definitions.set(definition.name, definition); } } as any);
    let draining = false, service: Awaited<ReturnType<typeof createBackgroundTools>> | undefined;
    const invoke = async (tool: string, params: any, key: string = randomUUID(), mutate?: (record: any) => void) => {
        const id = randomUUID(), secret = randomBytes(32).toString('hex'), path = join(directory, `${id}.json`);
        const record = { version: 2, id, secretHash: createHash('sha256').update(secret).digest('hex'), instanceId: 'instance', key, tool, params, parametersDigest: backgroundDigest(definitions.get(tool)?.parameters ?? {}), owner: { kind: 'parent-session', sessionId: 'native', workspace: root }, branchIds: [], projectTrusted: true, pid: process.pid, start: readAdmissionStartToken(process.pid) };
        mutate?.(record);
        writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
        try {
            return await service!.handle({ type: 'runtime_background_tool', authority: { id, secret } });
        }
        finally {
            rmSync(path, { force: true });
        }
    };
    try {
        const childLog = join(root, 'child.log');
        writeFileSync(childLog, 'one\ntwo\nchild-log-proof');
        const child = {id:'bgs_0123456789abcdef0123',durable:true,readOnly:true,parentAgentId:'worker',parentRecipient:{sessionId:'native',workspace:root,branchId:'branch'},
          status:'running',logPaths:{stdout:childLog,stderr:childLog,events:childLog}};
        const pointer = { id: 'bgs_00000000000000000001', durable: true, callbackPending: true, terminal: true, status: 'failed' };
        const completed = { id: pointer.id, durable: true, terminal: true, status: 'failed', waits: [], name: 'finished while disconnected' };
        service = await createBackgroundTools(root, 'instance', () => draining, async scope => ({status:'ready',scopeRevision:'fixture',
          rows:scope.cwd===root && scope.sessionId==='native'
            ? (scope.id === pointer.id ? [completed] : [child, pointer]).map(meta => ({meta})) : []}));
        await t.test('poll returns displayable tasks and resolves previously active terminals by ID', async () => {
            const onBranch = (record: any) => { record.branchIds = ['branch']; };
            const initial = await invoke('__background_poll', {}, 'initial-poll', onBranch);
            assert.deepEqual(initial.tasks, [child]);
            const restored = await invoke('__background_poll', { knownActiveIds: [pointer.id] }, 'restore-poll', onBranch);
            assert.deepEqual(restored.tasks, [child, completed]);
        });
        const assignmentStore = acquireMutationStore(root);
        try {
            for (const count of [1, 16]) {
                const assignmentId = `quiet-${count}`;
                const owner = { kind: 'worker-conversation', sessionId: assignmentId, workspace: root };
                const recipient = { kind: 'parent-session', sessionId: 'recipient', workspace: root };
                assignmentStore.store.registerAssignment({ assignmentId, attemptId: assignmentId, owner, recipient });
                assignmentStore.store.registerOperation({ operationId: assignmentId, taskId: assignmentId, launchToken: assignmentId,
                    owner, assignmentAttemptId: assignmentId, observer: { kind: 'fixture', version: '1' },
                    supervision: { hostId: 'local-fixture' } });
                const poll = async () => {
                    for (let i = 0; i < count; i++) {
                        await invoke('__background_poll', {}, randomUUID(), record => { record.owner.sessionId = `quiet-view-${i}`; });
                    }
                };
                await poll();
                const before: number = service.metrics().reconciles;
                assignmentStore.store.recordAssignmentOutcome({ assignmentId, owner, recipient, revision: 1, outcome: 'succeeded',
                    reason: 'Done', evidence: [], waits: [], processUncertain: false });
                await poll();
                assert.equal(service.metrics().reconciles - before, 0, `ending an assignment with ${count} unrelated warm views`);
            }
        } finally { assignmentStore.release(); }
        const childLogResult = await invoke('__background_log', {id:child.id,lines:1}, 'child-log', r => r.branchIds=['branch']);
        assert.equal(childLogResult.stdout,'child-log-proof');
        await assert.rejects(invoke('__background_log', {id:child.id}, 'wrong-branch'), /outside the captured scope/);
        await assert.rejects(invoke('__background_log', {id:child.id}, 'wrong-parent', r => {r.owner.sessionId='foreign';r.branchIds=['branch'];}), /outside the captured scope/);
        await assert.rejects(invoke('__background_action', {id:child.id,action:'stop'}, 'child-stop', r=>r.branchIds=['branch']), /outside the captured scope/);
        draining = true;
        await assert.rejects(invoke('bg_task_spawn', { shell: false, argv: [process.execPath, '-e', 'process.exit(0)'] }, 'new'), /runtime-draining/);
        await assert.rejects(invoke('bg_task_spawn', { shell: false, argv: [process.execPath, '-e', 'process.exit(0)'] }, 'schema', r => r.parametersDigest = 'wrong'), /capability-mismatch/);
        const published = {
            bg_task_spawn: '749d1a800ac365c2b920433e293545df74e81598323c4fcb31cc8c9681e168f8',
            bg_task_watch: '67315792d1bafee36fcc97754694d05c1ee7fad9ac1a4652c53d2c2bf127644b',
            bg_task_spawn_batch: '3e563b70cc3820411152d17844b6c248dcc2c8b6cd1dbe2663d8c2217bd833e7',
            bg_task: '55d174475db6a833691f0e0d55de87970a760c167ceb5cc5b8be9ff9a5338e77',
        };
        for (const [tool, digest] of Object.entries(published)) {
            assert.equal(backgroundParametersDigest(definitions.get(tool).parameters), digest, tool);
        }
        const ssh = { ssh: { host: 'fixture' }, command: 'true' };
        await assert.rejects(invoke('bg_task_spawn', ssh, 'prior-client', r => r.parametersDigest = published.bg_task_spawn), /runtime-draining/);
        const watch = { ...ssh, success_when: { type: 'json_path_exists', path: '$.ready' } };
        await assert.rejects(invoke('bg_task_watch', watch, 'prior-watch-client', r => r.parametersDigest = published.bg_task_watch), /runtime-draining/);
        await assert.rejects(invoke('bg_task_watch', { ...watch, success_when: { type: 'json_path_exists', path: 'ready' } }), /Invalid Background tool parameters/);
        const changed = structuredClone(definitions.get('bg_task_spawn').parameters);
        changed.properties.timeout_seconds.minimum = 1;
        await assert.rejects(invoke('bg_task_spawn', ssh, 'changed-rule', r => r.parametersDigest = backgroundParametersDigest(changed)), /capability-mismatch/);
        await assert.rejects(invoke('bg_task_spawn', { shell: 'invalid' }, 'invalid'), /Invalid Background tool parameters/);
        draining = false;
        const result = await invoke('bg_task_spawn', { shell: false, argv: [process.execPath, '-e', 'process.exit(0)'], callback: false }, 'accepted');
        assert.ok(result.details.id);
        draining = true;
        const replay = await invoke('bg_task_spawn', { shell: false, argv: [process.execPath, '-e', 'process.exit(0)'], callback: false }, 'accepted');
        assert.deepEqual(replay, result);
        await assert.rejects(invoke('bg_task_spawn', { command: 'changed' }, 'accepted'), /request-conflict/);
        await service.close();
        service = undefined;
        const lease = acquireMutationStore(root), journal = lease.store.backgroundRequests(), owner = JSON.stringify([root, 'native']);
        journal.accept(owner, 'interrupted', backgroundDigest({ tool: 'bg_task_spawn', params: { command: 'must-not-run' } }));
        journal.dispatch(owner, 'interrupted');
        journal.operation(owner, 'interrupted', { operationId: 'persisted-operation', taskId: 'persisted-task', token: 'persisted-token' });
        lease.release();
        service = await createBackgroundTools(root, 'instance', () => draining);
        const recovered = await invoke('bg_task_spawn', { command: 'must-not-run' }, 'interrupted');
        assert.equal(recovered.details.recovered, true);
        assert.equal(recovered.details.status, 'outcome_unknown');
        assert.equal(recovered.details.operations[0].taskId, 'persisted-task');
    }
    finally {
        await service?.close();
        await supervision.close();
        ports.delete(root);
        if (previous === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else
            process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test('Background recovery yields between bounded pending batches and preserves exact operation receipts', { timeout: 30000 }, async () => {
    const root = realpathSync(mkdtempSync('/tmp/bg-recover-')), previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const lease = acquireMutationStore(root), journal = lease.store.backgroundRequests();
    const keys = Array.from({ length: 260 }, (_, i) => `interrupted-${i}`);
    for (const key of keys) {
        journal.accept('owner', key, 'digest'); journal.dispatch('owner', key);
        journal.operation('owner', key, { operationId: `operation-${key}`, taskId: `task-${key}`, token: `token-${key}` });
    }
    let service: Awaited<ReturnType<typeof createBackgroundTools>> | undefined, complete = false, observedPartial = false;
    const observeYield = () => {
        if (complete) return;
        const returned = keys.filter(key => journal.read('owner', key)?.state === 'returned').length;
        if (returned > 0 && returned < keys.length) observedPartial = true;
        else if (!complete) setImmediate(observeYield);
    };
    setImmediate(observeYield);
    try {
        service = await createBackgroundTools(root, 'recovery-batches'); complete = true;
        assert.equal(observedPartial, true, 'other event-loop work runs between recovery batches');
        assert.equal(journal.hasPending(), false);
        for (const key of keys) {
            const result: any = journal.read('owner', key)?.result;
            assert.equal(result.details.status, 'outcome_unknown');
            assert.deepEqual(result.details.operations, [{ operationId: `operation-${key}`, taskId: `task-${key}`, token: `token-${key}` }]);
        }
    } finally {
        complete = true; await service?.close(); lease.release();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
