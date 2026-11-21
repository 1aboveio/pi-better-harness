import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'launch-abort-'));
process.env.TMPDIR = root;
process.env.PI_SUBAGENT_DURABLE_DIR = join(root, 'durable');
const { abortUncommittedLaunch } = await import('../launch-abort.ts');
const { acquireConversationLease, readConversationLease } = await import('../continuation.ts');
const { nextRunId, runDir, logPathFor, recordLaunchAttempt } = await import('../registry.ts');
const { spawnDetached, processExists } = await import('../spawn.ts');
after(() => rmSync(root, { recursive: true, force: true }));

it('retains the real conversation lease and launch evidence until the failed child closes', async () => {
    const id = nextRunId(), sessionId = nextRunId();
    mkdirSync(runDir(id), { recursive: true });
    recordLaunchAttempt(id);
    const lease = acquireConversationLease({ sessionId, attemptId: id });
    const child = spawnDetached({ file: process.execPath,
        fileArgs: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, logPath: logPathFor(id) });
    const abort = abortUncommittedLaunch(id, { child, lease, artifacts: {} });
    // A signal was sent, but close has not been observed. Another continuation
    // must still be refused in this exact signal/exit window.
    assert.equal(readConversationLease(sessionId)?.token, lease.token);
    assert.throws(() => acquireConversationLease({ sessionId, attemptId: nextRunId() }), /writer|busy|another|already/i);
    assert.ok(existsSync(runDir(id)));
    await abort;
    assert.equal(processExists(child.pid), false);
    assert.equal(readConversationLease(sessionId), undefined);
    assert.equal(existsSync(runDir(id)), false);
    const successor = acquireConversationLease({ sessionId, attemptId: nextRunId() });
    successor.release();
});

it('releases a pre-spawn lease and removes only the failed attempt', async () => {
    const id = nextRunId(), sessionId = nextRunId();
    mkdirSync(runDir(id), { recursive: true });
    recordLaunchAttempt(id);
    const lease = acquireConversationLease({ sessionId, attemptId: id });
    await abortUncommittedLaunch(id, { lease, artifacts: {} });
    assert.equal(readConversationLease(sessionId), undefined);
    assert.equal(existsSync(runDir(id)), false);
});
