// @covers subagent-spawn-batch.codemode-receipt
// @level integration
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'pi-codemode-batch-'));
const agentDir = join(root, 'agent');
const binDir = join(root, 'bin');
const oldEnv = Object.fromEntries(['TMPDIR', 'PI_CODING_AGENT_DIR', 'PI_SANDBOX_RECOVERY_SNAPSHOT', 'PATH']
    .map((key) => [key, process.env[key]]));
mkdirSync(agentDir);
mkdirSync(binDir);
Object.assign(process.env, { TMPDIR: root, PI_CODING_AGENT_DIR: agentDir,
    PI_SANDBOX_RECOVERY_SNAPSHOT: 'off', PATH: `${binDir}:${process.env.PATH}` });
// Fake only the external child process, not the extension or the SDK.
writeFileSync(join(binDir, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// Use checkout peers by default; the compatibility lane supplies its pinned SDK.
const sdkUrl = process.env.PI_CODEMODE_TEST_SDK_DIR
    ? pathToFileURL(join(process.env.PI_CODEMODE_TEST_SDK_DIR, 'dist/index.js')).href
    : import.meta.resolve('@earendil-works/pi-coding-agent');
const sdk = await import(sdkUrl);
const supported = typeof sdk.createCodemodeExtension === 'function';
if (process.env.PI_CODEMODE_TEST_REQUIRED === '1') {
    assert.ok(supported, 'the required native codemode SDK must be installed');
}
let registry;
let config;

function metas() {
    return registry.listMetas();
}

async function codemode(t, deny = false, observed) {
    const settingsManager = sdk.SettingsManager.inMemory();
    const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        extensionFactories: [sdk.createCodemodeExtension({ mode: 'on' }),
            { name: 'batch-under-test', factory: (await import('../index.ts')).default },
            ...(observed ? [{ name: 'observe-batch', factory: (pi) => pi.on('tool_result', (event) => {
                if (event.toolName === 'subagent_spawn_batch') observed.push(event);
            }) }] : []),
            ...(deny ? [{ name: 'deny-batch', factory: (pi) => pi.on('tool_call', (event) =>
                event.toolName === 'subagent_spawn_batch' ? { block: true, reason: 'batch denied by hook' } : undefined) }] : [])] });
    await loader.reload();
    const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: join(agentDir, 'models.json'),
        modelsStorePath: join(agentDir, 'models-store.json') });
    const { session } = await sdk.createAgentSession({ cwd: root, agentDir, resourceLoader: loader,
        settingsManager, modelRuntime, sessionManager: sdk.SessionManager.inMemory(root), noTools: 'builtin' });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    session.setActiveToolsByName(['codemode', 'subagent_spawn_batch']);
    const tool = session.agent.state.tools.find((candidate) => candidate.name === 'codemode');
    assert.ok(tool, 'native codemode must be registered');
    // The provider boundary supplies the assistant call; Pi owns tool dispatch.
    session.agent.state.messages.push({ role: 'assistant', content: [
        { type: 'toolCall', id: 'batch-test', name: 'codemode', arguments: { code: '' } }],
        api: 'test', provider: 'test', model: 'test', stopReason: 'toolUse', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    return tool;
}

async function script(tool, code) {
    const result = await tool.execute('batch-test', { code }, new AbortController().signal);
    assert.equal(result.isError, undefined, result.content.map((item) => item.text).join('\n'));
    // Parse only the script's serialization of its typed nested-tool value.
    return JSON.parse(result.content.at(-1).text);
}
const spawn = (args) => `const receipt = await tools.subagent_spawn_batch(${JSON.stringify(args)}); text(receipt);`;

test('native Pi codemode batch receipts', { skip: !supported && 'native codemode requires Pi >=0.99' }, async (t) => {
    t.after(() => {
        config?.setConfigForTests(undefined);
        for (const [key, value] of Object.entries(oldEnv)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        rmSync(root, { recursive: true, force: true });
    });
    registry = await import('../registry.ts');
    config = await import('../config.ts');
    config.setConfigForTests({ maxConcurrent: 4 });

    await t.test('typed launch receipt identifies persisted jobs', async (t) => {
        const tool = await codemode(t);
        const receipt = await script(tool, spawn({ batchName: 'audit', shared: { tools: 'read,bash', sandbox: false,
            model: 'test/model', callback: false }, jobs: [
            { prompt: 'first', name: 'review' }, { prompt: 'second', name: 'review' }] }));
        assert.equal(receipt.status, 'launched');
        assert.equal(receipt.batchName, 'audit');
        assert.equal(typeof receipt.batchId, 'string');
        assert.deepEqual([receipt.failed, receipt.skipped], [[], []]);
        assert.deepEqual(receipt.launched.map(({ job, name }) => ({ job, name })),
            [{ job: 1, name: 'review' }, { job: 2, name: 'review-2' }]);
        assert.equal(new Set(receipt.launched.map(({ id }) => id)).size, 2);
        for (const item of receipt.launched) {
            assert.match(item.id, /^sa_/);
            const meta = registry.readMeta(item.id);
            assert.equal(meta.batchId, receipt.batchId);
            assert.equal(meta.batchName, 'audit');
            assert.equal(meta.name, item.name);
            assert.equal(meta.model, 'test/model');
            assert.equal(meta.spawnPid, process.pid);
        }
    });

    await t.test('capacity reports partial/skipped and no-launch without creating extra runs', async (t) => {
        const tool = await codemode(t);
        const running = (name) => {
            const id = registry.nextRunId();
            registry.writeMeta({ id, name, status: 'running', pid: process.pid, spawnPid: process.pid,
                cwd: root, promptPreview: 'capacity fixture', startedAt: Date.now(),
                logPath: join(root, 'pi-better-subagents', 'runs', id, 'output.log'), sessionId: id });
            return id;
        };
        for (const meta of metas()) {
            if (meta.status === 'running') registry.writeMeta({ ...meta, status: 'completed' });
        }
        const fillers = Array.from({ length: 3 }, (_, i) => running(`occupied-${i}`));
        const partial = await script(tool, spawn({ shared: { tools: 'read,bash', sandbox: false, callback: false },
            onCapacity: 'launch-available', jobs: [{ prompt: 'admit', name: 'admit' }, { prompt: 'skip', name: 'skip' }] }));
        assert.equal(partial.status, 'partial');
        assert.deepEqual(partial.launched.map(({ job, name }) => ({ job, name })), [{ job: 1, name: 'admit' }]);
        assert.deepEqual(partial.skipped, [{ job: 2, name: 'skip' }]);
        assert.deepEqual(partial.failed, []);
        assert.equal(registry.readMeta(partial.launched[0].id).batchId, partial.batchId);
        const last = running('occupied-last');
        const before = metas().length;
        const full = await script(tool, spawn({ shared: { tools: 'read,bash', sandbox: false },
            onCapacity: 'launch-available', jobs: [{ prompt: 'blocked', name: 'blocked' }] }));
        assert.equal(full.status, 'not-launched');
        assert.deepEqual([full.launched, full.failed, full.skipped], [[], [], [{ job: 1, name: 'blocked' }]]);
        assert.equal(metas().length, before);
        for (const id of [...fillers, last]) registry.writeMeta({ ...registry.readMeta(id), status: 'completed' });
    });

    await t.test('a failed job retains its typed reason beside a launched job', async (t) => {
        config.setConfigForTests({ maxConcurrent: 4, toolExtensions: { web_fetch: '@juicesharp/rpiv-web-tools' } });
        t.after(() => config.setConfigForTests({ maxConcurrent: 4 }));
        const tool = await codemode(t);
        const receipt = await script(tool, spawn({ shared: { sandbox: false, callback: false },
            onCapacity: 'launch-available', jobs: [
                { prompt: 'missing extension', name: 'unavailable', tools: 'web_fetch' },
                { prompt: 'continue', name: 'available', tools: 'read,bash' }] }));
        assert.equal(receipt.status, 'partial');
        assert.deepEqual(receipt.skipped, []);
        assert.equal(receipt.failed.length, 1);
        assert.equal(receipt.failed[0].job, 1);
        assert.equal(receipt.failed[0].name, 'unavailable');
        assert.match(receipt.failed[0].reason, /extension.*not installed/i);
        assert.deepEqual(receipt.launched.map(({ job, name }) => ({ job, name })), [{ job: 2, name: 'available' }]);
        assert.equal(registry.readMeta(receipt.launched[0].id).batchId, receipt.batchId);
    });

    await t.test('clarification creates no run', async (t) => {
        const observed = [];
        const tool = await codemode(t, false, observed);
        const before = metas().length;
        const receipt = await script(tool, spawn({ shared: { tools: 'read,bash', sandbox: false },
            jobs: [{ prompt: 'ambiguous', agent: 'agent.any', role: 'role.any' }] }));
        assert.equal(receipt.status, 'clarification-needed');
        assert.deepEqual([receipt.launched, receipt.failed, receipt.skipped], [[], [], []]);
        assert.equal(typeof receipt.message, 'string');
        assert.ok(receipt.choices.length > 0);
        assert.equal(metas().length, before);
        assert.equal(observed.length, 1);
        assert.equal(observed[0].details.status, 'clarification-needed');
        assert.match(observed[0].content[0].text, /choose|split|UI is unavailable/i);
        assert.equal(observed[0].structuredContent.message, receipt.message);
    });

    await t.test('native tool_call hook denies nested batch before launch', async (t) => {
        const tool = await codemode(t, true);
        const before = metas().length;
        const outcome = await script(tool, `try { await tools.subagent_spawn_batch({ shared: { tools: 'read,bash', sandbox: false }, jobs: [{ prompt: 'denied' }] }); text({ blocked: false }); } catch (error) { text({ blocked: true, reason: String(error) }); }`);
        assert.equal(outcome.blocked, true);
        assert.match(outcome.reason, /batch denied by hook/);
        assert.equal(metas().length, before);
    });
});
