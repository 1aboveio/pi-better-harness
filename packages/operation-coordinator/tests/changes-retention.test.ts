/**
 * Durable change hints and conservation-aware retention.
 *
 * These tests use a real SQLite file, reopen it, and exercise an actual
 * filesystem/DB interruption boundary. Retention never invents a task path; the
 * store only reserves/tombstones, while the background retention test removes a
 * validated artifact.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { openStore } from "../index.ts";
import {
    cleanupHarnesses,
    createHarness,
    expectStoreError,
    otherWorkerOwner,
    registerOperation,
    settleOperation,
    workerOwner,
} from "./support.ts";

afterEach(cleanupHarnesses);

const DAY = 24 * 60 * 60 * 1000;

describe("owner-scoped coordinator change hints", () => {
    it("writes one terminal hint in the terminal transaction and scopes reads by owner", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        const before = harness.store.latestChangeSeq();
        settleOperation(harness.store, "op-build-1");
        const changes = harness.store.listChanges({ owner: workerOwner, afterSeq: before });
        assert.equal(changes.length, 1);
        assert.equal(changes[0]?.kind, "terminal");
        assert.equal(changes[0]?.operationId, "op-build-1");
        assert.equal(changes[0]?.taskId, "bg_op-build-1");
        assert.equal(changes[0]?.terminalRevision, 1);
        assert.deepEqual(harness.store.listChanges({ owner: otherWorkerOwner }), []);
        assert.equal(harness.store.latestChangeSeq(), changes[0]!.seq);
    });

    it("keeps hints durable across reopen and appends a wait hint", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        const reopened = harness.reopen();
        const terminal = reopened.listChanges({ owner: workerOwner });
        assert.equal(terminal.at(-1)?.kind, "terminal");
        reopened.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "read the build result",
        });
        const all = reopened.listChanges({ owner: workerOwner });
        assert.equal(all.at(-1)?.kind, "wait-ready");
        assert.equal(all.at(-1)?.operationId, "op-build-1");
    });

    it("bounds the journal by age/count and exposes the retained replay horizon", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "read it",
        });
        const before = harness.store.listChanges({ owner: workerOwner });
        assert.equal(before.length, 2);
        // The helper retains the newest row and removes the older hint; a cursor
        // before `oldestChangeSeq()` must be treated as reset, not replayed.
        const removed = harness.store.pruneChangesBefore(Date.now() + 1, 1);
        assert.equal(removed, 1);
        assert.equal(harness.store.oldestChangeSeq(), before[1]!.seq);
        assert.deepEqual(
            harness.store.listChanges({ owner: workerOwner, afterSeq: 0 }).map((change) => change.seq),
            [before[1]!.seq],
        );
    });

    it("prunes only a contiguous prefix so clock rollback never creates hidden holes", () => {
        const harness = createHarness();
        for (const index of [1, 2, 3]) {
            registerOperation(harness.store, {
                operationId: `op-order-${index}`,
                taskId: `bg_order_${index}`,
                launchToken: `launch_order_${index}`,
            });
            settleOperation(harness.store, `op-order-${index}`);
        }
        assert.deepEqual(
            harness.store.listChanges({ owner: workerOwner }).map((change) => change.seq),
            [1, 2, 3],
        );
        const db = new DatabaseSync(harness.path);
        // Newest sequence row has the oldest timestamp: pruning by time alone
        // would leave [1,3], hiding the removal of seq 2 from a cursor at 1.
        db.prepare("UPDATE coordinator_changes SET at = 200 WHERE seq = 1").run();
        db.prepare("UPDATE coordinator_changes SET at = 0 WHERE seq = 2").run();
        db.prepare("UPDATE coordinator_changes SET at = 0 WHERE seq = 3").run();
        db.close();
        assert.equal(harness.store.pruneChangesBefore(100, 1), 0);
        assert.deepEqual(
            harness.store.listChanges({ owner: workerOwner }).map((change) => change.seq),
            [1, 2, 3],
        );
        assert.equal(harness.store.oldestChangeSeq(), 1);

        const db2 = new DatabaseSync(harness.path);
        db2.prepare("UPDATE coordinator_changes SET at = 0 WHERE seq = 1").run();
        db2.prepare("UPDATE coordinator_changes SET at = 200 WHERE seq = 2").run();
        db2.prepare("UPDATE coordinator_changes SET at = 0 WHERE seq = 3").run();
        db2.close();
        // seq 1 may go, but seq 2 is a barrier and seq 3 must not become a hole.
        assert.equal(harness.store.pruneChangesBefore(100, 1), 1);
        assert.deepEqual(
            harness.store.listChanges({ owner: workerOwner }).map((change) => change.seq),
            [2, 3],
        );
        assert.equal(harness.store.oldestChangeSeq(), 2);
    });
});

describe("retention preview and reservation", () => {
    it("protects running, recent, pending delivery and unconsumed waits before becoming eligible", () => {
        const harness = createHarness();
        registerOperation(harness.store, { operationId: "op-running" });
        registerOperation(harness.store, { operationId: "op-recent" });
        settleOperation(harness.store, "op-recent");
        registerOperation(harness.store, { operationId: "op-waiting" });
        harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-waiting" }],
            continuationNote: "interpret the result",
        });
        settleOperation(harness.store, "op-waiting");
        const now = Date.now();
        const cutoff = now - DAY;
        // Make the wait old enough to be an age candidate.
        const db = new DatabaseSync(harness.path);
        db.prepare("UPDATE operations SET terminal_at = ? WHERE operation_id IN ('op-waiting','op-recent')")
            .run(now - 2 * DAY);
        db.close();

        const preview = harness.store.previewRetention({ cutoff, limit: 10 });
        const running = preview.protected.find((entry) => entry.operationId === "op-running");
        assert.ok(running?.reasons.includes("nonterminal"));
        const recent = preview.protected.find((entry) => entry.operationId === "op-recent");
        // op-recent was adjusted old above; it is eligible, proving age alone is not a protection.
        assert.equal(recent, undefined);
        const waiting = preview.protected.find((entry) => entry.operationId === "op-waiting");
        assert.ok(waiting?.reasons.includes("unconsumed-wait"));
        assert.ok(waiting?.reasons.includes("pending-outbox"));
        assert.ok(waiting?.reasons.includes("evidence-pin"));
        assert.equal(preview.candidates.some((entry) => entry.operationId === "op-running"), false);
    });

    it("rechecks protections in the reservation transaction and blocks new references", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        const cutoff = Date.now() + 1;
        const preview = harness.store.previewRetention({ cutoff, limit: 1 });
        assert.equal(preview.candidates.length, 1);
        const reserved = harness.store.reserveRetention({
            operationId: "op-build-1",
            cutoff,
            token: "retention_test_1",
        });
        assert.equal(reserved.state, "reserved");
        assert.equal(harness.store.retentionUnit("op-build-1")?.token, "retention_test_1");

        expectStoreError(() => harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "must not attach after reservation",
        }), "retention-protected");

        // The database trigger is the backstop for an older client that does not
        // call the newer registerWait check.
        const db = new DatabaseSync(harness.path);
        assert.throws(() => db.prepare(
            `INSERT INTO wait_dependencies (
                wait_id, generation, ordinal, operation_id, link, terminal_revision, terminal_outcome, settled_at
             ) VALUES ('wait_old_client', 1, 0, 'op-build-1', 'owner', 1, 'succeeded', ?)`,
        ).run(Date.now()), /retention-reserved/);
        db.close();
    });

    it("reserves, tombstones and finalizes an eligible terminal operation", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        const cutoff = Date.now() + 1;
        const unit = harness.store.reserveRetention({
            operationId: "op-build-1",
            cutoff,
            token: "retention_finalize",
            artifactRef: "/tmp/disposable-fixture",
        });
        harness.store.markRetentionDeletionStarted(unit.operationId, unit.token);
        harness.store.markRetentionFilesRemoved(unit.operationId, unit.token, "fixture removed");
        const complete = harness.store.finalizeRetention(unit.operationId, unit.token);
        assert.equal(complete.state, "complete");
        assert.equal(harness.store.getOperation("op-build-1"), null);
        assert.equal(harness.store.listOperationEvidence("op-build-1").length, 0);
        assert.equal(harness.store.retentionUnit("op-build-1")?.state, "complete");
        assert.equal(harness.store.listChanges({ owner: workerOwner }).length, 0);
    });

    it("resumes a files-deleted interruption after reopening the store", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        const token = "retention_interrupted";
        const unit = harness.store.reserveRetention({
            operationId: "op-build-1",
            cutoff: Date.now() + 1,
            token,
        });
        harness.store.markRetentionDeletionStarted(unit.operationId, unit.token);
        harness.store.markRetentionFilesRemoved(unit.operationId, unit.token);
        harness.closeStore();

        const reopened = harness.reopen();
        const pending = reopened.listRetentionUnits({ state: "files-removed" });
        assert.equal(pending.length, 1);
        const complete = reopened.finalizeRetention(pending[0]!.operationId, pending[0]!.token);
        assert.equal(complete.state, "complete");
        assert.equal(reopened.getOperation("op-build-1"), null);
    });

    it("adds new tables to a version-1 database without rewriting old records", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        harness.closeStore();
        const db = new DatabaseSync(harness.path);
        db.exec("DROP TRIGGER IF EXISTS retention_blocks_wait_dependency");
        db.exec("DROP TRIGGER IF EXISTS retention_blocks_evidence_pin");
        db.exec("DROP TRIGGER IF EXISTS retention_blocks_outbox");
        db.exec("DROP TRIGGER IF EXISTS retention_blocks_resume_claim");
        db.exec("DROP INDEX IF EXISTS coordinator_changes_owner");
        db.exec("DROP INDEX IF EXISTS retention_units_state");
        db.exec("DROP TABLE coordinator_changes");
        db.exec("DROP TABLE retention_units");
        db.close();

        const reopened = harness.reopen();
        assert.equal(reopened.getOperation("op-build-1")?.terminalRevision, 1);
        assert.equal(reopened.latestChangeSeq(), 0);
        assert.deepEqual(reopened.listRetentionUnits(), []);
        assert.equal(reopened.previewRetention({ cutoff: Date.now() + 1, limit: 1 }).candidates.length, 1);
    });

    it("adds the launch-token tombstone column to an existing retention table", () => {
        const harness = createHarness();
        harness.closeStore();
        const db = new DatabaseSync(harness.path);
        db.exec("DROP TRIGGER IF EXISTS retention_blocks_tombstoned_operation");
        db.exec("ALTER TABLE retention_units DROP COLUMN launch_token");
        db.close();
        const reopened = harness.reopen();
        const db2 = new DatabaseSync(harness.path);
        const columns = db2.prepare("PRAGMA table_info(retention_units)").all() as Array<{ name: string }>;
        assert.ok(columns.some((column) => column.name === "launch_token"));
        const trigger = db2.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'retention_blocks_tombstoned_operation'",
        ).get();
        assert.equal(trigger?.name, "retention_blocks_tombstoned_operation");
        db2.close();
        reopened.close();
    });

    it("crosses the deletion fence before files and refuses to release it afterwards", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        const unit = harness.store.reserveRetention({
            operationId: "op-build-1",
            cutoff: Date.now() + 1,
            token: "retention_release",
        });
        expectStoreError(
            () => harness.store.markRetentionFilesRemoved(unit.operationId, unit.token),
            "retention-protected",
        );
        const deleting = harness.store.markRetentionDeletionStarted(unit.operationId, unit.token);
        assert.equal(deleting.state, "deleting");
        harness.store.markRetentionFilesRemoved(unit.operationId, unit.token);
        expectStoreError(
            () => harness.store.releaseRetention(unit.operationId, unit.token, "too late"),
            "retention-protected",
        );
        assert.equal(harness.store.getOperation("op-build-1")?.terminalRevision, 1);
    });

    it("never resurrects a completed tombstoned launch identity", () => {
        const harness = createHarness();
        const input = {
            operationId: "op-build-1",
            taskId: "bg_op-build-1",
            launchToken: "launch_op-build-1",
            owner: workerOwner,
            observer: { kind: "background-tasks", version: "1.0.0" },
        };
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        const unit = harness.store.reserveRetention({
            operationId: "op-build-1",
            cutoff: Date.now() + 1,
            token: "retention_tombstone",
        });
        // Historical idempotency survives until cleanup completes.
        assert.equal(harness.store.registerOperation(input).created, false);
        harness.store.markRetentionDeletionStarted(unit.operationId, unit.token);
        harness.store.markRetentionFilesRemoved(unit.operationId, unit.token);
        harness.store.finalizeRetention(unit.operationId, unit.token);

        expectStoreError(() => harness.store.registerOperation(input), "retention-protected");
        expectStoreError(() => harness.store.registerOperation({
            ...input,
            operationId: "op-new-id",
        }), "retention-protected");
        expectStoreError(() => harness.store.registerOperation({
            ...input,
            operationId: "op-new-id-2",
            taskId: "bg-new-id-2",
        }), "retention-protected");

        // An older v1 client bypassing the API is stopped by the database trigger.
        const db = new DatabaseSync(harness.path);
        assert.throws(() => db.prepare(
            `INSERT INTO operations (
                operation_id, task_id, launch_token,
                owner_kind, owner_session_id, owner_workspace, owner_branch_id, owner_goal_id,
                observer_kind, observer_version, phase, health, terminal_revision, created_at, updated_at
             ) VALUES (?, ?, ?, 'worker-conversation', ?, ?, 'main', NULL,
                'background-tasks', '1.0.0', 'running', 'active', 0, ?, ?)`,
        ).run(
            input.operationId,
            input.taskId,
            input.launchToken,
            workerOwner.sessionId,
            workerOwner.workspace,
            Date.now(),
            Date.now(),
        ), /retention-tombstoned/);
        db.close();
    });

    it("holds a partial deletion as deletion-unknown without reopening references", () => {
        const harness = createHarness();
        registerOperation(harness.store);
        settleOperation(harness.store, "op-build-1");
        const unit = harness.store.reserveRetention({
            operationId: "op-build-1",
            cutoff: Date.now() + 1,
            token: "retention_unknown",
            artifactRef: "/tmp/disposable-fixture",
        });
        harness.store.markRetentionDeletionStarted(unit.operationId, unit.token);
        const held = harness.store.markRetentionDeletionUnknown(
            unit.operationId,
            unit.token,
            "rmSync failed after touching the artifact",
        );
        assert.equal(held.state, "deletion-unknown");
        expectStoreError(
            () => harness.store.releaseRetention(unit.operationId, unit.token, "must not reopen"),
            "retention-protected",
        );
        expectStoreError(() => harness.store.registerWait({
            owner: workerOwner,
            dependencies: [{ operationId: "op-build-1" }],
            continuationNote: "must not reference uncertain evidence",
        }), "retention-protected");
        assert.equal(harness.store.getOperation("op-build-1")?.terminalRevision, 1);
    });
});
