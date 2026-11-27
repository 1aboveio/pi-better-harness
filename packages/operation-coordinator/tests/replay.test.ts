import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
    cleanupHarnesses,
    createHarness,
    expectStoreError,
    parentOwner,
    registerOperation,
    settleOperation,
    workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/store-command.ts", import.meta.url));

interface CommandResult {
    code: number;
    payload: Record<string, unknown>;
}

function parseResult(stdout: string): Record<string, unknown> {
    const line = stdout.trim().split("\n").pop();
    assert.ok(line, "the fixture must print one JSON line");
    return JSON.parse(line) as Record<string, unknown>;
}

function spawnCommand(path: string, command: string, args: unknown): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ["--import", "tsx", fixture, path, command, JSON.stringify(args)],
            { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
            try {
                resolve({ code: code ?? -1, payload: parseResult(stdout) });
            } catch (error) {
                reject(
                    new Error(
                        `fixture produced no result (exit ${code}): ${stderr || stdout || String(error)}`,
                    ),
                );
            }
        });
    });
}

describe("cross-process durability", () => {
    it("sees a terminal revision written by another process and does not duplicate delivery", async () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-build-1", owner: workerOwner });
        harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the build result and continue packaging.",
        });
        harness.closeStore();

        const settled = await spawnCommand(harness.path, "settle", {
            operationId: "op-build-1",
            eventId: "event-from-runner",
            outcome: "succeeded",
            owner: workerOwner,
            evidence: [{ kind: "terminal-record", ref: "/logs/op-build-1/terminal.json", summary: "exit 0" }],
        });
        assert.equal(settled.code, 0, JSON.stringify(settled.payload));
        assert.equal(settled.payload.recorded, true);
        assert.equal(settled.payload.ready, 1);
        assert.equal(settled.payload.outbox, 1);

        // This process was restarted; it must read the same durable state.
        harness.reopen();
        const wait = harness.store.getWait({ waitId: "wait-build" });
        assert.equal(wait?.phase, "ready");
        assert.equal(wait?.dependencies[0].terminalRevision, 1);
        assert.equal(harness.store.listOutbox({ waitId: "wait-build" }).length, 1);
        assert.equal(
            harness.store.listOutbox({ waitId: "wait-build" })[0].evidence[0].ref,
            "/logs/op-build-1/terminal.json",
        );

        // A reconcile that replays the same terminal event adds nothing.
        const replay = await spawnCommand(harness.path, "settle", {
            operationId: "op-build-1",
            eventId: "event-from-runner",
            outcome: "succeeded",
            owner: workerOwner,
        });
        assert.equal(replay.payload.recorded, false);
        assert.equal(harness.store.listOutbox({ waitId: "wait-build" }).length, 1);
    });

    it("refuses a conflicting terminal event written by a second process", async () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1", "succeeded", workerOwner, "event-first");
        harness.closeStore();

        const conflict = await spawnCommand(harness.path, "settle", {
            operationId: "op-build-1",
            eventId: "event-second",
            outcome: "failed",
            owner: workerOwner,
            evidence: [{ kind: "log", ref: "/logs/op-build-1/build.log" }],
        });

        assert.equal(conflict.code, 3);
        assert.equal(conflict.payload.code, "terminal-conflict");
        harness.reopen();
        assert.equal(harness.store.getOperation("op-build-1")?.terminalOutcome, "succeeded");
    });

    it("admits exactly one resume claim when two supervisors race", async () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-parent", owner: parentOwner, taskId: "bg_parent" });
        settleOperation(harness.store, "op-parent", "succeeded", parentOwner);
        harness.store.registerWait({
            waitId: "wait-parent",
            owner: parentOwner,
            dependencies: [{ operationId: "op-parent" }],
            continuationNote: "Parent interprets the delivery result.",
        });
        harness.closeStore();

        const base = {
            waitId: "wait-parent",
            generation: 1,
            expectedCancelEpoch: 0,
            reservedCheckpointId: "checkpoint-parent",
        };
        const [left, right] = await Promise.all([
            spawnCommand(harness.path, "claim", {
                ...base,
                lease: { ownerId: "host-left", pid: process.pid },
            }),
            spawnCommand(harness.path, "claim", {
                ...base,
                lease: { ownerId: "host-right", pid: process.pid },
            }),
        ]);

        const winners = [left, right].filter((result) => result.code === 0);
        const losers = [left, right].filter((result) => result.code !== 0);
        assert.equal(winners.length, 1, `exactly one claim must win: ${JSON.stringify([left, right])}`);
        assert.equal(losers.length, 1);
        assert.equal(losers[0].payload.code, "concurrent-claim");

        harness.reopen();
        assert.equal(harness.store.getWait({ waitId: "wait-parent" })?.phase, "resuming");
        assert.equal(harness.store.listResumeClaims({ waitId: "wait-parent" }).length, 1);
    });

    it("keeps a pending delivery visible across a process restart", async () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        harness.store.registerWait({
            waitId: "wait-build",
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the build result.",
        });
        harness.closeStore();

        const snapshot = await spawnCommand(harness.path, "snapshot", { waitId: "wait-build" });
        assert.equal(snapshot.code, 0);
        assert.equal(snapshot.payload.phase, "ready");
        assert.deepEqual(snapshot.payload.outbox, [{ state: "pending", evidence: 2 }]);

        expectStoreError(
            () => harness.store.getWait({ waitId: "wait-build" }),
            "closed",
        );
    });
});
