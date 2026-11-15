import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkClient } from "../shared-work-client.mjs";
import { startWorkObservation, stopWorkObservation, workObservation } from "../work-observation.ts";

// An external query transport deterministically advances between bounded pages.
// The collector must preserve its final notification, without another event.
for (const mode of ["recover", "stop", "final-page-stop", "no-new-event"]) test(`shared observation pagination recovery: ${mode}`, async () => {
    const stopDuringRecovery = mode === "stop";
    const root = realpathSync(mkdtempSync("/tmp/pi-obs-retry-"));
    let sequence = 0, conflicts = 0, historyReads = 0;
    const originalGet = WorkClient.prototype.get;
    if (mode === "final-page-stop") WorkClient.prototype.get = async function(scope) {
        const result = await originalGet.call(this, scope);
        // The real socket response completed, but the consumer has not resumed.
        if (scope.pendingRecipient) stopWorkObservation();
        return result;
    };
    const snapshot = () => ({ instanceId: "fixture", seq: sequence, status: "ready", rows: [], totalMatching: 0 });
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
        assert.equal(conflicts, 2);
        if (stopDuringRecovery || mode === "final-page-stop") {
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
