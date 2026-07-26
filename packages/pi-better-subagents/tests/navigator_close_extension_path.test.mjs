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
};
`,
    });
    writeStubPackage("@earendil-works/pi-coding-agent", {
        "index.js": `
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
export const Key = { left: "left", x: "x", X: "X", up: "up", down: "down", enter: "enter", escape: "escape" };
export function matchesKey(data, key) {
    if (data == null || key == null) return false;
    if (data === key) return true;
    if (data === \`<\${key}>\`) return true;
    return false;
}
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
function bootRegisteredNavigator(mod, { writeMeta, metaBase }) {
    const handlers = {};
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
    };

    const pi = {
        registerTool() {},
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
            assert.ok(component, "enter on focused widget row must open navigator detail overlay");
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
        pressX() { editor.handleInput("x"); },
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

    // @covers navigator.close
    // @level integration
    it("source wiring imports stopRun for navigatorCloseRun (guards the ReferenceError class)", async () => {
        const { readFileSync } = await import("node:fs");
        const src = readFileSync(join(REPO_ROOT, "index.ts"), "utf8");
        assert.match(
            src,
            /import\s*\{[^}]*\bstopRun\b[^}]*\}\s*from\s*["']\.\/stop\.ts["']/,
            "index.ts must import stopRun from ./stop.ts",
        );
        const closeIdx = src.indexOf("function navigatorCloseRun");
        assert.ok(closeIdx >= 0, "navigatorCloseRun must exist");
        const closeBody = src.slice(closeIdx, src.indexOf("\n}", closeIdx) + 2);
        assert.match(closeBody, /\bstopRun\b/, "navigatorCloseRun must pass stopRun into executeNavigatorClose");
    });

    // @covers navigator.close
    // @level integration
    it("registered TUI path left focuses widget list and enter opens selected running detail", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        const affordancePid = spawnSleeper();
        const affordanceId = nav.seedRun({
            id: trackDisk(`sa_t47_ext_term_afford_${Date.now()}`),
            name: "live-affordance",
            status: "running",
            pid: affordancePid,
            startedAt: 50,
        });
        const id = nav.seedRun({
            id: trackDisk(`sa_t47_ext_term_${Date.now()}`),
            name: "done-job",
            status: "completed",
            startedAt: 100,
            endedAt: 99,
        });

        try {
            await nav.start();
            nav.focusViaLeftKey();
            const focused = nav.lastWidget("subagents");
            assert.ok(Array.isArray(focused), "left focuses the main widget list, not the overlay");
            assert.ok(focused[0].includes("<muted>Enter to view · x to stop</>"), "focused widget shows main-list actions");
            assert.ok(focused.some((line) => String(line).startsWith("› ") && String(line).includes("live-affordance")), "running row is selected");

            const component = await nav.openDetailViaEnter();
            const text = component.render(80).join("\n").replace(/<\/?[a-z]*>/g, "");
            assert.ok(text.includes("live-affordance"), text);
            assert.equal(processExists(affordancePid), true, "enter must not stop the selected run");
            const back = registry.readMeta(id);
            assert.equal(back.status, "completed", "terminal status preserved");
            assert.equal(back.dismissedAt, undefined, "terminal row is not dismissed by main running-list navigation");
        } finally {
            registry.dismissRun(affordanceId);
            try { process.kill(-affordancePid, "SIGTERM"); } catch { try { process.kill(affordancePid, "SIGTERM"); } catch { /* ignore */ } }
        }
    });

    // @covers navigator.close
    // @level integration
    it("running run: registered TUI main-list x stops via shared stopRun and dismisses", async () => {
        const nav = bootRegisteredNavigator(mod, { writeMeta: registry.writeMeta, metaBase });
        const pid = spawnSleeper();
        const id = nav.seedRun({
            id: trackDisk(`sa_t47_ext_run_${Date.now()}`),
            name: "live-job",
            status: "running",
            pid,
        });

        await nav.start();
        nav.focusViaLeftKey();

        nav.pressX();
        let back = registry.readMeta(id);
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
});
