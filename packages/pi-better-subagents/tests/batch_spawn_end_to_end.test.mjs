/**
 * End-to-end batch spawn test using a fake `pi` binary.
 *
 * This exercises the real index.ts spawn path without a model: a fake `pi`
 * executable is placed on PATH, the extension is loaded with a stubbed
 * ExtensionAPI, and subagent_spawn_batch is invoked. Each child writes a
 * minimal JSON log and exits 0, so registry/parse/finalize paths are real.
 *
 * Stubs for @earendil-works/* resolve entirely from a temp module root via a
 * process-local ESM loader. This test never creates, unlinks, or mutates
 * checkout node_modules (or any other package path under the repo).
 *
 * // @covers subagent-spawn-batch.end-to-end
 * // @level integration
 * // @covers subagent-spawn-batch.capacity-admission
 * // @level integration
 */
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    chmodSync,
    rmSync,
    existsSync,
    lstatSync,
    readdirSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const RUNTIME = mkdtempSync(join(tmpdir(), "batch-spawn-e2e-"));
process.env.TMPDIR = RUNTIME;

// All stub packages live under a temp root. Checkout node_modules is never touched.
const STUBS_DIR = mkdtempSync(join(RUNTIME, "stubs-"));
const CHECKOUT_NODE_MODULES = join(REPO_ROOT, "node_modules");

function writeStubPackage(name, files) {
    const pkgDir = join(STUBS_DIR, ...name.split("/"));
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({ name, type: "module", main: "index.js", exports: { ".": "./index.js" } }),
    );
    for (const [file, content] of Object.entries(files)) {
        writeFileSync(join(pkgDir, file), content);
    }
    return pkgDir;
}

function setupStubs() {
    writeStubPackage("@earendil-works/pi-ai", {
        "index.js": `
const scalar = (type, opts = {}) => ({ type, ...opts });
export const Type = {
    String: (opts) => scalar("string", opts),
    Number: (opts) => scalar("number", opts),
    Boolean: (opts) => scalar("boolean", opts),
    Optional: (schema) => schema,
    Array: (schema, opts = {}) => ({ type: "array", items: schema, ...opts }),
    Object: (props, opts = {}) => ({ type: "object", properties: props, ...opts }),
};
`,
    });
    writeStubPackage("@earendil-works/pi-coding-agent", {
        "index.js": "// Type-only stub\nexport class CustomEditor {}\n",
    });
    writeStubPackage("@earendil-works/pi-tui", {
        "index.js": `
export const Key = { left: "left" };
export function matchesKey() { return false; }
export function truncateToWidth(s) { return s; }
`,
    });

    // Loader resolves packages from STUBS_DIR only — no checkout mutation.
    const loaderPath = join(RUNTIME, "stub-loader.mjs");
    writeFileSync(
        loaderPath,
        `import { pathToFileURL } from "node:url";
const stubs = {
  "@earendil-works/pi-ai": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-ai/index.js"))},
  "@earendil-works/pi-coding-agent": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-coding-agent/index.js"))},
  "@earendil-works/pi-tui": ${JSON.stringify(join(STUBS_DIR, "@earendil-works/pi-tui/index.js"))},
};
export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier)) {
    return { shortCircuit: true, url: pathToFileURL(stubs[specifier]).href };
  }
  return nextResolve(specifier, context);
}
`,
    );
    register(pathToFileURL(loaderPath).href);
}

function assertCheckoutNodeModulesUntouched() {
    // Invariant: this suite must not create package trees or symlinks under the
    // checkout node_modules. An empty dir left by an older run is fine; any
    // package path is not.
    if (!existsSync(CHECKOUT_NODE_MODULES)) return;
    const entries = [];
    const walk = (dir, rel = "") => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const childRel = rel ? `${rel}/${name}` : name;
            let st;
            try {
                st = lstatSync(full);
            } catch {
                continue;
            }
            if (st.isSymbolicLink()) {
                entries.push(`symlink:${childRel}`);
            } else if (st.isDirectory()) {
                // Empty package-scope dirs from prior interrupted runs are ok only
                // when they contain nothing. Nested files/symlinks fail the invariant.
                walk(full, childRel);
            } else {
                entries.push(`file:${childRel}`);
            }
        }
    };
    walk(CHECKOUT_NODE_MODULES);
    assert.deepEqual(
        entries,
        [],
        `checkout node_modules must stay free of stubs/packages; found: ${entries.join(", ") || "(none)"}`,
    );
}

function clearRuns() {
    const runsDir = join(RUNTIME, "pi-better-subagents", "runs");
    rmSync(runsDir, { recursive: true, force: true });
}

function writeRunningMeta({ writeMeta, nextRunId }, name) {
    const id = nextRunId();
    const startedAt = Date.now();
    writeMeta({
        id,
        name,
        status: "running",
        pid: process.pid,
        spawnPid: process.pid,
        cwd: RUNTIME,
        promptPreview: "fake",
        startedAt,
        logPath: join(RUNTIME, "pi-better-subagents", "runs", id, "output.log"),
        sessionId: id,
    });
    return id;
}

function fakePiScript() {
    return `#!/bin/bash
if [ -n "$PI_SLEEP_SECONDS" ]; then
  sleep "$PI_SLEEP_SECONDS"
fi
id=""
sess=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id) id="$2"; shift 2 ;;
    --session-dir) sess="$2"; shift 2 ;;
    *) shift ;;
  esac
done
base=$(dirname "$sess")
log="$base/runs/$id/output.log"
mkdir -p "$(dirname "$log")"
printf '%s\\n' '{"type":"agent_settled"}' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}' > "$log"
`;
}

function makeMockPi() {
    const binDir = mkdtempSync(join(RUNTIME, "fake-bin-"));
    const piPath = join(binDir, "pi");
    writeFileSync(piPath, fakePiScript(), { mode: 0o755 });
    chmodSync(piPath, 0o755);
    return binDir;
}

function makeCtx() {
    return {
        cwd: RUNTIME,
        model: { provider: "test", id: "model" },
        hasUI: false,
        ui: { setWidget() {}, notify() {} },
    };
}

function loadExtension(mod) {
    const tools = {};
    const messages = [];
    const pi = {
        registerTool(def) {
            tools[def.name] = def;
        },
        on() {},
        sendMessage(msg, opts) {
            messages.push({ msg, opts });
        },
    };
    mod.default(pi);
    return { tools, messages };
}

function countOwnedRunning(listMetas, effectiveStatus, ownedByThisParent) {
    return listMetas().filter((m) => ownedByThisParent(m) && effectiveStatus(m) === "running").length;
}

async function waitForFinished(readMeta, id, { maxAttempts = 80, delayMs = 25 } = {}) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const meta = readMeta(id);
        if (meta && meta.status !== "running") return meta;
        await new Promise((r) => setTimeout(r, delayMs));
    }
    throw new Error(`run ${id} did not finish in time`);
}

describe("subagent_spawn_batch end-to-end", () => {
    let origPath;
    let mod;
    let registry;
    let capacity;

    before(async () => {
        origPath = process.env.PATH;
        setupStubs();
        assertCheckoutNodeModulesUntouched();
        const binDir = makeMockPi();
        process.env.PATH = `${binDir}:${origPath}`;
        mod = await import("../index.ts");
        registry = await import("../registry.ts");
        capacity = await import("../capacity.mjs");
        assertCheckoutNodeModulesUntouched();
    });

    beforeEach(() => {
        clearRuns();
        capacity._resetSharedCapacityGateForTests();
    });

    after(() => {
        process.env.PATH = origPath;
        // Cleanup owns only the temp RUNTIME tree created by this suite.
        rmSync(RUNTIME, { recursive: true, force: true });
        assertCheckoutNodeModulesUntouched();
    });

    it("does not mutate checkout node_modules for stubs", () => {
        assertCheckoutNodeModulesUntouched();
        // Source pin: setup must not reference checkout package path mutation APIs.
        // Behavioral proof is the filesystem assertion above.
        assert.equal(existsSync(join(CHECKOUT_NODE_MODULES, "@earendil-works/pi-ai")), false);
        assert.equal(existsSync(join(CHECKOUT_NODE_MODULES, "@earendil-works/pi-coding-agent")), false);
    });

    it("launches multiple jobs and records batchId/batchName in each meta", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        const res = await tools.subagent_spawn_batch.execute(
            "tc1",
            {
                batchName: "reviewers",
                shared: { model: "test/model", tools: "read,bash", sandbox: false },
                jobs: [
                    { prompt: "say hello" },
                    { prompt: "say world" },
                ],
            },
            null,
            null,
            ctx,
        );

        const text = res.content[0].text;
        assert.match(text, /Batch reviewers \(batch_[a-z0-9_]+\) launched 2 Subagent\(s\):/i);
        const ids = [...text.matchAll(/→ (sa_[a-z0-9_]+)/g)].map((m) => m[1]);
        assert.equal(ids.length, 2);
        assert.notEqual(ids[0], ids[1]);

        for (const id of ids) {
            const meta = registry.readMeta(id);
            assert.ok(meta, `meta for ${id} should exist`);
            assert.ok(meta.batchId, `meta.batchId should be set for ${id}`);
            assert.equal(meta.batchName, "reviewers");
            assert.equal(meta.status, "running");
            assert.equal(meta.model, "test/model");
        }
    });

    it("rejects the whole batch before launching when capacity is exceeded", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        // Fill capacity by writing four running metas for this parent PID.
        for (let i = 0; i < 4; i++) {
            writeRunningMeta(registry, `runner-${i}`);
        }

        await assert.rejects(
            () =>
                tools.subagent_spawn_batch.execute(
                    "tc2",
                    { shared: { tools: "read,bash", sandbox: false }, jobs: [{ prompt: "overflow" }] },
                    null,
                    null,
                    ctx,
                ),
            /Batch of 1 jobs exceeds available capacity \(0\/4 subagent slots free\)/,
        );
    });

    it("reject-mode batch + concurrent single-spawn never exceeds maxConcurrent", async () => {
        // Class counterexample: maxConcurrent free slots = 2. A two-job reject
        // batch and a concurrent single spawn race. Without shared reservation,
        // batch launches job 1, yields, single takes a slot, batch launches job 2
        // → 3 new runs (plus the 2 pre-filled = 5 > 4). With reservation, either
        // the batch takes both free slots or the single takes one and the batch
        // is rejected wholesale — never oversubscribe.
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        for (let i = 0; i < 2; i++) {
            writeRunningMeta(registry, `prefill-${i}`);
        }
        const before = countOwnedRunning(
            registry.listMetas,
            registry.effectiveStatus,
            registry.ownedByThisParent,
        );
        assert.equal(before, 2);

        const batchP = tools.subagent_spawn_batch.execute(
            "tc-race-batch",
            {
                shared: { tools: "read,bash", sandbox: false },
                jobs: [
                    { prompt: "race-a", name: "race-a" },
                    { prompt: "race-b", name: "race-b" },
                ],
            },
            null,
            null,
            ctx,
        );
        const singleP = tools.subagent_spawn.execute(
            "tc-race-single",
            { prompt: "race-single", name: "race-single", tools: "read,bash", sandbox: false },
            null,
            null,
            ctx,
        ).then(
            (res) => ({ ok: true, res }),
            (err) => ({ ok: false, err }),
        );

        const [batchOutcome, singleOutcome] = await Promise.all([
            batchP.then(
                (res) => ({ ok: true, res }),
                (err) => ({ ok: false, err }),
            ),
            singleP,
        ]);

        const after = countOwnedRunning(
            registry.listMetas,
            registry.effectiveStatus,
            registry.ownedByThisParent,
        );
        assert.ok(
            after <= 4,
            `owned running must not exceed maxConcurrent=4; got ${after} ` +
                `(batch ok=${batchOutcome.ok}, single ok=${singleOutcome.ok})`,
        );

        // Exactly one of: batch fully launched (2) and single rejected, or
        // single launched (1) and batch fully rejected. Never a partial batch
        // plus a single that together oversubscribe.
        if (batchOutcome.ok) {
            const text = batchOutcome.res.content[0].text;
            assert.match(text, /launched 2 subagent\(s\):/i);
            assert.equal(singleOutcome.ok, false, "single must be refused when batch reserved both free slots");
            assert.match(String(singleOutcome.err?.message ?? singleOutcome.err), /Max concurrent subagents/);
            assert.equal(after, 4); // 2 prefill + 2 batch
        } else {
            assert.equal(singleOutcome.ok, true, "if batch is rejected, single should have taken a free slot");
            assert.match(
                String(batchOutcome.err?.message ?? batchOutcome.err),
                /Batch of 2 jobs exceeds available capacity/,
            );
            assert.ok(after <= 4);
            // Single alone: 2 prefill + 1 single = 3
            assert.equal(after, 3);
        }
    });

    it("launch-available partial launch reports skipped jobs", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        // Fill capacity to 3/4.
        for (let i = 0; i < 3; i++) {
            writeRunningMeta(registry, `runner-${i}`);
        }

        const res = await tools.subagent_spawn_batch.execute(
            "tc3",
            {
                shared: { tools: "read,bash", sandbox: false },
                jobs: [{ prompt: "a" }, { prompt: "b" }],
                onCapacity: "launch-available",
            },
            null,
            null,
            ctx,
        );

        const text = res.content[0].text;
        assert.match(text, /launched 1 subagent\(s\):/i);
        assert.match(text, /Skipped \(capacity\): job-2/);
    });

    it("launch-available reports per-job launch failures without stopping successful launches", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        // Point the extension package lookup to a temp dir so the mapped
        // extension for web_fetch is reported missing, causing only that job
        // to fail while the read,bash job launches normally.
        const fakeAgentDir = mkdtempSync(join(RUNTIME, "fake-agent-"));
        const origAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
        try {
            const res = await tools.subagent_spawn_batch.execute(
                "tc3b",
                {
                    shared: { model: "test/model", sandbox: false },
                    jobs: [
                        { prompt: "a", tools: "read,bash" },
                        { prompt: "b", tools: "web_fetch" },
                    ],
                    onCapacity: "launch-available",
                },
                null,
                null,
                ctx,
            );

            const text = res.content[0].text;
            assert.match(text, /launched 1 subagent\(s\):/i);
            assert.match(text, /Failed \(1\): job-2: .*@juicesharp\/rpiv-web-tools/);
            const launchedId = text.match(/→ (sa_[a-z0-9_]+)/)?.[1];
            assert.ok(launchedId);
            const meta = registry.readMeta(launchedId);
            assert.equal(meta.status, "running");
        } finally {
            if (origAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = origAgentDir;
            }
        }
    });

    it("reject mode accounts for later jobs when an earlier launch fails", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        const fakeAgentDir = mkdtempSync(join(RUNTIME, "fake-agent-"));
        const origAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
        try {
            const res = await tools.subagent_spawn_batch.execute(
                "tc3c",
                {
                    shared: { model: "test/model", sandbox: false },
                    jobs: [
                        { prompt: "ok-job", name: "ok", tools: "read,bash" },
                        { prompt: "bad-job", name: "bad", tools: "web_fetch" },
                        { prompt: "later-job", name: "later", tools: "read,bash" },
                    ],
                },
                null,
                null,
                ctx,
            );

            const text = res.content[0].text;
            assert.match(text, /launched 1 subagent\(s\):/i);
            assert.match(text, /• ok → sa_/);
            assert.match(text, /Failed \(2\):/);
            assert.match(text, /bad: .*@juicesharp\/rpiv-web-tools/);
            assert.match(text, /later: not launched due to earlier job failure in reject mode/);
            // The already-launched run must still be running (no auto-stop).
            const launchedId = text.match(/• ok → (sa_[a-z0-9_]+)/)?.[1];
            assert.ok(launchedId);
            assert.equal(registry.readMeta(launchedId).status, "running");
            // Released unused reservations so later spawns are not blocked.
            const after = countOwnedRunning(
                registry.listMetas,
                registry.effectiveStatus,
                registry.ownedByThisParent,
            );
            assert.equal(after, 1);
            const follow = await tools.subagent_spawn.execute(
                "tc3c-follow",
                { prompt: "after-reject-failure", tools: "read,bash", sandbox: false },
                null,
                null,
                ctx,
            );
            assert.match(follow.content[0].text, /Subagent launched/);
        } finally {
            if (origAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = origAgentDir;
            }
        }
    });

    it("launch-available backfills a later job when an earlier admitted job fails before spawn", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        // Leave exactly 1 free slot. If the first admitted job fails before
        // launching a run, the second job must still get that slot.
        for (let i = 0; i < 3; i++) {
            writeRunningMeta(registry, `runner-${i}`);
        }

        const fakeAgentDir = mkdtempSync(join(RUNTIME, "fake-agent-"));
        const origAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = fakeAgentDir;
        try {
            const res = await tools.subagent_spawn_batch.execute(
                "tc3d",
                {
                    shared: { model: "test/model", sandbox: false },
                    jobs: [
                        { prompt: "bad-first", name: "bad", tools: "web_fetch" },
                        { prompt: "good-second", name: "good", tools: "read,bash" },
                        { prompt: "third", name: "third", tools: "read,bash" },
                    ],
                    onCapacity: "launch-available",
                },
                null,
                null,
                ctx,
            );

            const text = res.content[0].text;
            assert.match(text, /launched 1 subagent\(s\):/i);
            assert.match(text, /• good → sa_/);
            assert.match(text, /Failed \(1\): bad: .*@juicesharp\/rpiv-web-tools/);
            assert.match(text, /Skipped \(capacity\): third/);
            const launchedId = text.match(/• good → (sa_[a-z0-9_]+)/)?.[1];
            assert.ok(launchedId);
            assert.equal(registry.readMeta(launchedId).status, "running");
        } finally {
            if (origAgentDir === undefined) {
                delete process.env.PI_CODING_AGENT_DIR;
            } else {
                process.env.PI_CODING_AGENT_DIR = origAgentDir;
            }
        }
    });

    it("single subagent_spawn still works and leaves batch fields empty", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        const res = await tools.subagent_spawn.execute("tc", { prompt: "solo", tools: "read,bash", sandbox: false }, null, null, ctx);
        const text = res.content[0].text;
        const match = text.match(/id=(sa_[a-z0-9_]+)/);
        assert.ok(match);
        const meta = registry.readMeta(match[1]);
        assert.equal(meta.batchId, undefined);
        assert.equal(meta.batchName, undefined);
    });

    it("batch-launched run ids work with subagent_output", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        const res = await tools.subagent_spawn_batch.execute(
            "tc4",
            {
                shared: { tools: "read,bash", sandbox: false },
                jobs: [{ prompt: "emit output" }],
            },
            null,
            null,
            ctx,
        );
        const id = res.content[0].text.match(/→ (sa_[a-z0-9_]+)/)?.[1];
        assert.ok(id);

        await waitForFinished(registry.readMeta, id);
        const out = await tools.subagent_output.execute("tc4-out", { id });
        const text = out.content[0].text;
        assert.match(text, /completed/);
        assert.match(text, /done/);
    });

    it("batch-launched run ids work with subagent_result after completion", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        const res = await tools.subagent_spawn_batch.execute(
            "tc5",
            {
                shared: { tools: "read,bash", sandbox: false },
                jobs: [{ prompt: "finish and report" }],
            },
            null,
            null,
            ctx,
        );
        const id = res.content[0].text.match(/→ (sa_[a-z0-9_]+)/)?.[1];
        assert.ok(id);

        await waitForFinished(registry.readMeta, id);
        const result = await tools.subagent_result.execute("tc5-result", { id });
        const text = result.content[0].text;
        assert.match(text, /completed/);
        assert.match(text, /done/);
    });

    it("batch-launched run ids work with subagent_stop", async () => {
        const { tools } = loadExtension(mod);
        const ctx = makeCtx();

        process.env.PI_SLEEP_SECONDS = "10";
        try {
            const res = await tools.subagent_spawn_batch.execute(
                "tc6",
                {
                    shared: { tools: "read,bash", sandbox: false },
                    jobs: [{ prompt: "sleep a while" }],
                },
                null,
                null,
                ctx,
            );
            const id = res.content[0].text.match(/→ (sa_[a-z0-9_]+)/)?.[1];
            assert.ok(id);

            const stop = await tools.subagent_stop.execute("tc6-stop", { id });
            assert.match(stop.content[0].text, /Stopped subagent/);

            const meta = registry.readMeta(id);
            assert.equal(meta.status, "killed");
        } finally {
            delete process.env.PI_SLEEP_SECONDS;
        }
    });
});
