/**
 * Runtime smoke for issue #68 — orphaned stop / close cleanup.
 *
 * Exercises the shipping stop + navigator close seams against a real tmpdir
 * registry and real detached process groups. Does not load the full pi host.
 *
 *   node --experimental-strip-types tests/smoke_orphaned_stop.mjs \
 *     [--json docs/tests/_generated/runtime-smoke-results-68.json]
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    writeMeta,
    readMeta,
    effectiveStatus,
    dismissRun,
    runDir,
    logPathFor,
} from "../registry.ts";
import { stopRun } from "../stop.ts";
import { processExists } from "../spawn.ts";
import { executeNavigatorClose, closeConfirmHint } from "../navigator.ts";
import { subagentStopTool } from "../tools.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const outPath = jsonIdx >= 0
    ? args[jsonIdx + 1]
    : join(ROOT, "..", "docs/tests/_generated/runtime-smoke-results-68.json");

const THIS_PID = process.pid;
const diskIds = [];
const steps = [];

function record(name, status, detail = "") {
    steps.push({ name, status, detail });
    console.log(`[${status === "pass" ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function must(name, cond, detail = "") {
    if (cond) record(name, "pass", detail);
    else record(name, "fail", detail || "assertion failed");
}

function track(id) {
    diskIds.push(id);
    return id;
}

function spawnLeader() {
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

function seed(id, overrides = {}) {
    const m = {
        id,
        status: "orphaned",
        pid: 0,
        spawnPid: THIS_PID,
        cwd: "/tmp",
        promptPreview: "smoke68",
        startedAt: Date.now() - 60_000,
        orphanedAt: Date.now() - 30_000,
        logPath: logPathFor(id),
        sessionId: "smoke68",
        ...overrides,
    };
    writeMeta(m);
    mkdirSync(runDir(id), { recursive: true });
    return m;
}

function writeLog(id, events) {
    writeFileSync(
        logPathFor(id),
        events.length
            ? `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
            : "",
    );
}

const TypeStub = {
    Object: (v) => v,
    String: (v) => v,
    Number: (v) => v,
    Boolean: (v) => v,
    Array: (v) => v,
    Optional: (v) => v,
};

async function main() {
    // 1. Orphaned + live process group → killed
    {
        const id = track(`sa_smoke68_pg_${Date.now()}`);
        const pid = spawnLeader();
        seed(id, { pid: 0x3ffff000, pgid: pid });
        writeLog(id, []);
        const outcome = stopRun(id);
        must("orphaned PG stop action", outcome.action === "stopped");
        must("orphaned PG killed status", readMeta(id).status === "killed");
        must("orphaned PG process gone", await waitFor(() => !processExists(pid)));
    }

    // 2. Orphaned + no process + coherent terminal → completed
    {
        const id = track(`sa_smoke68_done_${Date.now()}`);
        seed(id, { pid: 0x3ffff001, pgid: 0x3ffff001 });
        writeLog(id, [
            {
                type: "message_update",
                message: { role: "assistant", content: [{ type: "text", text: "smoke-done" }] },
            },
            { type: "agent_end" },
        ]);
        const outcome = stopRun(id);
        must("terminal evidence action", outcome.action === "finalized" && outcome.status === "completed");
        must("terminal evidence status", readMeta(id).status === "completed");
    }

    // 3. Orphaned + no process + no terminal → lost
    {
        const id = track(`sa_smoke68_lost_${Date.now()}`);
        seed(id, { pid: 0x3ffff002, pgid: 0x3ffff002 });
        writeLog(id, [{ type: "message_update", message: { role: "assistant", content: "partial" } }]);
        const outcome = stopRun(id);
        must("lost cleanup action", outcome.action === "finalized" && outcome.status === "lost");
        must("lost cleanup status", readMeta(id).status === "lost");
    }

    // 4. Running stop compatibility
    {
        const id = track(`sa_smoke68_run_${Date.now()}`);
        const pid = spawnLeader();
        seed(id, { status: "running", pid, pgid: pid, orphanedAt: undefined });
        writeLog(id, []);
        const outcome = stopRun(id);
        must("running stop action", outcome.action === "stopped");
        must("running killed", readMeta(id).status === "killed");
        must("running process gone", await waitFor(() => !processExists(pid)));
    }

    // 5. TUI Close orphaned → terminal then dismiss
    {
        const id = track(`sa_smoke68_close_${Date.now()}`);
        seed(id, { name: "smoke-orphan", pid: 0x3ffff003, pgid: 0x3ffff003 });
        writeLog(id, []);
        must(
            "close hint stop wording",
            closeConfirmHint({ id, name: "smoke-orphan", status: "orphaned" })
                === "x again to stop smoke-orphan",
        );
        const outcome = executeNavigatorClose(id, {
            readMeta,
            effectiveStatus,
            stopRun,
            dismissRun,
            now: () => 99_000,
        });
        must("close action", outcome.action === "stopped-and-dismissed" && outcome.status === "lost");
        must("close dismissed after terminal", readMeta(id).status === "lost" && readMeta(id).dismissedAt === 99_000);
    }

    // 6. Model tool path
    {
        const id = track(`sa_smoke68_tool_${Date.now()}`);
        seed(id, { pid: 0x3ffff004, pgid: 0x3ffff004 });
        writeLog(id, []);
        const tool = subagentStopTool(TypeStub);
        const text = (await tool.execute("tc", { id })).content[0].text;
        must("tool resolved lost", /Resolved orphaned subagent/.test(text) && readMeta(id).status === "lost");
    }

    // 7. Strip-types parse of shipping modules
    {
        try {
            const { execFileSync } = await import("node:child_process");
            execFileSync(process.execPath, ["--experimental-strip-types", "--check", "stop.ts"], {
                cwd: join(ROOT, ".."),
                stdio: "pipe",
            });
            must("stop.ts strip-types check", true);
        } catch (err) {
            must("stop.ts strip-types check", false, String(err?.message ?? err));
        }
    }

    const failed = steps.filter((s) => s.status === "fail");
    const payload = {
        issue: 68,
        generatedAt: new Date().toISOString(),
        headSha: process.env.SMOKE_HEAD_SHA || null,
        surfaces: [
            {
                id: "stop.orphaned-cleanup",
                status: failed.some((f) => !f.name.startsWith("close")) ? "fail" : "pass",
            },
            {
                id: "navigator.close",
                status: failed.some((f) => f.name.startsWith("close")) ? "fail" : "pass",
            },
        ],
        steps,
        summary: {
            total: steps.length,
            pass: steps.filter((s) => s.status === "pass").length,
            fail: failed.length,
        },
    };
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

    for (const id of diskIds) {
        try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    if (failed.length) {
        console.error(`SMOKE FAIL — ${failed.length} step(s)`);
        process.exit(1);
    }
    console.log(`SMOKE PASS — ${steps.length} steps; wrote ${outPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
