import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkRuntimeFixture } from './work-runtime-fixture.mjs';
import { WorkClient } from '../../pi-better-server/src/runtime/work-client.mjs';

test('query fixture retains its real daemon while other-root journeys have no recipients', async () => {
    const root = mkdtempSync(join(tmpdir(), 'query-fixture-lifetime-'));
    const stop = await startWorkRuntimeFixture({ ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: join(root, 'agent'), TEST_DAEMON_IDLE_MS: '100' });
    try {
        // More than the production idle-sweep interval; no SDK recipient is open.
        await delay(2500);
        assert.ok(existsSync(stop.socketPath), `fixture socket disappeared: ${JSON.stringify(stop.diagnostics())}`);
        await stop.pause();
        await stop.resume();
        await delay(2500);
        assert.ok(existsSync(stop.socketPath), 'restart reacquires the fixture retention connection');
    } finally { await stop(); rmSync(root, { recursive: true, force: true }); }
});

test('closing another-root fixture leaves the retained result server and its instance usable', { timeout: 15000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'query-fixture-roots-'));
    const agent = join(root, 'outer-agent');
    const outer = await startWorkRuntimeFixture({ ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: agent });
    let inner, reader;
    try {
        reader = new WorkClient(outer.socketPath, agent);
        const first = await reader.ready;
        inner = await startWorkRuntimeFixture({ ...process.env, TMPDIR: root, PI_CODING_AGENT_DIR: join(root, 'inner-agent') });
        await Promise.all([inner(), inner()]);
        inner = undefined;
        const snapshot = await reader.get({ limit: 1 });
        assert.equal(snapshot.instanceId, first.instanceId, 'nested teardown must not replace or stop the result server');
        assert.equal(outer.diagnostics().exitCode, null);
        assert.ok(existsSync(outer.socketPath));
        await outer.pause();
        await outer.pause();
        await outer.resume();
        reader.close();
        reader = new WorkClient(outer.socketPath, agent);
        const restarted = await reader.ready;
        assert.notEqual(restarted.instanceId, first.instanceId, 'only explicit restart changes the server instance');
        assert.equal((await reader.get({ limit: 1 })).instanceId, restarted.instanceId);
    } finally {
        reader?.close();
        try { await inner?.(); } finally { await outer(); rmSync(root, { recursive: true, force: true }); }
    }
});
