/**
 * Extension-level contract for the Pi-style subagent transcript detail surface.
 *
 * // @covers subagent.navigator-transcript
 * // @level integration
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const tempDir = mkdtempSync(join(tmpdir(), "subagent-shared-tail-"));
process.env.TMPDIR = tempDir;

const { default: betterSubagents } = await import("../index.ts");
const { disposeBackgroundWorkNavigator } = await import("../shared-navigator.ts");
const { logPathFor, runDir, writeMeta } = await import("../registry.ts");

after(() => rmSync(tempDir, { recursive: true, force: true }));

test("subagent details render a structured Pi-style transcript", async () => {
    const id = `sa_shared_tail_${Date.now()}`;
    const cwd = join(tempDir, "workspace");
    const sessionId = "shared-tail-session";
    const logPath = logPathFor(id);
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPath, [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
            { type: "thinking", thinking: "inspect the navigator" },
            { type: "text", text: "## Finding\n\nUse **Pi Markdown**." },
        ] } }),
        JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: { path: "shared-navigator.ts" } }),
        JSON.stringify({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: { content: [{ type: "text", text: "file body" }] }, isError: false }),
    ].join("\n") + "\n");
    writeMeta({
        id,
        name: "tail verifier",
        status: "running",
        pid: process.pid,
        spawnPid: process.pid,
        cwd,
        promptPreview: "verify shared tail",
        startedAt: Date.now() - 1_000,

        logPath,
        sessionId: id,
        callbackOrigin: { cwd, sessionId },
    });

    const handlers = new Map();
    let component;
    let mainListWidget;
    let idle = true;
    const ui = {
        factory: undefined,
        theme: { fg: (_color, value) => value },
        setStatus() {},
        setWidget(key, value) {
            if (key === "background-work-list" && typeof value === "function") mainListWidget = value;
        },
        getEditorComponent() { return this.factory; },
        setEditorComponent(factory) { this.factory = factory; },
        custom(factory) {
            component = factory({ requestRender() {} }, this.theme, {}, () => undefined);
            return Promise.resolve(null);
        },
    };
    const ctx = {
        mode: "tui",
        hasUI: true,
        ui,
        cwd,
        model: { provider: "test", id: "test" },
        thinkingLevel: "high",
        isIdle: () => idle,
        getContextUsage: () => ({ tokens: 109_300, contextWindow: 200_000, percent: 54.65 }),
        sessionManager: { getSessionId: () => sessionId },
    };
    const pi = {
        registerTool() {},
        on(event, handler) { handlers.set(event, handler); },
        sendMessage() {},
    };

    betterSubagents(pi);
    try {
        await handlers.get("session_start")({}, ctx);
        const renderMainList = (width = 120) => mainListWidget({ requestRender() {} }, ui.theme).render(width).join("\n");
        let mainList = renderMainList();
        assert.match(mainList, /·\s+main\s+test high · 109\.3k tok\s+idle/);
        assert.ok(mainList.indexOf("main") < mainList.indexOf("tail verifier"), mainList);

        idle = false;
        await handlers.get("agent_start")({}, ctx);
        await handlers.get("tool_execution_start")({ toolCallId: "main-tool-1", toolName: "read" }, ctx);
        mainList = renderMainList();
        assert.match(mainList, /●\s+main\s+test high · tool read · 109\.3k tok/);

        const editor = ui.factory({}, {}, {});
        editor.handleInput("<left>");
        assert.match(renderMainList(), /^› ●\s+main/m, "left starts on main");
        editor.handleInput("<down>");
        editor.handleInput("<enter>");

        let rendered = component.render(160).join("\n");
        assert.match(rendered, /transcript/);
        assert.match(rendered, /Thinking\.\.\./);
        assert.match(rendered, /## Finding/);
        assert.match(rendered, /Use \*\*Pi Markdown\*\*\./);
        assert.match(rendered, /read.*shared-navigator\.ts/);

        const narrowLines = component.render(54);
        rendered = narrowLines.join("\n");
        assert.match(rendered, /shared-navigator\.ts/);
        assert.ok(narrowLines.every((line) => line.length <= 54), rendered);
    } finally {
        disposeBackgroundWorkNavigator(ctx);
    }
});