import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
// @ts-expect-error Shared JavaScript observation module.
import { AssignmentInbox } from "../assignment-inbox.mjs";
import { cleanupHarnesses, createHarness, workerOwner, parentOwner } from "./support.ts";

afterEach(cleanupHarnesses);

test("two inbox consumers share a handle without sharing positions or attachment ownership", () => {
    const h = createHarness(), source = new DatabaseSync(h.path), derived = new DatabaseSync(":memory:");
    const assignment = new AssignmentInbox(h.path + ".assignments", derived);
    let background = new AssignmentInbox(h.path + ".background", derived, { entityPrefix: "background:" });
    try {
        assert.equal(assignment.db, derived);
        assert.equal(background.db, derived);
        assert.deepEqual(derived.prepare("PRAGMA database_list").all().map(row => row.name), ["main", "assignment_inbox", "background_inbox"]);
        assert.throws(() => new AssignmentInbox(h.path + ".other-background", derived, { entityPrefix: "background:" }), /background_inbox.*(?:use|exist)/i,
            "a duplicate consumer cannot replace an attachment owned by the live inbox");
        derived.exec("CREATE TABLE query_owner(value TEXT); INSERT INTO query_owner VALUES('retained')");
        assignment.acknowledge(assignment.receive(source, "source"), true);
        background.acknowledge(background.receive(source, "source"), true);
        h.store.registerAssignment({ assignmentId: "assignment-only", owner: workerOwner, recipient: parentOwner });
        h.store.registerOperation({ operationId: "background-only", taskId: "background-only", launchToken: "token",
            owner: parentOwner, observer: { kind: "local-supervisor", version: "1" } });
        const a = assignment.receive(source, "source");
        assert.equal(background.metrics.received, 0, "assignment receipt cannot advance the Background cursor");
        derived.exec("CREATE TRIGGER background_inbox.reject_pending BEFORE INSERT ON pending BEGIN SELECT RAISE(ABORT,'injected Background receive failure'); END");
        assert.throws(() => background.receive(source, "source"), /injected Background receive failure/);
        assert.equal(background.metrics.received, 0);
        assert.equal(background.metrics.pending, 0);
        assert.equal(assignment.metrics.pending, 1);
        derived.exec("DROP TRIGGER background_inbox.reject_pending");
        const b = background.receive(source, "source");
        assert.equal(a.size, 1); assert.equal(b.size, 1);
        assert.equal(JSON.parse([...a.keys()][0])[2], "assignment-only");
        assert.equal(JSON.parse([...b.keys()][0])[2], "background-only");
        background.acknowledge(b, false);
        assert.equal(background.metrics.pending, 0);
        assert.equal(assignment.metrics.pending, 1, "Background application cannot acknowledge assignment work");
        background.close();
        assert.ok(derived.prepare("PRAGMA database_list").all().some(row => row.name === "assignment_inbox"));
        background = new AssignmentInbox(h.path + ".background", derived, { entityPrefix: "background:" });
        assert.equal(background.receive(source, "source").size, 0, "Background applied state survives detach and reattach");
        assert.equal(assignment.metrics.pending, 1);
        background.receive(source, "replacement");
        background.acknowledge(b, true);
        assert.equal(background.metrics.pending, 1, "old generations cannot acknowledge the replacement Background baseline");
        assert.equal(assignment.metrics.pending, 1);
    } finally {
        background.close(); assignment.close();
        assert.equal(derived.prepare("SELECT value FROM query_owner").get()!.value, "retained");
        derived.close(); source.close(); h.closeStore();
    }
});
