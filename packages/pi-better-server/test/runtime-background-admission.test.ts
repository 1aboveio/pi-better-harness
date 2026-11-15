import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { createBackgroundTools } from '../src/runtime/background-tools.ts';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';
import { RuntimeResultSupervision } from '../src/runtime/result-supervision.ts';
test('fixed Background adapter fences new admissions, accepts exact replay and recovers interrupted receipts', { timeout: 30000 }, async () => {
    const root = realpathSync(mkdtempSync('/tmp/bg-admit-')), previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const directory = join(root, 'background-tool-admission');
    mkdirSync(directory, { mode: 0o700 });
    const load = (name: string) => import(`../src/runtime/domain/background-service/${name}.domain.mjs`);
    const [{ registerTools }, { backgroundDigest }, { readProcessStartTokenFresh }] = await Promise.all([load('tools'), load('managed-authority'), load('process-identity')]);
    const supervision = new RuntimeResultSupervision(root, 'instance');
    const ports: Map<string, any> = (globalThis as any)[Symbol.for('pi-better-server:result-supervision-ports-v1')] ??= new Map();
    ports.set(root, { status() { supervision.reconcile(); return { hostId: supervision.hostId, epoch: supervision.epoch, reason: supervision.reason }; } });
    const definitions = new Map<string, any>();
    registerTools({ events: new EventEmitter(), on() { }, registerTool(definition: any) { definitions.set(definition.name, definition); } } as any);
    let draining = false, service: Awaited<ReturnType<typeof createBackgroundTools>> | undefined;
    const invoke = async (tool: string, params: any, key: string = randomUUID(), mutate?: (record: any) => void) => {
        const id = randomUUID(), secret = randomBytes(32).toString('hex'), path = join(directory, `${id}.json`);
        const record = { version: 1, id, secretHash: createHash('sha256').update(secret).digest('hex'), instanceId: 'instance', key, tool, params, parametersDigest: backgroundDigest(definitions.get(tool)?.parameters ?? {}), owner: { kind: 'parent-session', sessionId: 'native', workspace: root }, branchIds: [], projectTrusted: true, pid: process.pid, start: readProcessStartTokenFresh(process.pid) };
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
        service = await createBackgroundTools(root, 'instance', () => draining);
        draining = true;
        await assert.rejects(invoke('bg_task_spawn', { shell: false, argv: [process.execPath, '-e', 'process.exit(0)'] }, 'new'), /runtime-draining/);
        await assert.rejects(invoke('bg_task_spawn', { shell: false, argv: [process.execPath, '-e', 'process.exit(0)'] }, 'schema', r => r.parametersDigest = 'wrong'), /capability-mismatch/);
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
        supervision.close();
        ports.delete(root);
        if (previous === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else
            process.env.PI_CODING_AGENT_DIR = previous;
    }
});
