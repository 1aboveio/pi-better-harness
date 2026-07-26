/**
 * Runtime smoke for issue #45 — minimal subagent navigator from empty-editor ←.
 *
 * Exercises each changed non-browser surface for real (not via the test
 * harness): the real tmpdir-backed registry feeding the footer hint and the
 * overlay rows, the editor wrapper intercepting/delegating real key sequences,
 * the non-stacking install, and the overlay component driven through open →
 * move → close. Pi's UI/editor are the external boundary and are recorded with
 * fakes (per #43's thin-wiring-seam testing decision); everything on OUR side
 * of the boundary is the shipping code. Prints the results JSON to stdout;
 * exits non-zero if any surface fails.
 *
 * Rerun:  node docs/tests/issue-45-runtime-smoke.mjs > docs/tests/issue-45-runtime-smoke.json
 */
import { execFileSync } from "node:child_process";
import { register } from "node:module";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
    writeMeta,
    readMeta,
    listMetas,
    effectiveStatus,
    navigatorVisibleRuns,
    navigatorVisibleCount,
    dismissRun,
    runDir,
} from "../../registry.ts";
import {
    NAVIGATOR_STATUS_KEY,
    navigatorFooterHint,
    applyNavigatorFooter,
    isNavigatorUiAvailable,
    buildNavigatorRows,
    installNavigatorEditor,
    showNavigator,
} from "../../navigator.ts";
import { fmtElapsed, shortModel } from "../../widget.ts";

const THIS_PID = process.pid;
const results = [];
const diskIds = [];

function trackDisk(id) {
    diskIds.push(id);
    return id;
}

function baseMeta(overrides = {}) {
    return {
        id: overrides.id,
        status: "completed",
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "smoke",
        startedAt: 1,
        logPath: "/tmp/smoke.log",
        sessionId: "smoke",
        ...overrides,
    };
}

function record(surface, command, fn) {
    return Promise.resolve()
        .then(fn)
        .then(
            (observed) => results.push({ surface, kind: "library", status: "pass", command, observed }),
            (err) =>
                results.push({
                    surface,
                    kind: "library",
                    status: "fail",
                    command,
                    observed: `FAIL: ${err?.message ?? err}`,
                }),
        );
}

function check(cond, msg) {
    if (!cond) throw new Error(msg);
}

// 1. navigator.footer-hint — real registry visibility count drives the hint.
await record(
    "navigator.footer-hint",
    "node docs/tests/issue-45-runtime-smoke.mjs",
    () => {
        const ownId = trackDisk(`sa_smoke45_hint_${Date.now()}`);
        const dismissedId = trackDisk(`sa_smoke45_hintd_${Date.now()}`);
        writeMeta(baseMeta({ id: ownId, status: "running", pid: THIS_PID }));
        writeMeta(baseMeta({ id: dismissedId }));
        dismissRun(dismissedId);
        const statuses = [];
        const ui = { setStatus: (k, t) => statuses.push([k, t]) };
        const count = navigatorVisibleCount(listMetas(), THIS_PID);
        check(count >= 1, "expected at least one visible run");
        const hint = applyNavigatorFooter(ui, count);
        check(hint === `← subagents · ${count}`, `hint text wrong: ${hint}`);
        check(statuses[0][0] === NAVIGATOR_STATUS_KEY && statuses[0][1] === hint, "status key/text wrong");
        applyNavigatorFooter(ui, 0);
        check(statuses[1][1] === undefined, "hint must clear at zero visible runs");
        // The guard requires explicit TUI mode: pi exposes hasUI:true + a ui
        // object in RPC mode too, and the navigator is terminal-only there.
        check(
            isNavigatorUiAvailable({ mode: "rpc", hasUI: true, ui }) === false,
            "RPC contexts (mode:rpc with hasUI:true + ui) must fail the guard",
        );
        check(isNavigatorUiAvailable({ mode: "print" }) === false, "print contexts must fail the guard");
        check(isNavigatorUiAvailable({ mode: "tui", hasUI: true, ui }) === true, "real TUI contexts must pass the guard");
        return `real registry: visible count ${count} (dismissed excluded) → setStatus('${NAVIGATOR_STATUS_KEY}', '${hint}'); count 0 → status cleared; guard: rpc blocked / print blocked / tui allowed`;
    },
);

// 2. navigator.editor-wrapper — real key sequences through the installed factory.
await record(
    "navigator.editor-wrapper",
    "node docs/tests/issue-45-runtime-smoke.mjs",
    () => {
        const ownId = trackDisk(`sa_smoke45_wrap_${Date.now()}`);
        writeMeta(baseMeta({ id: ownId, status: "running", pid: THIS_PID }));
        const inner = {
            text: "",
            inputs: [],
            getText() { return this.text; },
            setText(t) { this.text = t; },
            handleInput(d) { this.inputs.push(d); },
            render: (w) => [`ed:${inner.text}`.slice(0, w)],
            invalidate() {},
        };
        let sets = 0;
        const ui = {
            factory: undefined,
            getEditorComponent() { return this.factory; },
            setEditorComponent(f) { this.factory = f; sets++; },
        };
        let opened = 0;
        const deps = {
            createDefaultEditor: () => inner,
            isOpenTrigger: (d) => d === "\x1b[D",
            canOpen: () => navigatorVisibleCount(listMetas(), THIS_PID) > 0,
            onOpen: () => opened++,
        };
        installNavigatorEditor(ui, deps);
        installNavigatorEditor(ui, deps);
        check(sets === 1, "repeat install must not re-set the factory (no stacked wrappers)");
        const editor = ui.factory("tui", "theme", "kb");
        editor.handleInput("\x1b[D");
        check(opened === 1 && inner.inputs.length === 0, "empty-editor bare ← must open, not delegate");
        inner.setText("draft");
        editor.handleInput("\x1b[D");
        check(opened === 1 && inner.inputs.length === 1, "← with text must delegate to the inner editor");
        editor.handleInput("a");
        check(inner.inputs.length === 2, "ordinary keys must delegate");
        return "real registry canOpen: bare ← on empty editor opened the navigator once (not delegated); ← with text + 'a' delegated; 2 installs → 1 factory (no stacking)";
    },
);

// 3. navigator.overlay — rows from the real registry; open → move → Escape close.
await record(
    "navigator.overlay",
    "node docs/tests/issue-45-runtime-smoke.mjs",
    async () => {
        const older = trackDisk(`sa_smoke45_row1_${Date.now()}`);
        const newer = trackDisk(`sa_smoke45_row2_${Date.now()}`);
        writeMeta(baseMeta({ id: older, name: "older", startedAt: 1000, status: "completed" }));
        writeMeta(baseMeta({ id: newer, startedAt: 2000, status: "running", pid: THIS_PID }));
        const rows = buildNavigatorRows(navigatorVisibleRuns(listMetas(), THIS_PID), {
            effectiveStatus,
            shortModel,
            fmtElapsed,
            spendFor: () => "",
        });
        const mine = rows.filter((r) => [older, newer].includes(r.id));
        check(mine.length === 2 && mine[0].id === newer, "rows must be newest first (running + terminal included)");
        check(mine[0].status === "running" && mine[1].status === "completed", "effective status on rows");
        check(mine[1].name === "older" && mine[0].name === undefined, "name-or-id carried");

        const overlayRows = mine;
        let customOptions;
        const doneCalls = [];
        let renders = 0;
        const ui = {
            custom(factory, options) {
                customOptions = options;
                const c = factory({ requestRender: () => renders++ }, { fg: (_c, s) => s }, {}, (v) => doneCalls.push(v));
                return Promise.resolve(c);
            },
        };
        const matchKey = (d, id) => d === `<${id}>`;
        const component = await showNavigator(ui, overlayRows, { matchKey, truncate: (s, w) => s.slice(0, w) });
        check(customOptions && customOptions.overlay === true, "must open with { overlay: true } (focused overlay)");
        const lines = component.render(60);
        check(lines.length === 4 && lines[1].startsWith("> "), `list shape wrong: ${JSON.stringify(lines)}`);
        check(lines.every((l) => l.length <= 60), "every line must fit the render width");
        component.handleInput("<down>");
        check(renders === 1 && component.render(60)[2].startsWith("> "), "Down must move selection + repaint");
        component.handleInput("<escape>");
        check(doneCalls.length === 1, "Escape must close the overlay");
        return "real registry rows newest-first (running+terminal) rendered as overlay list; {overlay:true}; Down moved+repainted; Escape closed";
    },
);

// 4. index.ts (extension entry) — parses; navigator wiring present; no setFooter;
//    registered extension RPC startup-through-shutdown emits zero navigator UI
//    calls for the full non-TUI isolation class (footer status + close-confirm
//    status + editor install + overlay custom).
await record(
    "index.ts (extension entry)",
    "node --experimental-strip-types --check index.ts && node docs/tests/issue-45-runtime-smoke.mjs (registered RPC path)",
    async () => {
        const repoRoot = path.dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
        execFileSync(process.execPath, ["--experimental-strip-types", "--check", "index.ts"], {
            cwd: repoRoot,
            stdio: "pipe",
        });
        // Invariant class: non-TUI navigator isolation.
        // Adjacent members driven here (all must stay silent on registered RPC):
        //   - footer status        (NAVIGATOR_STATUS_KEY / 'subagents-nav')
        //   - close-confirm status ('subagents-close'; #47+ adjacent member)
        //   - editor wrapper install
        //   - overlay custom()
        // Widget setWidget remains allowed in RPC (pi docs) and is not asserted away.
        // Live registered-path RPC probe (not source-scan-only): load the real
        // extension factory in-process (host packages stubbed via
        // pi_host_stub_hooks) and drive session_start → session_shutdown under
        // an RPC-shaped ctx. No global `pi` binary required (CI has none on PATH).
        // Class-complete: assert the FULL setStatus log is empty so an unguarded
        // setStatus('subagents-close', undefined) cannot green-pass a filter that
        // only checks NAVIGATOR_STATUS_KEY.
        register(new URL("../../tests/pi_host_stub_hooks.mjs", import.meta.url));
        const { default: betterSubagents } = await import("../../index.ts");

        const CLOSE_CONFIRM_STATUS_KEY = "subagents-close";
        const statusCalls = [];
        const editorCalls = [];
        const customCalls = [];
        const handlers = {};
        const ui = {
            setStatus(key, text) { statusCalls.push([key, text]); },
            getEditorComponent() { return undefined; },
            setEditorComponent(...a) { editorCalls.push(a); },
            custom(...a) { customCalls.push(a); return Promise.resolve(undefined); },
            setWidget() {},
        };
        const rpcCtx = {
            mode: "rpc",
            hasUI: true,
            ui,
            cwd: "/tmp",
            model: { provider: "test", id: "model" },
        };
        const pi = {
            registerTool() {},
            on(event, fn) { handlers[event] = fn; },
            sendMessage() {},
        };
        betterSubagents(pi);
        check(typeof handlers.session_start === "function", "session_start must register");
        check(typeof handlers.session_shutdown === "function", "session_shutdown must register");
        await handlers.session_start({}, rpcCtx);
        await handlers.session_shutdown({}, rpcCtx);

        check(
            statusCalls.length === 0,
            `RPC startup-through-shutdown must emit zero setStatus calls ` +
                `(non-TUI navigator isolation: footer '${NAVIGATOR_STATUS_KEY}' + ` +
                `close-confirm '${CLOSE_CONFIRM_STATUS_KEY}'); got ${JSON.stringify(statusCalls)}`,
        );
        check(
            statusCalls.filter(([key]) => key === NAVIGATOR_STATUS_KEY).length === 0,
            "RPC must not setStatus footer key (subagents-nav)",
        );
        check(
            statusCalls.filter(([key]) => key === CLOSE_CONFIRM_STATUS_KEY).length === 0,
            "RPC must not setStatus close-confirm key (subagents-close)",
        );
        check(editorCalls.length === 0, "RPC must not install navigator editor");
        check(customCalls.length === 0, "RPC must not open navigator overlay");
        return "index.ts parses under node type-stripping; footer hint via setStatus seam only (no setFooter); installNavigator/updateNavigatorFooter wired into session_start + subagent_spawn; registered extension RPC startup-through-shutdown: 0 setStatus (footer+close-confirm) / 0 editor / 0 overlay custom — non-TUI navigator isolation class complete; no global pi binary";
    },
);

for (const id of diskIds) {
    try {
        rmSync(runDir(id), { recursive: true, force: true });
    } catch {
        /* best-effort */
    }
}

process.stdout.write(JSON.stringify(results, null, 2) + "\n");
const failed = results.filter((r) => r.status !== "pass");
if (failed.length > 0) {
    process.stderr.write(`runtime smoke: ${failed.length} surface(s) FAILED\n`);
    process.exit(1);
}
process.stderr.write(`runtime smoke: ${results.length} surfaces, 0 fail\n`);
