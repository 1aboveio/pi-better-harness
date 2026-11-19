import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkClient } from "../shared-work-client.mjs";
import { startWorkObservation, stopWorkObservation, workObservation } from "../work-observation.ts";

// An external query transport deterministically advances between bounded pages.
// The collector must preserve its final notification, without another event.
for (const mode of ["recover", "stop", "final-page-stop", "final-anchor-stop", "no-new-event"]) test(`shared observation pagination recovery: ${mode}`, async () => {
    const stopDuringRecovery = mode === "stop";
    const root = realpathSync(mkdtempSync("/tmp/pi-obs-retry-"));
    let sequence = 0, conflicts = 0, historyReads = 0, anchorReads = 0;
    const originalGet = WorkClient.prototype.get;
    if (["final-page-stop", "final-anchor-stop"].includes(mode)) WorkClient.prototype.get = async function(scope) {
        const result = await originalGet.call(this, scope);
        // The real socket response completed, but the consumer has not resumed.
        if (mode === "final-page-stop" && scope.pendingRecipient) stopWorkObservation();
        if (mode === "final-anchor-stop" && scope.limit === 1 && ++anchorReads === 2) stopWorkObservation();
        return result;
    };
    const snapshot = () => ({ instanceId: "fixture", seq: sequence, scopeRevision: String(sequence), status: "ready", rows: [], totalMatching: 0 });
    const server = createServer(socket => {
        let buffer = "";
        socket.on("data", chunk => {
            buffer += chunk;
            while (buffer.includes("\n")) {
                const end = buffer.indexOf("\n"), command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
                if (command.type === "runtime_get_snapshot" && command.scope.active === false) {
                    historyReads++;
                    if (mode === "no-new-event") {
                        socket.write(JSON.stringify({ id: command.id, type: "response", success: false, error: "fixture read unavailable" }) + "\n");
                        continue;
                    }
                }
                let data = snapshot();
                if (command.type === "hello") data = { capabilities: [] };
                if (command.type === "runtime_get_snapshot" && command.scope.active === false && conflicts < 2) {
                    conflicts++; sequence++;
                    socket.write(JSON.stringify({ type: "event", event: { type: "runtime_snapshot", snapshot: snapshot() } }) + "\n");
                    data = snapshot();
                }
                socket.write(JSON.stringify({ id: command.id, type: "response", success: true, data }) + "\n");
            }
        });
    });
    try {
        server.listen(join(root, "pi-server.sock")); await once(server, "listening");
        writeFileSync(join(root, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
        await startWorkObservation(root, { cwd: root, sessionId: "parent" }, () => {
            if (stopDuringRecovery && workObservation()?.status === "degraded") stopWorkObservation();
        });
        if (mode === "no-new-event") {
            const reads = historyReads;
            await delay(50);
            assert.equal(workObservation()?.status, "degraded");
            assert.equal(historyReads, reads, "without a new notification, failure must not schedule retries");
            assert.ok(reads <= 4, "only the initial and already coalesced subscription demand may run");
            return;
        }
        const deadline = Date.now() + 1000;
        while (!stopDuringRecovery && mode !== "final-page-stop" && workObservation()?.status !== "ready" && Date.now() < deadline) await delay(10);
        assert.equal(conflicts, ["final-page-stop", "final-anchor-stop"].includes(mode) ? 1 : 2);
        if (stopDuringRecovery || ["final-page-stop", "final-anchor-stop"].includes(mode)) {
            await delay(20);
            assert.equal(workObservation(), undefined, "an in-flight dirty collection cannot restore a stopped generation");
            return;
        }
        assert.equal(workObservation()?.status, "ready", "the last dirty notification must survive the retry boundary");
        assert.equal(workObservation().seq, 2);
    } finally {
        WorkClient.prototype.get = originalGet;
        stopWorkObservation(); server.close(); await once(server, "close"); rmSync(root, { recursive: true, force: true });
    }
});

test('list waits through a missing socket during server replacement', async () => {
    const { observedList } = await import('../work-observation.ts');
    const root = realpathSync(mkdtempSync('/tmp/pi-obs-gap-'));
    const sockets = new Set();
    const server = createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket));
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk;
            while (buffer.includes('\n')) {
                const i = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
                const data = request.type === 'hello' ? { capabilities: [] } : { instanceId: 'replacement', seq: 1, scopeRevision: '1', status: 'ready', rows: [], totalMatching: 0 };
                socket.write(JSON.stringify({ id: request.id, success: true, data }) + '\n');
            }
        });
    });
    writeFileSync(join(root, 'server-registration-v1.json'), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
    const timer = setTimeout(() => server.listen(join(root, 'pi-server.sock')), 100);
    try {
        const start = startWorkObservation(root, { cwd: root }, () => {});
        const result = await observedList({ cwd: root });
        await start;
        assert.equal(result.instanceId, 'replacement');
        assert.equal(result.status, 'ready');
    } finally {
        clearTimeout(timer); stopWorkObservation();
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise(resolve => server.close(resolve));
        rmSync(root, { recursive: true, force: true });
    }
});

test('closing observation cancels a pending list without restarting a stopped generation', async () => {
    const { observedList } = await import('../work-observation.ts');
    const root = realpathSync(mkdtempSync('/tmp/pi-obs-cancel-'));
    writeFileSync(join(root, 'server-registration-v1.json'), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
    try {
        const start = startWorkObservation(root, { cwd: root }, () => {});
        const pending = assert.rejects(observedList({ cwd: root }), /abort|closed/i);
        stopWorkObservation();
        await pending; await start; await delay(30);
        assert.equal(workObservation(), undefined);
    } finally { stopWorkObservation(); rmSync(root, { recursive: true, force: true }); }
});

test('owned runtime root can drain installer writes after reconnect cancellation', { timeout: 4000 }, async () => {
    const { connectWorkClient } = await import('../shared-work-client.mjs');
    const { waitForWorkClientRecovery } = await import('../../pi-better-server/src/runtime/work-client.mjs');
    const root = realpathSync(mkdtempSync('/tmp/pi-obs-stage-'));
    const stage = join(root, '.stage-owned');
    const socketPath = join(root, 'pi-server.sock');
    const controller = new AbortController();
    const started = Promise.withResolvers();
    const cancelled = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const replacement = createServer(socket => {
        let buffer = '';
        const onData = chunk => {
            buffer += chunk;
            const end = buffer.indexOf('\n');
            if (end < 0) return;
            socket.off('data', onData);
            const hello = JSON.parse(buffer.slice(0, end));
            socket.write(JSON.stringify({ id: hello.id, success: true, data: { capabilities: [] } }) + '\n');
        };
        socket.setEncoding('utf8');
        socket.on('data', onData);
    });
    let installation;
    const dial = connectWorkClient(socketPath, root, [], {
        signal: controller.signal,
        recover({ signal }) {
            installation = (async () => {
                mkdirSync(stage);
                started.resolve();
                await once(signal, 'abort');
                cancelled.resolve();
                await finish.promise;
                writeFileSync(join(stage, 'late-installer-write'), 'finished');
                rmSync(stage, { recursive: true });
            })();
            return installation;
        },
    });
    void dial.catch(() => {});
    try {
        await started.promise;
        replacement.listen(socketPath);
        await once(replacement, 'listening');
        await dial;
        await cancelled.promise;
        let drained = false;
        const draining = waitForWorkClientRecovery(socketPath, root).then(() => { drained = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(drained, false, 'the root is still owned while the cancelled installer can write');
        finish.resolve();
        await draining;
        assert.equal(existsSync(stage), false, 'drain includes filesystem cleanup');
    } finally {
        controller.abort();
        finish.resolve();
        (await dial.catch(() => undefined))?.close();
        await installation;
        if (replacement.listening) await new Promise(resolve => replacement.close(resolve));
        rmSync(root, { recursive: true, force: true });
    }
});
