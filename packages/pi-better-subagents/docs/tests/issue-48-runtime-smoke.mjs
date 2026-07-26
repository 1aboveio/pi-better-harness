/**
 * Runtime smoke for issue #48 — navigator hardening (render/reload/lifecycle/docs).
 *
 * Exercises the changed non-browser surface for real (not via the test harness):
 * applyNavigatorRows selection stability; list/detail narrow truncation after
 * style strip; overlay dismiss clamp; editor install reload dedupe; tracked
 * dispose clearing detail + close-arm timers; footer count/confirm clear;
 * registered session_start reload path (real extension factory → open →
 * detail+arm → second session_start); TUI guard; index/navigator strip-types
 * parse. Pi UI/timer/clock are the external boundary (faked per #43);
 * everything on OUR side is shipping code.
 *
 * Rerun:  node docs/tests/issue-48-runtime-smoke.mjs > docs/tests/issue-48-runtime-smoke.json
 */
import { execFileSync } from "node:child_process";
import { rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
    writeMeta,
    listMetas,
    effectiveStatus,
    dismissRun,
    navigatorVisibleRuns,
    navigatorVisibleCount,
    runDir,
} from "../../registry.ts";
import {
    NAVIGATOR_STATUS_KEY,
    CLOSE_CONFIRM_STATUS_KEY,
    CLOSE_ARM_MS,
    applyNavigatorFooter,
    applyCloseConfirmFooter,
    applyNavigatorRows,
    createNavigatorState,
    buildNavigatorLines,
    buildDetailLines,
    createNavigatorOverlayComponent,
    openTrackedNavigator,
    disposeTrackedNavigator,
    installNavigatorEditor,
    NAVIGATOR_FACTORY_MARK,
    isNavigatorUiAvailable,
} from "../../navigator.ts";

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
        promptPreview: "smoke48",
        startedAt: 1,
        logPath: "/tmp/smoke48.log",
        sessionId: "smoke48",
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

const truncate = (s, w) => (s.length > w ? s.slice(0, Math.max(0, w)) : s);
const stripStyle = (s) => String(s).replace(/<\/?[a-z]*>/g, "");

function fakeClock(start = 3_000_000) {
    let now = start;
    let nextId = 1;
    const timeouts = new Map();
    return {
        now: () => now,
        advance(ms) {
            now += ms;
            const due = [...timeouts.entries()]
                .filter(([, t]) => !t.cleared && t.fireAt <= now)
                .sort((a, b) => a[1].fireAt - b[1].fireAt);
            for (const [id, t] of due) {
                timeouts.delete(id);
                t.fn();
            }
        },
        setTimeout(fn, ms) {
            const id = nextId++;
            timeouts.set(id, { fn, fireAt: now + ms, cleared: false });
            return id;
        },
        clearTimeout(id) {
            const t = timeouts.get(id);
            if (t) t.cleared = true;
            timeouts.delete(id);
        },
        pendingCount() {
            return [...timeouts.values()].filter((t) => !t.cleared).length;
        },
    };
}

function fakeTimers() {
    const intervals = new Map();
    let nextId = 1;
    return {
        setInterval(fn, ms) {
            const id = nextId++;
            intervals.set(id, { fn, ms });
            return id;
        },
        clearInterval(id) { intervals.delete(id); },
        activeCount: () => intervals.size,
    };
}

await record(
    "navigator.hardening",
    "node docs/tests/issue-48-runtime-smoke.mjs",
    async () => {
        // --- selection stability (pure seam) ---
        const state = createNavigatorState([
            { id: "a", name: "a", status: "running", model: "m", elapsed: "1s", spend: "" },
            { id: "b", name: "b", status: "running", model: "m", elapsed: "2s", spend: "" },
            { id: "c", name: "c", status: "completed", model: "m", elapsed: "3s", spend: "" },
        ]);
        state.selected = 1; // b
        applyNavigatorRows(state, [
            { id: "b", name: "b", status: "completed", model: "m", elapsed: "9s", spend: "" },
            { id: "c", name: "c", status: "completed", model: "m", elapsed: "3s", spend: "" },
            { id: "a", name: "a", status: "running", model: "m", elapsed: "2s", spend: "" },
        ]);
        check(state.rows[state.selected].id === "b", "selection stable by id across reorder/status refresh");
        applyNavigatorRows(state, [
            { id: "c", name: "c", status: "completed", model: "m", elapsed: "3s", spend: "" },
            { id: "a", name: "a", status: "running", model: "m", elapsed: "2s", spend: "" },
        ]);
        check(state.rows[state.selected].id !== "b", "selection clamped after disappear");
        check(state.selected >= 0 && state.selected < state.rows.length, "selection in range");

        // --- narrow list + detail (post style-strip) ---
        const longRows = [{
            id: "sa_long",
            name: "n".repeat(200),
            status: "running",
            model: "model-with-long-name",
            elapsed: "12m 34s",
            spend: "tok ".repeat(50),
        }];
        for (const w of [10, 20, 37, 80]) {
            for (const line of buildNavigatorLines(createNavigatorState(longRows), { width: w, truncate })) {
                check(line.length <= w, `list plain exceeds ${w}`);
            }
            const detailLines = buildDetailLines({
                id: "sa_long",
                name: "n".repeat(200),
                status: "running",
                model: "m",
                elapsed: "1s",
                currentTool: "tool-".repeat(20),
                spend: "s".repeat(100),
                output: ("o".repeat(120) + "\n").repeat(3),
            }, { width: w, truncate });
            for (const line of detailLines) check(line.length <= w, `detail plain exceeds ${w}`);
        }
        const styledTimers = fakeTimers();
        const styled = createNavigatorOverlayComponent(
            longRows,
            {
                matchKey: (d, id) => d === `<${id}>`,
                truncate,
                getDetail: () => ({
                    id: "sa_long", name: "n".repeat(200), status: "running", model: "m",
                    elapsed: "1s", spend: "s".repeat(80), tools: "t".repeat(80), output: "o".repeat(200),
                }),
                setInterval: styledTimers.setInterval,
                clearInterval: styledTimers.clearInterval,
            },
            { requestRender() {} },
            { fg: (c, s) => `<${c}>${s}</>` },
            () => {},
        );
        for (const w of [20, 37]) {
            for (const line of styled.render(w)) {
                check(stripStyle(line).length <= w, `styled list exceeds ${w}`);
            }
            styled.handleInput("<enter>");
            for (const line of styled.render(w)) {
                check(stripStyle(line).length <= w, `styled detail exceeds ${w}`);
            }
            styled.handleInput("<left>");
        }
        styled.dispose();

        // --- real registry visibility + overlay dismiss clamp ---
        const keepId = trackDisk(`sa_smoke48_keep_${Date.now()}`);
        const dropId = trackDisk(`sa_smoke48_drop_${Date.now()}`);
        writeMeta(baseMeta({ id: keepId, name: "keep", status: "completed", endedAt: 2 }));
        writeMeta(baseMeta({ id: dropId, name: "drop", status: "completed", endedAt: 3 }));
        check(navigatorVisibleRuns(listMetas(), THIS_PID).some((m) => m.id === dropId), "drop visible before");
        const clock = fakeClock();
        const timers = fakeTimers();
        const hints = [];
        const closed = new Set();
        const getRows = () => navigatorVisibleRuns(listMetas(), THIS_PID)
            .filter((m) => m.id === keepId || m.id === dropId)
            .filter((m) => !closed.has(m.id))
            .map((m) => ({
                id: m.id, name: m.name, status: effectiveStatus(m),
                model: "m", elapsed: "1s", spend: "",
            }));
        const component = createNavigatorOverlayComponent(
            getRows(),
            {
                matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
                truncate,
                getRows,
                closeRun: (id) => {
                    dismissRun(id, clock.now());
                    closed.add(id);
                    return { action: "dismissed", id, status: "completed" };
                },
                onCloseConfirmHint: (h) => hints.push(h),
                now: () => clock.now(),
                setTimeout: clock.setTimeout.bind(clock),
                clearTimeout: clock.clearTimeout.bind(clock),
                setInterval: timers.setInterval,
                clearInterval: timers.clearInterval,
            },
            { requestRender() {} },
            { fg: (_c, s) => s },
            () => {},
        );
        // Select drop (second row if newest-first puts drop first — pick by keying down until selected).
        let plain = component.render(80).join("\n");
        if (!plain.split("\n").some((l) => l.startsWith("> ") && l.includes("drop"))) {
            component.handleInput("<down>");
        }
        component.handleInput("x");
        check(hints.at(-1) === "x again to dismiss drop", `arm hint: ${hints.at(-1)}`);
        component.handleInput("x");
        check(closed.has(dropId), "drop dismissed");
        plain = component.render(80).join("\n");
        check(!plain.includes("drop"), "drop gone from list");
        check(plain.includes("keep"), "keep remains");
        check(plain.split("\n").some((l) => l.startsWith("> ") && l.includes("keep")), "selection clamped to keep");
        check(hints.at(-1) === null, "confirm cleared after dismiss");

        // --- editor reload dedupe ---
        const uiEd = {
            factory: undefined,
            sets: 0,
            getEditorComponent() { return this.factory; },
            setEditorComponent(f) { this.factory = f; this.sets++; },
        };
        const inner = { text: "", inputs: [], getText() { return this.text; }, handleInput(d) { this.inputs.push(d); } };
        const LEFT = "\x1b[D";
        let opens = 0;
        installNavigatorEditor(uiEd, {
            createDefaultEditor: () => inner,
            isOpenTrigger: (d) => d === LEFT,
            canOpen: () => true,
            onOpen: () => { opens += 1; },
        });
        const ed = uiEd.factory("t", "th", "kb");
        installNavigatorEditor(uiEd, {
            createDefaultEditor: () => { throw new Error("no rebuild"); },
            isOpenTrigger: (d) => d === LEFT,
            canOpen: () => true,
            onOpen: () => { opens += 10; },
        });
        check(uiEd.sets === 1, "reload does not stack setEditorComponent");
        check(uiEd.factory[NAVIGATOR_FACTORY_MARK] === true, "factory marked");
        ed.handleInput(LEFT);
        check(opens === 10, "refreshed deps drive existing wrapper once");
        check(inner.inputs.length === 0, "single interception layer");

        // --- tracked dispose clears detail + arm timers ---
        const slot = { v: undefined, get() { return this.v; }, set(x) { this.v = x; } };
        const clock2 = fakeClock();
        const timers2 = fakeTimers();
        const hints2 = [];
        let comp2;
        const ui = {
            custom(factory) {
                return new Promise((resolve) => {
                    comp2 = factory({ requestRender() {} }, { fg: (_c, s) => s }, {}, (v) => resolve(v));
                });
            },
        };
        openTrackedNavigator(ui, [{ id: keepId, name: "keep", status: "running", model: "m", elapsed: "1s", spend: "" }], {
            matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
            truncate,
            getDetail: () => ({ id: keepId, name: "keep", status: "running", model: "m", elapsed: "1s", spend: "", tools: "bash", output: "live" }),
            onCloseConfirmHint: (h) => hints2.push(h),
            now: () => clock2.now(),
            setTimeout: clock2.setTimeout.bind(clock2),
            clearTimeout: clock2.clearTimeout.bind(clock2),
            setInterval: timers2.setInterval,
            clearInterval: timers2.clearInterval,
            tickMs: 1000,
        }, slot);
        check(typeof slot.get() === "function", "dispose captured");
        comp2.handleInput("<enter>");
        comp2.handleInput("x");
        check(timers2.activeCount() === 1, "detail timer live");
        check(clock2.pendingCount() === 1, "arm timer live");
        disposeTrackedNavigator(slot);
        check(timers2.activeCount() === 0, "detail timer cleared on teardown");
        check(clock2.pendingCount() === 0, "arm timer cleared on teardown");
        check(hints2.at(-1) === null, "confirm cleared on teardown");
        check(CLOSE_ARM_MS === 3000, "arm window still 3s");

        // --- footer clear paths ---
        const calls = [];
        const fui = { setStatus(k, v) { calls.push([k, v]); } };
        applyNavigatorFooter(fui, navigatorVisibleCount(listMetas(), THIS_PID));
        applyCloseConfirmFooter(fui, "x again to dismiss keep");
        applyCloseConfirmFooter(fui, null);
        applyNavigatorFooter(fui, 0);
        check(calls.some((c) => c[0] === NAVIGATOR_STATUS_KEY), "count key used");
        check(calls.some((c) => c[0] === CLOSE_CONFIRM_STATUS_KEY && c[1] === undefined), "confirm cleared");
        check(calls.at(-1)[0] === NAVIGATOR_STATUS_KEY && calls.at(-1)[1] === undefined, "count cleared at 0");

        // --- registered session_start reload path (behavior, not source scan) ---
        // Loads real index.ts factory → session_start → empty-editor ← → detail +
        // close-arm → second session_start; asserts timers/confirm clear, editor
        // does not stack, footer republishes. Replaces source-token scanning.
        const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../index.ts");
        execFileSync(
            process.execPath,
            ["--test", path.join(path.dirname(fileURLToPath(import.meta.url)), "../../tests/navigator_reload_extension_path.test.mjs")],
            { stdio: "pipe", cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), "../..") },
        );

        // --- TUI guard ---
        check(isNavigatorUiAvailable({ mode: "tui", hasUI: true, ui: {} }) === true, "tui ok");
        check(isNavigatorUiAvailable({ mode: "rpc", hasUI: true, ui: {} }) === false, "rpc blocked");
        check(isNavigatorUiAvailable({ mode: "print" }) === false, "print blocked");

        // --- parse check ---
        const navPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../navigator.ts");
        execFileSync(process.execPath, ["--experimental-strip-types", "--check", indexPath], { stdio: "pipe" });
        execFileSync(process.execPath, ["--experimental-strip-types", "--check", navPath], { stdio: "pipe" });

        // --- README controls ---
        const readme = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../README.md"), "utf8");
        check(/Subagent navigator/i.test(readme), "README has navigator section");
        check(/two-press|x again/i.test(readme), "README documents two-press x");
        check(/dismiss/i.test(readme) && /subagent_list/i.test(readme), "README documents dismiss + tools");

        return "applyNavigatorRows keep-by-id + clamp; list/detail narrow post style-strip; overlay dismiss clamp; editor reload dedupe; dispose clears detail+arm timers+confirm; footer count/confirm clear; registered session_start reload disposes timers+confirm, no editor stack, republishes footer; TUI guard; strip-types index+navigator; README controls";
    },
);

for (const id of diskIds) {
    try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => r.status !== "pass");
process.exit(failed.length ? 1 : 0);
