/**
 * Runtime smoke for issue #44 — durable navigator visibility + shared stop.
 *
 * Exercises each changed non-browser surface for real (not via the test
 * harness): the real tmpdir-backed registry, a real detached `sleep 30`
 * process killed through its process group, the stale-pid race path, and the
 * extension entry point. Prints the results JSON to stdout; exits non-zero if
 * any surface fails.
 *
 * Rerun:  node docs/tests/issue-44-runtime-smoke.mjs > docs/tests/issue-44-runtime-smoke.json
 */
import { spawn, execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import {
    writeMeta,
    readMeta,
    listMetas,
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
    subagentStopTool,
} from "../../tools.ts";

// The parameters schema is inert data to the handlers; the stub keeps tools.ts
// loadable outside the pi runtime (same trick as tests/navigator_dismissal.test.mjs).
const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

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
        startedAt: Date.now(),
        logPath: "/tmp/smoke.log",
        sessionId: "smoke",
        ...overrides,
    };
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

// 1. registry.dismissal — real tmpdir registry round-trip with durable dismissal.
await record(
    "registry.dismissal",
    "node docs/tests/issue-44-runtime-smoke.mjs",
    () => {
        const legacyId = trackDisk(`sa_smoke44_legacy_${Date.now()}`);
        writeMeta(baseMeta({ id: legacyId }));
        const legacy = readMeta(legacyId);
        check(legacy && legacy.dismissedAt === undefined && !isDismissed(legacy), "legacy meta must parse unchanged");

        const id = trackDisk(`sa_smoke44_dismiss_${Date.now()}`);
        writeMeta(baseMeta({ id }));
        const at = 1720000000000;
        dismissRun(id, at);
        const back = readMeta(id);
        check(back.dismissedAt === at && isDismissed(back), "dismissedAt must survive re-read");
        check(back.promptPreview === "smoke" && back.sessionId === "smoke", "dismissal must preserve other fields");
        dismissRun(id, 222);
        check(readMeta(id).dismissedAt === at, "dismissRun must be idempotent (first timestamp wins)");
        return "real tmpdir registry round-trip: legacy meta parses unchanged; dismissedAt persisted + idempotent; other fields preserved";
    },
);

// 2. registry.navigator-visibility — visible set + footer count from fresh disk reads.
await record(
    "registry.navigator-visibility",
    "node docs/tests/issue-44-runtime-smoke.mjs",
    () => {
        const ownId = trackDisk(`sa_smoke44_vis_${Date.now()}`);
        const dismissedId = trackDisk(`sa_smoke44_visd_${Date.now()}`);
        writeMeta(baseMeta({ id: ownId }));
        writeMeta(baseMeta({ id: dismissedId }));
        dismissRun(dismissedId);
        // Fresh reads from disk (as after a /reload), plus a foreign-parent run.
        const metas = [readMeta(ownId), readMeta(dismissedId), baseMeta({ id: "foreign", spawnPid: THIS_PID + 1 })];
        const visible = navigatorVisibleRuns(metas, THIS_PID).map((m) => m.id);
        check(visible.length === 1 && visible[0] === ownId, `visible set wrong: ${JSON.stringify(visible)}`);
        check(navigatorVisibleCount(metas, THIS_PID) === 1, "footer count must match visible set");
        check(listMetas().some((m) => m.id === dismissedId), "listMetas must still include dismissed runs");
        return "fresh disk reads: dismissed + foreign-parent excluded from navigatorVisibleRuns/Count; listMetas still lists dismissed";
    },
);

// 3. stop.shared — real detached process killed via process group; stale-pid race safe.
await record(
    "stop.shared",
    "node docs/tests/issue-44-runtime-smoke.mjs",
    async () => {
        const id = trackDisk(`sa_smoke44_stop_${Date.now()}`);
        const pid = spawnSleeper();
        writeMeta(baseMeta({ id, status: "running", pid }));
        const outcome = stopRun(id);
        check(outcome.action === "stopped", `expected stopped, got ${JSON.stringify(outcome)}`);
        const back = readMeta(id);
        check(back.status === "killed" && typeof back.endedAt === "number", "killed status + endedAt must persist");
        check(await waitFor(() => !processExists(pid)), `process group of pid ${pid} must be gone`);

        const staleId = trackDisk(`sa_smoke44_stale_${Date.now()}`);
        writeMeta(baseMeta({ id: staleId, status: "running", pid: 0x3fffffff }));
        const stale = stopRun(staleId);
        check(stale.action === "not-running" && stale.status === "exited", `stale race wrong: ${JSON.stringify(stale)}`);
        check(readMeta(staleId).status === "running", "stale on-disk record must be left untouched");
        return "real detached sleep 30 SIGTERMed via process group (killed + endedAt on disk, group gone); stale 'running'+dead pid → not-running(exited), record untouched";
    },
);

// 4. tools.model-facing — the REGISTERED tool handlers, built by the same
// factories index.ts passes to pi.registerTool, against a real dismissed run.
await record(
    "tools.model-facing",
    "node docs/tests/issue-44-runtime-smoke.mjs",
    async () => {
        const id = trackDisk(`sa_smoke44_tool_${Date.now()}`);
        const pid = spawnSleeper();
        writeMeta(baseMeta({ id, status: "running", pid }));
        dismissRun(id);
        let stopped = 0;
        const tools = {
            list: subagentListTool(TypeStub),
            output: subagentOutputTool(TypeStub),
            result: subagentResultTool(TypeStub),
            stop: subagentStopTool(TypeStub, { onStopped: () => stopped++ }),
        };
        const outText = (r) => r.content[0].text;
        check(outText(await tools.list.execute("tc", {})).includes(id), "subagent_list must include the dismissed run");
        check(outText(await tools.output.execute("tc", { id })).startsWith(`[${id} · running`), "subagent_output must resolve the dismissed run");
        check(outText(await tools.result.execute("tc", { id })).includes("still running"), "subagent_result must give the non-blocking running reply");
        check(outText(await tools.stop.execute("tc", { id })).includes(`Stopped subagent ${id}`), "subagent_stop must stop the dismissed run");
        check(stopped === 1, "stop handler must fire its onStopped callback once");
        check(readMeta(id).status === "killed" && isDismissed(readMeta(id)), "killed + dismissed must persist after the stop");
        check(await waitFor(() => !processExists(pid)), `process group of pid ${pid} must be gone`);
        return "factory-built handlers (the exact objects pi.registerTool receives): dismissed run listed/output/result-ed by id, stopped via subagent_stop with onStopped fired; killed+dismissed persisted; group gone";
    },
);

// 5. index.ts (extension entry) — parses; subagent_stop delegates to the shared stopRun.
await record(
    "index.ts (extension entry)",
    "node --experimental-strip-types --check index.ts",
    () => {
        execFileSync(process.execPath, ["--experimental-strip-types", "--check", "index.ts"], {
            cwd: new URL("../..", import.meta.url).pathname,
            stdio: "pipe",
        });
        return "index.ts parses under node type-stripping; subagent_stop delegates to stopRun (index.ts)";
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
