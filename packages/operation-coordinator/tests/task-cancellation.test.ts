import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { openStore, type TaskCancellationRequest } from "../index.ts";
import { cleanupHarnesses, createHarness, expectStoreError, otherWorkerOwner, registerOperation, settleOperation, workerOwner } from "./support.ts";

afterEach(cleanupHarnesses);

const request: TaskCancellationRequest = {
    owner: workerOwner,
    idempotencyKey: "cancel-build",
    operationId: "op-build-1",
    expectedLaunchToken: "launch_op-build-1",
    expectedTerminalRevision: 0,
    expectedHostId: "host-1",
    reason: "explicit stop",
};

describe("durable task cancellation intent", () => {
    it("recovers the same receipt through another connection after terminal publication", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const original = harness.store.acceptTaskCancellation(request);
        assert.equal(original.state, "accepted");
        assert.equal(original.taskId, "bg_op-build-1");
        assert.equal(original.expectedLaunchToken, "launch_op-build-1");
        settleOperation(harness.store, request.operationId);
        harness.reopen();
        const connection = openStore({ path: harness.path });
        try {
            assert.deepEqual(connection.getTaskCancellation(request), original);
            assert.deepEqual(connection.acceptTaskCancellation(request), original);
            assert.equal(connection.getOperation(request.operationId)?.terminalOutcome, "succeeded");
        } finally { connection.close(); }
    });

    it("refuses changed content for the same owner and key without replacing the receipt", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const original = harness.store.acceptTaskCancellation(request);
        for (const changed of [
            { reason: "different reason" }, { expectedLaunchToken: "another-token" },
            { expectedTerminalRevision: 1 }, { expectedHostId: "replacement-host" },
            { operationId: "another-operation" },
        ]) {
            expectStoreError(() => harness.store.acceptTaskCancellation({ ...request, ...changed }), "request-conflict");
        }
        assert.deepEqual(harness.store.getTaskCancellation(request), original);
    });

    it("does not expose or accept another owner's intent even with the same key", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        harness.store.acceptTaskCancellation(request);
        for (const owner of [otherWorkerOwner, { ...workerOwner, workspace: "/workspace/foreign" }]) {
            assert.equal(harness.store.getTaskCancellation({ ...request, owner }), null);
            expectStoreError(() => harness.store.acceptTaskCancellation({ ...request, owner }), "foreign-owner");
        }
        assert.equal(harness.store.getOperation(request.operationId)?.phase, "running");
    });

    it("leaves no accepted receipt after a stale token, revision, or host refusal", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        for (const changed of [{ expectedLaunchToken: "old-token" }, { expectedTerminalRevision: 1 }]) {
            expectStoreError(() => harness.store.acceptTaskCancellation({ ...request, ...changed }), "operation-conflict");
            assert.equal(harness.store.getTaskCancellation(request), null);
        }
        expectStoreError(() => harness.store.acceptTaskCancellation({ ...request, expectedHostId: "old-host" }), "supervision-conflict");
        assert.equal(harness.store.getTaskCancellation(request), null);
    });

    it("records stop-file publication without inventing a terminal outcome or consuming evidence", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        expectStoreError(() => harness.store.recordTaskStopRequested(request), "request-conflict");
        harness.store.acceptTaskCancellation(request);
        const receipt = harness.store.recordTaskStopRequested(request);
        assert.equal(receipt.state, "stop-requested");
        harness.reopen();
        assert.deepEqual(harness.store.acceptTaskCancellation(request), receipt);
        assert.deepEqual(harness.store.recordTaskStopRequested(request), receipt);
        assert.equal(harness.store.getOperation(request.operationId)?.terminalRevision, 0);
        assert.equal(harness.store.getOperation(request.operationId)?.phase, "running");
    });

    it("rolls back an interrupted journal write and permits the original request", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const db = new DatabaseSync(harness.path);
        try {
            db.exec("CREATE TRIGGER reject_cancel BEFORE INSERT ON task_cancellation_requests BEGIN SELECT RAISE(ABORT, 'injected journal fault'); END");
            assert.throws(() => harness.store.acceptTaskCancellation(request), /injected journal fault/);
            assert.equal(harness.store.getTaskCancellation(request), null);
            assert.equal(harness.store.getOperation(request.operationId)?.phase, "running");
            db.exec("DROP TRIGGER reject_cancel");
            assert.equal(harness.store.acceptTaskCancellation(request).state, "accepted");
        } finally { db.close(); }
    });

    it("recovers the original exact-token intent after the accepting process is killed", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const child = spawnSync(process.execPath, ["--import", "tsx", new URL("./fixtures/cancel-intent-crash.ts", import.meta.url).pathname, harness.path], {
            encoding: "utf8", timeout: 10_000,
        });
        assert.equal(child.error, undefined, child.error?.message);
        assert.equal(child.signal, "SIGKILL", child.stderr);
        harness.reopen();
        const recovered = harness.store.getTaskCancellation(request);
        assert.equal(recovered?.state, "accepted");
        assert.equal(recovered?.expectedLaunchToken, "launch_op-build-1");
        assert.deepEqual(harness.store.acceptTaskCancellation(request), recovered);
        assert.equal(harness.store.getOperation(request.operationId)?.phase, "running");
    });

    it("adds the journal to an existing database without changing operation facts", () => {
        const harness = createHarness();
        const { operation } = registerOperation(harness.store);
        const db = new DatabaseSync(harness.path);
        db.exec("DROP TABLE task_cancellation_requests");
        db.close();
        harness.reopen();
        assert.deepEqual(harness.store.getOperation(operation.operationId), operation);
        assert.equal(harness.store.acceptTaskCancellation(request).state, "accepted");
    });
});
