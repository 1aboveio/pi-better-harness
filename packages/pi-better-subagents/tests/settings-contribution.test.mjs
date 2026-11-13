import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "subagent-settings-contribution-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const { default: extension } = await import("../index.ts");
const { setConfigPathForTests, setConfigForTests, loadConfig } = await import("../config.ts");
const { TIMING_ENV } = await import("../timing.ts");
const theme = { fg: (_color, text) => text, bg: (_color, text) => text,
    bold: (text) => text, inverse: (text) => text };

function selectedRowText(page) {
    const line = page.render(300).find((entry) => entry.trimStart().startsWith("> "));
    return line === undefined ? undefined : line.replace(/\x1b\[[0-9;]*m/g, "").trimStart().slice(2).trim();
}

/** Select by label so menu-row insertions do not silently retarget this test. */
function atRow(label, ...keys) {
    return (page) => {
        for (let attempt = 0; attempt < 32; attempt++) page.handleInput("\x1b[A");
        for (let attempt = 0; attempt < 32; attempt++) {
            const text = selectedRowText(page) ?? "";
            if (text === label || text.startsWith(label + " ")) return keys;
            page.handleInput("\x1b[B");
        }
        throw new Error(`could not select ${label}; selected ${selectedRowText(page)}`);
    };
}

test("subagents contributes the standalone settings opener with shared session and saved state, and removes its listener", async (t) => {
    const previousMax = process.env[TIMING_ENV.max];
    process.env[TIMING_ENV.max] = "5";
    const path = join(root, "settings.json");
    setConfigPathForTests(path);
    setConfigForTests({ delegationMode: "manual", maxConcurrent: 3 });
    const previousTimingEnv = {
        toolWait: process.env[TIMING_ENV.toolWait],
        stuck: process.env[TIMING_ENV.stuck],
    };
    process.env[TIMING_ENV.toolWait] = "7";
    process.env[TIMING_ENV.stuck] = "13";
    t.after(() => {
        if (previousTimingEnv.toolWait === undefined) delete process.env[TIMING_ENV.toolWait];
        else process.env[TIMING_ENV.toolWait] = previousTimingEnv.toolWait;
        if (previousTimingEnv.stuck === undefined) delete process.env[TIMING_ENV.stuck];
        else process.env[TIMING_ENV.stuck] = previousTimingEnv.stuck;
        if (previousMax === undefined) delete process.env[TIMING_ENV.max];
        else process.env[TIMING_ENV.max] = previousMax;
        setConfigPathForTests(undefined);
        rmSync(root, { recursive: true, force: true });
    });
    const events = createEventBus();
    const registrations = [];
    events.on("harness-settings:register", (data) => registrations.push(data));
    const commands = new Map();
    const handlers = new Map();
    const entries = [];
    extension({
        events,
        registerTool() {},
        registerCommand(name, command) { commands.set(name, command); },
        on(name, handler) {
            const prior = handlers.get(name);
            handlers.set(name, async (...args) => { await prior?.(...args); return handler(...args); });
        },
        appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
        sendMessage() { assert.fail("settings must not send messages"); },
        sendUserMessage() { assert.fail("settings must not send user messages"); },
    });
    const packageLinks = registrations.filter(item => item.command);
    assert.equal(packageLinks.length, 2);
    const contribution = packageLinks[0];
    assert.equal(contribution.id, "subagents");
    assert.equal(contribution.label, "Subagents");
    assert.equal(contribution.command, "/subagents settings");
    const agents = packageLinks[1];
    assert.equal(agents.id, "agents");
    assert.equal(agents.label, "Agents");
    assert.equal(agents.command, "/agents");
    const later = [];
    events.on("harness-settings:register", (data) => later.push(data));
    events.emit("harness-settings:request");
    events.emit("harness-settings:request");
    assert.deepEqual(later.filter(item => item.command), [contribution, agents, contribution, agents]);
    assert.equal(later.filter(item => item.id === "navigator-sticky").length, 2, "the shared navigator contributes its setting on each discovery");

    const pages = [];
    const uiEvents = [];
    let keys = [];
    const keyBatches = [];
    let closed = 0;
    const notices = [];
    const ctx = {
        cwd: root, mode: "tui", hasUI: true, isProjectTrusted: () => false,
        sessionManager: { getBranch: () => entries },
        ui: {
            notify(message) { notices.push(message); }, setWidget() {}, setStatus() {},
            custom(factory) {
                return new Promise((resolve) => {
                    const call = pages.length;
                    uiEvents.push(`open:${call}`);
                    let settled = false;
                    const done = (value) => {
                        if (settled) return;
                        settled = true;
                        closed++;
                        uiEvents.push(`close:${call}`);
                        resolve(value);
                    };
                    const page = factory({ requestRender() {} }, theme, {}, done);
                    pages.push(page.render(100).join("\n"));
                    const batch = keyBatches.length > 0 ? keyBatches.shift() : keys;
                    const selectedKeys = typeof batch === "function" ? batch(page) : batch;
                    for (const key of selectedKeys) page.handleInput(key);
                    for (let attempt = 0; attempt < 3 && !settled; attempt++) page.handleInput("\x1b");
                });
            },
        },
    };
    await contribution.open(ctx);
    await commands.get("subagents").handler("settings", ctx);
    assert.equal(pages.length, 2);
    assert.equal(pages[0], pages[1]);
    assert.match(pages[0], /Timeout \(minutes\)\s+5/, "the real settings page shows the environment-effective timeout");
    assert.match(pages[0], /Tool-wait alert\s+7 min/, "the real settings page shows the environment-effective value");
    assert.match(pages[0], /No-progress alert\s+13 min/);
    delete process.env[TIMING_ENV.toolWait];
    delete process.env[TIMING_ENV.stuck];
    assert.equal(closed, 2);
    assert.deepEqual(entries, []);
    assert.equal(existsSync(path), false);

    keys = ["\r"]; // manual -> adaptive, session only
    await contribution.open(ctx);
    assert.equal(entries.at(-1).data.mode, "adaptive");
    assert.equal(existsSync(path), false);
    keys = atRow("Timeout (minutes)", "\r", "\x15", "90", "\r");
    await contribution.open(ctx);
    assert.equal(entries.at(-1).data.maxMinutes, 90);
    keys = ["\x13"]; // save via standalone command
    await commands.get("subagents").handler("", ctx);
    assert.match(pages.at(-1), /Delegation mode\s+adaptive/);
    assert.match(pages.at(-1), /Timeout \(minutes\)\s+90/, "the session timeout wins over the environment");
    assert.equal(loadConfig().delegationMode, "adaptive");
    assert.equal(loadConfig().maxConcurrent, 3);
    assert.equal(loadConfig().maxMinutes, 90);
    assert.equal(existsSync(path), true);
    keys = [];
    await contribution.open(ctx);
    assert.match(pages.at(-1), /Timeout \(minutes\)\s+90/, "saving preserves the active session timeout over the environment");
    await handlers.get("session_tree")({}, ctx);
    await contribution.open(ctx);
    assert.match(pages.at(-1), /Timeout \(minutes\)\s+90/, "the saved session timeout survives branch restoration");

    keys = atRow("Timeout (minutes)", "\r", "\x15", "0", "\r", "\x13");
    await contribution.open(ctx);
    assert.equal(loadConfig().maxMinutes, 0);
    keys = [];
    await contribution.open(ctx);
    assert.match(pages.at(-1), /Timeout \(minutes\)\s+0/, "saving preserves an explicitly disabled timeout");
    await handlers.get("session_tree")({}, ctx);
    await contribution.open(ctx);
    assert.match(pages.at(-1), /Timeout \(minutes\)\s+0/, "the disabled timeout survives branch restoration");

    keys = atRow("Reset to defaults", "\r");
    await contribution.open(ctx);
    keys = [];
    await contribution.open(ctx);
    assert.match(pages.at(-1), /Timeout \(minutes\)\s+5/, "an explicit reset restores the environment-effective default");
    await commands.get("subagents").handler("mode coordinator", ctx);
    await contribution.open(ctx);
    assert.match(pages.at(-1), /Delegation mode\s+coordinator/);

    const beforeCatalog = entries.length;
    await agents.open(ctx);
    const hubCatalog = pages.at(-1);
    assert.match(hubCatalog, /Agents/);
    await commands.get("agents").handler("", ctx);
    assert.equal(pages.at(-1), hubCatalog, "the hub opens the same catalog as /agents");
    assert.equal(entries.length, beforeCatalog, "opening the catalog does not change saved session settings");

    const beforeAgents = entries.length;
    const openedBefore = pages.length;
    const eventsBefore = uiEvents.length;
    keyBatches.push(atRow("Agents", "\r"));
    await contribution.open(ctx);
    assert.match(pages.at(-2), /Agents/);
    assert.match(pages.at(-2), /Reset to defaults/);
    assert.deepEqual(uiEvents.slice(eventsBefore), [
        `open:${openedBefore}`, `close:${openedBefore}`,
        `open:${openedBefore + 1}`, `close:${openedBefore + 1}`,
    ], "the settings page closes before the catalog opens, and the catalog closes on its own");
    assert.equal(pages.at(-1), hubCatalog, "the settings Agents action opens the same catalog as /agents");
    assert.equal(entries.length, beforeAgents, "opening the catalog from settings changes no saved session settings");

    ctx.mode = "rpc";
    const opened = pages.length;
    await contribution.open(ctx);
    await commands.get("subagents").handler("settings", ctx);
    assert.equal(pages.length, opened);
    assert.equal(notices.at(-1), notices.at(-2));
    await handlers.get("session_shutdown")({}, ctx);
    const count = registrations.length;
    events.emit("harness-settings:request");
    assert.equal(registrations.length, count);
});
