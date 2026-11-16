import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { renameSync } from "node:fs";
// @ts-expect-error Read-only JavaScript observation module.
import { AssignmentInbox } from "../assignment-inbox.mjs";
// @ts-expect-error Read-only JavaScript observation module.
import { createAssignmentReader } from "../assignment-observation.mjs";
import { cleanupHarnesses, createHarness, workerOwner, parentOwner, registerOperation } from "./support.ts";

afterEach(cleanupHarnesses);

test("wait commits publish exact scopes; rollback publishes nothing, including an old SQL writer", () => {
    const h = createHarness();
    registerOperation(h.store);
    const db = new DatabaseSync(h.path);
    try {
        h.store.registerWait({ waitId: "wait-a", owner: workerOwner, dependencies: [{ operationId: "op-build-1" }], continuationNote: "Continue" });
        const before = db.prepare("SELECT count(*) AS n FROM assignment_changes").get()!.n;
        db.exec("BEGIN; UPDATE waits SET phase_reason='rollback'; ROLLBACK");
        assert.equal(db.prepare("SELECT count(*) AS n FROM assignment_changes").get()!.n, before);
        db.exec("UPDATE waits SET phase_reason='legacy writer'");
        const rows = db.prepare("SELECT * FROM assignment_changes WHERE seq>? ORDER BY seq").all(Number(before));
        assert.equal(rows.length, 2);
        assert.equal(rows[0].session_id, workerOwner.sessionId);
        assert.equal(rows[0].workspace, workerOwner.workspace);
        assert.equal(rows[0].entity, "wait");
    } finally { db.close(); h.closeStore(); }
});

test("received obligations survive reopen; later assignment application cannot skip earlier work", () => {
    const h = createHarness();
    const source = new DatabaseSync(h.path);
    const path = h.path + ".inbox";
    let inbox = new AssignmentInbox(path);
    try {
        inbox.acknowledge(inbox.receive(source, "source"), true);
        for (const assignmentId of ["a", "b"]) h.store.registerAssignment({ assignmentId, owner: workerOwner, recipient: parentOwner });
        const batch = inbox.receive(source, "source");
        assert.equal(batch.size, 2);
        inbox.close(); inbox = new AssignmentInbox(path);
        assert.equal(inbox.receive(source, "source").size, 2);
        const later = [...batch].at(-1)!;
        inbox.acknowledge(new Map([later]), true);
        assert.ok(inbox.metrics.applied < inbox.metrics.received);
        assert.equal(inbox.metrics.pending, 1);
        inbox.acknowledge(batch, true);
        assert.equal(inbox.metrics.applied, inbox.metrics.received);
        inbox.close(); inbox = new AssignmentInbox(path);
        assert.equal(inbox.receive(source, "source").size, 0);
    } finally { inbox.close(); source.close(); h.closeStore(); }
});

test("retention gap and replacement require baseline handoff; unknown schema refuses", () => {
    const h = createHarness();
    const source = new DatabaseSync(h.path);
    const inbox = new AssignmentInbox(":memory:");
    try {
        inbox.acknowledge(inbox.receive(source, "one"), true);
        source.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4200)
            INSERT INTO assignment_changes(entity,session_id,workspace) SELECT 'wait','s','/w' FROM n`);
        assert.equal(source.prepare("SELECT count(*) AS n FROM assignment_changes").get()!.n, 4096);
        const gap = inbox.receive(source, "one");
        assert.ok(gap.has("*"));
        inbox.acknowledge(gap, false);
        assert.equal(inbox.metrics.pending, 1);
        inbox.acknowledge(gap, true);
        assert.equal(inbox.metrics.pending, 0);
        assert.ok(inbox.receive(source, "replacement").has("*"));
        source.exec("UPDATE schema_meta SET value='999' WHERE key='schema_version'");
        assert.throws(() => inbox.receive(source, "replacement"), /Unsupported assignment source schema/);
    } finally { inbox.close(); source.close(); h.closeStore(); }
});

test("reader receives unrelated commits without inventory and retains newer scope revisions", () => {
    const h = createHarness();
    const reader = createAssignmentReader(h.path);
    try {
        reader.acknowledgeChanges(reader.changes(), true);
        registerOperation(h.store);
        assert.equal(reader.changes().size, 0);
        h.store.registerAssignment({ assignmentId: "a", owner: workerOwner, recipient: parentOwner });
        const old = reader.changes();
        h.store.recordAssignmentOutcome({ assignmentId: "a", owner: workerOwner, recipient: parentOwner,
            revision: 1, outcome: "failed", reason: "test", evidence: [], waits: [], processUncertain: false });
        reader.changes();
        assert.equal(reader.changeMetrics.applied, 0, "coalescing preserves the earliest unapplied obligation");
        reader.acknowledgeChanges(old, true);
        assert.equal(reader.changeMetrics.pending, 1);
    } finally { reader.close(); h.closeStore(); }
});

test("failed receive rolls back obligations and cursor together", () => {
    const h = createHarness(), source = new DatabaseSync(h.path);
    const inbox = new AssignmentInbox(":memory:");
    try {
        inbox.acknowledge(inbox.receive(source, "one"), true);
        h.store.registerAssignment({ assignmentId: "a", owner: workerOwner, recipient: parentOwner });
        inbox.db.exec("CREATE TRIGGER reject_pending BEFORE INSERT ON pending BEGIN SELECT RAISE(ABORT, 'injected receive crash'); END");
        assert.throws(() => inbox.receive(source, "one"), /injected receive crash/);
        assert.equal(inbox.metrics.received, 0);
        assert.equal(inbox.metrics.pending, 0);
        inbox.db.exec("DROP TRIGGER reject_pending");
        assert.equal(inbox.receive(source, "one").size, 1);
    } finally { inbox.close(); source.close(); h.closeStore(); }
});

test("actual database file replacement invalidates the received generation", () => {
    const first = createHarness(), replacement = createHarness();
    const reader = createAssignmentReader(first.path);
    try {
        reader.acknowledgeChanges(reader.changes(), true);
        first.closeStore(); replacement.closeStore();
        renameSync(replacement.path, first.path);
        assert.ok(reader.changes().has("*"));
    } finally { reader.close(); first.closeStore(); replacement.closeStore(); }
});
