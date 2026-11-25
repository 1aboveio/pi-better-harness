import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createBackgroundTools } from '../src/runtime/background-tools.ts';
import { RuntimeResultSupervision } from '../src/runtime/result-supervision.ts';
import { acquireMutationStore } from '../src/runtime/mutation-store.ts';
import { CiRecovery, diagnoseCiRecovery, type RecoveryDependencies } from '../src/runtime/ci-recovery.ts';
import { CatalogSources } from '../src/runtime/catalog-sources.ts';

test('original CI owner recovers the same run across disable, consultation and a lost receipt', { timeout: 15_000 }, async t => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'bg-ci-recovery-')));
    const env = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PATH: process.env.PATH };
    process.env.PI_CODING_AGENT_DIR = root;
    process.env.PATH = `${root}:${env.PATH}`;
    const calls = join(root, 'gh-calls'), stage = join(root, 'stage');
    writeFileSync(stage, 'Build');
    writeFileSync(calls, 'dispatch #123\n');
    writeFileSync(join(root, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(' ') + '\\n');
if (args[0] !== 'run' || args[2] !== '123') process.exit(90);
if (args[1] === 'watch') process.exit(1);
if (args[1] !== 'view' || args[3] !== '--repo' || args[4] !== 'github.com/example/project') process.exit(91);
console.log(JSON.stringify({ databaseId: 123, attempt: 1, status: 'in_progress', jobs: [{ name: 'CI', status: 'in_progress', steps: [{ name: fs.readFileSync(${JSON.stringify(stage)}, 'utf8'), status: 'in_progress' }] }] }));
`, { mode: 0o700 });
    const admission = join(root, 'background-tool-admission');
    mkdirSync(admission, { mode: 0o700 });
    const modules = (name: string) => import(`../src/runtime/domain/background-service/${name}.domain.mjs`);
    const [{ registerTools }, { backgroundParametersDigest }, { readAdmissionStartToken }] = await Promise.all([modules('tools'), modules('managed-authority'), modules('process-identity')]);
    const definitions = new Map<string, any>();
    registerTools({ events: new EventEmitter(), on() {}, registerTool(def: any) { definitions.set(def.name, def); } });
    const store = acquireMutationStore(root);
    const ports: Map<string, any> = (globalThis as any)[Symbol.for('pi-better-server:result-supervision-ports-v1')] ??= new Map();
    const supervision = new RuntimeResultSupervision(root, 'ci-recovery');
    ports.set(root, { status() { supervision.reconcile(); return { hostId: supervision.hostId, epoch: supervision.epoch, reason: supervision.reason }; } });
    const outcome = { id: 'outcome-1', objective: 'Verify the CI build', doneWhen: ['Tests pass'], boundaries: ['Do not rerun CI'] };
    const catalog = new CatalogSources();
    const requested: string[] = [];
    const model = {
        getModel(provider: string, id: string) { requested.push(`${provider}/${id}`); return { provider, id }; },
        async completeSimple(_model: unknown, context: any) {
            assert.match(context.systemPrompt, /suggest resuming observation by the original run ID/);
            assert.equal(context.tools, undefined);
            const evidence = JSON.parse(context.messages[0].content[0].text);
            assert.deepEqual(evidence.outcome, outcome);
            assert.deepEqual(evidence.stage.steps, ['CI / Build']);
            return { stopReason: 'stop', content: [{ type: 'text', text: 'RESUME_OBSERVATION' }] };
        },
    };
    let recordedInput: Parameters<RecoveryDependencies['diagnose']>[0] | undefined;
    let releaseDiagnosis!: () => void;
    let diagnosisStarted!: () => void;
    const started = new Promise<void>(resolve => { diagnosisStarted = resolve; });
    const complete = new Promise<void>(resolve => { releaseDiagnosis = resolve; });
    let diagnoses = 0;
    let host: Awaited<ReturnType<typeof createBackgroundTools>> | undefined;
    let agedOut = false, historyReads = 0;
    const owner = { kind: 'parent-session', workspace: root, sessionId: 'native' };
    const observe = async (scope: Record<string, unknown>) => {
        supervision.reconcile();
        if (scope.backgroundHistory) {
            assert.equal(scope.sessionId, owner.sessionId);
            assert.equal(scope.cwd, root);
            historyReads++;
        }
        return { status: 'ready', scopeRevision: store.store.getChangeRevision(), rows: agedOut && !scope.backgroundHistory ? [] : store.store.listOperations({ ownerScope: { ...owner, sessionId: scope.sessionId } }).map((op: any) => ({ meta: {
            durable: true, id: op.taskId, status: op.terminalOutcome ?? 'running', terminal: op.terminalRevision > 0,
            active: op.terminalRevision === 0, owner: op.owner,
        } })) };
    };
    const create = () => createBackgroundTools(root, 'ci-recovery', () => false, observe, 30_000, undefined, catalog, {
        async diagnose(input, signal) {
            diagnoses++;
            recordedInput = input;
            const answer = await diagnoseCiRecovery(model as any, catalog.load({ cwd: root, userRoot: root, projectTrusted: true }), input, signal);
            diagnosisStarted();
            await complete;
            return answer;
        },
    });
    async function request(tool: string, params: any = {}, edit: Record<string, unknown> = {}) {
        const id = randomUUID(), secret = randomBytes(32).toString('hex');
        const path = join(admission, `${id}.json`);
        const record = { version: 2, id, secretHash: createHash('sha256').update(secret).digest('hex'), instanceId: 'ci-recovery',
            key: randomUUID(), tool, params, parametersDigest: backgroundParametersDigest(definitions.get(tool)?.parameters ?? {}), owner,
            branchIds: ['outcome-1', 'launch-branch'], supervisorOutcome: outcome, projectTrusted: true,
            pid: process.pid, start: readAdmissionStartToken(process.pid), ...edit };
        writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
        try { return await host!.handle({ type: 'runtime_background_tool', authority: { id, secret } }); }
        finally { rmSync(path, { force: true }); }
    }
    async function until<T>(read: () => Promise<T>, condition: (value: T) => boolean) {
        for (let attempt = 0; attempt < 100; attempt++) {
            const result = await read();
            if (condition(result)) return result;
            await delay(25);
        }
        assert.fail('Expected CI recovery state was not reached');
    }
    const poll = () => request('__background_poll');
    const recoveryFrom = (result: any) => result.deliveries.find((item: any) => item.notification.event?.customType === 'background-ci-observation-recovery');
    const setting = (enabled: boolean, scenarios: string[]) => writeFileSync(join(root, 'settings.json'), JSON.stringify({ piBetterHarness: { supervisorMode: { enabled, scenarios } } }));
    try {
        host = await create();
        const { details: { id } } = await request('bg_task_spawn', { shell: false, argv: ['gh', 'run', 'watch', '123', '--repo', 'example/project'] });
        assert.equal((await request('supervisor_consult', { id })).details.status, 'disabled');
        await until(poll, result => result.tasks.some((task: any) => task.id === id && task.terminal));
        setting(true, []);
        assert.equal((await request('supervisor_consult', { id })).details.status, 'disabled');
        assert.equal(diagnoses, 0);
        setting(true, ['ci-observation']);
        await poll();
        await started;
        assert.deepEqual(recordedInput?.run, { repo: 'example/project', runId: '123', attempt: 1, outcomeId: 'outcome-1' });
        assert.equal((await request('supervisor_consult', { id }, { owner: { ...owner, sessionId: 'other' } })).details.status, 'outside-scope');
        assert.equal((await request('supervisor_consult', { id }, { branchIds: ['outcome-1', 'other-branch'] })).details.status, 'outside-scope');
        assert.equal((await request('supervisor_consult', { id })).details.status, 'queued');
        setting(false, ['ci-observation']);
        // The result finishes while disabled; it does not authorize notification.
        releaseDiagnosis();
        await delay(30);
        assert.equal(recoveryFrom(await poll()), undefined);
        writeFileSync(stage, 'Test');
        setting(true, ['ci-observation']);
        const handoff = recoveryFrom(await until(poll, result => !!recoveryFrom(result)));
        assert.match(handoff.notification.event.content, /CI \/ Test/);
        assert.equal(diagnoses, 1);
        assert.deepEqual(requested, ['openai/gpt-6.1-sol']);
        const ownerRead = handoff.notification.event.content.match(/`gh ([^`]+)`/)?.[1];
        assert.ok(ownerRead);
        assert.equal(JSON.parse(execFileSync('gh', ownerRead.split(' '), { encoding: 'utf8' })).jobs[0].steps[0].name, 'Test');
        // Lose the first receipt and reconstruct the original advice from durable evidence.
        await host.close();
        agedOut = true;
        historyReads = 0;
        host = await create();
        const replay = recoveryFrom(await until(poll, result => !!recoveryFrom(result)));
        assert.equal(historyReads, 1);
        assert.equal(replay.receiptId, handoff.receiptId);
        assert.equal(diagnoses, 1);
        assert.deepEqual(await request('__background_receipt', { token: replay.token, delivered: true }), { receipted: true });
        assert.equal(recoveryFrom(await poll()), undefined);
        const commands = readFileSync(calls, 'utf8').trim().split('\n');
        assert.equal(commands.filter(line => line.startsWith('dispatch')).length, 1);
        assert.equal(commands.filter(line => line.startsWith('run watch')).length, 1);
        assert.ok(commands.slice(1).every(line => /^run (watch|view) 123 /.test(line)));
        t.diagnostic('The original owner read Test on run 123, attempt 1; fixture recorded one dispatch and one original watcher.');
    } finally {
        releaseDiagnosis();
        await host?.close();
        supervision.close(); store.release(); ports.delete(root);
        for (const [name, value] of Object.entries(env)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
        rmSync(root, { recursive: true, force: true });
    }
});

test('diagnosis timeout stays terminal across repeated observations and host replacement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-diagnosis-timeout-'));
    const outcome = { id: 'outcome', objective: 'Verify CI', doneWhen: [], boundaries: [] };
    const input = { outcome, authorization: 'current', policy: undefined, projectTrusted: false };
    const evidence = {
        run: { repo: 'example/project', runId: '123', attempt: 1 },
        inspection: { taskDir: dir, status: 'lost', terminal: true },
        operation: { operationId: 'operation', terminalRevision: 1, owner: { workspace: dir } },
    };
    let calls = 0;
    const deps: RecoveryDependencies = {
        read: async () => ({ status: 'in_progress', steps: ['Build'] }),
        diagnose: (_input, signal) => {
            calls++;
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        },
    };
    const makeRecovery = () => new CiRecovery(() => true, deps, writeFileSync, 10);
    const first = makeRecovery();
    const replacement = makeRecovery();
    try {
        assert.equal(first.inspect(evidence, input).status, 'checking');
        assert.equal(first.inspect(evidence, input).status, 'checking');
        await delay(50);
        assert.equal(first.inspect(evidence, input).status, 'diagnosis-failed');
        assert.equal(replacement.inspect(evidence, input).status, 'diagnosis-failed');
        assert.equal(calls, 1);
    } finally {
        await first.close();
        await replacement.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
