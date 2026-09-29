import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const { default: extension, subagentsArgumentCompletions } = await import("../index.ts");
const { setConfigForTests } = await import("../config.ts");
const { normalizeDelegationMode, delegationPrompt, DELEGATION_MODE_REQUEST } = await import("../delegation.ts");

function harness() {
    const handlers = new Map();
    const commands = new Map();
    const notifications = [];
    const entries = [];
    const events = new EventEmitter();
    extension({
        events,
        appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
        registerTool() {},
        registerCommand(name, command) { commands.set(name, command); },
        on(name, handler) { handlers.set(name, handler); },
    });
    const ctx = { ui: { notify(message, level) { notifications.push({ message, level }); } }, sessionManager: { getBranch: () => entries } };
    const mode = () => { const request = {}; events.emit(DELEGATION_MODE_REQUEST, request); return request.mode; };
    const prompt = () => handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx).systemPrompt;
    return { handlers, commands, notifications, entries, ctx, mode, prompt };
}

test("normalization falls back to adaptive and each prompt expresses its boundary", () => {
    for (const value of [undefined, null, "invalid", "MANUAL", 1]) assert.equal(normalizeDelegationMode(value), "adaptive");
    assert.equal(normalizeDelegationMode("manual"), "manual");
    assert.equal(normalizeDelegationMode("coordinator"), "coordinator");
    assert.match(delegationPrompt("manual"), /plan mode does not override/);
    assert.match(delegationPrompt("manual"), /explicitly asks/);
    assert.doesNotMatch(delegationPrompt("manual"), /Delegate every nontrivial/);
    assert.match(delegationPrompt("adaptive"), /substantial independent work/);
    assert.match(delegationPrompt("coordinator"), /agents_catalog/);
    assert.match(delegationPrompt("coordinator"), /every nontrivial task covered by an available role/);
    assert.match(delegationPrompt("coordinator"), /unowned or ambiguous work/);
});

test("/subagents action completions expose complete mode selections with context", () => {
    assert.deepEqual(subagentsArgumentCompletions(""), [
        { value: "mode manual", label: "mode manual", description: "Delegate only when explicitly requested" },
        { value: "mode adaptive", label: "mode adaptive", description: "Delegate substantial independent work" },
        { value: "mode coordinator", label: "mode coordinator", description: "Delegate role-owned work by default" },
    ]);
    assert.deepEqual(subagentsArgumentCompletions(" mode a")?.map((entry) => entry.value), ["mode adaptive"]);
    assert.equal(subagentsArgumentCompletions("mode invalid"), null);
    const command = harness().commands.get("subagents");
    assert.deepEqual(command.getArgumentCompletions("mode c").map((entry) => entry.value), ["mode coordinator"]);
});

test("/subagents reports config, changes only this session, rejects invalid args and injects current mode", async () => {
    setConfigForTests({ delegationMode: "manual" });
    try {
        const h = harness();
        const command = h.commands.get("subagents");
        assert.ok(command);
        await command.handler("", h.ctx);
        assert.equal(h.notifications.at(-1).message, "Delegation mode: manual.");
        assert.match(h.prompt(), /Delegation mode: manual/);
        await command.handler("mode coordinator", h.ctx);
        assert.equal(h.mode(), "coordinator");
        assert.match(h.prompt(), /Call agents_catalog/);
        await command.handler("mode adaptive extra", h.ctx);
        assert.match(h.notifications.at(-1).message, /Usage: \/subagents/);
        assert.equal(h.notifications.at(-1).level, "warning");
        assert.equal(h.mode(), "coordinator");
        await command.handler("mode adaptive", h.ctx);
        assert.match(h.prompt(), /Delegation mode: adaptive/);
        await h.handlers.get("session_start")({ reason: "reload" }, { ...h.ctx, mode: "print", hasUI: false, cwd: process.cwd(), sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "test" }, isIdle: () => true });
        assert.equal(h.mode(), "adaptive");
        await command.handler("mode coordinator", h.ctx);
        await h.handlers.get("session_start")({ reason: "reload" }, { ...h.ctx, mode: "print", hasUI: false, cwd: process.cwd(), sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "test" }, isIdle: () => true });
        assert.equal(h.mode(), "coordinator", "the session entry restores an override after reload");
        h.entries.length = 0;
        await h.handlers.get("session_tree")({ reason: "branch-change" }, h.ctx);
        assert.equal(h.mode(), "manual", "a branch without an override returns to the configured mode");
        const another = harness();
        assert.equal(another.mode(), "manual", "an override must not change config or another extension instance");
    } finally {
        setConfigForTests(undefined);
    }
});
