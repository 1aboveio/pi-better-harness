/**
 * Integration regression for issue #47 close wiring through the real extension
 * factory path (index.ts registration → session_start → editor/overlay → x x).
 *
 * Pins the integrated-review finding: navigatorCloseRun must receive a real
 * stopRun binding from index.ts. Helper-only executeNavigatorClose coverage is
 * insufficient — second `x` must act via the registered production TUI path.
 *
 * // @covers navigator.close
 * // @level integration
 */
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    existsSync,
    lstatSync,
    readdirSync,
} from "node:fs";
import { register } from "node:module";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const RUNTIME = mkdtempSync(join(tmpdir(), "nav-close-ext-"));
process.env.TMPDIR = RUNTIME;

const STUBS_DIR = mkdtempSync(join(RUNTIME, "stubs-"));
const CHECKOUT_NODE_MODULES = join(REPO_ROOT, "node_modules");
const THIS_PID = process.pid;
const diskIds = [];

function trackDisk(id) {
    diskIds.push(id);
    return id;
}

function writeStubPackage(name, files) {
    const pkgDir = join(STUBS_DIR, ...name.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name, type: "module", main: "index.js", exports: { ".": "./index.js" } }),
    );
    for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(pkgDir, file), content);
    }
}

function setupStubs() {
    writeStubPackage("@earendil-works/pi-ai", {
        "index.js": `
const scalar = (type, opts = {}) => ({ type, ...opts });
export const Type = {
    String: (opts) => scalar("string", opts),
    Number: (opts) => scalar("number", opts),
    Boolean: (opts) => scalar("boolean", opts),
    Optional: (schema) => schema,
    Array: (schema, opts = {}) => ({ type: "array", items: schema, ...opts }),
    Object: (props, opts = {}) => ({ type: "object", properties: props, ...opts }),
    // Role selectors are Type.Union([string, string[]]). Registration only declares the schema.
    Union: (variants, opts = {}) => ({ type: "union", anyOf: variants, ...opts }),
};
export function getSupportedThinkingLevels(model) {
    if (!model || model.reasoning === false) return ["off"];
    return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
}
`,
    });
    writeStubPackage("@earendil-works/pi-coding-agent", {
        "index.js": `
export function getAgentDir() { return process.env.PI_CODING_AGENT_DIR || ${JSON.stringify(join(RUNTIME, "agent"))}; }
export class CustomEditor {
    constructor() { this._text = ""; }
    getText() { return this._text; }
    setText(t) { this._text = String(t ?? ""); }
    handleInput() {}
}
`,
    });
    // matchesKey must honor both bare ids and the literal "x" the overlay uses.
    writeStubPackage("@earendil-works/pi-tui", {
        "index.js": `
export class Input {}
export class SelectList {}
export const Key = { left: "left", x: "x", X: "X", up: "up", down: "down", enter: "enter", escape: "escape" };
export function matchesKey(data, key) {
    if (data == null || key == null) return false;
    if (data === key) return true;
    if (data === \`<\${key}>\`) return true;
    return false;
}
export function visibleWidth(s) { return String(s ?? "").length; }
export function truncateToWidth(s, w) {
    const str = String(s ?? "");
    const width = Number(w) || 0;
    return str.length > width ? str.slice(0, Math.max(0, width)) : str;
}
`,
    });

    const loaderPath = join(RUNTIME, "stub-loader.mjs");
    writeFileSync(
        loaderPath,
        `import { pathToFileURL } from "node:url";
const stubs = {
  "@earendil-works/pi-ai": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-ai/index.js"))},
  "@earendil-works/pi-coding-agent": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-coding-agent/index.js"))},
  "@earendil-works/pi-tui": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-tui/index.js"))},
};
export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
    return { shortCircuit: true, url: pathToFileURL(stubs[specifier]).href };
  }
  return nextResolve(specifier, context);
}
`,
    );
    register(pathToFileURL(loaderPath).href);
}

function assertCheckoutNodeModulesUntouched() {
    if (!existsSync(CHECKOUT_NODE_MODULES)) return;
    const entries = [];
    const walk = (dir, rel = "") => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const childRel = rel ? `${rel}/${name}` : name;
            let st;
            try { st = lstatSync(full); } catch { continue; }
            if (st.isSymbolicLink()) entries.push(`symlink:${childRel}`);
            else if (st.isDirectory()) walk(full, childRel);
            else entries.push(`file:${childRel}`);
        }
    };
    walk(CHECKOUT_NODE_MODULES);
    assert.deepEqual(entries, [], `checkout node_modules must stay clean; found: ${entries.join(", ")}`);
}

function spawnSleeper() {
    const proc = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    proc.unref();
    return proc.pid;
}

async function waitFor(pred, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 20));
    }
    return pred();
}

/**
 * Boot the real extension factory, fire session_start on a TUI ctx, and drive
 * the empty-editor main-window subagent navigation path.
 */
function bootRegisteredNavigator(mod, { writeMeta, metaBase, sessionId }) {
    const handlers = {};
    const tools = new Map();
    const statusCalls = [];
    const widgetCalls = [];
    const closedOutcomes = [];
    let overlayComponent;
    let editor;
    let resolveOverlay;
    const overlayReady = new Promise((r) => { resolveOverlay = r; });

    const ui = {
        theme: { fg: (color, s) => `<${color}>${s}</>` },
        setStatus(k, v) { statusCalls.push([k, v]); },
        setWidget(k, v) { widgetCalls.push([k, v]); },
        notify() {},
        factory: undefined,
        getEditorComponent() { return this.factory; },
        setEditorComponent(f) { this.factory = f; },
        custom(factory) {
            return new Promise((resolve) => {
                const tui = { requestRender() {} };
                const theme = { fg: (_c, s) => s };
                const component = factory(tui, theme, {}, (v) => resolve(v));
                overlayComponent = component;
                resolveOverlay(component);
            });
        },
    };

    const ctx = {
        mode: "tui",
        hasUI: true,
        ui,
        cwd: RUNTIME,
        model: { provider: "test", id: "model" },
        ...(sessionId ? { sessionManager: { getSessionId: () => sessionId } } : {}),
    };

    const pi = {
        registerTool(tool) { tools.set(tool.name, tool); },
        on(event, fn) { handlers[event] = fn; },
        sendMessage() {},
    };

    // Load the production registration path.
    mod.default(pi);
    assert.equal(typeof handlers.session_start, "function", "extension must register session_start");

    return {
        async start() {
            await handlers.session_start({}, ctx);
            assert.ok(ui.factory, "session_start must install the navigator editor factory");
            editor = ui.factory("tui", "theme", "kb");
            assert.equal(typeof editor.handleInput, "function");
            assert.equal(editor.getText(), "");
        },
        focusViaLeftKey() {
            editor.handleInput("left");
        },
        async openDetailViaEnter() {
            editor.handleInput("enter");
            const component = await Promise.race([
                overlayReady,
                new Promise((_, rej) => setTimeout(() => rej(new Error("overlay did not open")), 1000)),
            ]);
            assert.ok(component, "enter must open the shared detail overlay");
            assert.equal(typeof component.handleInput, "function");
            return component;
        },
        pressEditor(key) {
            editor.handleInput(key);
        },
        lastWidget(key) {
            for (let i = widgetCalls.length - 1; i >= 0; i--) {
                if (widgetCalls[i][0] === key) return widgetCalls[i][1];
            }
            return Symbol.for("missing");
        },
        pressX() { overlayComponent ? overlayComponent.handleInput("x") : editor.handleInput("x"); },
        async shutdown() { await handlers.session_shutdown({}, ctx); },
        tools,
        statusCalls,
        widgetCalls,
        closedOutcomes,
        ui,
        ctx,
        /** Seed a visible run owned by this parent. */
        seedRun(overrides = {}) {
            const id = trackDisk(overrides.id ?? `sa_t47_ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
            writeMeta({
                ...metaBase,
                id,
                ...overrides,
            });
            return id;
        },
    };
}

function renderWidgetValue(value, width = 120) {
    if (Array.isArray(value)) return value.join("\n");
    if (typeof value === "function") {
        return value({ requestRender() {} }, { fg: (_color, s) => s }).render(width).join("\n");
    }
    return String(value ?? "");
}

describe("registered extension path: main-window navigator actions", () => {
    let mod;
    let registry;
    let processExists;
    let metaBase;

    before(async () => {
        setupStubs();
        assertCheckoutNodeModulesUntouched();
        mod = await import("../index.ts");
        registry = await import("../registry.ts");
        ({ processExists } = await import("../spawn.ts"));
        metaBase = {
            status: "completed",
            pid: 0,
            spawnPid: THIS_PID,
            cwd: RUNTIME,
            promptPreview: "ext-path",
            startedAt: 1,
            logPath: join(RUNTIME, "x.log"),
            sessionId: "ext",
        };
        assertCheckoutNodeModulesUntouched();
    });

    after(() => {
        for (const id of diskIds) {
            try { rmSync(registry.runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
        }
        try { rmSync(RUNTIME, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    // @covers navigator.incident-presentation
    // @level integration
    it("hides incident summaries in registered rows and detail while preserving results and transcripts", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        const now = Date.now();
        const id = nav.seedRun({
            name: "quiet-failure", status: "failed", startedAt: now - 1000, endedAt: now,
            model: "test/model", exitCode: 1,
        });
        const logPath = registry.logPathFor(id);
        const liveId = nav.seedRun({
            name: "live-affordance", status: "running", pid: spawnSleeper(), startedAt: now - 2000,
        });
        writeFileSync(registry.logPathFor(liveId), "");
        const events = [];
        for (let attempt = 1; attempt <= 3; attempt++) {
            const toolCallId = `bad-${attempt}`;
            events.push(
                { type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "npm test" } },
                { type: "tool_execution_end", toolCallId, toolName: "bash", isError: true,
                    result: { content: [{ type: "text", text: "ORIGINAL_CHILD_ERROR" }] } },
            );
        }
        events.push(
            { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "MODEL_FAILURE" } },
            { type: "agent_end" },
        );
        writeFileSync(logPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
        const { failureView } = await import("../failures.ts");
        assert.equal(failureView(id, RUNTIME, true).actionable, true, "fixture must need action");
        try {
            await nav.start();
            const { renderRegisteredWorkDetail, refreshBackgroundWorkNavigator } = await import("../shared-navigator.ts");
            const rail = renderWidgetValue(nav.lastWidget("background-work-list"));
            assert.match(rail, /quiet-failure\s+failed/);
            assert.doesNotMatch(rail, /Action required|ORIGINAL_CHILD_ERROR|model error|MODEL_FAILURE/);
            const rendered = renderRegisteredWorkDetail("subagents", id, 120);
            assert.ok(rendered.listedIds.includes(id));
            assert.match(rendered.rowLine, /failed/);
            assert.doesNotMatch(rendered.rowLine, /Action required|ORIGINAL_CHILD_ERROR|model error|MODEL_FAILURE/);
            assert.equal(rendered.detail.status, "failed");
            assert.ok(!rendered.detail.metadata.some((entry) => entry.label === "failure"));
            assert.equal(rendered.detail.subtitle, undefined);
            assert.equal(rendered.detail.transcriptDiagnostic, undefined);
            assert.doesNotMatch(rendered.detail.evidence.text, /Action required|active failure observations/);
            const transcriptTools = rendered.detail.transcript.filter((entry) => entry.type === "tool");
            assert.equal(transcriptTools.length, 3);
            assert.ok(transcriptTools.every((entry) => entry.isError && entry.result.content[0].text === "ORIGINAL_CHILD_ERROR"));
            const result = await nav.tools.get("subagent_result").execute("result", { id, all: true, max_bytes: 8192 });
            assert.match(result.content.map((entry) => entry.text ?? "").join("\n"), /Action required/);
            assert.equal(failureView(id, RUNTIME, true).actionable, true, "navigator cannot dispose incidents");
            registry.writeMeta({ ...registry.readMeta(id), status: "lost", lostAt: now });
            refreshBackgroundWorkNavigator(nav.ctx);
            const lostRail = renderWidgetValue(nav.lastWidget("background-work-list"));
            assert.match(lostRail, /quiet-failure\s+lost/);
            assert.doesNotMatch(lostRail, /Action required|ORIGINAL_CHILD_ERROR|model error|MODEL_FAILURE/);
            rmSync(logPath);
            const unreadable = renderRegisteredWorkDetail("subagents", id, 120).detail;
            assert.equal(unreadable.status, "lost");
            assert.match(unreadable.transcriptDiagnostic, /Log unreadable/);
            assert.doesNotMatch(unreadable.transcriptDiagnostic, /Action required|active failure observations/);
        } finally {
            await nav.shutdown();
            registry.dismissRun(id);
            registry.dismissRun(liveId);
        }
    });

    // @covers navigator.close
    // @level integration
    it("registered TUI path left focuses the main list and enter opens selected detail", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        const affordancePid = spawnSleeper();
        const affordanceId = nav.seedRun({
            id: trackDisk(`sa_t47_ext_term_afford_${Date.now()}`),
            name: "live-affordance",
            status: "running",
            pid: affordancePid,
            startedAt: Date.now() + 1000,
        });
        const id = nav.seedRun({
            id: trackDisk(`sa_t47_ext_term_${Date.now()}`),
            name: "done-job",
            status: "completed",
            startedAt: 100,
            endedAt: 100,
        });

        try {
            await nav.start();
            nav.focusViaLeftKey();
            nav.pressEditor("down");
            const component = await nav.openDetailViaEnter();
            const text = component.render(80).join("\n").replace(/<\/?[a-z]*>/g, "");
            assert.ok(text.includes("live-affordance"), text);
            assert.equal(processExists(affordancePid), true, "enter must not stop the selected run");
            const back = registry.readMeta(id);
            assert.equal(back.status, "completed", "terminal status preserved");
            assert.equal(back.dismissedAt, undefined, "terminal row is not dismissed by main running-list navigation");

            component.handleInput("left");
            assert.equal(typeof component.handleInput, "function", "left closes detail through the overlay component");
        } finally {
            registry.dismissRun(affordanceId);
            try { process.kill(-affordancePid, "SIGTERM"); } catch { try { process.kill(affordancePid, "SIGTERM"); } catch { /* ignore */ } }
        }
    });

    // @covers navigator.close
    // @level integration
    it("running run: registered shared navigator x stops via shared stopRun and dismisses", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        const pid = spawnSleeper();
        const id = nav.seedRun({
            id: trackDisk(`sa_t47_ext_run_${Date.now()}`),
            name: "live-job",
            status: "running",
            pid,
            startedAt: Date.now() + 1000,
        });

        await nav.start();
        nav.focusViaLeftKey();

        nav.pressX();
        nav.pressX();
        let back = registry.readMeta(id);
        assert.equal(back.status, "running", "main is not a stoppable navigator target");

        nav.pressEditor("down");
        nav.pressX();
        nav.pressX();
        back = registry.readMeta(id);
        assert.equal(back.status, "killed", "main-list x must mark killed via shared stopRun");
        assert.equal(typeof back.dismissedAt, "number", "main-list x must dismiss");
        assert.equal(
            await waitFor(() => !processExists(pid)),
            true,
            "process group must be terminated",
        );
        assert.ok(
            !registry.navigatorVisibleRuns(registry.listMetas(), THIS_PID).some((m) => m.id === id),
            "stopped+dismissed run leaves navigator visibility",
        );
    });

    // @covers navigator.close
    // @level integration
    it("registered main-list widget hides subagents from other sessions", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase, sessionId: "session-b" });
        nav.seedRun({
            id: trackDisk(`sa_t47_session_a_${Date.now()}`),
            name: "session-a-run",
            status: "running",
            pid: THIS_PID,
            startedAt: Date.now() + 1000,
            callbackOrigin: { cwd: RUNTIME, sessionId: "session-a" },
        });
        nav.seedRun({
            id: trackDisk(`sa_t47_session_b_${Date.now()}`),
            name: "session-b-run",
            status: "running",
            pid: THIS_PID,
            startedAt: Date.now() + 2000,
            callbackOrigin: { cwd: RUNTIME, sessionId: "session-b" },
        });

        await nav.start();

        const mainList = renderWidgetValue(nav.lastWidget("background-work-list"));
        assert.ok(mainList.includes("session-b-run"), mainList);
        assert.ok(!mainList.includes("session-a-run"), mainList);
    });

    // @covers navigator.close
    // @level integration
    it("registered main-list widget hides the section when only terminal subagents remain", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        const now = Date.now();
        const recentFailedId = nav.seedRun({
            id: trackDisk(`sa_t47_recent_failed_${now}`),
            name: "recent-failed-run",
            status: "failed",
            pid: THIS_PID,
            startedAt: now - 40_000,
            endedAt: now - 29_000,
        });
        const oldFailedId = nav.seedRun({
            id: trackDisk(`sa_t47_old_failed_${now}`),
            name: "old-failed-run",
            status: "failed",
            pid: THIS_PID,
            startedAt: now - 50_000,
            endedAt: now - 31_000,
        });
        const recentCompletedId = nav.seedRun({
            id: trackDisk(`sa_t47_recent_completed_${now}`),
            name: "recent-completed-run",
            status: "completed",
            pid: THIS_PID,
            startedAt: now - 40_000,
            endedAt: now - 29_000,
        });
        const oldCompletedId = nav.seedRun({
            id: trackDisk(`sa_t47_old_completed_${now}`),
            name: "old-completed-run",
            status: "completed",
            pid: THIS_PID,
            startedAt: now - 50_000,
            endedAt: now - 31_000,
        });

        await nav.start();

        const mainList = renderWidgetValue(nav.lastWidget("background-work-list"));
        assert.ok(!mainList.includes("subagents"), mainList);
        assert.ok(!mainList.includes("recent-failed-run"), mainList);
        assert.ok(!mainList.includes("recent-completed-run"), mainList);
        assert.ok(!mainList.includes("old-failed-run"), mainList);
        assert.ok(!mainList.includes("old-completed-run"), mainList);
        assert.equal(registry.readMeta(recentFailedId).status, "failed");
        assert.equal(registry.readMeta(oldFailedId).status, "failed");
        assert.equal(registry.readMeta(recentCompletedId).status, "completed");
        assert.equal(registry.readMeta(oldCompletedId).status, "completed");
    });
});
