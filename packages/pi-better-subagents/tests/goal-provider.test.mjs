import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { registerSubagentsGoalProvider } from "../goal-provider.ts";
import { logPathFor, removeMetaArtifacts, writeMeta } from "../registry.ts";

const metas = [];
afterEach(() => {
    for (const meta of metas.splice(0)) removeMetaArtifacts(meta);
});

function seed(id, callbackOrigin, extra = {}) {
    const meta = {
        id, status: "running", pid: process.pid, spawnPid: process.pid,
        cwd: "/child/worktree", callbackOrigin, promptPreview: id,
        startedAt: 0, logPath: logPathFor(id), sessionId: `child-${id}`, ...extra,
    };
    metas.push(meta);
    writeMeta(meta);
    return meta;
}

function provider() {
    const events = createEventBus();
    let current;
    events.on("pi-better-goal:register-provider", (value) => { current = value; });
    registerSubagentsGoalProvider({ events });
    return { events, get current() { return current; } };
}

function context(cwd, id) {
    return { cwd, sessionManager: SessionManager.inMemory(cwd, { id }) };
}

it("scopes by stable callback origin, not child cwd, child session id or just the parent PID", () => {
    const own = seed("sa_goal_own", { cwd: "/project", sessionId: "parent-a" });
    seed("sa_goal_sibling", { cwd: "/project", sessionId: "parent-b" });
    seed("sa_goal_othercwd", { cwd: "/elsewhere", sessionId: "parent-a" });
    seed("sa_goal_unknown", undefined, { cwd: "/project" });
    seed("sa_goal_nosession", { cwd: "/project" });
    seed("sa_goal_otherparent", own.callbackOrigin, { spawnPid: process.pid + 1 });
    const p = provider();
    assert.equal(p.current.scope, "session");
    assert.deepEqual(p.current.getActivity(context("/project", "parent-a")).items.map((item) => item.id), [own.id]);
    p.events.clear();
});

it("retains foreground snapshots without context and cwd-only legacy origins without a session id", () => {
    const legacy = seed("sa_goal_legacy", undefined, { cwd: "/project" });
    const cwdOnly = seed("sa_goal_cwdonly", { cwd: "/project" });
    const identified = seed("sa_goal_identified", { cwd: "/project", sessionId: "known" });
    const elsewhere = seed("sa_goal_elsewhere", { cwd: "/elsewhere" });
    const p = provider();
    assert.deepEqual(new Set(p.current.getActivity().items.map((item) => item.id)), new Set([legacy.id, cwdOnly.id, identified.id, elsewhere.id]));
    for (const ctx of [{ cwd: "/project" }, { cwd: "/project", sessionManager: { getSessionId() { throw new Error("unavailable"); } } }]) {
        assert.deepEqual(new Set(p.current.getActivity(ctx).items.map((item) => item.id)), new Set([legacy.id, cwdOnly.id]));
    }
    p.events.clear();
});

it("publishes metadata settlement and preserves orphaned versus terminal activity after goal-ready registration", () => {
    const own = seed("sa_goal_lifecycle", { cwd: "/project", sessionId: "parent-a" }, { status: "orphaned" });
    const p = provider();
    p.events.emit("pi-better-goal:ready", {});
    const ctx = context("/project", "parent-a");
    let snapshot;
    const unsubscribe = p.current.onActivityChanged(() => { snapshot = p.current.getActivity(ctx); });
    const orphaned = p.current.getActivity(ctx).items[0];
    assert.equal(orphaned.active, true);
    assert.equal(orphaned.unhealthy, true);
    assert.equal(orphaned.terminal, false);
    writeMeta({ ...own, status: "completed", endedAt: 100 });
    assert.equal(snapshot.items[0].active, false);
    assert.equal(snapshot.items[0].terminal, true);
    assert.equal(snapshot.items[0].endedAt, 100);
    unsubscribe();
    p.events.clear();
});
