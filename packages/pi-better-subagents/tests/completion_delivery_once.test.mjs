/**
 * #624 — every terminal subagent run delivers exactly one completion callback.
 *
 * Reporter evidence: a run stopped as stuck never delivered any completion, batch
 * completions arrived late and were then delivered a second time, and the same
 * happened to a scout run. Two distinct defects were reproduced against the
 * current sources (subagents 0.26.0, callback batcher as shipped):
 *
 * 1. A stop wrote a terminal `killed` record but owed no completion callback, so
 *    neither the stopping instance nor a later `session_start` recovery ever told
 *    the caller (the only way to learn was `subagent_list`).
 * 2. The shared batcher keyed ordinary completions by source+id+status. Because
 *    the status is a snapshot (failure notes, observation gaps), a not-yet-
 *    delivered run whose status changed between enqueues entered the pending map
 *    twice and one batch then rendered the same run twice.
 *
 * These tests use the REAL extension, registry and callback batcher with real
 * child processes. Only the `pi` child binary is a shell stand-in, exactly as the
 * other extension-level suites do.
 *
 * // @covers subagent.completion-callback
 * // @level integration
 * // @fails-without-fix subagent.completion-callback
 */
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

// Hermetic registry: the extension boots, reconciles and recovers on session_start.
const HERMETIC = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "subagent-completion-once-"));
process.env.TMPDIR = HERMETIC;

const { default: betterSubagents } = await import("../index.ts");
const { getCallbackBatcher } = await import("../shared-callback-batcher.ts");
const { readMeta, writeMeta, nextRunId, runDir, logPathFor } = await import("../registry.ts");
const { killProcessTree } = await import("../spawn.ts");

const HEALTH_TICK_MS = 15_000;
/** Above the Linux/macOS pid max: guaranteed dead, never a live group. */
const DEAD_PID = 4194304;

// ---- stand-in `pi` child: a real process that only sleeps -------------------
const binDir = mkdtempSync(join(HERMETIC, "fake-pi-bin-"));
const fakePiPath = join(binDir, "pi");
writeFileSync(fakePiPath, "#!/bin/sh\nsleep 300\n");
chmodSync(fakePiPath, 0o755);
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${binDir}:${originalPath}`;

// ---- harness ---------------------------------------------------------------
const liveRuns = [];
const dirOnly = [];

function makeHarness({ cwd, sessionId, idle = () => true, sent = [] } = {}) {
    const tools = new Map();
    const handlers = new Map();
    const notes = [];
    const pi = {
        registerTool: (def) => tools.set(def.name, def),
        on: (event, fn) => handlers.set(event, fn),
        sendMessage: (message, options) => { sent.push({ message, options }); },
    };
    const ctx = {
        cwd,
        isIdle: () => idle(),
        hasUI: false,
        ui: { notify: (msg, level) => notes.push({ msg, level }), setWidget: () => {} },
        model: undefined,
        sessionManager: { getSessionId: () => sessionId },
    };
    betterSubagents(pi);
    return {
        pi, tools, handlers, sent, notes, ctx,
        shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
        start: () => handlers.get("session_start")({}, ctx),
        settle: () => handlers.get("agent_settled")({}, ctx),
    };
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() > deadline) return undefined;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

const completionMessages = (sent) => sent.filter((entry) => entry.message.customType === "background-completion-batch");

/** One row per run id: the batcher renders exactly one `- source=` line per completion. */
function rowsFor(sent, id) {
    return sent.flatMap((entry) => entry.message.content.split("\n"))
        .filter((line) => line.startsWith("- source=") && line.includes(`id=${id} `));
}

async function spawnRun(harness, overrides = {}) {
    const res = await harness.tools.get("subagent_spawn").execute(
        "tc", { prompt: "completion delivery task", clean: true, sandbox: false, cwd: tmpdir(), ...overrides },
        undefined, undefined, harness.ctx,
    );
    const out = res.content[0].text;
    const id = out.match(/id=(\S+)/)[1];
    const pid = Number(out.match(/\(pid (\d+)\)/)[1]);
    liveRuns.push({ id, pid });
    return { id, pid };
}

/** Mock only setInterval (the supervision ticker); real timers keep exits/retries honest. */
async function withFakeClock(fn) {
    mock.timers.enable({ apis: ["setInterval"] });
    try { await fn(); } finally { mock.timers.reset(); }
}

after(() => {
    process.env.PATH = originalPath;
    for (const { id, pid } of liveRuns) {
        try { killProcessTree(pid, "SIGKILL"); } catch { /* already reaped */ }
        rmSync(runDir(id), { recursive: true, force: true });
    }
    for (const id of dirOnly) rmSync(runDir(id), { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
    rmSync(HERMETIC, { recursive: true, force: true });
});

describe("#624 one completion per terminal run", () => {
    it("a stopped run records its completion obligation and reports killed exactly once", async () => {
        const h = makeHarness({ cwd: mkdtempSync(join(HERMETIC, "stop-cwd-")), sessionId: "stop-session" });
        try {
            await h.start();
            const { id, pid } = await spawnRun(h);

            const stopped = await h.tools.get("subagent_stop").execute("tc", { id }, undefined, undefined, h.ctx);
            assert.match(stopped.content[0].text, new RegExp(`Stopped subagent ${id}`));

            const killed = readMeta(id);
            assert.equal(killed.status, "killed");
            assert.ok(killed.completionCallbackPendingAt > 0, "a stop owes the caller its completion callback");

            const delivered = await waitFor(() => readMeta(id).completionCallbackSentAt);
            assert.ok(delivered > 0, "the killed completion is handed off");
            const messages = completionMessages(h.sent);
            assert.equal(messages.length, 1);
            assert.equal(rowsFor(h.sent, id).length, 1, "one row for the run");
            assert.match(messages[0].message.content, /status=killed/);
            assert.match(messages[0].message.content, new RegExp(`subagent_result id="${id}"`));
            assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });

            // The child's own exit (SIGTERM) must not add a second obligation.
            await waitFor(() => readMeta(id).status !== "running");
            await h.start();
            await h.settle();
            await getCallbackBatcher(h.pi).flush();
            assert.equal(completionMessages(h.sent).length, 1, "no second delivery after reload/exit");
            assert.equal(rowsFor(h.sent, id).length, 1);
            assert.equal(readMeta(id).completionCallbackSentAt, delivered, "the sent marker is never rewritten");
            killProcessTree(pid, "SIGKILL");
        } finally { h.shutdown(); }
    });

    it("a run stopped by the reload drain is recovered once by the next extension instance", async () => {
        const cwd = mkdtempSync(join(HERMETIC, "drain-cwd-"));
        const sessionId = "drain-session";
        const first = makeHarness({ cwd, sessionId });
        const secondSent = [];
        try {
            await first.start();
            const { id, pid } = await spawnRun(first);

            // Reload: Pi stops current-session children before dropping the session.
            await first.shutdown();
            const stopped = readMeta(id);
            assert.equal(stopped.status, "killed");
            assert.ok(stopped.completionCallbackPendingAt > 0, "the drained run stays recoverable");
            assert.equal(stopped.completionCallbackSentAt, undefined);
            assert.equal(completionMessages(first.sent).length, 0, "the stopping instance never notifies");

            // The resuming instance recovers the pending record exactly once.
            const second = makeHarness({ cwd, sessionId, sent: secondSent });
            await second.start();
            assert.equal(await waitFor(() => completionMessages(secondSent).length), 1);
            assert.equal(rowsFor(secondSent, id).length, 1);
            assert.match(completionMessages(secondSent)[0].message.content, /status=killed/);
            assert.ok(readMeta(id).completionCallbackSentAt > 0);

            await second.start();
            await getCallbackBatcher(second.pi).flush();
            assert.equal(completionMessages(secondSent).length, 1, "a second session_start must not re-deliver");
            assert.equal(completionMessages(first.sent).length, 0);
            killProcessTree(pid, "SIGKILL");
            second.shutdown();
        } finally { first.shutdown(); }
    });

    it("an ordinary completion whose status snapshot changes before delivery is reported once", async () => {
        await withFakeClock(async () => {
            let idle = false;
            const h = makeHarness({ cwd: mkdtempSync(join(HERMETIC, "dup-cwd-")), sessionId: "dup-session", idle: () => idle });
            const id = nextRunId();
            const keeper = nextRunId();
            dirOnly.push(id, keeper);
            try {
                mkdirSync(runDir(id), { recursive: true });
                mkdirSync(runDir(keeper), { recursive: true });
                writeMeta({ id, status: "completed", pid: DEAD_PID, spawnPid: process.pid, cwd: h.ctx.cwd,
                    callbackOrigin: { cwd: h.ctx.cwd, sessionId: "dup-session" }, promptPreview: "done",
                    startedAt: Date.now() - 60_000, endedAt: Date.now(), exitCode: 0,
                    logPath: logPathFor(id), sessionId: id, callback: true, completionCallbackPendingAt: Date.now() });
                writeFileSync(logPathFor(id), `${JSON.stringify({ type: "message_end",
                    message: { role: "assistant", content: [{ type: "text", text: "finished" }] } })}\n`);
                // Another monitored run keeps supervision ticking; callback:false keeps it silent.
                writeMeta({ id: keeper, status: "orphaned", pid: process.pid, spawnPid: process.pid, cwd: h.ctx.cwd,
                    callbackOrigin: { cwd: h.ctx.cwd, sessionId: "dup-session" }, promptPreview: "keeper",
                    startedAt: Date.now() - 60_000, orphanedAt: Date.now(),
                    logPath: logPathFor(keeper), sessionId: keeper, callback: false });
                writeFileSync(logPathFor(keeper), "");

                await h.start();
                const batcher = getCallbackBatcher(h.pi);
                assert.equal(batcher.pendingCount(), 1, "the pending completion is queued while the caller is busy");

                // The child log gains an unreadable row: the status snapshot gains an observation gap.
                appendFileSync(logPathFor(id), '{"type":"tool_execution_end","toolCallId":"broken"}\n');
                mock.timers.tick(HEALTH_TICK_MS);
                await new Promise((resolve) => setImmediate(resolve));
                mock.timers.tick(HEALTH_TICK_MS);
                await new Promise((resolve) => setImmediate(resolve));
                assert.equal(batcher.pendingCount(), 1, "a changed status must not queue the same run twice");

                idle = true;
                await h.settle();
                assert.equal(await batcher.flush(), true);
                const messages = completionMessages(h.sent);
                assert.equal(messages.length, 1);
                assert.equal(rowsFor(h.sent, id).length, 1, "one batch row for one run");
                assert.match(messages[0].message.content, /^1 background completion is ready:/);
                assert.ok(readMeta(id).completionCallbackSentAt > 0);
            } finally { h.shutdown(); }
        });
    });

    it("orphaned cleanup that finalizes from coherent log evidence still reports its completion", async () => {
        const h = makeHarness({ cwd: mkdtempSync(join(HERMETIC, "cleanup-cwd-")), sessionId: "cleanup-session" });
        const id = nextRunId();
        dirOnly.push(id);
        try {
            await h.start();
            mkdirSync(runDir(id), { recursive: true });
            writeMeta({ id, status: "orphaned", pid: DEAD_PID, pgid: DEAD_PID, spawnPid: process.pid, cwd: h.ctx.cwd,
                callbackOrigin: { cwd: h.ctx.cwd, sessionId: "cleanup-session" }, promptPreview: "orphan",
                startedAt: Date.now() - 120_000, orphanedAt: Date.now() - 60_000,
                logPath: logPathFor(id), sessionId: id, callback: true });
            writeFileSync(logPathFor(id), `${[
                { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
                { type: "agent_end", messages: [] },
            ].map((row) => JSON.stringify(row)).join("\n")}\n`);

            const resolved = await h.tools.get("subagent_stop").execute("tc", { id }, undefined, undefined, h.ctx);
            assert.match(resolved.content[0].text, new RegExp(`Resolved orphaned subagent ${id} → completed`));
            const meta = readMeta(id);
            assert.equal(meta.status, "completed");
            assert.ok(meta.completionCallbackPendingAt > 0, "log-evidence finalization owes one completion");

            assert.equal(await waitFor(() => completionMessages(h.sent).length), 1);
            assert.equal(rowsFor(h.sent, id).length, 1);
            assert.match(completionMessages(h.sent)[0].message.content, /status=completed/);
            assert.ok(readMeta(id).completionCallbackSentAt > 0);
        } finally { h.shutdown(); }
    });

    it("a callback:false run stopped by the drain stays silent and records no obligation", async () => {
        const cwd = mkdtempSync(join(HERMETIC, "quiet-cwd-"));
        const sessionId = "quiet-session";
        const first = makeHarness({ cwd, sessionId });
        const secondSent = [];
        try {
            await first.start();
            const { id, pid } = await spawnRun(first, { callback: false });
            await first.shutdown();
            const meta = readMeta(id);
            assert.equal(meta.status, "killed");
            assert.equal(meta.completionCallbackPendingAt, undefined);

            const second = makeHarness({ cwd, sessionId, sent: secondSent });
            await second.start();
            await getCallbackBatcher(second.pi).flush();
            assert.deepEqual(completionMessages(secondSent), []);
            assert.equal(readMeta(id).completionCallbackSentAt, undefined);
            killProcessTree(pid, "SIGKILL");
            second.shutdown();
        } finally { first.shutdown(); }
    });
});
