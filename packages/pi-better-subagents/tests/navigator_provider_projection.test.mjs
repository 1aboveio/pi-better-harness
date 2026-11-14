// @covers subagent.assignment-projection
// @level integration
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, register, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import "./isolate-registry.mjs";
import { startWorkRuntimeFixture } from "./work-runtime-fixture.mjs";
const stopRuntime = await startWorkRuntimeFixture();
after(stopRuntime);

async function eventually(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail("shared runtime observation did not converge");
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));
process.env.PI_CATALOG_ACCEPTANCE_PROBE = "1";
const { default: extension } = await import("../index.ts");
const { writeMeta, runDir } = await import("../registry.ts");
const { refreshBackgroundWorkNavigator } = await import("../shared-navigator.ts");
const { openStore } = await import("../../operation-coordinator/index.ts");
const sqlite = createRequire(import.meta.url)("node:sqlite");

for (const count of [1, 50]) test(`registered provider observes ${count} attempts once per refresh`, async (t) => {
    const now = Date.now();
    const handlers = new Map();
    const widgets = new Map();
    const ctx = { cwd: process.env.TMPDIR, mode: "tui", hasUI: true, isIdle: () => true,
        sessionManager: { getSessionId: () => `parent-${count}`, getBranch: () => [] },
        ui: { theme: { fg: (_c, s) => s }, notify() {}, setStatus() {},
            setWidget: (key, value) => widgets.set(key, value),
            getEditorComponent() { return this.factory; }, setEditorComponent(f) { this.factory = f; } } };
    extension({ on: (key, fn) => handlers.set(key, fn), registerTool() {}, sendMessage() {} });
    const store = openStore({ path: join(process.env.PI_CODING_AGENT_DIR, "operation-coordinator.sqlite") });
    const metas = Array.from({ length: count }, (_, i) => ({ id: `sa_provider_${count}_${i}`,
        sessionId: `worker-${count}-${i}`, cwd: ctx.cwd, status: "running", pid: process.pid,
        spawnPid: process.pid, startedAt: now - 1000, callback: false,
        callbackOrigin: { cwd: ctx.cwd, sessionId: `parent-${count}` },
        operations: { conversationId: `worker-${count}-${i}`, workspace: ctx.cwd } }));
    const originalRead = fs.readFileSync;
    const OriginalDatabase = sqlite.DatabaseSync;
    let connections = 0;
    let reads = 0;
    const paths = new Set(metas.map(m => join(runDir(m.id), "meta.json")));
    const externalWrite = (meta) => fs.writeFileSync(join(runDir(meta.id), "meta.json"), JSON.stringify(meta));
    const list = () => globalThis[Symbol.for("pi-better-subagents.acceptance-hooks")].listRows();
    function budget(action, label) {
        connections = reads = 0;
        const result = action();
        const observed = { connections, reads };
        t.diagnostic(`${label}: ${JSON.stringify(observed)}`);
        assert.equal(connections, 0, `${label}: no client-side coordinator observations`);
        assert.equal(reads, 0, `${label}: no client-side metadata observations`);
        return result;
    }
    try {
        await handlers.get("session_start")({}, ctx);
        metas.forEach(writeMeta);
        await eventually(() => list().length === count && list().every(row => row.status === "running"));
        sqlite.DatabaseSync = class extends OriginalDatabase {
            constructor(...args) { super(...args); connections++; }
        };
        fs.readFileSync = function(path, ...args) {
            if (paths.has(String(path))) reads++;
            return originalRead.call(this, path, ...args);
        };
        syncBuiltinESMExports();
        assert.equal(budget(list, "direct refresh").length, count);
        assert.equal(budget(list, "separate refresh at same time").length, count);
        budget(() => refreshBackgroundWorkNavigator(ctx), "mounted refresh");
        for (let frame = 0; frame < 60; frame++) budget(list, "unchanged frame");

        // Continuation metadata is read from disk by the assignment projection,
        // independently of this host's registry notifications.
        const continuation = { ...metas[0], id: `${metas[0].id}_resume`, resumedFrom: metas[0].id,
            startedAt: now, status: "failed", operations: { ...metas[0].operations, resumeLaunchToken: "resume" } };
        fs.mkdirSync(runDir(continuation.id), { recursive: true });
        try {
            externalWrite(continuation);
            await eventually(() => list().find(r => r.id === metas[0].id)?.status === "failed");
            assert.equal(list().find(r => r.id === metas[0].id).status, "failed");
            externalWrite({ ...continuation, status: "running" });
            await eventually(() => list().find(r => r.id === metas[0].id)?.status === "running");
            assert.equal(list().find(r => r.id === metas[0].id).status, "running");
        } finally {
            fs.rmSync(runDir(continuation.id), { recursive: true, force: true });
        }

        // An independent coordinator transition must be visible with no clock advance.
        const first = metas[0];
        const owner = { kind: "worker-conversation", sessionId: first.sessionId, workspace: ctx.cwd };
        store.registerOperation({ operationId: `op-${count}`, taskId: `task-${count}`, launchToken: "token", owner,
            observer: { kind: "background-tasks", version: "1" }, supervision: { hostId: "host", runnerId: "runner" }, authorityRef: "scope" });
        store.registerWait({ waitId: `wait-${count}`, owner, dependencies: [{ operationId: `op-${count}` }],
            origin: { attemptId: first.id }, continuationNote: "Interpret evidence." });
        await eventually(() => list().find(r => r.id === first.id)?.status === "waiting");
        assert.equal(budget(list, "external coordinator wait").find(r => r.id === first.id).status, "waiting");
        writeMeta({ ...first, status: "completed", endedAt: Date.now() - 30_000 });
        assert.equal(list().find(r => r.id === first.id).status, "waiting",
            "an old exited attempt with a pending authoritative wait does not expire");
        writeMeta(first);
        store.cancelWait({ waitId: `wait-${count}`, generation: 1, owner, expectedCancelEpoch: 0, reason: "Cancelled externally" });
        await eventually(() => list().find(r => r.id === first.id)?.status === "cancelled");
        assert.equal(budget(list, "external coordinator cancellation").find(r => r.id === first.id).status, "cancelled");

        // Registry transitions retain terminal expiry and origin filtering.
        const terminal = { ...first, status: "failed", endedAt: Date.now(), operations: undefined };
        writeMeta(terminal);
        await eventually(() => list().find(r => r.id === first.id)?.status === "failed");
        assert.equal(list().find(r => r.id === first.id).status, "failed");
        writeMeta({ ...terminal, endedAt: Date.now() - 30_000 });
        await eventually(() => !list().some(r => r.id === first.id));
        assert.ok(!list().some(r => r.id === first.id), "terminal row expires at the retention boundary");
        writeMeta({ ...first, callbackOrigin: { cwd: ctx.cwd, sessionId: "foreign-parent" } });
        await eventually(() => !list().some(r => r.id === first.id));
        assert.ok(!list().some(r => r.id === first.id), "foreign origin is excluded");
        writeMeta(first);
        await eventually(() => list().some(r => r.id === first.id));
        writeMeta({ ...first, callbackOrigin: { cwd: join(ctx.cwd, "foreign"), sessionId: `parent-${count}` } });
        await eventually(() => !list().some(r => r.id === first.id));
        assert.ok(!list().some(r => r.id === first.id), "foreign workspace is excluded");
        writeMeta(first);
        await handlers.get("session_shutdown")({}, ctx);
        connections = 0;
        assert.equal(connections, 0, "disposal cancels periodic provider work");
        await handlers.get("session_start")({}, ctx);
        await eventually(() => list().length === count);
        assert.equal(budget(list, "remounted provider").length, count);
    } finally {
        fs.readFileSync = originalRead;
        sqlite.DatabaseSync = OriginalDatabase;
        syncBuiltinESMExports();
        await handlers.get("session_shutdown")({}, ctx);
        store.close();
        metas.forEach(m => fs.rmSync(runDir(m.id), { recursive: true, force: true }));
    }
});
