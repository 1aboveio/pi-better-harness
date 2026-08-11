/**
 * Extension-level lifecycle tests for the issue #63 production wiring.
 *
 * The pure seams (reconcileRun / needsMonitoring / registry identity) are
 * covered by tests/health_reconcile.test.mjs and tests/registry_identity.test.mjs
 * with fake probes. This file loads the REAL extension (index.ts) with a fake
 * ExtensionAPI and a PATH-injected fake `pi` binary, and drives the wiring the
 * seam tests cannot see:
 *
 * - AC1: subagent_spawn persists captured process identity into meta.json
 *   (deterministic fake probe through the injectable spawn-time probe seam,
 *   plus capability-conditioned parity with the real OS probe).
 * - AC9: the health ticker starts on session_start, persists scheduled
 *   transitions across fake-clock ticks, and self-stops once nothing
 *   current-parent needs monitoring — proven by new monitored work NOT being
 *   reconciled after the last terminal transition.
 * - Interleavings: coherent child-exit evidence supersedes provisional
 *   orphaned/lost reconciliation (a health tick can observe the just-exited
 *   pid before the close handler runs; the close is the stronger evidence).
 * - AC7/AC8 outcome evidence: the registered `subagent_result` tool returns a
 *   non-final diagnostic plus best-current artifacts for orphaned metadata and
 *   a terminal lost diagnostic plus best-available artifacts for lost metadata;
 *   default `subagent_list` surfaces orphaned as a non-terminal listed status.
 * - #65 health callbacks: orphaned/lost transitions deliver one durable,
 *   non-interrupting coordinator follow-up when callback:true; callback:false
 *   suppresses model follow-up only; markers mean successful handoff and
 *   survive reloads/repeated ticks; persisted unmarked orphaned/lost recover
 *   after reload even without a fresh transition.
 *
 * The host-provided `@earendil-works/pi-ai` package (not installed in this
 * repo) is stubbed via module resolve hooks — an external boundary; no
 * first-party module is mocked. Process probes are faked only at the kernel
 * boundary (ProcessProbe), everything else is the real extension, registry,
 * and spawn machinery (real child processes, real meta.json files).
 *
 * // @covers health.reconcile
 * // @level unit
 * // @covers registry.process-identity
 * // @level unit
 * // @covers subagent.health-callback
 * // @level unit
 * // @covers subagent.result
 * // @level unit
 */
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

// Hermetic registry: this file boots the real extension and fires
// session_start, which runs registry maintenance (cleanup, size cap,
// abandoned-record reconciliation). Those act on the WHOLE registry, so a
// suite run must never see a developer's live one.
const HERMETIC_TMPDIR = mkdtempSync(join(tmpdir(), "subagent-ext-health-"));
process.env.TMPDIR = HERMETIC_TMPDIR;

const { default: betterSubagents, setIdentityProbeForTests, isHealthTickerActive } = await import("../index.ts");
const { getCallbackBatcher } = await import("../shared-callback-batcher.ts");
const { readMeta, writeMeta, nextRunId, runDir } = await import("../registry.ts");
const { realProcessProbe, OLD_METADATA_LOST_CONFIRM_TICKS } = await import("../health.ts");
const { killProcessTree } = await import("../spawn.ts");

/** Above the Linux/macOS pid max: guaranteed dead, never a live group. */
const DEAD_PID = 4194304;
const HEALTH_TICK_MS = 15_000;

// ---- fake pi binary on PATH (real child processes, no model calls) --------
const binDir = mkdtempSync(join(tmpdir(), "fake-pi-bin-"));
const fakePiPath = join(binDir, "pi");
const SLEEP_SCRIPT = "#!/bin/sh\nsleep 300\n";
// `echo ready` AFTER the trap is installed: the log sentinel proves the USR1
// handler exists before the test signals the child (a signal delivered before
// `trap` runs would kill the script with the default disposition instead of
// exiting 3).
const TRAP_FAIL_SCRIPT = "#!/bin/sh\ntrap 'exit 3' USR1\necho ready\nwhile :; do sleep 1; done\n";
function writeFakePi(script) {
    writeFileSync(fakePiPath, script);
    chmodSync(fakePiPath, 0o755);
}
writeFakePi(SLEEP_SCRIPT);
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${binDir}:${originalPath}`;

// ---- harness ---------------------------------------------------------------
const liveRuns = []; // { id, pid } — children to reap and dirs to remove
const dirOnly = []; // ids with no child (metadata-only fixtures)

function makeHarness(options = {}) {
    const tools = new Map();
    const handlers = new Map();
    const sent = [];
    const notes = [];
    const cwd = options.cwd ?? tmpdir();
    const sessionId = options.sessionId ?? "test-session";
    const pi = {
        registerTool: (def) => tools.set(def.name, def),
        on: (event, fn) => handlers.set(event, fn),
        sendMessage: (message, sendOptions) => {
            if (options.sendMessage) return options.sendMessage(message, sendOptions, sent);
            sent.push({ message, options: sendOptions });
        },
    };
    const ctx = {
        cwd,
        hasUI: false,
        ui: { notify: (msg, level) => notes.push({ msg, level }), setWidget: () => {} },
        model: undefined,
        sessionManager: { getSessionId: () => sessionId },
    };
    betterSubagents(pi);
    const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);
    return { pi, tools, handlers, sent, notes, ctx, shutdown };
}

async function spawnRun({ tools, ctx }, overrides = {}) {
    const res = await tools.get("subagent_spawn").execute(
        "tc", { prompt: "lifecycle test task", clean: true, sandbox: false, cwd: tmpdir(), ...overrides },
        undefined, undefined, ctx,
    );
    const out = res.content[0].text;
    const id = out.match(/id=(\S+)/)[1];
    const pid = Number(out.match(/\(pid (\d+)\)/)[1]);
    liveRuns.push({ id, pid });
    return { id, pid, out };
}

/** Poll (real timers) until fn() returns truthy; undefined on timeout. */
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) return undefined;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

/**
 * Reap a spawned run inside the test that created it: kill the child, wait
 * for the close handler to write a terminal status, and remove the run dir.
 * A still-running meta would keep `needsMonitoring` true for LATER tests in
 * this process (they share the module-level health ticker), so per-test
 * reaping is required for isolation — the file-level after() is only a
 * backstop for failures.
 */
async function reapRun({ id, pid }) {
    killProcessTree(pid, "SIGKILL");
    await waitFor(() => {
        const m = readMeta(id);
        return m && m.status !== "running" && m.status !== "orphaned" ? m : undefined;
    }, { timeoutMs: 2000 });
    rmSync(runDir(id), { recursive: true, force: true });
}

/**
 * Run `fn` with ONLY setInterval mocked (the health/widget tickers);
 * setTimeout/Date stay real so exit-event delivery and polling behave
 * normally. Enabled per test (never file-wide) and reset afterwards: Node 22
 * cannot mock clearInterval, so a mocked interval that production "clears"
 * keeps firing until mock.timers.reset() — file-wide mocking would leak
 * extra reconcile ticks between tests.
 */
async function withFakeClock(fn) {
    mock.timers.enable({ apis: ["setInterval"] });
    try {
        await fn();
    } finally {
        mock.timers.reset();
    }
}

after(() => {
    process.env.PATH = originalPath;
    for (const { id, pid } of liveRuns) {
        killProcessTree(pid, "SIGKILL");
        rmSync(runDir(id), { recursive: true, force: true });
    }
    for (const id of dirOnly) rmSync(runDir(id), { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
});

/** Deterministic fake probe: the spawned child leads its own group (pgid==pid). */
function fakeSpawnIdentityProbe() {
    return {
        pidExists: () => true,
        startToken: (pid) => `tok-${pid}`,
        groupId: (pid) => pid,
        groupAlive: () => false,
        // Process-group-only (ADR 0002): no descendants method on ProcessProbe.
    };
}

describe("AC1 — subagent_spawn persists process identity into meta.json", () => {
    it("persists every captured identity field through the production spawn path (fake probe)", async () => {
        const h = makeHarness();
        setIdentityProbeForTests(fakeSpawnIdentityProbe());
        try {
            const { id, pid } = await spawnRun(h);
            const meta = readMeta(id);
            assert.equal(meta.status, "running");
            assert.equal(meta.pid, pid);
            assert.equal(meta.pgid, pid, "meta.json must persist the captured process group id");
            assert.equal(meta.pidStartTime, `tok-${pid}`, "meta.json must persist the captured start-time token");
            await reapRun({ id, pid });
        } finally {
            setIdentityProbeForTests(undefined);
            h.shutdown();
        }
    });

    it("records the real OS identity where the environment exposes it", async () => {
        const h = makeHarness();
        try {
            const { id, pid } = await spawnRun(h);
            const meta = readMeta(id);
            assert.equal(meta.pid, pid);
            assert.equal(realProcessProbe.pidExists(pid), true, "spawned child stays alive for probing");
            // Best-effort capabilities: assert parity only where the OS probe
            // actually exposes the field in this environment.
            const pgid = realProcessProbe.groupId(pid);
            if (pgid !== undefined) assert.equal(meta.pgid, pgid, "persisted pgid must match the live probe");
            const token = realProcessProbe.startToken(pid);
            if (token !== undefined) assert.equal(meta.pidStartTime, token, "persisted start token must match the live probe");
            await reapRun({ id, pid });
        } finally {
            h.shutdown();
        }
    });
});

describe("session_shutdown child ownership", () => {
    it("kills current-session running subagents and records killed", async () => {
        const h = makeHarness({ cwd: tmpdir(), sessionId: "shutdown-kill" });
        try {
            const { id, pid } = await spawnRun(h);
            assert.equal(readMeta(id).status, "running");
            await h.shutdown();
            const meta = readMeta(id);
            assert.equal(meta.status, "killed", "shutdown must close current-session running work as killed");
            assert.equal(meta.lifecycleClassification, "killed");
            assert.equal(typeof meta.endedAt, "number");
            assert.equal(
                await waitFor(() => !realProcessProbe.pidExists(pid), { timeoutMs: 3000 }),
                true,
                "shutdown must terminate the child process group",
            );
            rmSync(runDir(id), { recursive: true, force: true });
        } finally {
            await h.shutdown();
        }
    });

    it("does not kill same-parent runs from a different foreground session", async () => {
        const cwd = tmpdir();
        const h = makeHarness({ cwd, sessionId: "session-b" });
        let id;
        let pid;
        try {
            ({ id, pid } = await spawnRun(h));
            const launched = readMeta(id);
            writeMeta({ ...launched, callbackOrigin: { cwd, sessionId: "session-a" } });
            await h.shutdown();
            const meta = readMeta(id);
            assert.equal(meta.status, "running", "other-session run must stay running");
            assert.equal(realProcessProbe.pidExists(pid), true, "other-session child must not be killed");
        } finally {
            if (pid) killProcessTree(pid, "SIGKILL");
            if (id) rmSync(runDir(id), { recursive: true, force: true });
            await h.shutdown();
        }
    });

    it("does not signal the foreground process when corrupt metadata points at itself", async () => {
        const cwd = tmpdir();
        const h = makeHarness({ cwd, sessionId: "self-pid-guard" });
        const id = nextRunId();
        try {
            writeMeta({
                id,
                status: "running",
                pid: process.pid,
                pgid: process.pid,
                spawnPid: process.pid,
                cwd,
                callbackOrigin: { cwd, sessionId: "self-pid-guard" },
                promptPreview: "self pid guard",
                startedAt: Date.now(),
                logPath: join(runDir(id), "output.log"),
                sessionId: id,
            });
            await h.shutdown();
            assert.equal(readMeta(id).status, "running", "self-referential metadata must be left untouched");
        } finally {
            rmSync(runDir(id), { recursive: true, force: true });
            await h.shutdown();
        }
    });
});

describe("AC9 — health ticker production lifecycle (fake clock)", () => {
    const fixture = () => {
        const id = nextRunId();
        dirOnly.push(id);
        return {
            // Old metadata (no pgid / start token): conservative lost detection.
            id, status: "running", pid: DEAD_PID, spawnPid: process.pid, cwd: tmpdir(),
            promptPreview: "p", startedAt: Date.now(), logPath: join(runDir(id), "output.log"),
            sessionId: id,
        };
    };

    it("starts on session_start, persists scheduled transitions, and self-stops when idle", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const a = fixture();
                const b = fixture();
                writeMeta(a);
                writeMeta(b);

                assert.equal(isHealthTickerActive(), false, "no ticker before monitored work appears");
                await h.handlers.get("session_start")({}, h.ctx);
                assert.equal(isHealthTickerActive(), true, "session_start starts the ticker for monitored work");
                assert.equal(readMeta(a.id).probeMisses, undefined, "no reconciliation before the first scheduled tick");

                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(readMeta(a.id).probeMisses, 1, "tick 1 persists the old-metadata miss");
                assert.equal(readMeta(b.id).probeMisses, 1);
                assert.equal(readMeta(a.id).status, "running", "old metadata is not lost on first suspicion");

                for (let i = 1; i < OLD_METADATA_LOST_CONFIRM_TICKS; i++) mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(readMeta(a.id).status, "lost", "the confirming tick persists terminal lost");
                assert.equal(readMeta(b.id).status, "lost");
                assert.ok(readMeta(a.id).lostAt > 0);
                assert.ok(readMeta(a.id).endedAt > 0);
                assert.equal(h.notes.filter((n) => n.level === "warning").length, 2, "each lost transition notifies once");

                assert.equal(isHealthTickerActive(), false, "ticker self-stops after the last monitored run went terminal");
            } finally {
                h.shutdown();
            }
        });
    });
});

describe("completion callback batching", () => {
    // @covers subagent.completion-callback
    // @level integration
    // @fails-without-fix subagent.completion-callback
    it("batches real child exits and keeps callback:false silent in a mixed group", async () => {
        const previousWindow = process.env.PI_BETTER_CALLBACK_BATCH_MS;
        process.env.PI_BETTER_CALLBACK_BATCH_MS = "5000";
        const h = makeHarness({ cwd: tmpdir(), sessionId: "completion-batch" });
        let runs = [];
        try {
            const first = await spawnRun(h, { name: "first", callback: true });
            const second = await spawnRun(h, { name: "second", callback: true });
            const quiet = await spawnRun(h, { name: "quiet", callback: false });
            runs = [first, second, quiet];

            for (const run of runs) killProcessTree(run.pid, "SIGKILL");
            const batcher = getCallbackBatcher(h.pi);
            const terminal = await waitFor(() => {
                const metas = runs.map((run) => readMeta(run.id));
                return metas.every((meta) => meta && meta.status !== "running" && meta.status !== "orphaned")
                    && batcher.pendingCount() === 2;
            });
            assert.equal(terminal, true, "two callback-enabled terminal runs enter the shared batch");
            assert.equal(h.sent.length, 0, "long test window holds the aggregate until explicit flush");

            assert.equal(await batcher.flush(), true);
            const completionMessages = h.sent.filter((entry) => entry.message.customType === "background-completion-batch");
            assert.equal(completionMessages.length, 1);
            const content = completionMessages[0].message.content;
            assert.match(content, /2 background completions are ready/);
            assert.match(content, new RegExp(first.id));
            assert.match(content, new RegExp(second.id));
            assert.doesNotMatch(content, new RegExp(quiet.id));
            assert.match(content, /subagent_result/);
            assert.doesNotMatch(content, /lifecycle test task|--- result ---/);
            assert.ok(readMeta(first.id).completionCallbackSentAt > 0);
            assert.ok(readMeta(second.id).completionCallbackSentAt > 0);
            assert.equal(readMeta(quiet.id).completionCallbackSentAt, undefined);
            assert.equal(readMeta(quiet.id).completionCallbackPendingAt, undefined);
        } finally {
            for (const run of runs) rmSync(runDir(run.id), { recursive: true, force: true });
            h.shutdown();
            if (previousWindow === undefined) delete process.env.PI_BETTER_CALLBACK_BATCH_MS;
            else process.env.PI_BETTER_CALLBACK_BATCH_MS = previousWindow;
        }
    });

    // @covers subagent.completion-callback
    // @level integration
    // @fails-without-fix subagent.completion-callback
    it("recovers durable pending callbacks after reload and retries a failed aggregate without early markers", async () => {
        let failNext = true;
        const h = makeHarness({
            cwd: tmpdir(),
            sessionId: "session-b",
            sendMessage(message, options, sent) {
                if (message.customType === "background-completion-batch" && failNext) {
                    failNext = false;
                    throw new Error("simulated aggregate handoff failure");
                }
                sent.push({ message, options });
            },
        });
        const now = Date.now();
        const ids = [nextRunId(), nextRunId(), nextRunId()];
        for (const id of ids) dirOnly.push(id);
        const base = {
            status: "completed",
            pid: DEAD_PID,
            spawnPid: process.pid,
            cwd: h.ctx.cwd,
            promptPreview: "durable callback recovery",
            startedAt: now - 2_000,
            endedAt: now - 1_000,
            exitCode: 0,
            logPath: "",
            sessionId: "child-session",
            callback: true,
            completionCallbackPendingAt: now - 1_000,
        };
        try {
            writeMeta({ ...base, id: ids[0], name: "active-a", logPath: join(runDir(ids[0]), "output.log"), callbackOrigin: { cwd: h.ctx.cwd, sessionId: "session-b" } });
            writeMeta({ ...base, id: ids[1], name: "active-b", logPath: join(runDir(ids[1]), "output.log"), callbackOrigin: { cwd: h.ctx.cwd, sessionId: "session-b" } });
            writeMeta({ ...base, id: ids[2], name: "foreign", logPath: join(runDir(ids[2]), "output.log"), callbackOrigin: { cwd: h.ctx.cwd, sessionId: "session-a" } });

            await h.handlers.get("session_start")({}, h.ctx);
            const batcher = getCallbackBatcher(h.pi);
            assert.equal(batcher.pendingCount(), 3, "reload recovers every unhandled pending record before ownership filtering");

            assert.equal(await batcher.flush(), false);
            assert.equal(readMeta(ids[0]).completionCallbackSentAt, undefined);
            assert.equal(readMeta(ids[1]).completionCallbackSentAt, undefined);
            assert.equal(readMeta(ids[2]).completionCallbackSentAt, undefined);
            assert.ok(readMeta(ids[2]).completionCallbackSuppressedAt > 0, "foreign record is durably suppressed");

            assert.equal(await batcher.flush(), true);
            const messages = h.sent.filter((entry) => entry.message.customType === "background-completion-batch");
            assert.equal(messages.length, 1);
            assert.match(messages[0].message.content, new RegExp(ids[0]));
            assert.match(messages[0].message.content, new RegExp(ids[1]));
            assert.doesNotMatch(messages[0].message.content, new RegExp(ids[2]));
            assert.ok(readMeta(ids[0]).completionCallbackSentAt > 0);
            assert.ok(readMeta(ids[1]).completionCallbackSentAt > 0);
        } finally {
            h.shutdown();
        }
    });
});

describe("terminal exit evidence supersedes provisional health reconciliation", () => {
    it("a health tick's provisional lost is superseded by the child's real exit", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            setIdentityProbeForTests(fakeSpawnIdentityProbe());
            try {
                const { id, pid } = await spawnRun(h);
                // Deterministically construct the race state: the health tick's
                // probe view of an exited child (recorded pid + group both gone)
                // while the close handler has not run yet.
                const meta = readMeta(id);
                writeMeta({ ...meta, pid: DEAD_PID, pgid: DEAD_PID, pidStartTime: "gone-token" });
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(readMeta(id).status, "lost", "health tick persists provisional lost first");

                killProcessTree(pid, "SIGKILL"); // the REAL child now exits
                // lifecycle.ts may classify a signal exit without stream end as
                // incomplete/failed rather than completed — either is a real
                // terminal supersession of provisional lost.
                const final = await waitFor(() => {
                    const m = readMeta(id);
                    return (m.status === "completed" || m.status === "failed") ? m : undefined;
                });
                assert.ok(final, "coherent child exit must supersede the provisional lost write");
                assert.notEqual(final.status, "lost", "provisional lost must not remain");
                assert.ok("exitCode" in final, "the real exit code is recorded");
                assert.equal(await getCallbackBatcher(h.pi).flush(), true);
                assert.ok(
                    h.sent.some((s) => s.message.customType === "background-completion-batch" && s.message.content.includes(id)),
                    "the superseding completion remains present in the aggregate callback",
                );
            } finally {
                setIdentityProbeForTests(undefined);
                h.shutdown();
            }
        });
    });

    it("a health tick's provisional orphaned is superseded by a real non-zero exit", async () => {
        writeFakePi(TRAP_FAIL_SCRIPT);
        await withFakeClock(async () => {
            const h = makeHarness();
            setIdentityProbeForTests(fakeSpawnIdentityProbe());
            try {
                const { id, pid } = await spawnRun(h);
                // Recorded pid gone but the recorded group (the live child) alive
                // → provisional orphaned; then the child really exits non-zero.
                const meta = readMeta(id);
                writeMeta({ ...meta, pid: DEAD_PID });
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(readMeta(id).status, "orphaned", "pid-gone + live recorded group persists orphaned");
                assert.equal(isHealthTickerActive(), true, "orphaned is non-terminal: monitoring continues");

                // Signal only after the trap is installed (log sentinel).
                const ready = await waitFor(() => {
                    try { return readFileSync(meta.logPath, "utf-8").includes("ready"); } catch { return false; }
                });
                assert.ok(ready, "child installed its USR1 trap");
                process.kill(pid, "SIGUSR1"); // trap exits the child with code 3
                const final = await waitFor(() => {
                    const m = readMeta(id);
                    return m.status === "failed" ? m : undefined;
                });
                assert.ok(final, "coherent non-zero exit must supersede the provisional orphaned write");
                assert.equal(final.exitCode, 3, "the real exit code wins");
            } finally {
                setIdentityProbeForTests(undefined);
                h.shutdown();
                assert.equal(isHealthTickerActive(), false, "session_shutdown stops the ticker");
                writeFakePi(SLEEP_SCRIPT);
            }
        });
    });
});

/**
 * AC7/AC8 — outcome evidence through the registered tools, not helper tables.
 * Metadata is written directly (status already reconciled); the assertion is
 * the tool response shape the coordinator actually sees.
 */
describe("AC7/AC8 — subagent_result and default list outcomes for orphaned/lost", () => {
    function toolText(res) {
        return res.content.map((c) => c.text).join("");
    }

    function writeFixtureMeta({ status, artifactLine }) {
        const id = nextRunId();
        dirOnly.push(id);
        const logPath = join(runDir(id), "output.log");
        const meta = {
            id,
            status,
            pid: DEAD_PID,
            spawnPid: process.pid,
            cwd: tmpdir(),
            promptPreview: `${status} fixture`,
            startedAt: Date.now() - 60_000,
            logPath,
            sessionId: id,
            pgid: DEAD_PID,
            pidStartTime: "gone-token",
        };
        if (status === "orphaned") meta.orphanedAt = Date.now() - 30_000;
        if (status === "lost") {
            meta.lostAt = Date.now() - 10_000;
            meta.endedAt = meta.lostAt;
        }
        writeMeta(meta);
        writeFileSync(logPath, artifactLine + "\n");
        return meta;
    }

    it("subagent_result returns non-final diagnostic plus best-current artifacts for orphaned metadata", async () => {
        const h = makeHarness();
        try {
            const artifact = "still-running-group-output";
            const meta = writeFixtureMeta({
                status: "orphaned",
                artifactLine: artifact,
            });
            const res = await h.tools.get("subagent_result").execute("tc", { id: meta.id });
            const out = toolText(res);
            assert.match(out, /orphaned/i, `must name orphaned status:\n${out}`);
            assert.match(out, /no final result/i, `must refuse a final result:\n${out}`);
            assert.match(out, /best-current parsed output/i, `must label best-current artifacts:\n${out}`);
            assert.match(out, new RegExp(artifact), `must surface best-current log artifacts:\n${out}`);
            assert.doesNotMatch(out, /\bexit\b/i, `must not present an exit-coded final block:\n${out}`);
            assert.doesNotMatch(out, /Best-available artifacts/i, `orphaned is not the lost terminal path:\n${out}`);
            assert.doesNotMatch(out, /✓ completed/i, `must not pretend normal completion:\n${out}`);
        } finally {
            h.shutdown();
        }
    });

    it("subagent_result returns terminal lost diagnostics plus available artifacts", async () => {
        const h = makeHarness();
        try {
            const artifact = "partial-progress-before-loss";
            const meta = writeFixtureMeta({ status: "lost", artifactLine: artifact });
            const res = await h.tools.get("subagent_result").execute("tc", { id: meta.id });
            const out = toolText(res);
            assert.match(out, new RegExp(`\\[${meta.id} · lost ·`), `must open a terminal result head with lost:\n${out}`);
            assert.match(out, /Run is lost: no related process remains/i, `must include the lost diagnostic:\n${out}`);
            assert.match(out, /[Bb]est-available/i, `must point at best-available artifacts:\n${out}`);
            assert.match(out, new RegExp(artifact), `must surface available log artifacts:\n${out}`);
        } finally {
            h.shutdown();
        }
    });

    it("subagent_result does not throw solely because a run is orphaned or lost", async () => {
        const h = makeHarness();
        try {
            const orphaned = writeFixtureMeta({ status: "orphaned", artifactLine: "o" });
            const lost = writeFixtureMeta({ status: "lost", artifactLine: "l" });
            await assert.doesNotReject(() => h.tools.get("subagent_result").execute("tc", { id: orphaned.id }));
            await assert.doesNotReject(() => h.tools.get("subagent_result").execute("tc", { id: lost.id }));
        } finally {
            h.shutdown();
        }
    });

    it("default subagent_list surfaces orphaned as a non-terminal listed status", async () => {
        const h = makeHarness();
        try {
            const orphaned = writeFixtureMeta({
                status: "orphaned",
                artifactLine: "list-orphaned-artifact",
            });
            const completed = writeFixtureMeta({
                status: "completed",
                artifactLine: "list-completed-artifact",
            });
            // completed fixture also needs endedAt for a sensible row; rewrite.
            writeMeta({ ...readMeta(completed.id), endedAt: Date.now(), exitCode: 0 });

            const res = await h.tools.get("subagent_list").execute("tc", {});
            const out = toolText(res);
            assert.match(out, new RegExp(`${orphaned.id}[^\n]*\\[orphaned\\]`), `default list must show orphaned runs:\n${out}`);
            assert.match(out, new RegExp(`${completed.id}[^\n]*\\[completed\\]`), `default list still shows completed runs:\n${out}`);
            // Non-terminal: list is display-only here; result path (above) is the
            // gate that refuses finalization. The list row must not relabel
            // orphaned as a finished status.
            assert.doesNotMatch(
                out,
                new RegExp(`${orphaned.id}[^\n]*\\[(completed|failed|killed|lost|exited)\\]`),
                `orphaned must not be listed under a terminal status:\n${out}`,
            );
        } finally {
            h.shutdown();
        }
    });
});

/**
 * Session isolation for unsolicited coordinator messages. Explicit id-based
 * tools remain global for recovery, but callbacks must only target the
 * foreground session that launched the run.
 *
 * // @covers subagent.callback-session-isolation
 * // @level unit
 */
describe("callback session isolation", () => {
    it("suppresses completion follow-up after the foreground session changes", async () => {
        const cwd = tmpdir();
        const h = makeHarness({ cwd, sessionId: "session-a" });
        try {
            const { id, pid } = await spawnRun(h);
            const launched = readMeta(id);
            assert.deepEqual(launched.callbackOrigin, { cwd, sessionId: "session-a" });

            const switchedCtx = {
                ...h.ctx,
                sessionManager: { getSessionId: () => "session-b" },
            };
            await h.handlers.get("session_start")({}, switchedCtx);

            killProcessTree(pid, "SIGKILL");
            const suppressed = await waitFor(() => {
                const meta = readMeta(id);
                return meta?.completionCallbackSuppressedAt ? meta : undefined;
            }, { timeoutMs: 3000 });

            assert.ok(suppressed, "completion callback suppression marker is written");
            assert.match(suppressed.completionCallbackSuppressedReason, /origin session session-a does not match active session session-b/);
            assert.equal(
                h.sent.some((s) => s.message?.customType === "subagent-complete" && s.message.content.includes(id)),
                false,
                "completion follow-up must not be delivered to the new session",
            );
            rmSync(runDir(id), { recursive: true, force: true });
        } finally {
            h.shutdown();
        }
    });

    it("suppresses recovered lost health follow-up after the foreground session changes", async () => {
        await withFakeClock(async () => {
            const cwd = tmpdir();
            const h = makeHarness({ cwd, sessionId: "session-b" });
            try {
                const id = nextRunId();
                dirOnly.push(id);
                writeMeta({
                    id,
                    status: "lost",
                    pid: DEAD_PID,
                    pgid: DEAD_PID,
                    pidStartTime: "gone-token",
                    spawnPid: process.pid,
                    cwd,
                    promptPreview: "p",
                    startedAt: Date.now() - 120_000,
                    lostAt: Date.now() - 60_000,
                    endedAt: Date.now() - 60_000,
                    logPath: join(runDir(id), "output.log"),
                    sessionId: id,
                    callbackOrigin: { cwd, sessionId: "session-a" },
                    callback: true,
                });
                writeFileSync(join(runDir(id), "output.log"), "lost-other-session\n");

                await h.handlers.get("session_start")({}, h.ctx);
                mock.timers.tick(HEALTH_TICK_MS);

                const meta = readMeta(id);
                assert.equal(meta.status, "lost");
                assert.ok(meta.lostCallbackSuppressedAt > 0, "lost callback suppression marker is written");
                assert.match(meta.lostCallbackSuppressedReason, /origin session session-a does not match active session session-b/);
                assert.equal(
                    h.sent.some((s) => s.message?.customType === "subagent-health" && s.message.content.includes(id)),
                    false,
                    "health follow-up must not be delivered to the new session",
                );
                assert.equal(
                    h.notes.some((n) => n.msg.includes(id)),
                    false,
                    "health toast must not be delivered to the new session",
                );
                assert.equal(isHealthTickerActive(), false, "suppressed lost callback no longer keeps recovery armed");
            } finally {
                h.shutdown();
            }
        });
    });
});

/**
 * Issue #65 — orphaned/lost coordinator follow-ups through the real health tick.
 * Proves delivery, wording hooks, callback:false suppression, durable recovery
 * after reload for unmarked orphaned/lost, post-handoff markers, and durable
 * dedupe via registered extension wiring (not helper truth tables alone).
 *
 * // @covers subagent.health-callback
 * // @level unit
 */
describe("#65 — orphaned/lost health callbacks via health ticker", () => {
    /** Health follow-ups for one run id (other on-disk fixtures may also tick). */
    function healthMsgsFor(sent, id) {
        return sent.filter(
            (s) => s.message?.customType === "subagent-health"
                && typeof s.message?.content === "string"
                && s.message.content.includes(id),
        );
    }

    it("orphaned transition sends one explicit followUp when callback:true", async () => {
        writeFakePi(TRAP_FAIL_SCRIPT);
        await withFakeClock(async () => {
            const h = makeHarness();
            setIdentityProbeForTests(fakeSpawnIdentityProbe());
            try {
                const { id, pid } = await spawnRun(h);
                // Recorded pid gone + live group (the real child) → orphaned.
                const meta = readMeta(id);
                writeMeta({ ...meta, pid: DEAD_PID, callback: true });
                mock.timers.tick(HEALTH_TICK_MS);

                assert.equal(readMeta(id).status, "orphaned");
                const msgs = healthMsgsFor(h.sent, id);
                assert.equal(msgs.length, 1, `exactly one health callback for ${id}; got ${msgs.length}`);
                assert.equal(msgs[0].options.deliverAs, "followUp");
                assert.equal(msgs[0].options.triggerTurn, true);
                assert.match(msgs[0].message.content, /ATTENTION/i);
                assert.match(msgs[0].message.content, /supervision/i);
                assert.match(msgs[0].message.content, /may still be alive/i);
                assert.match(msgs[0].message.content, /subagent_result/);
                assert.match(msgs[0].message.content, /subagent_output/);
                assert.match(msgs[0].message.content, /wait/i);
                assert.match(msgs[0].message.content, /stop/i);
                assert.match(msgs[0].message.content, /retry/i);
                assert.ok(readMeta(id).orphanedCallbackSentAt > 0, "durable orphaned callback marker");
                assert.ok(
                    h.notes.some((n) => n.level === "warning" && n.msg.includes(id)),
                    "human notify still fires for this run",
                );

                // Repeated ticks must not re-fire this run.
                mock.timers.tick(HEALTH_TICK_MS);
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(healthMsgsFor(h.sent, id).length, 1, "dedupe across repeated ticks");

                await reapRun({ id, pid });
            } finally {
                setIdentityProbeForTests(undefined);
                h.shutdown();
                writeFakePi(SLEEP_SCRIPT);
            }
        });
    });

    it("lost transition sends one explicit followUp when callback:true", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const id = nextRunId();
                dirOnly.push(id);
                writeMeta({
                    id,
                    status: "running",
                    pid: DEAD_PID,
                    pgid: DEAD_PID,
                    pidStartTime: "gone-token",
                    spawnPid: process.pid,
                    cwd: tmpdir(),
                    promptPreview: "p",
                    startedAt: Date.now(),
                    logPath: join(runDir(id), "output.log"),
                    sessionId: id,
                    callback: true,
                });
                writeFileSync(join(runDir(id), "output.log"), "lost-before-complete\n");

                await h.handlers.get("session_start")({}, h.ctx);
                mock.timers.tick(HEALTH_TICK_MS);

                assert.equal(readMeta(id).status, "lost");
                const msgs = healthMsgsFor(h.sent, id);
                assert.equal(msgs.length, 1, `exactly one lost health callback for ${id}; got ${msgs.length}`);
                assert.equal(msgs[0].options.deliverAs, "followUp");
                assert.equal(msgs[0].options.triggerTurn, true);
                assert.match(msgs[0].message.content, /ATTENTION/i);
                assert.match(msgs[0].message.content, /no related process remains/i);
                assert.match(msgs[0].message.content, /no coherent terminal/i);
                assert.match(msgs[0].message.content, /subagent_result/);
                assert.ok(readMeta(id).lostCallbackSentAt > 0, "durable lost callback marker");

                // Reload / further ticks: marker survives, no second delivery.
                mock.timers.tick(HEALTH_TICK_MS);
                // Simulate /reload: session_start again with marker already on disk.
                await h.handlers.get("session_start")({}, h.ctx);
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(healthMsgsFor(h.sent, id).length, 1, "dedupe survives reload + ticks");
            } finally {
                h.shutdown();
            }
        });
    });

    it("callback:false suppresses model follow-up but keeps human notify", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const id = nextRunId();
                dirOnly.push(id);
                writeMeta({
                    id,
                    status: "running",
                    pid: DEAD_PID,
                    pgid: DEAD_PID,
                    pidStartTime: "gone-token",
                    spawnPid: process.pid,
                    cwd: tmpdir(),
                    promptPreview: "p",
                    startedAt: Date.now(),
                    logPath: join(runDir(id), "output.log"),
                    sessionId: id,
                    callback: false,
                });
                writeFileSync(join(runDir(id), "output.log"), "quiet-lost\n");

                await h.handlers.get("session_start")({}, h.ctx);
                mock.timers.tick(HEALTH_TICK_MS);

                assert.equal(readMeta(id).status, "lost");
                assert.equal(healthMsgsFor(h.sent, id).length, 0, "no model follow-up when callback:false");
                assert.ok(
                    h.notes.some((n) => n.level === "warning" && n.msg.includes(id) && /lost/i.test(n.msg)),
                    "human notify still fires under callback:false",
                );
                // Marker still set after intentional callback:false suppression so
                // recovery does not keep retrying the suppressed model path.
                assert.ok(readMeta(id).lostCallbackSentAt > 0, "marker still written for dedupe");
            } finally {
                h.shutdown();
            }
        });
    });

    it("pre-marked meta does not re-fire after reload (durable dedupe)", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const id = nextRunId();
                dirOnly.push(id);
                // Already orphaned with marker from a prior session.
                writeMeta({
                    id,
                    status: "orphaned",
                    pid: DEAD_PID,
                    pgid: DEAD_PID,
                    pidStartTime: "gone-token",
                    spawnPid: process.pid,
                    cwd: tmpdir(),
                    promptPreview: "p",
                    startedAt: Date.now() - 60_000,
                    orphanedAt: Date.now() - 30_000,
                    orphanedCallbackSentAt: Date.now() - 30_000,
                    logPath: join(runDir(id), "output.log"),
                    sessionId: id,
                    callback: true,
                });
                writeFileSync(join(runDir(id), "output.log"), "premarked\n");

                await h.handlers.get("session_start")({}, h.ctx);
                // First tick with no group evidence advances orphaned → lost and
                // should fire ONLY the lost callback (orphaned already marked).
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(readMeta(id).status, "lost");
                const msgs = healthMsgsFor(h.sent, id);
                assert.equal(msgs.length, 1, "only the new lost transition fires for this run");
                assert.match(msgs[0].message.content, /status lost|is lost/i);
                assert.doesNotMatch(msgs[0].message.content, /may still be alive/i);
            } finally {
                h.shutdown();
            }
        });
    });

    it("persisted unmarked orphaned recovers one callback after reload without a fresh transition", async () => {
        writeFakePi(TRAP_FAIL_SCRIPT);
        await withFakeClock(async () => {
            const h = makeHarness();
            setIdentityProbeForTests(fakeSpawnIdentityProbe());
            try {
                const { id, pid } = await spawnRun(h);
                // Persist orphaned from a prior session WITHOUT a handoff marker.
                // Live process-group evidence keeps reconcileRun at changed:false
                // (orphaned-kept), so recovery must not depend on a new transition.
                writeMeta({
                    ...readMeta(id),
                    status: "orphaned",
                    pid: DEAD_PID,
                    orphanedAt: Date.now() - 60_000,
                    callback: true,
                });
                // Drop any in-memory marker field if present.
                const disk = readMeta(id);
                assert.equal(disk.orphanedCallbackSentAt, undefined, "fixture starts unmarked");

                await h.handlers.get("session_start")({}, h.ctx);
                mock.timers.tick(HEALTH_TICK_MS);

                assert.equal(readMeta(id).status, "orphaned", "live group evidence keeps orphaned");
                const msgs = healthMsgsFor(h.sent, id);
                assert.equal(msgs.length, 1, `exactly one recovered orphaned callback; got ${msgs.length}`);
                assert.equal(msgs[0].options.deliverAs, "followUp");
                assert.equal(msgs[0].options.triggerTurn, true);
                assert.match(msgs[0].message.content, /ATTENTION/i);
                assert.match(msgs[0].message.content, /may still be alive/i);
                assert.ok(readMeta(id).orphanedCallbackSentAt > 0, "marker written after successful handoff");

                // Reload + ticks must not re-fire.
                mock.timers.tick(HEALTH_TICK_MS);
                await h.handlers.get("session_start")({}, h.ctx);
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(healthMsgsFor(h.sent, id).length, 1, "dedupe after recovered handoff");

                await reapRun({ id, pid });
            } finally {
                setIdentityProbeForTests(undefined);
                h.shutdown();
                writeFakePi(SLEEP_SCRIPT);
            }
        });
    });

    it("persisted unmarked lost recovers one callback after reload", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const id = nextRunId();
                dirOnly.push(id);
                // Already terminal-lost from a prior session, marker missing.
                // Lost is excluded from process monitoring, so recovery must
                // scan unmarked lost independently of reconcile transitions.
                writeMeta({
                    id,
                    status: "lost",
                    pid: DEAD_PID,
                    pgid: DEAD_PID,
                    pidStartTime: "gone-token",
                    spawnPid: process.pid,
                    cwd: tmpdir(),
                    promptPreview: "p",
                    startedAt: Date.now() - 120_000,
                    orphanedAt: Date.now() - 90_000,
                    lostAt: Date.now() - 60_000,
                    endedAt: Date.now() - 60_000,
                    logPath: join(runDir(id), "output.log"),
                    sessionId: id,
                    callback: true,
                });
                writeFileSync(join(runDir(id), "output.log"), "lost-unmarked\n");
                assert.equal(readMeta(id).lostCallbackSentAt, undefined);

                await h.handlers.get("session_start")({}, h.ctx);
                assert.equal(isHealthTickerActive(), true, "unmarked lost keeps the health ticker alive");
                mock.timers.tick(HEALTH_TICK_MS);

                assert.equal(readMeta(id).status, "lost");
                const msgs = healthMsgsFor(h.sent, id);
                assert.equal(msgs.length, 1, `exactly one recovered lost callback; got ${msgs.length}`);
                assert.equal(msgs[0].options.deliverAs, "followUp");
                assert.equal(msgs[0].options.triggerTurn, true);
                assert.match(msgs[0].message.content, /ATTENTION/i);
                assert.match(msgs[0].message.content, /no related process remains/i);
                assert.ok(readMeta(id).lostCallbackSentAt > 0, "marker written after successful handoff");
                assert.equal(isHealthTickerActive(), false, "ticker stops after marked lost has nothing left to monitor");

                // Reload after successful handoff must not re-fire.
                await h.handlers.get("session_start")({}, h.ctx);
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(healthMsgsFor(h.sent, id).length, 1, "dedupe after recovered lost handoff");
            } finally {
                h.shutdown();
            }
        });
    });

    it("failed callback handoff is not permanently suppressed; reload delivers one later success", async () => {
        await withFakeClock(async () => {
            let failNext = true;
            const tools = new Map();
            const handlers = new Map();
            const sent = [];
            const notes = [];
            const pi = {
                registerTool: (def) => tools.set(def.name, def),
                on: (event, fn) => handlers.set(event, fn),
                sendMessage: (message, options) => {
                    if (failNext) {
                        failNext = false;
                        throw new Error("simulated host delivery failure");
                    }
                    sent.push({ message, options });
                },
            };
            const ctx = {
                cwd: tmpdir(),
                hasUI: false,
                ui: { notify: (msg, level) => notes.push({ msg, level }), setWidget: () => {} },
                model: undefined,
            };
            betterSubagents(pi);
            const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);
            try {
                const id = nextRunId();
                dirOnly.push(id);
                writeMeta({
                    id,
                    status: "lost",
                    pid: DEAD_PID,
                    pgid: DEAD_PID,
                    pidStartTime: "gone-token",
                    spawnPid: process.pid,
                    cwd: tmpdir(),
                    promptPreview: "p",
                    startedAt: Date.now() - 120_000,
                    lostAt: Date.now() - 60_000,
                    endedAt: Date.now() - 60_000,
                    logPath: join(runDir(id), "output.log"),
                    sessionId: id,
                    callback: true,
                });
                writeFileSync(join(runDir(id), "output.log"), "handoff-fail\n");

                await handlers.get("session_start")({}, ctx);
                mock.timers.tick(HEALTH_TICK_MS);

                assert.equal(healthMsgsFor(sent, id).length, 0, "failed handoff must not count as delivered");
                assert.equal(
                    readMeta(id).lostCallbackSentAt,
                    undefined,
                    "marker must NOT be written before successful handoff",
                );
                assert.equal(isHealthTickerActive(), true, "failed handoff keeps recovery armed");

                // Simulate /reload after the host recovered: next handoff succeeds once.
                await handlers.get("session_start")({}, ctx);
                mock.timers.tick(HEALTH_TICK_MS);

                const msgs = healthMsgsFor(sent, id);
                assert.equal(msgs.length, 1, `exactly one successful recovery callback; got ${msgs.length}`);
                assert.equal(msgs[0].options.deliverAs, "followUp");
                assert.equal(msgs[0].options.triggerTurn, true);
                assert.match(msgs[0].message.content, /ATTENTION/i);
                assert.ok(readMeta(id).lostCallbackSentAt > 0, "marker written only after successful handoff");

                // Further reload/ticks stay at exactly one.
                await handlers.get("session_start")({}, ctx);
                mock.timers.tick(HEALTH_TICK_MS);
                assert.equal(healthMsgsFor(sent, id).length, 1, "no second delivery after success");
            } finally {
                shutdown();
            }
        });
    });
});
