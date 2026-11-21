import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { observeOwnedProcess, executableDiagnostic } = await import(String('./test-support/owned-process.mjs'));

test('owned fixture cleanup retains an early close instead of awaiting a lost event', async () => {
    let kills = 0;
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null, stderr: new PassThrough(),
        kill() { kills++; return false; } });
    const owned = observeOwnedProcess(child);
    child.stderr.end('fixture exited before inventory'); child.exitCode = 1; child.emit('close', 1, null);
    assert.deepEqual(await owned.stop(), { code: 1, signal: null });
    assert.equal(kills, 0);
    assert.equal(owned.diagnostic().stderr, 'fixture exited before inventory');
});

test('owned fixture cleanup signals only its live child and bounds error output', async () => {
    let kills = 0;
    const events = new EventEmitter();
    const child = Object.assign(events, { pid: 123, exitCode: null, signalCode: null as string | null, stderr: new PassThrough(),
        kill(signal: string) { kills++; this.signalCode = signal; queueMicrotask(() => events.emit('close', null, signal)); return true; } });
    const owned = observeOwnedProcess(child);
    child.stderr.end('x'.repeat(4096));
    assert.deepEqual(await owned.stop(), { code: null, signal: 'SIGKILL' });
    assert.equal(kills, 1); assert.equal(owned.diagnostic().stderr.length, 2048);
    assert.ok(executableDiagnostic(import.meta.filename).canonical);
});

test('owned fixture launch errors remain available after cleanup without becoming cleanup failures', async () => {
    const child = Object.assign(new EventEmitter(), { pid: undefined, exitCode: -2, signalCode: null, stderr: new PassThrough(),
        kill() { assert.fail('a failed launch owns no live child'); } });
    const owned = observeOwnedProcess(child);
    child.emit('error', new Error('fixture launch denied')); child.emit('close', -2, null);
    assert.deepEqual(await owned.stop(), { code: -2, signal: null });
    assert.equal(owned.diagnostic().error, 'fixture launch denied');
});
