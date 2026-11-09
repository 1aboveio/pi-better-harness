import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { openStore, SCHEMA_VERSION } from "../index.ts";
import {
    cleanupHarnesses,
    createHarness,
    expectStoreError,
    observer,
    otherWorkerOwner,
    parentOwner,
    registerOperation,
    settleOperation,
    workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

describe("operation registration", () => {
    it("persists the launch identity and reads it back after reopen", () => {
        const harness = createHarness();
        const { operation } = registerOperation(harness.store);

        harness.reopen();

        const reread = harness.store.getOperation(operation.operationId);
        assert.ok(reread, "operation should survive reopen");
        assert.deepEqual(reread.owner, workerOwner);
        assert.equal(reread.taskId, "bg_op-build-1");
        assert.equal(reread.launchToken, "launch_op-build-1");
        assert.equal(reread.phase, "running");
        assert.equal(reread.health, "active");
        assert.equal(reread.terminalRevision, 0);
        assert.deepEqual(reread.observer, observer);
        assert.deepEqual(reread.supervision, { hostId: "host-1", runnerId: "runner-1", processStartToken: null });
        assert.equal(reread.authorityRef, "permission-revision:7");
    });

    it("replays the same launch idempotently without rewriting it", () => {
        const harness = createHarness();
        const first = registerOperation(harness.store);
        const second = registerOperation(harness.store);

        assert.equal(first.created, true);
        assert.equal(second.created, false);
        assert.equal(harness.store.listOperations().length, 1);
    });

    it("refuses a changed launch token for an existing operation id", () => {
        const harness = createHarness();
        registerOperation(harness.store);

        const refusal = expectStoreError(
            () => registerOperation(harness.store, { launchToken: "launch_different" }),
            "operation-conflict",
            /launchToken/,
        );
        assert.match(refusal.message, /immutable/);
        assert.equal(harness.store.getOperation("op-build-1")?.launchToken, "launch_op-build-1");
    });

    it("refuses a second operation bound to the same background task", () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-build-1", taskId: "bg_shared" });

        expectStoreError(
            () => registerOperation(harness.store, { operationId: "op-build-2", taskId: "bg_shared" }),
            "operation-conflict",
            /bg_shared/,
        );
        assert.equal(harness.store.listOperations().length, 1);
    });

    it("refuses a task id claimed by a different owner", () => {
        const harness = createHarness();
        registerOperation(harness.store, { owner: workerOwner, taskId: "bg_owned" });

        expectStoreError(
            () => registerOperation(harness.store, { operationId: "op-foreign", owner: otherWorkerOwner, taskId: "bg_owned" }),
            "task-ownership",
            /another execution owner/,
        );
    });

    it("keeps supervision replaceable but ownership immutable", () => {
        const harness = createHarness();
        registerOperation(harness.store);

        const updated = harness.store.recordSupervision({
            operationId: "op-build-1",
            owner: workerOwner,
            supervision: { hostId: "host-2" },
            health: "unmonitored",
            reason: "host stopped watching; replacement pending",
        });
        assert.deepEqual(updated.supervision, { hostId: "host-2", runnerId: null, processStartToken: null });
        assert.equal(updated.health, "unmonitored");
        assert.equal(updated.healthReason, "host stopped watching; replacement pending");
        assert.deepEqual(updated.owner, workerOwner);

        expectStoreError(
            () => harness.store.recordSupervision({ operationId: "op-build-1", owner: otherWorkerOwner, health: "active" }),
            "foreign-owner",
        );
    });
});

describe("terminal outcomes", () => {
    it("records one terminal revision and enqueues delivery for an existing wait", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the build result and continue packaging.",
        });

        const result = settleOperation(harness.store, "op-build-1");

        assert.equal(result.recorded, true);
        assert.equal(result.operation.phase, "terminal");
        assert.equal(result.operation.terminalRevision, 1);
        assert.equal(result.operation.terminalOutcome, "succeeded");
        assert.equal(result.ready.length, 1);
        assert.equal(result.ready[0].phase, "ready");
        assert.equal(result.outbox.length, 1);
        assert.equal(result.outbox[0].state, "pending");
        assert.equal(result.outbox[0].terminalRevision, 1);
        assert.deepEqual(result.outbox[0].recipient, workerOwner);
        assert.deepEqual(
            result.outbox[0].evidence.map((pin) => pin.ref).sort(),
            ["/logs/op-build-1/build.log", "/logs/op-build-1/terminal.json"],
        );
    });

    it("is idempotent for a replayed terminal event id", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Read the build result.",
        });
        const first = settleOperation(harness.store, "op-build-1");

        const replay = settleOperation(harness.store, "op-build-1");

        assert.equal(replay.recorded, false);
        assert.equal(replay.operation.terminalRevision, 1);
        assert.deepEqual(
            replay.outbox.map((event) => event.eventId),
            first.outbox.map((event) => event.eventId),
        );
        assert.equal(harness.store.listOutbox().length, 1);
        assert.equal(harness.store.listOperationEvidence("op-build-1").length, 2);
    });

    it("refuses a different terminal event for the same operation", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1", "succeeded", workerOwner, "event-first");

        expectStoreError(
            () => settleOperation(harness.store, "op-build-1", "failed", workerOwner, "event-second"),
            "terminal-conflict",
            /event-first/,
        );
        assert.equal(harness.store.getOperation("op-build-1")?.terminalOutcome, "succeeded");
    });

    it("refuses a terminal outcome for an operation that was never registered", () => {
        const harness = createHarness();
        expectStoreError(
            () => settleOperation(harness.store, "op-missing", "succeeded", workerOwner, "event-missing"),
            "unknown-operation",
            /Register the launch/,
        );
    });

    it("refuses a terminal outcome from a foreign owner", () => {
        const harness = createHarness();
        registerOperation(harness.store);

        expectStoreError(
            () => settleOperation(harness.store, "op-build-1", "succeeded", otherWorkerOwner),
            "foreign-owner",
            /registered owner/,
        );
        assert.equal(harness.store.getOperation("op-build-1")?.phase, "running");
    });

    it("refuses a terminal outcome with neither evidence nor a reason", () => {
        const harness = createHarness();
        registerOperation(harness.store);

        expectStoreError(
            () => harness.store.recordTerminalOutcome({
                operationId: "op-build-1",
                eventId: "event-bare",
                outcome: "failed",
                owner: workerOwner,
            }),
            "validation",
            /must record why/,
        );
    });

    it("records a lost operation without inventing terminal evidence", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "Decide what to do about the lost runner.",
        });

        const result = settleOperation(harness.store, "op-build-1", "lost");

        assert.equal(result.operation.terminalOutcome, "lost");
        assert.equal(result.operation.terminalDetailLost, true);
        assert.equal(result.ready[0].dependencies[0].terminalOutcome, "lost");
        assert.deepEqual(result.ready[0].dependencies[0].terminalRevision, 1);
        assert.equal(result.outbox.length, 1, "a lost outcome still resolves the dependency");
    });

    it("persists the terminal reason for a lost outcome across reopen", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const reason = "runner disappeared before the terminal record was written";

        const result = harness.store.recordTerminalOutcome({
            operationId: "op-build-1",
            eventId: "event-lost",
            outcome: "lost",
            owner: workerOwner,
            reason,
        });
        assert.equal(result.operation.terminalReason, reason);

        harness.reopen();

        const reread = harness.store.getOperation("op-build-1");
        assert.equal(reread?.terminalOutcome, "lost");
        assert.equal(reread?.terminalReason, reason, "the explanation survives replay in a new process");
        assert.equal(reread?.terminalDetailLost, true);
    });
});

describe("store guards", () => {
    it("refuses credential material in notes and references", () => {
        const harness = createHarness();
        registerOperation(harness.store);

        expectStoreError(
            () => harness.store.registerWait({
                owner: workerOwner,
                dependencies: [{ operationId: "op-build-1" }],
                continuationNote: "Retry with AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG",
            }),
            "validation",
            /environment assignment/,
        );
        expectStoreError(
            () => harness.store.registerWait({
                owner: workerOwner,
                dependencies: [{ operationId: "op-build-1" }],
                continuationNote: "Reuse the cached credential from Authorization: Bearer abcdefghijklmnop",
            }),
            "validation",
            /bearer token/,
        );
        expectStoreError(
            () => harness.store.registerOperation({
                operationId: "op-key",
                taskId: "bg_key",
                launchToken: "launch_key",
                owner: workerOwner,
                observer,
                authorityRef: "sk-proj-abcdefghijklmnopqrstuvwx",
            }),
            "validation",
            /provider api key/,
        );
        assert.equal(harness.store.listWaits().length, 0);
    });

    it("allows ordinary status evidence that only looks like an assignment", () => {
        const harness = createHarness();
        registerOperation(harness.store);

        const registered = harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "HTTP_STATUS=500 after AUTH: rejected by upstream; inspect the retained log.",
        });
        assert.equal(registered.wait.phase, "waiting");
    });

    it("refuses a newer schema version and leaves its records in place", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        harness.closeStore();

        const raw = new DatabaseSync(harness.path);
        raw.exec("UPDATE schema_meta SET value = '99' WHERE key = 'schema_version'");
        raw.close();

        expectStoreError(() => openStore({ path: harness.path }), "schema-version", /version 99/);

        const inspect = new DatabaseSync(harness.path);
        const row = inspect.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
            | { value: string }
            | undefined;
        const operations = inspect.prepare("SELECT count(*) AS count FROM operations").get() as { count: number };
        inspect.close();
        assert.equal(row?.value, "99", "the refused schema version is not rewritten");
        assert.equal(operations.count, 1, "records are not deleted by a schema refusal");
    });

    it("refuses an unversioned database it did not create", () => {
        const harness = createHarness();
        const foreignPath = join(dirname(harness.path), "foreign.sqlite");
        const raw = new DatabaseSync(foreignPath);
        raw.exec("CREATE TABLE someone_else (id INTEGER PRIMARY KEY)");
        raw.close();

        expectStoreError(
            () => openStore({ path: foreignPath }),
            "schema-version",
            /was not written by the operation coordinator/,
        );
    });

    it(`writes schema version ${SCHEMA_VERSION} on a fresh database`, () => {
        const harness = createHarness();
        assert.equal(harness.store.schemaVersion, SCHEMA_VERSION);
        harness.reopen();
        assert.equal(harness.store.schemaVersion, SCHEMA_VERSION);
    });

    it("refuses calls after close", () => {
        const harness = createHarness();
        harness.closeStore();
        expectStoreError(() => harness.store.getOperation("op-build-1"), "closed");
    });

    it("keeps separate store paths isolated", () => {
        const first = createHarness();
        const second = createHarness();
        registerOperation(first.store, { operationId: "op-a" });
        registerOperation(second.store, { operationId: "op-b" });

        assert.equal(first.store.listOperations().length, 1);
        assert.equal(first.store.getOperation("op-b"), null);
        assert.equal(second.store.listOperations().length, 1);
    });

    it("scopes operations by owner", () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-parent", owner: parentOwner, taskId: "bg_parent" });
        registerOperation(harness.store, { operationId: "op-worker", owner: workerOwner, taskId: "bg_worker" });

        const parentOperations = harness.store.listOperations({ owner: parentOwner });
        assert.deepEqual(parentOperations.map((operation) => operation.operationId), ["op-parent"]);
        assert.equal(harness.store.listOperations({ phase: "terminal" }).length, 0);
    });
});
