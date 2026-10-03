import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "node:module";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const { default: extension, subagentsArgumentCompletions } = await import("../index.ts");
const { setConfigForTests, setConfigPathForTests, loadConfig, writeSubagentSettings, normalizeConcurrencyCap } = await import("../config.ts");
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

test("session cap validates input and follows reload, branch navigation, and reset", async () => {
    setConfigForTests({ delegationMode: "manual", maxConcurrent: 3 });
    try {
        const h = harness();
        const command = h.commands.get("subagents");
        await command.handler("cap 6", h.ctx);
        for (const value of ["0", "-1", "1.5", "abc", "9007199254740992"]) {
            const before = h.entries.length;
            await command.handler(`cap ${value}`, h.ctx);
            assert.equal(h.entries.length, before, "invalid caps do not alter session history");
            assert.equal(h.notifications.at(-1).level, "warning");
        }
        await command.handler("settings", h.ctx);
        assert.match(h.notifications.at(-1).message, /Concurrent subagents: 6\./);
        await h.handlers.get("session_start")({}, { ...h.ctx, mode: "print", hasUI: false, cwd: process.cwd(), isIdle: () => true });
        await command.handler("settings", h.ctx);
        assert.match(h.notifications.at(-1).message, /Concurrent subagents: 6\./);
        h.entries.length = 0;
        await h.handlers.get("session_tree")({}, h.ctx);
        await command.handler("settings", h.ctx);
        assert.match(h.notifications.at(-1).message, /Concurrent subagents: 3\./);
        await command.handler("cap 9", h.ctx);
        await command.handler("mode coordinator", h.ctx);
        await command.handler("reset", h.ctx);
        await command.handler("settings", h.ctx);
        assert.match(h.notifications.at(-1).message, /Delegation mode: manual\. Concurrent subagents: 3\./);
    } finally {
        setConfigForTests(undefined);
    }
});

test("settings save refuses corrupt config without discarding session choices", async () => {
    const dir = mkdtempSync(join(tmpdir(), "subagent-settings-"));
    const path = join(dir, "config.json");
    setConfigPathForTests(path);
    try {
        const h = harness();
        await h.commands.get("subagents").handler("cap 8", h.ctx);
        writeFileSync(path, "{broken");
        await h.commands.get("subagents").handler("save", h.ctx);
        assert.equal(readFileSync(path, "utf8"), "{broken");
        assert.equal(h.notifications.at(-1).level, "warning");
        await h.commands.get("subagents").handler("settings", h.ctx);
        assert.match(h.notifications.at(-1).message, /Concurrent subagents: 8\./);
        writeFileSync(path, "{}");
        writeSubagentSettings({ delegationMode: "manual", maxConcurrent: 5 });
        assert.equal(loadConfig().maxConcurrent, 5);
        assert.equal(normalizeConcurrencyCap(5), 5);
        for (const value of [undefined, null, 0, -1, 1.5, "8", NaN, Infinity]) {
            assert.equal(normalizeConcurrencyCap(value), 4);
        }
    } finally {
        setConfigPathForTests(undefined);
        rmSync(dir, { recursive: true, force: true });
    }
});

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
        { value: "settings", label: "settings", description: "Open delegation mode and concurrency settings" },
        { value: "cap", label: "cap <number>", description: "Set a positive concurrent subagent limit for this session" },
        { value: "reset", label: "reset", description: "Reset session mode and cap to saved defaults" },
        { value: "mode manual", label: "mode manual", description: "Delegate only when explicitly requested" },
        { value: "mode adaptive", label: "mode adaptive", description: "Delegate substantial independent work" },
        { value: "mode coordinator", label: "mode coordinator", description: "Delegate role-owned work by default" },
        { value: "save", label: "save", description: "Save the current mode and cap as defaults" },
    ]);
    assert.deepEqual(subagentsArgumentCompletions(" mode a")?.map((entry) => entry.value), ["mode adaptive"]);
    assert.equal(subagentsArgumentCompletions("mode invalid"), null);
    const command = harness().commands.get("subagents");
    assert.deepEqual(command.getArgumentCompletions("mode c").map((entry) => entry.value), ["mode coordinator"]);
    assert.match(command.description, /settings.*cap <number>.*save.*reset/);
});

test("/subagents save confirms, preserves other config, and clears the session override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "delegation-save-"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ defaultTools: "read", delegationMode: "adaptive" }));
    setConfigPathForTests(path);
    try {
        const h = harness();
        const command = h.commands.get("subagents");
        await command.handler("mode coordinator", h.ctx);
        await command.handler("cap 7", h.ctx);
        h.ctx.hasUI = true;
        h.ctx.ui.confirm = async () => false;
        await command.handler("save", h.ctx);
        assert.equal(JSON.parse(readFileSync(path, "utf8")).delegationMode, "adaptive");
        assert.match(h.notifications.at(-1).message, /unchanged/);
        h.ctx.ui.confirm = async () => true;
        await command.handler("save", h.ctx);
        const saved = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(saved.delegationMode, "coordinator");
        assert.equal(saved.maxConcurrent, 7);
        assert.equal(saved.defaultTools, "read");
        assert.equal(h.entries.at(-1).data.mode, null);
        assert.equal(h.mode(), "coordinator");
        await h.handlers.get("session_start")({ reason: "reload" }, { ...h.ctx, mode: "print", hasUI: false, cwd: process.cwd(), sessionManager: h.ctx.sessionManager, isIdle: () => true });
        assert.equal(h.mode(), "coordinator", "a saved default survives reload after the session override is cleared");
        await command.handler("settings", h.ctx);
        assert.match(h.notifications.at(-1).message, /Concurrent subagents: 7\./);
    } finally {
        setConfigPathForTests(undefined);
        setConfigForTests(undefined);
        rmSync(dir, { recursive: true, force: true });
    }
});

test("/subagents reports config, changes only this session, rejects invalid args and injects current mode", async () => {
    setConfigForTests({ delegationMode: "manual" });
    try {
        const h = harness();
        const command = h.commands.get("subagents");
        assert.ok(command);
        await command.handler("", h.ctx);
        assert.match(h.notifications.at(-1).message, /^Delegation mode: manual\. Concurrent subagents: 4\./);
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
