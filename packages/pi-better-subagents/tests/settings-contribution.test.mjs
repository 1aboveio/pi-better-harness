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
const theme = { fg: (_color, text) => text, bg: (_color, text) => text,
    bold: (text) => text, inverse: (text) => text };

test("subagents contributes the standalone settings opener with shared session and saved state, and removes its listener", async (t) => {
    const path = join(root, "settings.json");
    setConfigPathForTests(path);
    setConfigForTests({ delegationMode: "manual", maxConcurrent: 3 });
    t.after(() => {
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
        on(name, handler) { handlers.set(name, handler); },
        appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
        sendMessage() { assert.fail("settings must not send messages"); },
        sendUserMessage() { assert.fail("settings must not send user messages"); },
    });
    assert.equal(registrations.length, 2);
    const contribution = registrations[0];
    assert.equal(contribution.id, "subagents");
    assert.equal(contribution.label, "Subagents");
    assert.equal(contribution.command, "/subagents settings");
    const agents = registrations[1];
    assert.equal(agents.id, "agents");
    assert.equal(agents.label, "Agents");
    assert.equal(agents.command, "/agents");
    const later = [];
    events.on("harness-settings:register", (data) => later.push(data));
    events.emit("harness-settings:request");
    events.emit("harness-settings:request");
    assert.deepEqual(later, [contribution, agents, contribution, agents]);

    const pages = [];
    let keys = [];
    let closed = 0;
    const notices = [];
    const ctx = {
        cwd: root, mode: "tui", hasUI: true, isProjectTrusted: () => false,
        sessionManager: { getBranch: () => entries },
        ui: {
            notify(message) { notices.push(message); }, setWidget() {}, setStatus() {},
            async custom(factory) {
                const page = factory({ requestRender() {} }, theme, {}, () => { closed++; });
                pages.push(page.render(100).join("\n"));
                for (const key of keys) page.handleInput(key);
                page.handleInput("\x1b");
            },
        },
    };
    await contribution.open(ctx);
    await commands.get("subagents").handler("settings", ctx);
    assert.equal(pages.length, 2);
    assert.equal(pages[0], pages[1]);
    assert.equal(closed, 2);
    assert.deepEqual(entries, []);
    assert.equal(existsSync(path), false);

    keys = ["\r"]; // manual -> adaptive, session only
    await contribution.open(ctx);
    assert.equal(entries.at(-1).data.mode, "adaptive");
    assert.equal(existsSync(path), false);
    keys = ["\x13"]; // save via standalone command
    await commands.get("subagents").handler("", ctx);
    assert.match(pages.at(-1), /Delegation mode\s+adaptive/);
    assert.equal(loadConfig().delegationMode, "adaptive");
    assert.equal(loadConfig().maxConcurrent, 3);
    assert.equal(existsSync(path), true);
    keys = [];
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
