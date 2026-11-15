import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startWorkRuntimeFixture } from './work-runtime-fixture.mjs';

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
