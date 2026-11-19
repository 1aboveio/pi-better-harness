import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanupHarnesses, createHarness, registerOperation, removeAssignmentOperationBinding, workerOwner } from "./support.ts";
import { openStore } from "../index.ts";
import { DatabaseSync } from "node:sqlite";

afterEach(cleanupHarnesses);
const transfer = (operationId: string) => ({ operationId, expectedHostId: "host-1", directory: "/supervisor", hostId: "server:epoch-1", epoch: "epoch-1" });

test("result supervision follows exact shared changes and detects a retained-feed gap", () => {
    const { store, path } = createHarness();
    const baseline = store.resultSupervisionChanges();
    assert.equal(baseline.reset, true);
    store.registerOperation({ operationId: "op-build-1", taskId: "task", launchToken: "token", owner: workerOwner,
        observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "host-1" } });
    store.handoffResultSupervision(transfer("op-build-1"));
    const changed = store.resultSupervisionChanges(baseline);
    assert.equal(changed.reset, false);
    assert.deepEqual(changed.operationIds, ["op-build-1"]);
    assert.deepEqual(store.resultSupervisionChanges(changed).operationIds, []);
    const peer = new DatabaseSync(path);
    try {
        // The normal retention trigger drops earlier feed positions. The
        // consumer must recover authority instead of trusting a stale cursor.
        const insert = peer.prepare("INSERT INTO assignment_changes(entity,entity_id,session_id,workspace) VALUES('binding','unrelated','s','/w')");
        peer.exec("BEGIN");
        for (let i = 0; i < 4200; i++) insert.run();
        peer.exec("COMMIT");
    } finally { peer.close(); }
    assert.equal(store.resultSupervisionChanges(changed).reset, true);
    assert.equal(store.resultSupervisions(true)[0]?.operationId, "op-build-1");
});

test("unrelated assignment traffic yields bounded pages without runner work", () => {
    const { store, path } = createHarness();
    const baseline = store.resultSupervisionChanges();
    const peer = new DatabaseSync(path);
    try {
        const insert = peer.prepare("INSERT INTO assignment_changes(entity,entity_id,session_id,workspace) VALUES('binding','unrelated','s','/w')");
        for (let i = 0; i < 129; i++) insert.run();
    } finally { peer.close(); }
    const first = store.resultSupervisionChanges(baseline);
    assert.equal(first.more, true);
    assert.equal(first.seq - baseline.seq, 128);
    assert.deepEqual(first.operationIds, []);
    const second = store.resultSupervisionChanges(first);
    assert.equal(second.more, false);
    assert.equal(second.seq - first.seq, 1);
    assert.deepEqual(second.operationIds, []);
});

test("the first open of a v3 database installs the result admission fence", () => {
    const harness = createHarness();
    registerOperation(harness.store);
    harness.closeStore();
    const old = new DatabaseSync(harness.path);
    removeAssignmentOperationBinding(old);
    old.exec("DROP TRIGGER result_scope_admission_v1; DROP TABLE assignment_repairs; UPDATE schema_meta SET value = '3' WHERE key = 'schema_version'");
    old.close();
    const migrated = openStore({ path: harness.path });
    try {
        migrated.handoffResultScope({ scope: "scope-760", expectedDiscovery: null, grants: [transfer("op-build-1")] });
        assert.throws(() => migrated.registerOperation({ operationId: "legacy", taskId: "legacy-task", launchToken: "legacy-token",
            owner: workerOwner, observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "old-client" } }),
        /legacy launch into managed result scope/);
    } finally { migrated.close(); }
});

test("scope transfer atomically refuses a legacy registration after the admission snapshot", () => {
    const harness = createHarness();
    const peer = openStore({ path: harness.path });
    try {
        registerOperation(harness.store);
        assert.equal(harness.store.listOperations({ phase: "running" }).length, 1);
        peer.registerOperation({ operationId: "legacy-race", taskId: "legacy-task", launchToken: "legacy-token",
            owner: workerOwner, observer: { kind: "local-supervisor", version: "1" },
            supervision: { hostId: "dead-host", resultScope: "scope-760" } });
        assert.throws(() => harness.store.handoffResultScope({ scope: "scope-760", expectedDiscovery: null,
            grants: [transfer("op-build-1")] }), /untransferred legacy operation/);
        assert.equal(harness.store.resultScopeManaged("scope-760"), false);
        assert.equal(harness.store.resultSupervision("op-build-1"), null, "partial grants roll back with the fence");
        assert.equal(harness.store.getOperation("op-build-1")?.supervision?.hostId, "host-1");
    } finally { peer.close(); harness.closeStore(); }
});

test("database admission fence rejects old writers after scope transfer but preserves other known scopes", () => {
    const harness = createHarness();
    const peer = openStore({ path: harness.path });
    try {
        registerOperation(harness.store);
        harness.store.handoffResultScope({ scope: "scope-760", expectedDiscovery: null, grants: [transfer("op-build-1")] });
        const legacy = (id: string, resultScope?: string, resultAdapter?: 1) => peer.registerOperation({
            operationId: id, taskId: `task-${id}`, launchToken: `token-${id}`, owner: workerOwner,
            observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "legacy-host", resultScope, resultAdapter },
        });
        assert.throws(() => legacy("unknown"), /legacy launch into managed result scope/);
        assert.throws(() => legacy("same", "scope-760"), /legacy launch into managed result scope/);
        assert.equal(legacy("other", "another-scope").created, true);
        assert.equal(legacy("compatible", "scope-760", 1).created, true, "compatible hosts grant before runner start");
        assert.equal(harness.store.getOperation("unknown"), null);
        assert.equal(harness.store.getOperation("same"), null);
    } finally { peer.close(); harness.closeStore(); }
});

test("a failed dependency handoff rolls back every owner change and grant", () => {
    const { store } = createHarness();
    registerOperation(store);
    registerOperation(store, { operationId: "other" });
    assert.throws(() => store.handoffResultSupervisions([transfer("op-build-1"), { ...transfer("other"), expectedHostId: "foreign" }]), /exact supervision owner changed/);
    assert.equal(store.resultSupervision("op-build-1"), null);
    assert.equal(store.getOperation("op-build-1")?.supervision?.hostId, "host-1");
    assert.equal(store.getOperation("other")?.supervision?.hostId, "host-1");
    const grants = store.handoffResultSupervisions([transfer("op-build-1"), transfer("other")]);
    assert.equal(grants.length, 2);
    assert.deepEqual(store.handoffResultSupervisions([transfer("op-build-1"), transfer("other")]), grants);
});

test("restart preserves captured execution authority and fences the preceding epoch", () => {
    const harness = createHarness();
    registerOperation(harness.store);
    const grant = harness.store.handoffResultSupervision(transfer("op-build-1"));
    harness.reopen();
    const store = harness.store;
    assert.deepEqual(store.resultSupervision(grant.operationId), grant);
    assert.throws(() => store.recoverResultSupervision({ ...grant, authorityRef: "another-frontend" }), /captured authority changed/);
    assert.throws(() => store.recoverResultSupervision({ ...grant, directory: "/another-directory" }), /captured authority changed/);
    assert.throws(() => store.recoverResultSupervision({ ...grant, owner: { ...workerOwner, sessionId: "another-recipient" } }), /captured authority changed/);
    assert.throws(() => store.recoverResultSupervision({ ...grant, launchToken: "replacement-command" }), /captured authority changed/);
    const publication = { operationId: grant.operationId, eventId: "exact-terminal", outcome: "succeeded" as const, owner: workerOwner,
        evidence: [{ kind: "terminal-record" as const, ref: "/supervisor/result.json" }] };
    store.recoverResultSupervision({ ...grant, epoch: "epoch-2", hostId: "server:epoch-2" });
    assert.throws(() => store.publishSupervisedResult({ operationId: grant.operationId, epoch: "epoch-1", publication }), /stale-runtime-epoch/);
    assert.equal(store.getOperation(grant.operationId)?.terminalRevision, 0);
    store.publishSupervisedResult({ operationId: grant.operationId, epoch: "epoch-2", publication });
    store.publishSupervisedResult({ operationId: grant.operationId, epoch: "epoch-2", publication });
    assert.equal(store.getOperation(grant.operationId)?.terminalRevision, 1);
    assert.equal(store.resultSupervisions(true).length, 0, "completed supervision must leave the active reconcile query");
    assert.equal(store.resultSupervisions().length, 1, "history remains durable without being polled");
});

test("scope handoff fences discovery transactionally without stealing a changed owner", () => {
    const { store } = createHarness();
    registerOperation(store);
    const claim = store.tryClaimDiscovery({ scope: "scope-760", hostId: "host-1", token: "discovery-1", expected: null })!;
    assert.deepEqual(store.readDiscoveryState(claim.scope), { managed: false, claim });
    assert.equal(store.listOperations()[0].resultManaged, false);
    assert.throws(() => store.handoffResultScope({ scope: claim.scope, expectedDiscovery: null, grants: [transfer("op-build-1")] }), /discovery owner changed/);
    assert.equal(store.resultScopeManaged(claim.scope), false);
    assert.equal(store.resultSupervision("op-build-1"), null);
    store.handoffResultScope({ scope: claim.scope, expectedDiscovery: claim, grants: [transfer("op-build-1")] });
    assert.equal(store.resultScopeManaged(claim.scope), true);
    assert.deepEqual(store.readDiscoveryState(claim.scope), { managed: true, claim: null });
    assert.equal(store.listOperations()[0].resultManaged, true);
    assert.equal(store.listRunningSupervisedBy("server:epoch-1")[0].resultManaged, true);
    assert.deepEqual(store.listRunningSupervisedBy("host-1"), []);
    assert.equal(store.readDiscoveryClaim(claim.scope), null);
    assert.equal(store.tryClaimDiscovery({ scope: claim.scope, expected: null, hostId: "old-host", token: "discovery-2" }), null);
    assert.equal(store.getOperation("op-build-1")?.supervision?.hostId, "server:epoch-1");
});


test("repeated handoff cannot silently accept a different destination or authority", () => {
    const { store } = createHarness();
    registerOperation(store);
    const input = { ...transfer("op-build-1"), capability: { adapter: "background-results-v1", captured: { allowed: true }, current: { allowed: true } } };
    const grant = store.handoffResultSupervision(input);
    assert.deepEqual(store.handoffResultSupervision(input), grant);
    for (const patch of [{ directory: "/foreign" }, { hostId: "server:other" }, { epoch: "other" },
        { capability: undefined }, { capability: { ...input.capability, current: { allowed: false } } }]) {
        assert.throws(() => store.handoffResultSupervision({ ...input, ...patch }), /supervision-conflict/);
        assert.deepEqual(store.resultSupervision(input.operationId), grant);
        assert.equal(store.getOperation(input.operationId)?.supervision?.hostId, grant.hostId);
    }
});
