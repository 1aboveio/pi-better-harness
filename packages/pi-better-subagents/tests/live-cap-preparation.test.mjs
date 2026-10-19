import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "live-admission-"));
const original = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.TMPDIR = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR);
const bin = join(root, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "pi"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
process.env.PATH = `${bin}:${original.PATH}`;

// Keep the real catalog/model resolver; control only when its async result is
// delivered to execute. SDK stubs and the inert child never use real credentials.
const catalogUrl = new URL("../catalog-runtime.ts", import.meta.url).href;
const wrapper = `export * from ${JSON.stringify(catalogUrl)};
import { prepareCatalogJob as prepare } from ${JSON.stringify(catalogUrl)};
export async function prepareCatalogJob(...args) {
    const result = await prepare(...args);
    await globalThis.__holdCatalogPreparation?.(args[1]);
    return result;
}`;
const stubs = new URL("./fixtures/earendil-stubs/", import.meta.url).href;
const loader = `export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@earendil-works/")) {
        return { shortCircuit: true, url: ${JSON.stringify(stubs)} + specifier + "/index.js" };
    }
    if (specifier === "./catalog-runtime.ts" && context.parentURL?.endsWith("/index.ts")) {
        return { shortCircuit: true, url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(wrapper))} };
    }
    return nextResolve(specifier, context);
}`;
register("data:text/javascript," + encodeURIComponent(loader));

const { default: extension } = await import("../index.ts");
const registry = await import("../registry.ts");
const capacity = await import("../capacity.mjs");
const config = await import("../config.ts");
const settingsPath = join(process.env.PI_CODING_AGENT_DIR, "settings.json");

function save(cap) {
    writeFileSync(settingsPath, JSON.stringify({ piBetterHarness: { subagents: { maxConcurrent: cap, defaultTools: "read", defaultModel: null } } }));
}

function harness(t) {
    const tools = {};
    const commands = {};
    const handlers = {};
    const entries = [];
    const events = new EventEmitter();
    extension({
        events,
        registerTool(tool) { tools[tool.name] = tool; },
        registerCommand(name, command) { commands[name] = command; },
        appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
        on(name, handler) { handlers[name] = handler; },
        sendMessage() {},
    });
    const model = { provider: "local", id: "fixture", reasoning: true };
    const ctx = { cwd: root, model, hasUI: false, isProjectTrusted: () => false,
        sessionManager: { getBranch: () => entries }, modelRegistry: { getAvailable: () => [model] },
        ui: { setWidget() {}, notify() {} } };
    const run = (tool, params) => tools[tool].execute("live-settings", params, undefined, undefined, ctx);
    const inspect = async () => (await run("subagent_settings", {})).structuredContent;
    t.after(async () => {
        delete globalThis.__holdCatalogPreparation;
        for (const meta of registry.listMetas().filter((m) => m.status === "running")) {
            await run("subagent_stop", { id: meta.id });
        }
        await handlers.session_shutdown({}, ctx);
    });
    return { tools, commands, ctx, events, run, inspect };
}

function holdPreparation(prompt) {
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    globalThis.__holdCatalogPreparation = async (job) => {
        if (job.prompt === prompt) {
            entered.resolve();
            await resume.promise;
        }
    };
    return { entered: entered.promise, release: () => resume.resolve() };
}

const plain = (prompt) => ({ prompt, tools: "read", sandbox: false, callback: false });
const selected = (prompt) => ({ ...plain(prompt), role: "developer", model: "local/fixture", thinking: "low" });
const launchId = (result) => result.content[0].text.match(/id=(sa_[a-z0-9_]+)/)?.[1];

beforeEach(() => {
    rmSync(registry.baseDir(), { recursive: true, force: true });
    capacity._resetSharedCapacityGateForTests();
    config.setConfigPathForTests(undefined);
    save(6);
});

after(() => {
    config.setConfigPathForTests(undefined);
    for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
});

test("external saved cap edits update inspect, semantic revisions, and both admission paths", async (t) => {
    const h = harness(t);
    const before = await h.inspect();
    assert.equal(before.maxConcurrent, 6);
    const id = launchId(await h.run("subagent_spawn", plain("already running")));
    assert.ok(id);
    save(1);
    const lowered = await h.inspect();
    assert.equal(lowered.maxConcurrent, 1);
    assert.equal(lowered.runningCount, 1);
    assert.equal(lowered.availableSlots, 0);
    assert.notEqual(lowered.revision, before.revision);
    save(1);
    assert.equal((await h.inspect()).revision, lowered.revision, "rewriting the same value is not a semantic revision");
    await h.commands.subagents.handler("cap 1", h.ctx);
    const session = await h.inspect();
    assert.equal(session.maxConcurrent, 1);
    assert.equal(session.sources.maxConcurrent, "session");
    assert.notEqual(session.revision, lowered.revision, "same value with a new source is a semantic revision");
    await h.commands.subagents.handler("reset", h.ctx);
    assert.equal((await h.inspect()).revision, lowered.revision);
    await assert.rejects(h.run("subagent_spawn", plain("blocked single")), /Max concurrent subagents \(1\)/);
    await assert.rejects(h.run("subagent_spawn_batch", { jobs: [plain("blocked batch")] }), /0\/1 subagent slots free/);
    assert.deepEqual(registry.listMetas().map((m) => m.id), [id]);
});

test("a pending single loses admission after a saved cap reduction without stopping running work", async (t) => {
    const h = harness(t);
    const id = launchId(await h.run("subagent_spawn", plain("existing")));
    const held = holdPreparation("pending single");
    const pending = h.run("subagent_spawn", selected("pending single"));
    await held.entered;
    assert.equal((await h.inspect()).pendingCount, 1);
    save(1);
    const rejected = assert.rejects(pending, /Max concurrent subagents \(1\)/);
    held.release();
    await rejected;
    assert.equal((await h.inspect()).pendingCount, 0);
    assert.deepEqual(registry.listMetas().map((m) => [m.id, m.status]), [[id, "running"]]);
    assert.deepEqual(readdirSync(join(registry.baseDir(), "runs")), [id], "refused launch artifacts are discarded");
    process.kill(registry.readMeta(id).pid, 0);
    save(2);
    assert.ok(launchId(await h.run("subagent_spawn", plain("reservation released"))));
});

test("a cap change during synchronous launch preparation is checked at the child boundary", async (t) => {
    const h = harness(t);
    const id = launchId(await h.run("subagent_spawn", plain("existing boundary run")));
    let changed;
    h.events.once("pi-better-sandbox:policy-request", () => {
        changed = h.commands.subagents.handler("cap 1", h.ctx);
    });
    await assert.rejects(h.run("subagent_spawn", plain("synchronous preparation")), /Max concurrent subagents \(1\)/);
    await changed;
    assert.equal((await h.inspect()).pendingCount, 0);
    assert.deepEqual(registry.listMetas().map((m) => [m.id, m.status]), [[id, "running"]]);
    assert.deepEqual(readdirSync(join(registry.baseDir(), "runs")), [id]);
});

for (const onCapacity of ["reject", "launch-available"]) {
    test(`${onCapacity} batch revalidates a held job and preserves per-job failure/skip receipts`, async (t) => {
        const h = harness(t);
        const held = holdPreparation("held second");
        const pending = h.run("subagent_spawn_batch", {
            jobs: [plain("first"), selected("held second"), plain("third")], onCapacity,
        });
        await held.entered;
        const existing = registry.listMetas();
        assert.equal(existing.length, 1);
        assert.equal((await h.inspect()).pendingCount, onCapacity === "reject" ? 2 : 1);
        await h.commands.subagents.handler("cap 1", h.ctx);
        held.release();
        const receipt = (await pending).structuredContent;
        assert.equal(receipt.status, "partial");
        assert.deepEqual(receipt.launched.map(({ job, id }) => [job, id]), [[1, existing[0].id]]);
        assert.deepEqual(receipt.failed.map(({ job }) => job), onCapacity === "reject" ? [2, 3] : [2]);
        assert.match(receipt.failed[0].reason, /Max concurrent subagents \(1\)/);
        assert.deepEqual(receipt.skipped.map(({ job }) => job), onCapacity === "reject" ? [] : [3]);
        assert.equal((await h.inspect()).pendingCount, 0);
        assert.deepEqual(registry.listMetas().map((m) => [m.id, m.status]), [[existing[0].id, "running"]]);
        assert.deepEqual(readdirSync(join(registry.baseDir(), "runs")), [existing[0].id]);
        process.kill(existing[0].pid, 0);
        await h.commands.subagents.handler("cap 2", h.ctx);
        assert.ok(launchId(await h.run("subagent_spawn", plain("released batch reservations"))));
    });
}

test("pending reject reservations do not block an already reserved job that fits the reduced cap", async (t) => {
    const h = harness(t);
    const held = holdPreparation("held first");
    const pending = h.run("subagent_spawn_batch", { jobs: [selected("held first"), plain("second"), plain("third")] });
    await held.entered;
    save(1);
    held.release();
    const receipt = (await pending).structuredContent;
    assert.deepEqual(receipt.launched.map(({ job }) => job), [1]);
    assert.deepEqual(receipt.failed.map(({ job }) => job), [2, 3]);
    assert.equal((await h.inspect()).pendingCount, 0);
    assert.equal((await h.inspect()).runningCount, 1);
});
