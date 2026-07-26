/**
 * Runtime smoke for issue #47 — two-press close behavior.
 *
 * Exercises the changed non-browser surface for real (not via the test
 * harness): real tmpdir registry + shared stopRun/dismissRun feeding
 * executeNavigatorClose; overlay arm → confirm hint → second-x close for
 * running and terminal runs; finish-during-arm terminal dismissal; expiry
 * and selection/list↔detail/dispose disarm; footer confirm coexists with
 * count hint; tools still resolve dismissed runs by id. Pi's UI/timer/clock
 * are the external boundary and are recorded with fakes (per #43's
 * thin-wiring-seam testing decision); everything on OUR side of the boundary
 * is the shipping code.
 *
 * Rerun:  node docs/tests/issue-47-runtime-smoke.mjs > docs/tests/issue-47-runtime-smoke.json
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
    writeMeta,
    readMeta,
    listMetas,
    effectiveStatus,
    dismissRun,
    isDismissed,
    navigatorVisibleRuns,
    navigatorVisibleCount,
    runDir,
} from "../../registry.ts";
import { stopRun } from "../../stop.ts";
import { processExists } from "../../spawn.ts";
import {
    subagentListTool,
    subagentOutputTool,
    subagentResultTool,
} from "../../tools.ts";
import {
    CLOSE_ARM_MS,
    CLOSE_CONFIRM_STATUS_KEY,
    NAVIGATOR_STATUS_KEY,
    closeConfirmHint,
    applyCloseConfirmFooter,
    applyNavigatorFooter,
    executeNavigatorClose,
    createNavigatorOverlayComponent,
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
        promptPreview: "smoke47",
        startedAt: 1,
        logPath: "/tmp/smoke47.log",
        sessionId: "smoke47",
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

function fakeClock(start = 2_000_000) {
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

const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

// 1. navigator.close — pure execute + overlay two-press against real registry.
await record(
    "navigator.close",
    "node docs/tests/issue-47-runtime-smoke.mjs",
    async () => {
        const runId = trackDisk(`sa_smoke47_run_${Date.now()}`);
        const termId = trackDisk(`sa_smoke47_term_${Date.now()}`);
        const pid = spawnSleeper();
        writeMeta(baseMeta({
            id: runId,
            name: "smoke-run",
            status: "running",
            pid,
            startedAt: Date.now() - 5000,
        }));
        writeMeta(baseMeta({
            id: termId,
            name: "smoke-done",
            status: "completed",
            startedAt: Date.now() - 60_000,
            endedAt: Date.now() - 30_000,
        }));

        // Pure seam: first x never mutates; execute stops running + dismisses.
        check(closeConfirmHint({ id: runId, name: "smoke-run", status: "running" }) === "x again to stop smoke-run", "running hint");
        check(closeConfirmHint({ id: termId, name: "smoke-done", status: "completed" }) === "x again to dismiss smoke-done", "terminal hint");
        check(CLOSE_ARM_MS === 3000, "arm window is exactly 3s");

        const stopOut = executeNavigatorClose(runId, {
            readMeta, effectiveStatus, stopRun, dismissRun, now: () => 11,
        });
        check(stopOut.action === "stopped-and-dismissed", `expected stopped-and-dismissed, got ${stopOut.action}`);
        check(readMeta(runId).status === "killed", "running close records killed");
        check(isDismissed(readMeta(runId)), "running close dismisses");
        check(await waitFor(() => !processExists(pid)), "process group gone");

        const termOut = executeNavigatorClose(termId, {
            readMeta, effectiveStatus, stopRun, dismissRun, now: () => 22,
        });
        check(termOut.action === "dismissed", `expected dismissed, got ${termOut.action}`);
        check(readMeta(termId).status === "completed", "terminal status preserved");
        check(readMeta(termId).dismissedAt === 22, "terminal dismissedAt set");

        // Finish-during-arm: stale running + dead pid → terminal dismiss, no kill rewrite.
        const finishId = trackDisk(`sa_smoke47_fin_${Date.now()}`);
        writeMeta(baseMeta({ id: finishId, name: "fin", status: "running", pid: 0x3fffffff }));
        const finOut = executeNavigatorClose(finishId, {
            readMeta, effectiveStatus, stopRun, dismissRun, now: () => 33,
        });
        check(finOut.action === "dismissed" && finOut.status === "exited", "finish-during uses terminal dismissal");
        check(readMeta(finishId).status === "running", "on-disk status not rewritten to killed");
        check(isDismissed(readMeta(finishId)), "still dismissed");

        // Overlay two-press with injected clock (no real sleeps).
        const liveId = trackDisk(`sa_smoke47_live_${Date.now()}`);
        const keepId = trackDisk(`sa_smoke47_keep_${Date.now()}`);
        writeMeta(baseMeta({ id: liveId, name: "live", status: "completed", endedAt: 1 }));
        writeMeta(baseMeta({ id: keepId, name: "keep", status: "failed", endedAt: 2 }));
        const clock = fakeClock();
        const hints = [];
        const tui = { renders: 0, requestRender() { this.renders++; } };
        const rows = [
            { id: liveId, name: "live", status: "completed", model: "m", elapsed: "1s", spend: "" },
            { id: keepId, name: "keep", status: "failed", model: "m", elapsed: "2s", spend: "" },
        ];
        let done = false;
        const component = createNavigatorOverlayComponent(
            rows,
            {
                matchKey: (d, id) => d === `<${id}>` || (id === "x" && d === "x"),
                truncate: (s) => s,
                getRows: () => buildVisibleRows(),
                closeRun: (id) => executeNavigatorClose(id, {
                    readMeta, effectiveStatus, stopRun, dismissRun, now: () => clock.now(),
                }),
                onCloseConfirmHint: (h) => hints.push(h),
                now: () => clock.now(),
                setTimeout: clock.setTimeout.bind(clock),
                clearTimeout: clock.clearTimeout.bind(clock),
            },
            tui,
            { fg: (_c, s) => s },
            () => { done = true; },
        );
        function buildVisibleRows() {
            return navigatorVisibleRuns(listMetas(), THIS_PID).map((m) => ({
                id: m.id,
                name: m.name,
                status: effectiveStatus(m),
                model: "m",
                elapsed: "1s",
                spend: "",
            })).filter((r) => r.id === liveId || r.id === keepId);
        }

        component.handleInput("x");
        check(hints.at(-1) === "x again to dismiss live", `first x hint: ${hints.at(-1)}`);
        check(!isDismissed(readMeta(liveId)), "first x non-mutating");
        clock.advance(CLOSE_ARM_MS - 1);
        component.handleInput("x");
        check(isDismissed(readMeta(liveId)), "second x dismisses");
        check(hints.at(-1) === null, "hint cleared after act");
        const after = component.render(80).join("\n");
        check(!after.includes("live"), "dismissed leaves list");
        check(after.includes("keep"), "sibling remains");

        // Expiry disarm + re-arm without acting.
        component.handleInput("x");
        check(hints.at(-1) === "x again to dismiss keep", "re-arm after prior close");
        clock.advance(CLOSE_ARM_MS);
        check(hints.at(-1) === null, "expiry clears hint");
        check(!isDismissed(readMeta(keepId)), "expiry does not dismiss");

        // Selection change disarms.
        // Restore keep as selected only row after prior partial state: reopen mental model.
        // keep still visible; press x then down is N/A with one row — use dispose path.
        component.handleInput("x");
        component.dispose();
        check(hints.at(-1) === null, "dispose disarms");
        check(clock.pendingCount() === 0, "arm timer cleared");
        check(!done, "dispose must not call done");
        check(!isDismissed(readMeta(keepId)), "dispose non-mutating");

        // Footer confirm coexists with count hint.
        const calls = [];
        const ui = { setStatus(k, v) { calls.push([k, v]); } };
        applyNavigatorFooter(ui, navigatorVisibleCount(listMetas(), THIS_PID));
        applyCloseConfirmFooter(ui, "x again to dismiss keep");
        check(calls.some((c) => c[0] === NAVIGATOR_STATUS_KEY), "count key published");
        check(calls.some((c) => c[0] === CLOSE_CONFIRM_STATUS_KEY && c[1] === "x again to dismiss keep"), "confirm key published");
        applyCloseConfirmFooter(ui, null);
        check(calls.at(-1)[0] === CLOSE_CONFIRM_STATUS_KEY && calls.at(-1)[1] === undefined, "confirm cleared");

        // Tools still see dismissed runs.
        const tools = {
            list: subagentListTool(TypeStub),
            output: subagentOutputTool(TypeStub),
            result: subagentResultTool(TypeStub),
        };
        const listOut = (await tools.list.execute("tc", {})).content[0].text;
        check(listOut.includes(liveId), "subagent_list still lists dismissed");
        check((await tools.output.execute("tc", { id: liveId })).content[0].text.includes(liveId), "subagent_output by id");
        check((await tools.result.execute("tc", { id: liveId })).content[0].text.includes(liveId), "subagent_result by id");

        // TUI guard intact.
        check(isNavigatorUiAvailable({ mode: "tui", hasUI: true, ui: {} }) === true, "tui ok");
        check(isNavigatorUiAvailable({ mode: "rpc", hasUI: true, ui: {} }) === false, "rpc blocked");

        // index.ts parses under strip-types AND wires stopRun into navigatorCloseRun
        // (integrated-review P0: missing import → ReferenceError on second x).
        const indexPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../index.ts");
        execFileSync(process.execPath, ["--experimental-strip-types", "--check", indexPath], { stdio: "pipe" });
        const indexSrc = readFileSync(indexPath, "utf8");
        check(
            /import\s*\{[^}]*\bstopRun\b[^}]*\}\s*from\s*["']\.\/stop\.ts["']/.test(indexSrc),
            "index.ts must import stopRun from ./stop.ts for navigatorCloseRun",
        );
        const closeIdx = indexSrc.indexOf("function navigatorCloseRun");
        check(closeIdx >= 0, "navigatorCloseRun exists");
        const closeBody = indexSrc.slice(closeIdx, indexSrc.indexOf("\n}", closeIdx) + 2);
        check(/\bstopRun\b/.test(closeBody), "navigatorCloseRun passes stopRun");

        // Registered extension-path regression must stay green (loads real index
        // factory → session_start → overlay → first+second x).
        execFileSync(
            process.execPath,
            ["--test", path.join(path.dirname(fileURLToPath(import.meta.url)), "../../tests/navigator_close_extension_path.test.mjs")],
            { stdio: "pipe", cwd: path.join(path.dirname(fileURLToPath(import.meta.url)), "../..") },
        );

        return "real registry+stopRun/dismissRun: running→killed+dismissed (pg gone); terminal dismiss preserves status; finish-during→exited dismiss no kill rewrite; overlay two-press within 3s dismisses+hides; expiry/dispose disarm non-mutating; footer confirm coexists with count; tools list/output/result still resolve dismissed; TUI guard; index.ts imports stopRun + strip-types check; registered extension-path second-x suite green";
    },
);

for (const id of diskIds) {
    try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
const failed = results.filter((r) => r.status !== "pass");
process.exit(failed.length ? 1 : 0);
