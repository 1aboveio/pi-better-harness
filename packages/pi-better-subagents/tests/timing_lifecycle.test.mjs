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

const { default: betterSubagents } = await import("../index.ts");
const { getCallbackBatcher } = await import("../shared-callback-batcher.ts");
const { readMeta, runDir } = await import("../registry.ts");
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
        sendMessage: (message, sendOptions) => { sent.push({ message, options: sendOptions }); },
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
    it("every run carries the default policy, loads the child steer extension, and gets the steer file path", async () => {
        const h = makeHarness();
        try {
            const run = await spawnRun(h, { deadline_minutes: null, grace_minutes: null, max_minutes: null, stuck_minutes: null });
            const meta = readMeta(run.id);
            assert.equal(meta.timing.deadlineAt - meta.startedAt, 30 * 60_000);
            assert.equal(meta.timing.graceMs, 5 * 60_000);
            assert.equal(meta.timing.ceilingAt - meta.startedAt, 90 * 60_000);
            assert.equal(meta.timing.stuckMs, 10 * 60_000);
            assert.match(run.out, /Timing: soft deadline 30m \(\+5m grace\), ceiling 90m, stuck wake after 10m without progress\./);
            const log = await waitFor(() => {
                const text = existsSync(meta.logPath) ? readFileSync(meta.logPath, "utf8") : "";
                return text.includes("--extension") ? text : undefined;
            });
            assert.ok(log, "the fake child recorded its arguments");
            assert.match(log, /--extension \S*child-steer\.ts/);
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
            for (const meta of metas) await reap({ id: meta.id, pid: meta.pid });
        } finally { h.shutdown(); }
    });
});

describe("harness timing: soft deadline", () => {
    it("steers the child once and wakes the parent once, then stops after grace with reason deadline", async () => {
        await withFakeClock(async () => {
            const h = makeHarness();
            try {
                const run = await spawnRun(h, { deadline_minutes: 0.001, grace_minutes: 0.005, max_minutes: 0, stuck_minutes: 0 });
                await sleep(80);
                await tick();
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

                await sleep(320);
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
                const output = (await h.tools.get("subagent_output").execute("x", { id: run.id }, undefined, undefined, h.ctx)).content[0].text;
                assert.match(output, /Timing: stopped: deadline/);
                await tick();
                assert.equal(wakes(h, "deadline").length, 1);
                await reap(run);
            } finally { h.shutdown(); }
        });
    });

    it("a child that finishes inside grace is not killed and reports deadline: finished in grace", async () => {
        await withFakeClock(async () => {
            writeFakePi("#!/bin/sh\nsleep 0.4\nexit 0\n");
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
