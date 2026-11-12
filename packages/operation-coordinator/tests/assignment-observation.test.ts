import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { cleanupHarnesses, createHarness, parentOwner, registerOperation, workerOwner } from "./support.ts";

afterEach(cleanupHarnesses);
const readers = await Promise.all([
    "../assignment-observation.mjs",
    "../../pi-better-background-tasks/src/shared-operation-coordinator/assignment-observation.mjs",
    "../../pi-better-subagents/shared-operation-coordinator/assignment-observation.mjs",
    "../../pi-better-goal/src/shared-assignment-observation.mjs",
].map(async (path) => (await import(new URL(path, import.meta.url).href)).readAssignmentWaits));
const [readAssignmentWaits] = readers;

test("v4 observers read real assignment waits and terminal outcomes without modifying storage", () => {
    const h = createHarness();
    assert.equal(h.store.schemaVersion, 4);
    registerOperation(h.store);
    h.store.registerAssignment({ assignmentId: "observed-assignment", owner: workerOwner, recipient: parentOwner });
    const wait = h.store.registerWait({ owner: workerOwner, dependencies: [{ operationId: "op-build-1" }],
        origin: { assignmentRef: "observed-assignment" }, continuationNote: "Interpret exact evidence" }).wait;
    const owner = { sessionId: workerOwner.sessionId, workspace: workerOwner.workspace, assignmentId: "observed-assignment" };
    assert.equal(readAssignmentWaits(h.path, owner).waits[0].phase, wait.phase);
    const terminal = h.store.recordAssignmentOutcome({ assignmentId: owner.assignmentId, owner: workerOwner, recipient: parentOwner,
        revision: 1, outcome: "failed", reason: "Retained failure", processUncertain: true,
        evidence: [{ kind: "summary", ref: "retained-evidence" }],
        waits: [{ waitId: wait.waitId, generation: wait.generation, cancelEpoch: wait.cancelEpoch }] });
    h.closeStore();
    const before = readFileSync(h.path);
    for (const read of readers) {
        const observed = read(h.path, owner);
        assert.equal(observed.verified, true);
        assert.deepEqual(observed.outcome, terminal);
        assert.equal(observed.waits[0].waitId, wait.waitId);
        assert.equal(observed.waits[0].phase, "held");
        assert.equal(observed.waits[0].acknowledgement, null);
        assert.equal(read(h.path, { ...owner, sessionId: "foreign-worker" }).verified, false);
    }
    assert.deepEqual(readFileSync(h.path), before, "observers must not migrate or write v4 storage");
});

test("observers refuse unknown schema versions without migration or evidence disclosure", () => {
    const h = createHarness();
    h.closeStore();
    for (const version of ["5", "999", "0", "4.0", "invalid"]) {
        const db = new DatabaseSync(h.path);
        try { db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(version); }
        finally { db.close(); }
        const before = readFileSync(h.path);
        for (const read of readers) {
            const observed = read(h.path, { ...workerOwner, assignmentId: "unknown" });
            assert.equal(observed.verified, false);
            assert.deepEqual(observed.waits, []);
            assert.equal(observed.outcome, undefined);
            assert.match(observed.reason, /Unsupported coordinator schema/);
        }
        assert.deepEqual(readFileSync(h.path), before, "unsupported storage must remain untouched");
    }
});

test("v4 missing required fields remains unverified and missing storage is never created", () => {
    const h = createHarness();
    h.closeStore();
    const db = new DatabaseSync(h.path);
    try { db.exec("DROP TABLE waits"); } finally { db.close(); }
    const before = readFileSync(h.path);
    for (const read of readers) {
        assert.equal(read(h.path, workerOwner).verified, false);
        assert.equal(read(`${h.path}.missing`, workerOwner).verified, false);
    }
    assert.deepEqual(readFileSync(h.path), before);
    assert.equal(existsSync(`${h.path}.missing`), false);
});
