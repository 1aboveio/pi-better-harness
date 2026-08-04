/**
 * Extension-level contract for the shared 10/25 log-tail detail surface.
 *
 * // @covers subagent.navigator-log-tail
 * // @level integration
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const tempDir = mkdtempSync(join(tmpdir(), "subagent-shared-tail-"));
process.env.TMPDIR = tempDir;

const { default: betterSubagents } = await import("../index.ts");
const { disposeBackgroundWorkNavigator } = await import("../shared-navigator.ts");
const { logPathFor, runDir, writeMeta } = await import("../registry.ts");

after(() => rmSync(tempDir, { recursive: true, force: true }));

test("subagent details use the shared 10/25 rolling log tail", async () => {
    const id = `sa_shared_tail_${Date.now()}`;
    const cwd = join(tempDir, "workspace");
    const sessionId = "shared-tail-session";
    const logPath = logPathFor(id);
    mkdirSync(runDir(id), { recursive: true });
    writeFileSync(logPath, Array.from({ length: 12 }, (_, index) => `row-${index + 1}`).join("\n") + "\n");
    writeMeta({
        id,
        name: "tail verifier",
        status: "completed",
        pid: 0,
        spawnPid: process.pid,
        cwd,
        promptPreview: "verify shared tail",
        startedAt: Date.now() - 1_000,
        endedAt: Date.now(),
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
        editor.handleInput("<enter>");

        let rendered = component.render(160).join("\n");
        assert.match(rendered, /log tail · latest 10 rows/);
        assert.doesNotMatch(rendered, /row-1\n/);
        assert.match(rendered, /row-3/);
        assert.match(rendered, /row-12/);

        component.handleInput("l");
        rendered = component.render(160).join("\n");
        assert.match(rendered, /log tail · latest 25 rows/);
        assert.match(rendered, /row-1/);
        assert.match(rendered, /row-12/);

        appendFileSync(logPath, "row-13\ntool read /Users/exoulster/projects/pi-better-harness/packages/pi-better-subagents/shared-navigator.ts\n");
        component.handleInput("l");
        const narrowLines = component.render(54);
        rendered = narrowLines.join("\n");
        assert.match(rendered, /log tail · latest 10 rows/);
        assert.doesNotMatch(rendered, /row-3\n/);
        assert.match(rendered, /row-13/);
        assert.match(rendered, /shared-navigator\.ts/);
        assert.ok(narrowLines.every((line) => line.length <= 54), rendered);
    } finally {
        disposeBackgroundWorkNavigator(ctx);
    }
});