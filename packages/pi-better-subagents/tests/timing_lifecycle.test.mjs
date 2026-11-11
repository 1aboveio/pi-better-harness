/**
 * Harness-owned run timing through the REAL extension (index.ts): soft deadline
 * with a wrap-up steer and grace, hard ceiling, and the stuck (no-progress) wake.
 *
 * Real child processes come from a PATH-injected fake `pi` binary (no model
 * calls); only setInterval is mocked, so the 15 s health tick is driven by
 * hand while Date stays real. Deadlines use fractional minutes (0.001 min =
 * 60 ms). The pi host packages are stubbed at the module boundary; no
 * first-party module is mocked.
 *
 * // @covers subagent.timing
 * // @level integration
 */
import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { mkdtempSync, writeFileSync, appendFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));

const HERMETIC_TMPDIR = mkdtempSync(join(tmpdir(), "subagent-timing-"));
process.env.TMPDIR = HERMETIC_TMPDIR;

const { default: betterSubagents, progressCacheIdsForTests, isHealthTickerActive, forgetProgressCacheForTests } = await import("../index.ts");
const { getCallbackBatcher } = await import("../shared-callback-batcher.ts");
const { readMeta, writeMeta, runDir } = await import("../registry.ts");
const { killProcessTree } = await import("../spawn.ts");

const HEALTH_TICK_MS = 15_000;

// ---- fake pi binary: echo its launch facts into the log, then idle ---------
const binDir = mkdtempSync(join(tmpdir(), "fake-pi-timing-"));
const fakePiPath = join(binDir, "pi");
const IDLE_SCRIPT = "#!/bin/sh\necho \"{\\\"type\\\":\\\"fake_launch\\\",\\\"steerFile\\\":\\\"$PI_SUBAGENT_STEER_FILE\\\"}\"\necho \"$@\"\nsleep 300\n";
function writeFakePi(script) {
    writeFileSync(fakePiPath, script);
    chmodSync(fakePiPath, 0o755);
}
writeFakePi(IDLE_SCRIPT);
const originalPath = process.env.PATH ?? "";
process.env.PATH = `${binDir}:${originalPath}`;

const liveRuns = [];

function makeHarness(options = {}) {
    const tools = new Map();
    const handlers = new Map();
    const sent = [];
    const notes = [];
    const pi = {
        registerTool: (def) => tools.set(def.name, def),
        on: (event, fn) => handlers.set(event, fn),
        sendMessage: (message, sendOptions) => {
            if (options.failSend?.()) throw new Error("simulated callback send failure");
            sent.push({ message, options: sendOptions });
        },
    };
    const ctx = {
        cwd: tmpdir(),
        hasUI: false,
        ui: { notify: (msg, level) => notes.push({ msg, level }), setWidget: () => {} },
        model: undefined,
        sessionManager: { getSessionId: () => options.sessionId ?? "timing-session" },
    };
    betterSubagents(pi);
    const shutdown = () => handlers.get("session_shutdown")?.({}, ctx);
    return { pi, tools, handlers, sent, notes, ctx, shutdown };
}

async function spawnRun(h, { noWaitForLaunch, ...overrides } = {}) {
    const res = await h.tools.get("subagent_spawn").execute(
        "tc", { prompt: "timing test task", clean: true, sandbox: false, cwd: tmpdir(), ...overrides },
        undefined, undefined, h.ctx,
    );
    const out = res.content[0].text;
    const id = out.match(/id=(\S+)/)[1];
    const pid = Number(out.match(/\(pid (\d+)\)/)[1]);
    liveRuns.push({ id, pid });
    // The fake child writes its launch lines through a non-append fd; appending test
    // events before it has written would let those lines overwrite them.
    if (!noWaitForLaunch) {
        await waitFor(() => { try { return readFileSync(join(runDir(id), "output.log"), "utf8").includes("--extension"); } catch { return false; } });
    }
    return { id, pid, out };
}

async function waitFor(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > deadline) return undefined;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settle = () => new Promise((r) => setImmediate(r));

async function tick() {
    mock.timers.tick(HEALTH_TICK_MS);
    await settle();
}

async function reap({ id, pid }) {
    killProcessTree(pid, "SIGKILL");
    await waitFor(() => {
        const m = readMeta(id);
        return m && m.status !== "running" && m.status !== "orphaned" ? m : undefined;
    }, { timeoutMs: 2000 });
    rmSync(runDir(id), { recursive: true, force: true });
}

/** Health-tick until the deadline steer is requested (the 60 ms deadline passes on its own). */
async function untilSteerRequested(id) {
    while (!(readMeta(id).timing.steerRequestedAt > 0)) {
        await tick();
        await sleep(20);
    }
}

/** Move a persisted limit instead of waiting for it, so the outcome never depends on how slow the host is. */
function rewindTiming(id, change) {
    const meta = readMeta(id);
    writeMeta({ ...meta, timing: { ...meta.timing, ...change(meta.timing) } });
}

const MINUTE = 60_000;

async function withFakeClock(fn) {
    mock.timers.enable({ apis: ["setInterval"] });
    try { await fn(); } finally { mock.timers.reset(); }
}

const wakes = (h, kind) => h.sent.filter((entry) => entry.message.customType === `subagent-${kind}`);
const steerPath = (id) => join(runDir(id), "steer.json");

function appendEvents(id, events) {
    appendFileSync(join(runDir(id), "output.log"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

/** A successful edit, as the child's JSON stream records it: start, then a timestamped tool result. */
function editEvents(callId, at = Date.now()) {
    return [
        { type: "tool_execution_start", toolCallId: callId, toolName: "edit", args: { path: "a.txt" } },
        { type: "message_end", message: { role: "toolResult", toolCallId: callId, toolName: "edit", isError: false, timestamp: at, content: [{ type: "text", text: "ok" }] } },
    ];
}

after(() => {
    process.env.PATH = originalPath;
    for (const { id, pid } of liveRuns) {
        killProcessTree(pid, "SIGKILL");
        rmSync(runDir(id), { recursive: true, force: true });
    }
    rmSync(binDir, { recursive: true, force: true });
});

describe("harness timing: launch", () => {
    it("defaults to a 60-minute ceiling and stall detection and prepares explicit deadline support", async () => {
        const h = makeHarness();
        try {
            const run = await spawnRun(h, { deadline_minutes: null, grace_minutes: null, max_minutes: null, stuck_minutes: null });
            const meta = readMeta(run.id);
            assert.equal(meta.timing.deadlineAt, undefined);
            assert.equal(meta.timing.graceMs, 5 * 60_000);
            assert.equal(meta.timing.ceilingAt, meta.startedAt + 60 * 60_000);
            assert.equal(meta.timing.toolWaitMs, 5 * 60_000);
            assert.equal(meta.timing.stuckMs, 10 * 60_000);
            assert.match(run.out, /Timing: no soft deadline, ceiling 60m, tool wait after 5m, stuck wake after 10m without progress\./);
            const log = await waitFor(() => {
                const text = existsSync(meta.logPath) ? readFileSync(meta.logPath, "utf8") : "";
                return text.includes("--extension") ? text : undefined;
            });
            assert.ok(log, "the fake child recorded its arguments");
            assert.match(log, /--extension \S*child-steer\.ts/);
            assert.match(log, /--extension \S*child-ownership\.ts/, "single clean launches carry ownership enforcement");
            assert.ok(log.includes(`"steerFile":"${steerPath(run.id)}"`), "the child learns where its steer requests appear");
            await reap(run);
        } finally { h.shutdown(); }
    });

    it("rejects an invalid timing value before anything launches", async () => {
        const h = makeHarness();
        try {
            await assert.rejects(
                h.tools.get("subagent_spawn").execute("tc", { prompt: "x", clean: true, sandbox: false, deadline_minutes: -1 }, undefined, undefined, h.ctx),
                /deadline_minutes must be a number of minutes/,
            );
            const batch = await h.tools.get("subagent_spawn_batch").execute("tc", {
                shared: { clean: true, sandbox: false, stuck_minutes: "soon" }, jobs: [{ prompt: "a" }],
            }, undefined, undefined, h.ctx).catch((error) => error);
            assert.match(String(batch?.message ?? batch?.content?.[0]?.text), /stuck_minutes must be a number of minutes/);
        } finally { h.shutdown(); }
    });

    it("batch jobs inherit shared timing and may override it per job", async () => {
        const h = makeHarness();
        try {
            const res = await h.tools.get("subagent_spawn_batch").execute("tc", {
                shared: { clean: true, sandbox: false, tools: "read,bash", cwd: tmpdir(), deadline_minutes: 12, max_minutes: 0 },
                jobs: [{ prompt: "one", name: "one" }, { prompt: "two", name: "two", deadline_minutes: 3, grace_minutes: 1 }],
            }, undefined, undefined, h.ctx);
            const ids = [...res.content[0].text.matchAll(/(sa_[a-z0-9]+_[a-z0-9]+)/g)].map((m) => m[1]);
            const metas = [...new Set(ids)].map((id) => readMeta(id));
            for (const meta of metas) liveRuns.push({ id: meta.id, pid: meta.pid });
            const one = metas.find((m) => m.name === "one");
            const two = metas.find((m) => m.name === "two");
            assert.equal(one.timing.deadlineAt - one.startedAt, 12 * 60_000);
            assert.equal(one.timing.ceilingAt, undefined, "max_minutes 0 disables the ceiling");
            assert.equal(two.timing.deadlineAt - two.startedAt, 3 * 60_000);
            assert.equal(two.timing.graceMs, 60_000);
            for (const meta of metas) {
                assert.ok(await waitFor(() => readFileSync(meta.logPath, "utf8").includes("child-ownership.ts")), "each batch launch carries ownership enforcement");
                await reap({ id: meta.id, pid: meta.pid });
            }
        } finally { h.shutdown(); }
    });
});

describe("shared supervision watcher", () => {
    const WAIT_SCRIPT = "#!/bin/sh\nd=$(dirname \"$PI_SUBAGENT_STEER_FILE\")\necho launched --extension\nwhile [ ! -f \"$d/done\" ]; do sleep 0.05; done\necho '{\"type\":\"agent_end\"}'\nexit 0\n";
    const finish = async (run) => {
        writeFileSync(join(runDir(run.id), "done"), "");
        assert.equal(await waitFor(() => readMeta(run.id)?.status === "completed"), true);
    };

    it("shares one timer across sequential launches and reload, stops on the last exit, and restarts for later work", async () => {
        await withFakeClock(async () => {
            writeFakePi(WAIT_SCRIPT);
            const intervals = mock.method(globalThis, "setInterval");
            const watcherStarts = () => intervals.mock.calls.filter((call) => call.arguments[1] === HEALTH_TICK_MS).length;
            const h = makeHarness();
            h.ctx.isIdle = () => true;
            const runs = [];
            try {
                assert.equal(isHealthTickerActive(), false);
                const first = await spawnRun(h);
                runs.push(first);
                const second = await spawnRun(h);
                runs.push(second);
                await h.handlers.get("session_start")({}, h.ctx);
                assert.equal(watcherStarts(), 1, "overlapping launches and reattachment must reuse the timer");
                await finish(first);
                assert.equal(isHealthTickerActive(), true, "the remaining worker still needs supervision");
                await finish(second);
                assert.equal(isHealthTickerActive(), false, "the final exit stops supervision without another tick");
                assert.ok(readMeta(second.id).completionCallbackPendingAt, "callback delivery is independent of supervision");
                assert.equal(await getCallbackBatcher(h.pi).flush(), true);
                assert.ok(readMeta(second.id).completionCallbackSentAt);
                await h.handlers.get("session_start")({}, h.ctx);
                assert.equal(isHealthTickerActive(), false, "terminal history must not restart the watcher");
                const later = await spawnRun(h);
                runs.push(later);
                assert.equal(watcherStarts(), 2, "a later launch starts a new watcher");
                await h.tools.get("subagent_stop").execute("stop", { id: later.id }, undefined, undefined, h.ctx);
                assert.equal(isHealthTickerActive(), false, "stopping the last worker also stops supervision immediately");
            } finally {
                for (const run of runs) await reap(run);
                h.shutdown();
                intervals.mock.restore();
                writeFakePi(IDLE_SCRIPT);
            }
        });
    });

    it("shares the watcher with batch launches and preserves it across a partial launch failure", async () => {
        await withFakeClock(async () => {
            writeFakePi(WAIT_SCRIPT);
            const intervals = mock.method(globalThis, "setInterval");
            const h = makeHarness();
            const runs = [];
            try {
                const first = await spawnRun(h, { callback: false });
                runs.push(first);
                const result = await h.tools.get("subagent_spawn_batch").execute("batch", {
                    shared: { clean: true, sandbox: false, callback: false, tools: "read,bash", cwd: tmpdir() },
                    jobs: [{ prompt: "batch worker" }, { prompt: "failed worker", cwd: join(binDir, "missing-directory") }],
                }, undefined, undefined, h.ctx);
                const ids = [...new Set([...result.content[0].text.matchAll(/(sa_[a-z0-9]+_[a-z0-9]+)/g)].map((m) => m[1]))];
                const launched = ids.map((id) => readMeta(id)).filter(Boolean);
                for (const meta of launched) {
                    const run = { id: meta.id, pid: meta.pid };
                    runs.push(run);
                    liveRuns.push(run);
                }
                assert.equal(launched.length, 1, "one batch worker launches despite the other spawn failing");
                assert.match(result.content[0].text, /Failed/i);
                assert.equal(intervals.mock.calls.filter((call) => call.arguments[1] === HEALTH_TICK_MS).length, 1);
                await finish(first);
                assert.equal(isHealthTickerActive(), true, "the batch worker retains the shared watcher");
                await finish(runs[1]);
                assert.equal(isHealthTickerActive(), false);
                await assert.rejects(() => h.tools.get("subagent_spawn").execute("failed", {
                    prompt: "no launch", clean: true, sandbox: false, cwd: join(binDir, "missing-directory"),
                }, undefined, undefined, h.ctx), /Failed to spawn/);
                assert.equal(isHealthTickerActive(), false, "a failed launch must not create a watcher");
            } finally {
                for (const run of runs) await reap(run);
                h.shutdown();
                intervals.mock.restore();
                writeFakePi(IDLE_SCRIPT);
            }
        });
    });
});

describe("harness timing: soft deadline", () => {
    it("steers the child once and wakes the parent once, then stops after grace with reason deadline", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0.001, grace_minutes: 10, max_minutes: 0, stuck_minutes: 0 });
                await untilSteerRequested(run.id);
                await waitFor(() => existsSync(steerPath(run.id)));
                const steer = JSON.parse(readFileSync(steerPath(run.id), "utf8"));
                assert.match(steer.text, /soft deadline/);
                assert.match(steer.text, /Do not start new work/);
                const steeredAt = readMeta(run.id).timing.steerRequestedAt;
                assert.ok(steeredAt > 0);
                await waitFor(() => wakes(h, "deadline").length === 1);
                assert.equal(wakes(h, "deadline").length, 1);
                assert.match(wakes(h, "deadline")[0].message.content, /soft deadline/);
                assert.equal(readMeta(run.id).status, "running", "grace has not run out");

                // Within grace: more ticks neither re-steer nor re-wake.
                await tick();
                await tick();
                assert.equal(readMeta(run.id).timing.steerRequestedAt, steeredAt);
                assert.equal(wakes(h, "deadline").length, 1);
                const running = (await h.tools.get("subagent_result").execute("x", { id: run.id }, undefined, undefined, h.ctx)).content[0].text;
                assert.match(running, /Timing: deadline — past its/);

                rewindTiming(run.id, (timing) => ({ steerRequestedAt: timing.steerRequestedAt - 11 * MINUTE }));
                await tick();
                const meta = readMeta(run.id);
                assert.equal(meta.status, "killed");
                assert.equal(meta.timing.stopReason, "deadline");
                assert.ok(await waitFor(() => { try { process.kill(run.pid, 0); return false; } catch { return true; } }), "the child process is gone");

                assert.equal(await getCallbackBatcher(h.pi).flush(), true);
                const completion = h.sent.filter((entry) => entry.message.customType === "background-completion-batch");
                assert.equal(completion.length, 1);
                assert.match(completion[0].message.content, /status=killed; stopped: deadline/);
                const result = (await h.tools.get("subagent_result").execute("x", { id: run.id }, undefined, undefined, h.ctx)).content[0].text;
                assert.match(result, /Timing: stopped: deadline/);
                const list = (await h.tools.get("subagent_list").execute("x", {}, undefined, undefined, h.ctx)).content[0].text;
                assert.match(list, new RegExp(`${run.id}.*stopped: deadline`));
                const output = (await h.tools.get("subagent_output").execute("x", { id: run.id, max_bytes: 2048 }, undefined, undefined, h.ctx)).content[0].text;
                assert.match(output, /Timing: stopped: deadline/);
                await tick();
                assert.equal(wakes(h, "deadline").length, 1);
                await reap(run);
            } finally { h.shutdown(); }
        });
    });

    it("a child that finishes inside grace is not killed and reports deadline: finished in grace", async () => {
        await withFakeClock(async () => {
            writeFakePi("#!/bin/sh\nsleep 0.4\necho '{\"type\":\"agent_end\"}'\nexit 0\n");
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0.001, grace_minutes: 10, max_minutes: 0, stuck_minutes: 0, noWaitForLaunch: true });
                await sleep(80);
                await tick();
                assert.ok(existsSync(steerPath(run.id)));
                const done = await waitFor(() => {
                    const m = readMeta(run.id);
                    return m && m.status !== "running" ? m : undefined;
                });
                assert.ok(done, "the child exited on its own");
                assert.notEqual(done.status, "killed");
                assert.equal(done.timing.stopReason, undefined);
                await tick();
                assert.notEqual(readMeta(run.id).status, "killed", "a later tick does not stop a finished run");
                assert.equal(await getCallbackBatcher(h.pi).flush(), true);
                const completion = h.sent.filter((entry) => entry.message.customType === "background-completion-batch");
                assert.match(completion.at(-1).message.content, /deadline: finished in grace/);
                rmSync(runDir(run.id), { recursive: true, force: true });
            } finally {
                writeFakePi(IDLE_SCRIPT);
                h.shutdown();
            }
        });
    });

    it("keeps the deadline and its one-shot markers across a reload", async () => {
        await withFakeClock(async () => {
            const first = makeHarness();
            const run = await spawnRun(first, { deadline_minutes: 0.001, grace_minutes: 10, max_minutes: 0, stuck_minutes: 0 });
            // Reload: a fresh extension instance over the same durable registry.
            const second = makeHarness();
            try {
                await second.handlers.get("session_start")({}, second.ctx);
                const persisted = readMeta(run.id).timing;
                assert.equal(persisted.deadlineAt - readMeta(run.id).startedAt, 60);
                await sleep(80);
                await tick();
                assert.ok(existsSync(steerPath(run.id)), "the reloaded session enforces the stored deadline");
                await waitFor(() => wakes(second, "deadline").length === 1);
                assert.equal(wakes(second, "deadline").length, 1);
                const steeredAt = readMeta(run.id).timing.steerRequestedAt;

                const third = makeHarness();
                await third.handlers.get("session_start")({}, third.ctx);
                await tick();
                assert.equal(readMeta(run.id).timing.steerRequestedAt, steeredAt, "no second steer after another reload");
                assert.equal(wakes(third, "deadline").length, 0, "no second deadline wake after another reload");
                await reap(run);
            } finally { second.shutdown(); first.shutdown(); }
        });
    });
});

describe("harness timing: a steer queued behind a long tool call", () => {
    // Exits 0 with a coherent stream once the test creates `done` next to the steer file.
    const WAIT_SCRIPT = "#!/bin/sh\nd=$(dirname \"$PI_SUBAGENT_STEER_FILE\")\necho launched --extension\nwhile [ ! -f \"$d/done\" ]; do sleep 0.05; done\necho '{\"type\":\"agent_end\"}'\nexit 0\n";
    const longCallStart = (id) => [
        { type: "message_end", message: { role: "assistant", timestamp: Date.now(), content: [] } },
        { type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "./gradlew test" } },
    ];
    const longCallEnd = (id) => [
        { type: "tool_execution_end", toolCallId: id, toolName: "bash", isError: false, result: { content: [] } },
        { type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, timestamp: Date.now(), content: [] } },
    ];

    it("holds the deadline stop until the steer is delivered, then a child finishing inside grace is not killed", async () => {
        await withFakeClock(async () => {
            writeFakePi(WAIT_SCRIPT);
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0.001, grace_minutes: 10, max_minutes: 0, stuck_minutes: 0 });
                appendEvents(run.id, longCallStart("long"));
                await untilSteerRequested(run.id);
                assert.ok(readMeta(run.id).timing.steerRequestedAt > 0, "steer requested at the deadline");
                rewindTiming(run.id, (timing) => ({ steerRequestedAt: timing.steerRequestedAt - 11 * MINUTE }));
                await tick();
                assert.equal(readMeta(run.id).status, "running", "past request + grace, but the steer waits behind the open tool call");
                assert.match((await h.tools.get("subagent_result").execute("x", { id: run.id }, undefined, undefined, h.ctx)).content[0].text,
                    /once the message reaches it/);

                appendEvents(run.id, longCallEnd("long"));
                // The child's steer extension writes this receipt when the steer enters its conversation.
                writeFileSync(`${steerPath(run.id)}.delivered`, JSON.stringify({ id: `deadline:${run.id}`, at: Date.now() }));
                await tick();
                const deliveredAt = readMeta(run.id).timing.steerDeliveredAt;
                assert.ok(deliveredAt > 0, "delivery time recorded durably");
                await tick();
                assert.equal(readMeta(run.id).status, "running", "grace runs from delivery");
                writeFileSync(join(runDir(run.id), "done"), "");
                const done = await waitFor(() => { const m = readMeta(run.id); return m && m.status !== "running" ? m : undefined; });
                assert.equal(done.status, "completed");
                assert.equal(done.timing.stopReason, undefined);
                assert.equal(await getCallbackBatcher(h.pi).flush(), true);
                const completion = h.sent.filter((entry) => entry.message.customType === "background-completion-batch");
                assert.match(completion.at(-1).message.content, /status=completed; deadline: finished in grace/);
                rmSync(runDir(run.id), { recursive: true, force: true });
            } finally {
                writeFakePi(IDLE_SCRIPT);
                h.shutdown();
            }
        });
    });

    it("a tool call that never ends is bounded by the ceiling", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0.001, grace_minutes: 10, max_minutes: 10, stuck_minutes: 0 });
                appendEvents(run.id, longCallStart("hang"));
                await untilSteerRequested(run.id);
                rewindTiming(run.id, (timing) => ({ steerRequestedAt: timing.steerRequestedAt - 11 * MINUTE }));
                await tick();
                assert.equal(readMeta(run.id).status, "running", "held: the steer is still waiting");
                rewindTiming(run.id, () => ({ ceilingAt: Date.now() - 1 }));
                await tick();
                await waitFor(() => readMeta(run.id).status === "killed");
                const meta = readMeta(run.id);
                assert.equal(meta.status, "killed");
                assert.equal(meta.timing.stopReason, "ceiling");
                await reap(run);
            } finally { h.shutdown(); }
        });
    });
});

describe("harness timing: ceiling", () => {
    it("stops at the hard ceiling without grace and reports reason ceiling", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0, max_minutes: 0.001, stuck_minutes: 0 });
                await sleep(80);
                await tick();
                const meta = readMeta(run.id);
                assert.equal(meta.status, "killed");
                assert.equal(meta.timing.stopReason, "ceiling");
                assert.equal(existsSync(steerPath(run.id)), false, "a ceiling stop does not steer");
                assert.equal(await getCallbackBatcher(h.pi).flush(), true);
                const completion = h.sent.filter((entry) => entry.message.customType === "background-completion-batch");
                assert.match(completion.at(-1).message.content, /stopped: ceiling/);
                const result = (await h.tools.get("subagent_result").execute("x", { id: run.id }, undefined, undefined, h.ctx)).content[0].text;
                assert.match(result, /Timing: stopped: ceiling/);
                await reap(run);
            } finally { h.shutdown(); }
        });
    });
});

describe("harness timing: orphaned runs and memory", () => {
    it("the ceiling also stops an orphaned run whose process group is still alive", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0, max_minutes: 0.001, stuck_minutes: 0 });
                const meta = readMeta(run.id);
                meta.status = "orphaned";
                meta.orphanedAt = Date.now();
                meta.orphanedCallbackSentAt = Date.now();
                writeMeta(meta);
                await sleep(80);
                await tick();
                const after = readMeta(run.id);
                assert.equal(after.status, "killed");
                assert.equal(after.timing.stopReason, "ceiling");
                assert.ok(await waitFor(() => { try { process.kill(run.pid, 0); return false; } catch { return true; } }), "the group is gone");
                await reap(run);
            } finally { h.shutdown(); }
        });
    });

    it("releases a run's progress state once it is no longer live, whatever ended it", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0, max_minutes: 0, stuck_minutes: 5 });
                await tick();
                assert.ok(progressCacheIdsForTests().includes(run.id), "held while running");
                const meta = readMeta(run.id);
                meta.status = "lost";
                meta.lostAt = Date.now();
                meta.lostCallbackSentAt = Date.now();
                writeMeta(meta);
                await tick();
                assert.equal(progressCacheIdsForTests().includes(run.id), false, "released after reconcile marks it lost");
                await reap(run);
            } finally { h.shutdown(); }
        });
    });
});

describe("harness timing: stuck wake", () => {
    it("wakes the parent once for a child with no progress, and never for a progressing child", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const idle = await spawnRun(h, { name: "idle", deadline_minutes: 0, max_minutes: 0, stuck_minutes: 0.002 });
                const busy = await spawnRun(h, { name: "busy", deadline_minutes: 0, max_minutes: 0, stuck_minutes: 0.002 });
                for (let i = 0; i < 4; i++) {
                    appendEvents(busy.id, editEvents(`edit-${i}`));
                    await sleep(70);
                    appendEvents(busy.id, editEvents(`edit-${i}b`));
                    await tick();
                }
                await waitFor(() => wakes(h, "stuck").length >= 1);
                const stuck = wakes(h, "stuck");
                assert.equal(stuck.length, 1, "one wake");
                assert.match(stuck[0].message.content, new RegExp(idle.id));
                assert.match(stuck[0].message.content, /no progress/);
                assert.equal(stuck.filter((w) => w.message.content.includes(busy.id)).length, 0, "a progressing child never wakes the parent");
                assert.equal(readMeta(idle.id).status, "running", "stuck never stops a run");
                const list = (await h.tools.get("subagent_list").execute("x", {}, undefined, undefined, h.ctx)).content[0].text;
                assert.match(list, new RegExp(`${idle.id}.*· stuck`));
                const output = (await h.tools.get("subagent_output").execute("x", { id: idle.id }, undefined, undefined, h.ctx)).content[0].text;
                assert.match(output, /Timing: stuck/);
                await reap(idle);
                await reap(busy);
            } finally { h.shutdown(); }
        });
    });

    it("a read-only research child making distinct successful calls is never stuck; one looping the same read is", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const research = await spawnRun(h, { name: "research", deadline_minutes: 0, max_minutes: 0, stuck_minutes: 0.005 });
                const looping = await spawnRun(h, { name: "looping", deadline_minutes: 0, max_minutes: 0, stuck_minutes: 0.005 });
                // As a real child logs it: the assistant turn that asks for the call, the call, its result.
                const call = (id, callId, args) => [
                    { type: "message_end", message: { role: "assistant", timestamp: Date.now(), content: [] } },
                    { type: "tool_execution_start", toolCallId: callId, toolName: "read", args },
                    { type: "message_end", message: { role: "toolResult", toolCallId: callId, toolName: "read", isError: false, timestamp: Date.now(), content: [] } },
                ];
                // 300 ms window, a call every ~70 ms, for ~700 ms: margin for a slow event loop either way.
                for (let i = 0; i < 10; i++) {
                    appendEvents(research.id, call(research.id, `r${i}`, { path: `src/file-${i}.ts` }));
                    // Same read every time; null optional fields are the same call (#336).
                    appendEvents(looping.id, call(looping.id, `l${i}`, i % 2 ? { path: "README.md", offset: null } : { path: "README.md" }));
                    await sleep(70);
                    await tick();
                }
                await waitFor(() => wakes(h, "stuck").length >= 1);
                const stuck = wakes(h, "stuck");
                assert.equal(stuck.length, 1);
                assert.match(stuck[0].message.content, new RegExp(looping.id));
                assert.match(stuck[0].message.content, /only repeated earlier calls/);
                assert.equal(stuck.filter((w) => w.message.content.includes(research.id)).length, 0, "distinct reads are progress");
                await reap(research);
                await reap(looping);
            } finally { h.shutdown(); }
        });
    });

    it("does not count time inside a running tool call, and re-arms after new progress", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0, max_minutes: 0, stuck_minutes: 0.002 });
                appendEvents(run.id, [
                    { type: "message_end", message: { role: "assistant", timestamp: Date.now(), content: [] } },
                    { type: "tool_execution_start", toolCallId: "long-test", toolName: "bash", args: { command: "npm test" } },
                ]);
                await sleep(200);
                await tick();
                assert.equal(wakes(h, "stuck").length, 0, "a long-running command is waiting, not stuck");
                appendEvents(run.id, [{ type: "message_end", message: { role: "toolResult", toolCallId: "long-test", toolName: "bash", isError: false, timestamp: Date.now(), content: [] } }]);
                await tick();
                assert.equal(wakes(h, "stuck").length, 0, "the tool call's own duration does not count");
                await sleep(160);
                await tick();
                await waitFor(() => wakes(h, "stuck").length === 1);
                assert.equal(wakes(h, "stuck").length, 1);
                await tick();
                assert.equal(wakes(h, "stuck").length, 1, "once per stuck spell");
                appendEvents(run.id, editEvents("fix"));
                await tick();
                assert.equal(readMeta(run.id).timing.lastProgressAt > readMeta(run.id).timing.stuckAnchorAt, true);
                const result = (await h.tools.get("subagent_result").execute("x", { id: run.id }, undefined, undefined, h.ctx)).content[0].text;
                assert.doesNotMatch(result, /Timing: stuck/, "progress clears the stuck reason");
                await sleep(160);
                await tick();
                await waitFor(() => wakes(h, "stuck").length === 2);
                assert.equal(wakes(h, "stuck").length, 2, "a new stuck spell after progress wakes again");
                await reap(run);
            } finally { h.shutdown(); }
        });
    });
});

describe("harness timing: tool wait", () => {
    const startCall = (callId, command = "npm test", at = Date.now()) => [
        { type: "message_end", message: { role: "assistant", timestamp: at, content: [] } },
        { type: "tool_execution_start", toolCallId: callId, toolName: "bash", args: { command } },
    ];
    const endCall = (callId, command = "npm test", at = Date.now()) => ({
        type: "message_end", message: { role: "toolResult", toolCallId: callId, toolName: "bash", isError: false, timestamp: at, content: [], args: { command } },
    });

    it("wakes once per open call with facts, never stops the run, and lets the next call alert independently", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { name: "builder", deadline_minutes: 0, max_minutes: 0, tool_wait_minutes: 0.002, stuck_minutes: 0 });
                appendEvents(run.id, startCall("long-test"));
                await sleep(200);
                await tick();
                await waitFor(() => wakes(h, "tool-wait").length === 1);
                const first = wakes(h, "tool-wait");
                assert.equal(first.length, 1, "a long normal tool call still alerts once");
                assert.match(first[0].message.content, new RegExp(run.id));
                assert.match(first[0].message.content, /tool wait/i);
                assert.match(first[0].message.content, /long-test/);
                assert.match(first[0].message.content, /bash: npm test/);
                assert.match(first[0].message.content, /Last progress: none observed/);
                assert.match(first[0].message.content, /subagent_output id=/);
                assert.doesNotMatch(first[0].message.content, /before deciding|no action is needed|Inspect it with/i);
                const meta = readMeta(run.id);
                assert.equal(meta.status, "running", "the alert does not stop or cancel the run");
                assert.deepEqual(meta.timing.toolWaitAlerted, ["long-test"]);
                process.kill(run.pid, 0);
                await tick();
                assert.equal(wakes(h, "tool-wait").length, 1, "one alert while the same call stays open");

                appendEvents(run.id, [endCall("long-test")]);
                await tick();
                assert.equal(readMeta(run.id).timing.toolWaitAlerted, undefined, "the finished call no longer needs a marker");
                appendEvents(run.id, startCall("second-test", "npm run lint"));
                await sleep(200);
                await tick();
                await waitFor(() => wakes(h, "tool-wait").length === 2);
                const second = wakes(h, "tool-wait");
                assert.equal(second.length, 2, "the next call alerts independently");
                assert.match(second[1].message.content, /second-test/);
                assert.match(second[1].message.content, /npm run lint/);
                assert.match(second[1].message.content, new RegExp(run.id));
                await reap(run);
            } finally { h.shutdown(); }
        });
    });

    it("alerts parallel calls independently and does not repeat either after reload", async () => {
        await withFakeClock(async () => {
            const first = makeHarness();
            const run = await spawnRun(first, { name: "parallel", deadline_minutes: 0, max_minutes: 0, tool_wait_minutes: 0.002, stuck_minutes: 0 });
            let second;
            try {
                appendEvents(run.id, [...startCall("call-a", "build"), ...startCall("call-b", "test").slice(1)]);
                await sleep(200);
                await tick();
                await waitFor(() => wakes(first, "tool-wait").length === 2);
                assert.equal(wakes(first, "tool-wait").length, 2, "each parallel call gets its own alert");
                assert.deepEqual(new Set(readMeta(run.id).timing.toolWaitAlerted), new Set(["call-a", "call-b"]));
                assert.deepEqual(readMeta(run.id).timing.openCalls.map((call) => call.id), ["call-a", "call-b"]);

                forgetProgressCacheForTests();
                second = makeHarness();
                await second.handlers.get("session_start")({}, second.ctx);
                await tick();
                assert.equal(wakes(second, "tool-wait").length, 0, "a reload does not repeat a handed-off wait alert");
                assert.equal(readMeta(run.id).status, "running");
                await reap(run);
            } finally {
                second?.shutdown();
                first.shutdown();
            }
        });
    });

    it("retries a failed send on the next tick instead of marking the call alerted", async () => {
        await withFakeClock(async () => {
            let fail = true;
            const h = makeHarness({ failSend: () => fail });
            try {
                const run = await spawnRun(h, { deadline_minutes: 0, max_minutes: 0, tool_wait_minutes: 0.002, stuck_minutes: 0 });
                appendEvents(run.id, startCall("retry-call", "slow test"));
                await sleep(200);
                await tick();
                assert.equal(wakes(h, "tool-wait").length, 0);
                assert.equal(readMeta(run.id).timing.toolWaitAlerted, undefined, "a failed handoff leaves the marker unset");
                fail = false;
                await tick();
                await waitFor(() => wakes(h, "tool-wait").length === 1);
                assert.equal(wakes(h, "tool-wait").length, 1, "the existing urgent callback path retries");
                assert.deepEqual(readMeta(run.id).timing.toolWaitAlerted, ["retry-call"]);
                await reap(run);
            } finally { h.shutdown(); }
        });
    });

    it("keeps callback:false quiet while still marking the call and showing the human notify", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { callback: false, deadline_minutes: 0, max_minutes: 0, tool_wait_minutes: 0.002, stuck_minutes: 0 });
                appendEvents(run.id, startCall("quiet-call", "quiet test"));
                await sleep(200);
                await tick();
                await waitFor(() => readMeta(run.id).timing.toolWaitAlerted?.includes("quiet-call"));
                assert.equal(wakes(h, "tool-wait").length, 0, "callback:false suppresses the model message");
                assert.match(h.notes.at(-1).msg, /tool wait/i, "the human notify remains");
                assert.deepEqual(readMeta(run.id).timing.toolWaitAlerted, ["quiet-call"]);
                await tick();
                assert.equal(wakes(h, "tool-wait").length, 0, "the marked call does not retry");
                await reap(run);
            } finally { h.shutdown(); }
        });
    });
});

describe("harness timing: a reload whose bounded log read lost the running call (#620)", () => {
    // A child log past the 32 MiB read window. The window's leading partial line is
    // dropped, so nothing before it — including a running call's start — is visible.
    const LOST_WINDOW = "x".repeat(33 * 1024 * 1024) + "\n";
    const startCall = (id) => ({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "pnpm build" } });
    const endCall = (id) => ({ type: "message_end", message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, timestamp: Date.now(), content: [] } });

    it("still treats the silent command as waiting, not stuck, and resumes detection once it ends", async () => {
        await withFakeClock(async () => {
            const first = makeHarness();
            const run = await spawnRun(first, { deadline_minutes: 0, max_minutes: 0, stuck_minutes: 0.002 });
            let second;
            try {
                appendEvents(run.id, [startCall("long-build")]);
                await tick();
                assert.equal(readMeta(run.id).timing.inFlight?.id, "long-build", "the parent records the running call durably");
                appendFileSync(join(runDir(run.id), "output.log"), LOST_WINDOW);
                forgetProgressCacheForTests();
                second = makeHarness();
                await second.handlers.get("session_start")({}, second.ctx);
                await sleep(200);
                await tick();
                assert.equal(wakes(second, "stuck").length, 0, "a rebuild from the log tail is not evidence of no progress");
                assert.equal(readMeta(run.id).status, "running");
                appendEvents(run.id, [endCall("long-build")]);
                await tick();
                assert.equal(readMeta(run.id).timing.inFlight, undefined, "the record is cleared by the call's own result");
                assert.equal(wakes(second, "stuck").length, 0, "the call's own duration is a pause, not silence");
                await sleep(200);
                await tick();
                await waitFor(() => wakes(second, "stuck").length === 1);
                assert.equal(wakes(second, "stuck").length, 1, "a full window of real silence after the call still wakes the parent");
            } finally {
                second?.shutdown();
                await reap(run);
                first.shutdown();
            }
        });
    });

    it("keeps the deadline hold for a running call whose start the rebuilt log window lost", async () => {
        await withFakeClock(async () => {
            const first = makeHarness();
            const run = await spawnRun(first, { deadline_minutes: 0.001, grace_minutes: 10, max_minutes: 0, stuck_minutes: 0 });
            let second;
            try {
                appendEvents(run.id, [startCall("long-build")]);
                await tick();
                await untilSteerRequested(run.id);
                assert.equal(readMeta(run.id).timing.inFlight?.id, "long-build", "the call is recorded before the deadline");
                rewindTiming(run.id, (timing) => ({ steerRequestedAt: timing.steerRequestedAt - 11 * MINUTE }));
                appendFileSync(join(runDir(run.id), "output.log"), LOST_WINDOW);
                forgetProgressCacheForTests();
                second = makeHarness();
                await second.handlers.get("session_start")({}, second.ctx);
                await tick();
                const meta = readMeta(run.id);
                assert.equal(meta.status, "running", "the steer still waits behind the running call");
                assert.equal(meta.timing.stopReason, undefined, "not stopped mid-call");
                const result = (await second.tools.get("subagent_result").execute("x", { id: run.id }, undefined, undefined, second.ctx)).content[0].text;
                assert.match(result, /once the message reaches it/);
            } finally {
                second?.shutdown();
                await reap(run);
                first.shutdown();
            }
        });
    });
});
