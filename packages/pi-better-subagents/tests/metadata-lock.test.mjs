/**
 * Metadata lock: a live holder paused past two seconds must not be stolen,
 * release must not drop a newer owner's lock, and a crashed owner is recoverable.
 *
 * // @covers registry.metadata-lock
 * // @level integration
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = fileURLToPath(new URL("../registry.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TSX_CJS = fileURLToPath(new URL("../../../node_modules/tsx/dist/cjs/index.cjs", import.meta.url));

function tempRoot() {
    return mkdtempSync(join(tmpdir(), "meta-lock-"));
}

/** Node 22.0 has no node:sqlite and rejects this flag. Later 22.x and 24 accept it. */
function sqliteOffArgs() {
    const probe = spawnSync(process.execPath, ["--no-experimental-sqlite", "-e", "process.exit(0)"], { encoding: "utf8" });
    return probe.status === 0 ? ["--no-experimental-sqlite"] : [];
}

function runNode(script, env, { timeoutMs = 20_000, args = ["--import", "tsx", "--input-type=module", "-e"] } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [...args, script], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`timed out\n${stderr}\n${stdout}`));
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error(`child exited ${code}\n${stderr}\n${stdout}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function baseMeta(id, extra) {
    return {
        id,
        status: "running",
        pid: 1,
        spawnPid: 1,
        cwd: "/tmp",
        promptPreview: "lock",
        startedAt: 1,
        logPath: `/tmp/${id}.log`,
        sessionId: id,
        ...extra,
    };
}

describe("run metadata lock", { concurrency: false }, () => {
    it("does not let a paused live worker steal or overwrite the first snapshot", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const script = `
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const registry = ${JSON.stringify(REGISTRY)};
const id = "sa_pause_worker";
const sab = new SharedArrayBuffer(16);
const sync = new Int32Array(sab);
const metaPath = join(process.env.TMPDIR, "pi-better-subagents", "runs", id, "meta.json");
const lockPath = join(process.env.TMPDIR, "pi-better-subagents", "runs", id, ".meta.lock");
const worker = \`
require(${JSON.stringify(TSX_CJS)});
const { parentPort, workerData } = require("node:worker_threads");
const { writeMeta, setMetaWriteBarrierForTests } = require(workerData.registry);
const sync = new Int32Array(workerData.sab);
if (workerData.role === "A") {
  setMetaWriteBarrierForTests(() => {
    Atomics.store(sync, 0, 1);
    Atomics.notify(sync, 0);
    while (Atomics.load(sync, 1) === 0) Atomics.wait(sync, 1, 0, 20);
  });
}
try {
  if (workerData.role === "B") {
    while (Atomics.load(sync, 0) !== 1) Atomics.wait(sync, 0, 0, 20);
  }
  writeMeta(workerData.meta);
  parentPort.postMessage({ role: workerData.role, ok: true });
} catch (error) {
  parentPort.postMessage({ role: workerData.role, ok: false, message: error.message, code: error.code ?? null });
}
\`;
const inbox = [];
function start(role, meta) {
  const child = new Worker(worker, { eval: true, execArgv: [], workerData: { registry, role, sab, meta, id } });
  child.on("message", (message) => inbox.push(message));
  return child;
}
const holder = base(${JSON.stringify(baseMeta("sa_pause_worker", { name: "holder-A", catalog: { marker: "A", identity: { label: "holder-A" } } }))});
const waiter = base(${JSON.stringify(baseMeta("sa_pause_worker", { name: "holder-B", status: "completed", endedAt: 5, catalog: { marker: "B", identity: { label: "holder-B" } } }))});
function base(meta) { return meta; }
start("A", holder);
const entered = Date.now();
while (Atomics.load(sync, 0) !== 1) {
  if (Date.now() - entered > 5000) throw new Error("holder did not enter the lock");
  Atomics.wait(sync, 0, 0, 20);
}
start("B", waiter);
await new Promise((resolve) => setTimeout(resolve, 2300));
const mid = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
const lockMid = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
Atomics.store(sync, 1, 1);
Atomics.notify(sync, 1);
const deadline = Date.now() + 8000;
while (inbox.length < 2) {
  if (Date.now() > deadline) throw new Error("workers did not finish " + JSON.stringify(inbox));
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const finalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
process.stdout.write(JSON.stringify({
  midMarker: mid?.catalog?.marker ?? null,
  lockHeldByLivePid: lockMid?.includes(String(process.pid)) === true,
  finalMarker: finalMeta.catalog.marker,
  finalName: finalMeta.name,
  finalStatus: finalMeta.status,
  inbox,
}));
`;
        try {
            const { stdout } = await runNode(script, { TMPDIR: root, TMP: root, TEMP: root });
            const reported = JSON.parse(stdout);
            assert.equal(reported.midMarker, null);
            assert.equal(reported.lockHeldByLivePid, true);
            assert.equal(reported.finalMarker, "A");
            assert.equal(reported.finalName, "holder-A");
            assert.equal(reported.finalStatus, "completed");
            assert.deepEqual(reported.inbox.map((item) => item.ok), [true, true]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not let another process steal a lock from a stopped live writer", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const held = join(root, "held");
        const go = join(root, "go");
        const id = "sa_pause_proc";
        const holderScript = `
import { writeFileSync, existsSync } from "node:fs";
import { writeMeta, setMetaWriteBarrierForTests } from ${JSON.stringify(REGISTRY)};
const park = new Int32Array(new SharedArrayBuffer(4));
setMetaWriteBarrierForTests(() => {
  writeFileSync(${JSON.stringify(held)}, "1");
  while (!existsSync(${JSON.stringify(go)})) Atomics.wait(park, 0, 0, 30);
});
writeMeta(${JSON.stringify(baseMeta(id, { name: "proc-A", catalog: { marker: "A" } }))});
`;
        const waiterScript = `
import { writeMeta } from ${JSON.stringify(REGISTRY)};
writeMeta(${JSON.stringify(baseMeta(id, { name: "proc-B", status: "failed", catalog: { marker: "B" } }))});
`;
        const env = { TMPDIR: root, TMP: root, TEMP: root };
        const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", holderScript], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
        });
        try {
            const started = Date.now();
            while (!existsSync(held)) {
                if (Date.now() - started > 5000) throw new Error("holder did not acquire the lock");
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            process.kill(holder.pid, "SIGSTOP");
            const waiter = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", waiterScript], {
                cwd: REPO_ROOT,
                env: { ...process.env, ...env },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let waiterErr = "";
            waiter.stderr.setEncoding("utf8");
            waiter.stderr.on("data", (chunk) => { waiterErr += chunk; });
            await new Promise((resolve) => setTimeout(resolve, 2300));
            const metaPath = join(root, "pi-better-subagents", "runs", id, "meta.json");
            const mid = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null;
            writeFileSync(go, "1");
            process.kill(holder.pid, "SIGCONT");
            const holderCode = await new Promise((resolve) => holder.on("close", resolve));
            const waiterCode = await new Promise((resolve) => waiter.on("close", resolve));
            const finalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
            assert.equal(holderCode, 0, waiterErr);
            assert.equal(waiterCode, 0, waiterErr);
            assert.equal(mid, null);
            assert.equal(finalMeta.catalog.marker, "A");
            assert.equal(finalMeta.name, "proc-A");
        } finally {
            try { process.kill(holder.pid, "SIGCONT"); } catch { /* already gone */ }
            try { process.kill(holder.pid, "SIGKILL"); } catch { /* already gone */ }
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("times out instead of stealing when a live holder outlasts the wait", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const script = `
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const registry = ${JSON.stringify(REGISTRY)};
const id = "sa_timeout";
const sab = new SharedArrayBuffer(16);
const sync = new Int32Array(sab);
const metaPath = join(process.env.TMPDIR, "pi-better-subagents", "runs", id, "meta.json");
const worker = \`
require(${JSON.stringify(TSX_CJS)});
const { parentPort, workerData } = require("node:worker_threads");
const { writeMeta, setMetaWriteBarrierForTests } = require(workerData.registry);
const sync = new Int32Array(workerData.sab);
if (workerData.role === "A") {
  setMetaWriteBarrierForTests(() => {
    Atomics.store(sync, 0, 1);
    Atomics.notify(sync, 0);
    Atomics.wait(sync, 1, 0, 6500);
  });
}
const started = Date.now();
try {
  writeMeta(workerData.meta);
  parentPort.postMessage({ role: workerData.role, ok: true, ms: Date.now() - started });
} catch (error) {
  parentPort.postMessage({ role: workerData.role, ok: false, ms: Date.now() - started, message: error.message });
}
\`;
const inbox = [];
function start(role, meta) {
  const child = new Worker(worker, { eval: true, execArgv: [], workerData: { registry, role, sab, meta } });
  child.on("message", (message) => inbox.push(message));
  return child;
}
start("A", ${JSON.stringify(baseMeta("sa_timeout", { name: "slow", catalog: { marker: "slow" } }))});
while (Atomics.load(sync, 0) !== 1) Atomics.wait(sync, 0, 0, 20);
start("B", ${JSON.stringify(baseMeta("sa_timeout", { name: "waiter", catalog: { marker: "waiter" } }))});
const deadline = Date.now() + 12000;
while (inbox.length < 2) {
  if (Date.now() > deadline) throw new Error("timed out waiting " + JSON.stringify(inbox));
  await new Promise((resolve) => setTimeout(resolve, 30));
}
const finalMeta = JSON.parse(readFileSync(metaPath, "utf8"));
const waiter = inbox.find((item) => item.role === "B");
process.stdout.write(JSON.stringify({
  waiter,
  finalMarker: finalMeta.catalog.marker,
  finalName: finalMeta.name,
  existedDuringWait: existsSync(metaPath),
}));
`;
        try {
            const { stdout } = await runNode(script, { TMPDIR: root, TMP: root, TEMP: root }, { timeoutMs: 20_000 });
            const reported = JSON.parse(stdout);
            assert.equal(reported.waiter.ok, false);
            assert.match(reported.waiter.message, /^Timed out writing metadata for sa_timeout$/);
            assert.ok(reported.waiter.ms >= 4_500 && reported.waiter.ms < 7_000);
            assert.equal(reported.finalMarker, "slow");
            assert.equal(reported.finalName, "slow");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not unlink a newer owner's lock when the previous holder releases", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const ordered = `
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const registry = ${JSON.stringify(REGISTRY)};
const id = "sa_release";
const sab = new SharedArrayBuffer(16);
const sync = new Int32Array(sab);
const lockPath = join(process.env.TMPDIR, "pi-better-subagents", "runs", id, ".meta.lock");
const metaPath = join(process.env.TMPDIR, "pi-better-subagents", "runs", id, "meta.json");
const worker = \`
require(${JSON.stringify(TSX_CJS)});
const { parentPort, workerData } = require("node:worker_threads");
const { writeMeta, setMetaWriteBarrierForTests } = require(workerData.registry);
const sync = new Int32Array(workerData.sab);
let passed = false;
setMetaWriteBarrierForTests(() => {
  if (passed) return;
  passed = true;
  Atomics.store(sync, 0, 1);
  Atomics.notify(sync, 0);
  while (Atomics.load(sync, 1) === 0) Atomics.wait(sync, 1, 0, 20);
});
try {
  writeMeta(workerData.meta);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
\`;
const child = new Worker(worker, {
  eval: true,
  execArgv: [],
  workerData: { registry, sab, meta: ${JSON.stringify(baseMeta("sa_release", { name: "old", catalog: { marker: "old" } }))} },
});
const message = new Promise((resolve, reject) => child.on("message", resolve).on("error", reject));
const started = Date.now();
while (Atomics.load(sync, 0) !== 1) {
  if (Date.now() - started > 5000) throw new Error("holder did not enter");
  await new Promise((resolve) => setTimeout(resolve, 10));
}
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "newer-owner", start: null }));
Atomics.store(sync, 1, 1);
Atomics.notify(sync, 1);
const result = await message;
const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, "utf8")) : null;
process.stdout.write(JSON.stringify({
  result,
  metaExists: existsSync(metaPath),
  token: lock?.token ?? null,
}));
`;
        try {
            const { stdout } = await runNode(ordered, { TMPDIR: root, TMP: root, TEMP: root }, { timeoutMs: 15_000 });
            const reported = JSON.parse(stdout);
            assert.equal(reported.result.ok, false);
            assert.match(reported.result.message, /^Timed out writing metadata for sa_release$/);
            assert.equal(reported.metaExists, false);
            assert.equal(reported.token, "newer-owner");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("recovers a lock whose owner process was killed", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const held = join(root, "held");
        const id = "sa_crash";
        const holderScript = `
import { writeFileSync } from "node:fs";
import { writeMeta, setMetaWriteBarrierForTests } from ${JSON.stringify(REGISTRY)};
const park = new Int32Array(new SharedArrayBuffer(4));
setMetaWriteBarrierForTests(() => {
  writeFileSync(${JSON.stringify(held)}, String(process.pid));
  Atomics.wait(park, 0, 0, 30000);
});
writeMeta(${JSON.stringify(baseMeta(id, { name: "crashed", catalog: { marker: "crashed" } }))});
`;
        const recoverScript = `
import { writeMeta, readMeta } from ${JSON.stringify(REGISTRY)};
const started = Date.now();
writeMeta(${JSON.stringify(baseMeta(id, { name: "recovered", status: "completed", catalog: { marker: "recovered" } }))});
const meta = readMeta(${JSON.stringify(id)});
process.stdout.write(JSON.stringify({ ms: Date.now() - started, marker: meta.catalog.marker, name: meta.name, status: meta.status }));
`;
        const env = { TMPDIR: root, TMP: root, TEMP: root };
        const holder = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", holderScript], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
        });
        try {
            const started = Date.now();
            while (!existsSync(held)) {
                if (Date.now() - started > 5000) throw new Error("holder did not acquire");
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
            holder.kill("SIGKILL");
            await new Promise((resolve) => holder.on("close", resolve));
            const { stdout } = await runNode(recoverScript, env, { timeoutMs: 8_000 });
            const reported = JSON.parse(stdout);
            assert.ok(reported.ms < 1_500, `recovery took ${reported.ms}ms`);
            assert.equal(reported.marker, "recovered");
            assert.equal(reported.name, "recovered");
            assert.equal(reported.status, "completed");
        } finally {
            try { holder.kill("SIGKILL"); } catch { /* already gone */ }
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("recovers a stale crashed owner record and a legacy pid lock without waiting them out", { timeout: 15_000 }, async () => {
        const root = tempRoot();
        const script = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeMeta, readMeta } from ${JSON.stringify(REGISTRY)};
const root = join(process.env.TMPDIR, "pi-better-subagents", "runs");
function plant(id, body) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".meta.lock"), body);
}
const dead = ${JSON.stringify(baseMeta("sa_dead_json", { name: "fresh", catalog: { marker: "fresh" } }))};
const legacy = ${JSON.stringify(baseMeta("sa_dead_legacy", { name: "legacy", catalog: { marker: "legacy" } }))};
plant(dead.id, JSON.stringify({ pid: 2147483646, token: "stale-owner", start: "not-this-process" }));
plant(legacy.id, "2147483646\\n");
const samples = [];
for (const meta of [dead, legacy]) {
  const started = Date.now();
  writeMeta(meta);
  samples.push({ id: meta.id, ms: Date.now() - started, marker: readMeta(meta.id).catalog.marker, name: readMeta(meta.id).name });
}
process.stdout.write(JSON.stringify(samples));
`;
        try {
            const { stdout } = await runNode(script, { TMPDIR: root, TMP: root, TEMP: root });
            const samples = JSON.parse(stdout);
            assert.equal(samples.length, 2);
            for (const sample of samples) {
                assert.ok(sample.ms < 1_000, `${sample.id} took ${sample.ms}ms`);
            }
            assert.equal(samples[0].marker, "fresh");
            assert.equal(samples[1].marker, "legacy");
            assert.equal(samples[1].name, "legacy");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("reports lock IO failures instead of spinning until the wait expires", { timeout: 15_000 }, async () => {
        const root = tempRoot();
        const script = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeMeta } from ${JSON.stringify(REGISTRY)};
const dir = join(process.env.TMPDIR, "pi-better-subagents", "runs", "sa_io");
mkdirSync(dir, { recursive: true });
mkdirSync(join(dir, ".meta.lock"));
const started = Date.now();
try {
  writeMeta(${JSON.stringify(baseMeta("sa_io", { name: "io" }))});
  process.stdout.write(JSON.stringify({ ok: true, ms: Date.now() - started }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, ms: Date.now() - started, code: error.code ?? null, message: error.message }));
}
`;
        try {
            const { stdout } = await runNode(script, { TMPDIR: root, TMP: root, TEMP: root });
            const reported = JSON.parse(stdout);
            assert.equal(reported.ok, false);
            assert.ok(reported.ms < 1_000, `swallowed IO until ${reported.ms}ms`);
            assert.equal(reported.message.includes("Timed out writing metadata"), false);
            assert.ok(reported.code === "EISDIR" || reported.code === "EPERM" || reported.code === "EEXIST");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps the first catalog and name while later writes still record result status", { timeout: 15_000 }, async () => {
        const root = tempRoot();
        const script = `
import { writeMeta, readMeta } from ${JSON.stringify(REGISTRY)};
const id = "sa_anchor";
writeMeta(${JSON.stringify(baseMeta("sa_anchor", { name: "kept", catalog: { marker: "first", identity: { label: "kept" } } }))});
const replaced = ${JSON.stringify(baseMeta("sa_anchor", {
            name: "replaced",
            status: "completed",
            endedAt: 9,
            exitCode: 0,
            catalog: { marker: "second" },
        }))};
writeMeta(replaced);
const kept = readMeta(id);
const plainId = "sa_plain";
writeMeta(${JSON.stringify(baseMeta("sa_plain", { name: "plain" }))});
writeMeta(${JSON.stringify(baseMeta("sa_plain", { name: "plain-2", status: "completed", endedAt: 4, exitCode: 0 }))});
const filled = ${JSON.stringify(baseMeta("sa_plain", { name: "incoming", status: "completed", endedAt: 4, exitCode: 0, catalog: { identity: { label: "Incoming" }, marker: "Incoming" } }))};
writeMeta(filled);
const plain = readMeta(plainId);
process.stdout.write(JSON.stringify({
  marker: kept.catalog.marker,
  name: kept.name,
  status: kept.status,
  exitCode: kept.exitCode,
  replacedName: replaced.name,
  replacedMarker: replaced.catalog.marker,
  argumentName: filled.name,
  argumentCatalog: Object.hasOwn(filled, "catalog"),
  plainCatalog: Object.hasOwn(plain, "catalog"),
  plainStatus: plain.status,
  plainName: plain.name,
}));
`;
        try {
            const { stdout } = await runNode(script, { TMPDIR: root, TMP: root, TEMP: root });
            const reported = JSON.parse(stdout);
            assert.equal(reported.marker, "first");
            assert.equal(reported.name, "kept");
            assert.equal(reported.status, "completed");
            assert.equal(reported.exitCode, 0);
            assert.equal(reported.replacedName, "kept");
            assert.equal(reported.replacedMarker, "first");
            assert.equal(reported.argumentName, "plain");
            assert.equal(reported.argumentCatalog, false);
            assert.equal(reported.plainCatalog, false);
            assert.equal(reported.plainStatus, "completed");
            assert.equal(reported.plainName, "plain");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps the first snapshot when several processes write the same run", { timeout: 30_000 }, async () => {
        const root = tempRoot();
        const gate = join(root, "gate");
        const id = "sa_stress";
        const seed = `
import { writeFileSync } from "node:fs";
import { writeMeta } from ${JSON.stringify(REGISTRY)};
writeMeta(${JSON.stringify(baseMeta(id, { name: "first-name", catalog: { marker: "first", snapshot: "immutable" } }))});
writeFileSync(${JSON.stringify(gate)}, "1");
`;
        const hammer = `
import { existsSync } from "node:fs";
import { writeMeta } from ${JSON.stringify(REGISTRY)};
const park = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(${JSON.stringify(gate)})) Atomics.wait(park, 0, 0, 20);
const tag = process.env.HAMMER_TAG;
for (let i = 0; i < 15; i += 1) {
  writeMeta(${JSON.stringify(baseMeta(id, { status: "completed", endedAt: 3 }))}.name = tag, ${JSON.stringify(baseMeta(id, { status: "completed", endedAt: 3, catalog: { marker: "nope" } }))});
}
`.replace(
            `${JSON.stringify(baseMeta(id, { status: "completed", endedAt: 3 }))}.name = tag, ${JSON.stringify(baseMeta(id, { status: "completed", endedAt: 3, catalog: { marker: "nope" } }))}`,
            `Object.assign(${JSON.stringify(baseMeta(id, { status: "completed", endedAt: 3, catalog: { marker: "nope" } }))}, { name: tag, catalog: { marker: tag } })`,
        );
        const env = { TMPDIR: root, TMP: root, TEMP: root };
        try {
            await runNode(seed, env);
            await Promise.all(Array.from({ length: 6 }, (_, index) => runNode(hammer, { ...env, HAMMER_TAG: `other-${index}` })));
            const meta = JSON.parse(readFileSync(join(root, "pi-better-subagents", "runs", id, "meta.json"), "utf8"));
            assert.equal(meta.catalog.marker, "first");
            assert.equal(meta.catalog.snapshot, "immutable");
            assert.equal(meta.name, "first-name");
            assert.equal(meta.status, "completed");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("adopts a legacy meta.json snapshot before a later writer can replace it", { timeout: 15_000 }, async () => {
        const root = tempRoot();
        const script = `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeMeta, readMeta } from ${JSON.stringify(REGISTRY)};
const id = "sa_legacy_anchor";
const dir = join(process.env.TMPDIR, "pi-better-subagents", "runs", id);
mkdirSync(dir, { recursive: true });
const planted = ${JSON.stringify(baseMeta("sa_legacy_anchor", { name: "legacy-name", catalog: { marker: "legacy", snapshot: "planted" } }))};
writeFileSync(join(dir, "meta.json"), JSON.stringify(planted, null, 2));
writeMeta({ ...planted, name: "incoming", status: "completed", endedAt: 9, exitCode: 0, catalog: { marker: "incoming" } });
const meta = readMeta(id);
process.stdout.write(JSON.stringify({
  marker: meta.catalog.marker,
  snapshot: meta.catalog.snapshot,
  name: meta.name,
  status: meta.status,
  exitCode: meta.exitCode,
  launch: JSON.parse(readFileSync(join(dir, ".launch.json"), "utf8")),
}));
`;
        try {
            const { stdout } = await runNode(script, { TMPDIR: root, TMP: root, TEMP: root });
            const reported = JSON.parse(stdout);
            assert.equal(reported.marker, "legacy");
            assert.equal(reported.snapshot, "planted");
            assert.equal(reported.name, "legacy-name");
            assert.equal(reported.status, "completed");
            assert.equal(reported.exitCode, 0);
            assert.equal(reported.launch.name, "legacy-name");
            assert.equal(reported.launch.catalog.marker, "legacy");
            assert.equal(reported.launch.catalog.snapshot, "planted");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps the first persisted snapshot when stale recovery renames a live token", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const scriptPath = join(root, "fallback-race.cjs");
        const sqliteArgs = sqliteOffArgs();
        const source = `
const { Worker, isMainThread, workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = ${JSON.stringify(REPO_ROOT)};
if (!isMainThread) {
  require(ROOT + "/node_modules/tsx/dist/cjs/index.cjs");
  const sync = new Int32Array(workerData.sab);
  const signal = (i) => { Atomics.store(sync, i, 1); Atomics.notify(sync, i); };
  const park = (i) => { if (Atomics.wait(sync, i, 0, 15000) === "timed-out") throw Error("park timeout " + i); };
  const originalRename = fs.renameSync;
  let intercepted = false;
  fs.renameSync = function(from, to, ...rest) {
    if (workerData.role === "A" && path.basename(String(from)) === ".meta.lock" && !intercepted) {
      intercepted = true;
      signal(0); park(1);
      const result = originalRename.call(this, from, to, ...rest);
      signal(2); park(3);
      return result;
    }
    if (workerData.role === "B" && path.basename(String(to)) === "meta.json" && !intercepted) {
      intercepted = true;
      signal(4); park(5);
    }
    return originalRename.call(this, from, to, ...rest);
  };
  const { writeMeta } = require(ROOT + "/packages/pi-better-subagents/registry.ts");
  try {
    writeMeta({id:"race", name:workerData.role, catalog:{marker:workerData.role},status:"running",pid:1,spawnPid:1,cwd:process.env.TMPDIR,promptPreview:"synthetic",startedAt:1,logPath:"none",sessionId:"test"});
    parentPort.postMessage({role:workerData.role, ok:true});
  } catch (e) { parentPort.postMessage({role:workerData.role, ok:false, error:e.message}); }
} else {
  (async () => {
    let sqlite = true;
    try { require("node:sqlite"); } catch { sqlite = false; }
    const fixture = fs.mkdtempSync(path.join(${JSON.stringify(root)}, "fallback-race-"));
    process.env.TMPDIR = fixture; process.env.TMP = fixture; process.env.TEMP = fixture;
    const run = path.join(fixture, "pi-better-subagents/runs/race");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, ".meta.lock"), JSON.stringify({ pid: 2147483646, token: "dead" }));
    const sab = new SharedArrayBuffer(32), sync = new Int32Array(sab), workers = [];
    const start = (role) => {
      const w = new Worker(__filename, { workerData: { role, sab }, execArgv: ${JSON.stringify(sqliteArgs)} });
      workers.push(w);
      return new Promise((resolve, reject) => w.once("message", resolve).once("error", reject));
    };
    const wait = (i) => { if (Atomics.wait(sync, i, 0, 10000) === "timed-out") throw Error("wait timeout " + i); };
    const release = (i) => { Atomics.store(sync, i, 1); Atomics.notify(sync, i); };
    try {
      const a = start("A"); wait(0);
      const b = start("B"); wait(4);
      release(1); wait(2);
      const c = await start("C");
      const first = JSON.parse(fs.readFileSync(path.join(run, "meta.json"), "utf8"));
      release(3);
      await new Promise((r) => setTimeout(r, 100)); release(5);
      const outcomes = await Promise.all([a, b]);
      const finalMeta = JSON.parse(fs.readFileSync(path.join(run, "meta.json"), "utf8"));
      const launch = JSON.parse(fs.readFileSync(path.join(run, ".launch.json"), "utf8"));
      console.log(JSON.stringify({
        sqlite,
        first: first.catalog.marker,
        final: finalMeta.catalog.marker,
        firstName: first.name,
        finalName: finalMeta.name,
        launchName: launch.name,
        launchMarker: launch.catalog.marker,
        splitName: fs.existsSync(path.join(run, ".launch-name")),
        splitCatalog: fs.existsSync(path.join(run, ".launch-catalog.json")),
        outcomes: [c, ...outcomes],
      }));
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
`;
        writeFileSync(scriptPath, source);
        try {
            const { stdout } = await runNode(scriptPath, {
                TMPDIR: root,
                TMP: root,
                TEMP: root,
                REVIEW_EARLY_NODE: "1",
                TSX_DISABLE_CACHE: "1",
            }, {
                args: sqliteArgs,
                timeoutMs: 20_000,
            });
            const reported = JSON.parse(stdout);
            assert.equal(reported.sqlite, false);
            assert.equal(reported.first, reported.final);
            assert.equal(reported.firstName, reported.finalName);
            assert.equal(reported.firstName, reported.first);
            assert.equal(reported.launchName, reported.finalName);
            assert.equal(reported.launchMarker, reported.final);
            assert.equal(reported.splitName, false);
            assert.equal(reported.splitCatalog, false);
            assert.ok(reported.first === "A" || reported.first === "B" || reported.first === "C");
            assert.deepEqual(reported.outcomes.map((item) => item.ok), [true, true, true]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps one whole launch when a writer pauses after the launch link", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const scriptPath = join(root, "coherent-launch.cjs");
        const sqliteArgs = sqliteOffArgs();
        const source = `
const { Worker, isMainThread, workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const ROOT = ${JSON.stringify(REPO_ROOT)};
function snapshot(role) {
  return {
    id: "race",
    name: role,
    catalog: {
      identity: { label: role, id: "agent." + role.toLowerCase() },
      effective: { marker: role },
      provenance: { source: role },
    },
    status: role === "C" ? "completed" : "running",
    ...(role === "C" ? { endedAt: 2, exitCode: 0, completionCallbackSentAt: 3 } : {}),
    pid: 1,
    spawnPid: 1,
    cwd: process.env.TMPDIR,
    promptPreview: role,
    startedAt: 1,
    logPath: "none",
    sessionId: "test",
  };
}
if (!isMainThread) {
  require(ROOT + "/node_modules/tsx/dist/cjs/index.cjs");
  const sync = new Int32Array(workerData.sab);
  const signal = (i) => { Atomics.store(sync, i, 1); Atomics.notify(sync, i); };
  const park = (i) => { if (Atomics.wait(sync, i, 0, 15000) === "timed-out") throw Error("park timeout " + i); };
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let held = false;
  fs.renameSync = function(from, to, ...rest) {
    if (workerData.role === "A" && path.basename(String(from)) === ".meta.lock" && !held) {
      held = true;
      signal(0); park(1);
      const result = originalRename.call(this, from, to, ...rest);
      signal(2); park(3);
      return result;
    }
    return originalRename.call(this, from, to, ...rest);
  };
  fs.linkSync = function(from, to, ...rest) {
    const result = originalLink.call(this, from, to, ...rest);
    if (workerData.role === "B" && path.basename(String(to)) === ".launch.json" && !held) {
      held = true;
      signal(4); park(5);
    }
    return result;
  };
  const { writeMeta } = require(ROOT + "/packages/pi-better-subagents/registry.ts");
  try {
    writeMeta(snapshot(workerData.role));
    parentPort.postMessage({ role: workerData.role, ok: true });
  } catch (e) {
    parentPort.postMessage({ role: workerData.role, ok: false, error: e.message });
  }
} else {
  (async () => {
    const fixture = fs.mkdtempSync(path.join(${JSON.stringify(root)}, "coherent-launch-"));
    process.env.TMPDIR = fixture; process.env.TMP = fixture; process.env.TEMP = fixture;
    const run = path.join(fixture, "pi-better-subagents/runs/race");
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, ".meta.lock"), JSON.stringify({ pid: 2147483646, token: "dead" }));
    const sab = new SharedArrayBuffer(32), sync = new Int32Array(sab), workers = [];
    const start = (role) => {
      const w = new Worker(__filename, { workerData: { role, sab }, execArgv: ${JSON.stringify(sqliteArgs)} });
      workers.push(w);
      return new Promise((resolve, reject) => w.once("message", resolve).once("error", reject));
    };
    const wait = (i) => { if (Atomics.wait(sync, i, 0, 10000) === "timed-out") throw Error("wait timeout " + i); };
    const release = (i) => { Atomics.store(sync, i, 1); Atomics.notify(sync, i); };
    try {
      const a = start("A"); wait(0);
      const b = start("B"); wait(4);
      release(1); wait(2);
      const c = await start("C");
      const first = JSON.parse(fs.readFileSync(path.join(run, "meta.json"), "utf8"));
      const launchAtFirst = fs.readFileSync(path.join(run, ".launch.json"), "utf8");
      release(3); release(5);
      const outcomes = [c, ...await Promise.all([a, b])];
      const finalMeta = JSON.parse(fs.readFileSync(path.join(run, "meta.json"), "utf8"));
      const launch = JSON.parse(fs.readFileSync(path.join(run, ".launch.json"), "utf8"));
      console.log(JSON.stringify({
        first, final: finalMeta, launch, launchUnchanged: launchAtFirst === JSON.stringify(launch), outcomes,
      }));
    } finally {
      await Promise.all(workers.map((w) => w.terminate()));
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  })().catch((e) => { console.error(e); process.exitCode = 1; });
}
`;
        writeFileSync(scriptPath, source);
        try {
            const { stdout } = await runNode(scriptPath, {
                TMPDIR: root,
                TMP: root,
                TEMP: root,
                TSX_DISABLE_CACHE: "1",
            }, { args: sqliteArgs, timeoutMs: 20_000 });
            const reported = JSON.parse(stdout);
            const catalog = {
                identity: { label: "B", id: "agent.b" },
                effective: { marker: "B" },
                provenance: { source: "B" },
            };
            assert.equal(reported.launch.name, "B");
            assert.deepEqual(reported.launch.catalog, catalog);
            assert.equal(reported.launchUnchanged, true);
            assert.equal(reported.first.name, "B");
            assert.deepEqual(reported.first.catalog, catalog);
            assert.equal(reported.first.status, "completed");
            assert.equal(reported.first.endedAt, 2);
            assert.equal(reported.first.exitCode, 0);
            assert.equal(reported.first.completionCallbackSentAt, 3);
            assert.equal(reported.final.name, "B");
            assert.deepEqual(reported.final.catalog, catalog);
            assert.deepEqual(reported.outcomes.map((item) => item.ok), [true, true, true]);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("adopts a whole legacy launch and ignores a partial or mismatched anchor", { timeout: 20_000 }, async () => {
        const root = tempRoot();
        const scriptPath = join(root, "launch-record-cases.cjs");
        const source = `
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const ROOT = ${JSON.stringify(REPO_ROOT)};
if (process.argv[2] === "child") {
  require(ROOT + "/node_modules/tsx/dist/cjs/index.cjs");
  const original = fs.linkSync;
  fs.linkSync = function(from, to, ...rest) {
    const result = original.call(this, from, to, ...rest);
    if (path.basename(String(to)) === ".launch.json") process.exit(42);
    return result;
  };
  const { writeMeta } = require(ROOT + "/packages/pi-better-subagents/registry.ts");
  writeMeta(JSON.parse(process.argv[3]));
  process.exit(0);
}
require(ROOT + "/node_modules/tsx/dist/cjs/index.cjs");
const { writeMeta, readMeta, runDir } = require(ROOT + "/packages/pi-better-subagents/registry.ts");
function snap(id, role, extra) {
  return Object.assign({
    id, name: role,
    catalog: {
      identity: { label: role, id: "agent." + role.toLowerCase() },
      effective: { marker: role },
      provenance: { source: role },
    },
    status: "running", pid: 1, spawnPid: 1, cwd: process.env.TMPDIR,
    promptPreview: role, startedAt: 1, logPath: "none", sessionId: "test",
  }, extra || {});
}
function plant(id) {
  fs.mkdirSync(runDir(id), { recursive: true });
  return runDir(id);
}
const out = {};
{
  const dir = plant("orphan-name");
  fs.writeFileSync(path.join(dir, ".launch-name"), "A");
  const incoming = snap("orphan-name", "B", { status: "completed", endedAt: 4, exitCode: 0 });
  writeMeta(incoming);
  out.orphanName = { argument: incoming.name, argumentLabel: incoming.catalog.identity.label, disk: readMeta("orphan-name") };
}
{
  const dir = plant("split");
  fs.writeFileSync(path.join(dir, ".launch-name"), "A");
  fs.writeFileSync(path.join(dir, ".launch-catalog.json"), JSON.stringify({ identity: { label: "C", id: "agent.c" }, effective: { marker: "C" }, provenance: { source: "C" } }));
  writeMeta(snap("split", "B"));
  out.split = readMeta("split");
}
{
  const dir = plant("legacy-full");
  const old = snap("legacy-full", "Legacy");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(old));
  const incoming = snap("legacy-full", "Incoming", { status: "completed", endedAt: 9, exitCode: 0 });
  writeMeta(incoming);
  out.legacyFull = { argument: incoming, disk: readMeta("legacy-full"), launch: JSON.parse(fs.readFileSync(path.join(dir, ".launch.json"), "utf8")) };
}
{
  const dir = plant("legacy-null");
  const old = snap("legacy-null", "Legacy", { catalog: null });
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(old));
  const incoming = snap("legacy-null", "Incoming", { status: "completed", endedAt: 9, exitCode: 0 });
  writeMeta(incoming);
  out.legacyNull = { catalog: incoming.catalog, disk: readMeta("legacy-null"), launch: JSON.parse(fs.readFileSync(path.join(dir, ".launch.json"), "utf8")) };
}
{
  const dir = plant("legacy-absent");
  const old = snap("legacy-absent", "Legacy");
  delete old.catalog;
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(old));
  const incoming = snap("legacy-absent", "Incoming", { status: "completed", endedAt: 9, exitCode: 0 });
  writeMeta(incoming);
  const disk = readMeta("legacy-absent");
  out.legacyAbsent = {
    argumentName: incoming.name,
    argumentCatalog: Object.hasOwn(incoming, "catalog"),
    diskName: disk.name,
    diskCatalog: Object.hasOwn(disk, "catalog"),
    diskStatus: disk.status,
    launch: JSON.parse(fs.readFileSync(path.join(dir, ".launch.json"), "utf8")),
  };
}
{
  const dir = plant("mismatch");
  const old = snap("mismatch", "A");
  old.catalog = { identity: { label: "C", id: "agent.c" }, effective: { marker: "C" }, provenance: { source: "C" } };
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(old));
  const incoming = snap("mismatch", "B", { status: "completed", endedAt: 6, exitCode: 0 });
  writeMeta(incoming);
  out.mismatch = { disk: readMeta("mismatch"), launch: JSON.parse(fs.readFileSync(path.join(dir, ".launch.json"), "utf8")) };
}
{
  const dir = plant("truncated");
  fs.writeFileSync(path.join(dir, "meta.json"), "{not-json");
  writeMeta(snap("truncated", "B"));
  out.truncated = readMeta("truncated");
}
{
  const crashed = snap("crash", "A");
  const child = spawnSync(process.execPath, [__filename, "child", JSON.stringify(crashed)], { env: process.env, encoding: "utf8", timeout: 15000 });
  const dir = runDir("crash");
  const before = {
    exit: child.status,
    launch: JSON.parse(fs.readFileSync(path.join(dir, ".launch.json"), "utf8")),
    meta: fs.existsSync(path.join(dir, "meta.json")),
    splitName: fs.existsSync(path.join(dir, ".launch-name")),
  };
  const incoming = snap("crash", "B", { status: "completed", endedAt: 7, exitCode: 0, completionCallbackSentAt: 8 });
  writeMeta(incoming);
  out.crash = { before, argument: incoming, disk: readMeta("crash"), stderr: child.stderr };
}
{
  const dir = plant("corrupt");
  fs.writeFileSync(path.join(dir, ".launch.json"), "");
  let message = null;
  try { writeMeta(snap("corrupt", "B")); } catch (error) { message = error.message; }
  out.corrupt = { message, meta: fs.existsSync(path.join(dir, "meta.json")), launch: fs.readFileSync(path.join(dir, ".launch.json"), "utf8") };
}
{
  const first = snap("status", "Same");
  writeMeta(first);
  const update = snap("status", "Other", { status: "completed", endedAt: 4, exitCode: 0, completionCallbackSentAt: 8 });
  writeMeta(update);
  out.status = { argument: update, disk: readMeta("status") };
}
console.log(JSON.stringify(out));
`;
        writeFileSync(scriptPath, source);
        try {
            const { stdout } = await runNode(scriptPath, {
                TMPDIR: root,
                TMP: root,
                TEMP: root,
                TSX_DISABLE_CACHE: "1",
            }, { args: [], timeoutMs: 20_000 });
            const reported = JSON.parse(stdout);
            const whole = (role) => ({
                identity: { label: role, id: "agent." + role.toLowerCase() },
                effective: { marker: role },
                provenance: { source: role },
            });
            assert.equal(reported.orphanName.argument, "B");
            assert.equal(reported.orphanName.argumentLabel, "B");
            assert.equal(reported.orphanName.disk.name, "B");
            assert.deepEqual(reported.orphanName.disk.catalog, whole("B"));
            assert.equal(reported.orphanName.disk.status, "completed");
            assert.equal(reported.split.name, "B");
            assert.deepEqual(reported.split.catalog, whole("B"));
            assert.equal(reported.legacyFull.argument.name, "Legacy");
            assert.deepEqual(reported.legacyFull.argument.catalog, whole("Legacy"));
            assert.equal(reported.legacyFull.argument.status, "completed");
            assert.equal(reported.legacyFull.disk.name, "Legacy");
            assert.deepEqual(reported.legacyFull.disk.catalog, whole("Legacy"));
            assert.equal(reported.legacyFull.disk.status, "completed");
            assert.equal(reported.legacyFull.launch.name, "Legacy");
            assert.deepEqual(reported.legacyFull.launch.catalog, whole("Legacy"));
            assert.equal(reported.legacyNull.catalog, null);
            assert.equal(reported.legacyNull.disk.name, "Legacy");
            assert.equal(reported.legacyNull.disk.catalog, null);
            assert.equal(reported.legacyNull.disk.status, "completed");
            assert.equal(reported.legacyNull.launch.name, "Legacy");
            assert.equal(reported.legacyNull.launch.catalog, null);
            assert.equal(reported.legacyAbsent.argumentName, "Legacy");
            assert.equal(reported.legacyAbsent.argumentCatalog, false);
            assert.equal(reported.legacyAbsent.diskName, "Legacy");
            assert.equal(reported.legacyAbsent.diskCatalog, false);
            assert.equal(reported.legacyAbsent.diskStatus, "completed");
            assert.equal(reported.legacyAbsent.launch.name, "Legacy");
            assert.equal(Object.hasOwn(reported.legacyAbsent.launch, "catalog"), false);
            assert.equal(reported.mismatch.disk.name, "A");
            assert.equal(reported.mismatch.disk.catalog.identity.label, "C");
            assert.equal(reported.mismatch.disk.status, "completed");
            assert.equal(reported.mismatch.launch.name, "A");
            assert.equal(reported.mismatch.launch.catalog.identity.label, "C");
            assert.notEqual(reported.mismatch.launch.name, reported.mismatch.launch.catalog.identity.label);
            assert.equal(reported.truncated.name, "B");
            assert.deepEqual(reported.truncated.catalog, whole("B"));
            assert.equal(reported.crash.before.exit, 42);
            assert.equal(reported.crash.before.meta, false);
            assert.equal(reported.crash.before.splitName, false);
            assert.equal(reported.crash.before.launch.name, "A");
            assert.deepEqual(reported.crash.before.launch.catalog, whole("A"));
            assert.equal(reported.crash.argument.name, "A");
            assert.deepEqual(reported.crash.argument.catalog, whole("A"));
            assert.equal(reported.crash.argument.status, "completed");
            assert.equal(reported.crash.argument.completionCallbackSentAt, 8);
            assert.equal(reported.crash.disk.name, "A");
            assert.deepEqual(reported.crash.disk.catalog, whole("A"));
            assert.equal(reported.crash.disk.status, "completed");
            assert.equal(reported.crash.disk.endedAt, 7);
            assert.equal(reported.crash.disk.completionCallbackSentAt, 8);
            assert.match(reported.corrupt.message, /Unreadable launch record for corrupt/);
            assert.equal(reported.corrupt.meta, false);
            assert.equal(reported.corrupt.launch, "");
            assert.equal(reported.status.argument.name, "Same");
            assert.deepEqual(reported.status.argument.catalog, whole("Same"));
            assert.equal(reported.status.argument.status, "completed");
            assert.equal(reported.status.argument.completionCallbackSentAt, 8);
            assert.equal(reported.status.disk.name, "Same");
            assert.deepEqual(reported.status.disk.catalog, whole("Same"));
            assert.equal(reported.status.disk.status, "completed");
            assert.equal(reported.status.disk.exitCode, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
