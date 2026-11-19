import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, appendFileSync, statSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MessageChannel, receiveMessageOnPort, type Worker } from "node:worker_threads";
import { fixture } from "./support/query-fixture.ts";
import { HostSourceWatches, nativeWatch } from "../src/runtime/source-watch.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { createQueryPhaseBuffer, readQueryPhases, recordQueryPhase, queryPhase } from "../src/runtime/query-phase-diagnostics.mjs";
const { commitMetadata } = await import(String("../scripts/event-publication/commit.mjs"));


async function ready(client: WorkClient) {
  await client.subscribe({});
  if (client.snapshot?.status === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { stop(); reject(new Error("read worker did not finish its initial inventory")); }, 5000);
    const stop = client.onChange(snapshot => { if (snapshot.status === "ready") { clearTimeout(timeout); stop(); resolve(); } });
  });
}

test("query fixture cancellation closes live and already-ended resources without retaining the process", { timeout: 20000 }, () => {
  // The host supports Node 22; this no-isolation control uses the already
  // provisioned private Node 24, as does the managed mutation-store test.
  const runtime = Number(process.versions.node.split(".")[0]) < 24 ? process.env.PI_TEST_PRIVATE_RUNTIME_NODE : process.execPath;
  assert.ok(runtime, "Set PI_TEST_PRIVATE_RUNTIME_NODE to the verified private Node 24 binary");
  for (const mode of ["bootstrap-held", "already-ended"]) {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_QUERY_FIXTURE_CANCEL_MODE: mode };
    delete env.NODE_TEST_CONTEXT;
    const child: SpawnSyncReturns<string> = spawnSync(runtime, ["--import", "tsx", "--test", "--test-isolation=none", "--test-reporter=tap",
      new URL("./support/query-fixture-cancel.mjs", import.meta.url).pathname], {
      env, encoding: "utf8", timeout: 8000,
    });
    assert.equal(child.error, undefined, `${mode}: ${child.error}\n${child.stdout}\n${child.stderr}`);
    assert.equal(child.status, 1, `the deliberate test timeout remains a failure, not a waived assertion\n${child.stdout}\n${child.stderr}`);
    assert.match(child.stdout, /test timed out after 1000ms/);
    assert.match(child.stdout, /"workerStopped":true,"clientDestroyed":true,"transportRemoved":true,"rootRemoved":true/);
    if (mode === "already-ended") {
      assert.match(child.stdout, /"code":"ECONNRESET","expected":true/);
      assert.match(child.stdout, /"code":"EPIPE","expected":true/);
    }
  }
});

test("unexpected accepted-peer errors cannot stand in for the intentional cancellation timeout", { timeout: 20000 }, () => {
  const runtime = Number(process.versions.node.split(".")[0]) < 24 ? process.env.PI_TEST_PRIVATE_RUNTIME_NODE : process.execPath;
  assert.ok(runtime);
  for (const mode of ["unannounced-reset", "unannounced-pipe", "unexpected-error"]) {
    const env = { ...process.env, PI_QUERY_FIXTURE_CANCEL_MODE: mode } as NodeJS.ProcessEnv;
    delete env.NODE_TEST_CONTEXT;
    const child: SpawnSyncReturns<string> = spawnSync(runtime, ["--import", "tsx", "--test", "--test-isolation=none", "--test-reporter=tap",
      new URL("./support/query-fixture-cancel.mjs", import.meta.url).pathname], { env, encoding: "utf8", timeout: 8000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, child.stderr);
    assert.doesNotMatch(child.stdout, /test timed out after 1000ms/);
    assert.match(child.stdout, mode === "unannounced-reset" ? /code: 'ECONNRESET'/ : mode === "unannounced-pipe" ? /code: 'EPIPE'/ : /code: 'EIO'/);
    assert.match(child.stdout, /"expected":false/);
    assert.match(child.stdout, /"workerStopped":true,"clientDestroyed":true,"transportRemoved":true,"rootRemoved":true/);
  }
});

test("host-owned native streams survive forced read worker termination during actual writes", { timeout: 15000 }, async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const f = await fixture();
    let writes: ReturnType<typeof setInterval> | undefined;
    try {
      const client = await f.client(); await ready(client);
      const directory = join(f.root, "runs", "sa_native_exit"); mkdirSync(directory);
      const put = () => writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_native_exit", cwd: f.root, status: "completed", startedAt: 1, name: "writing" }));
      put(); writes = setInterval(put, 2);
      await f.stall();
      await f.worker.terminate();
      clearInterval(writes); writes = undefined;
      assert.equal((await client.request("ping")).ok, true);
    } finally { clearInterval(writes); await f.close(); }
    assert.equal(f.executor.metrics().sourceSubscriptions.allocated, 0, "dead workers cannot retain native streams");
  }
});

test("executor close retains delayed native stops within its existing bounded shutdown", { timeout: 10000 }, async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const host = new HostSourceWatches((path, changed, failed) => {
    const stop = nativeWatch(path, changed, failed);
    return async () => { await stop(); await gate; };
  });
  (f.executor as any).sourceWatches = host;
  try {
    const client = await f.client(); await ready(client);
    const began = performance.now(); await f.executor.close();
    assert.ok(performance.now() - began < 1500);
    assert.ok(host.metrics().retiring > 0);
    release(); await host.close();
    assert.equal(host.metrics().allocated, 0);
  } finally { release(); await f.close(); }
});

test("a dropped same-consumer snapshot reports a gap while unrelated global commits do not", { timeout: 10000 }, async () => {
  const f = await fixture();
  const peers = new Set<Socket>();
  let dropped = false;
  const proxy = createServer(downstream => {
    const upstream = connect(f.path); peers.add(upstream); peers.add(downstream);
    downstream.pipe(upstream); upstream.setEncoding("utf8");
    let buffer = "";
    upstream.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const frame = JSON.parse(line);
        if (frame.event?.type === "runtime_snapshot" && frame.event.snapshot.rows[0]?.meta.name === "gap-one") {
          dropped = true; continue;
        }
        downstream.write(line + "\n");
      }
    });
    upstream.on("error", () => downstream.destroy()); downstream.on("error", () => upstream.destroy());
  });
  let consumer: WorkClient | undefined;
  const write = (id: string, cwd: string, name: string) => {
    mkdirSync(join(f.root, "runs", id), { recursive: true });
    const path = join(f.root, "runs", id, "meta.json");
    writeFileSync(path + ".tmp", JSON.stringify({ id, cwd, name, status: "completed", startedAt: 1 }));
    renameSync(path + ".tmp", path);
  };
  const wait = async (condition: () => boolean) => {
    const deadline = Date.now() + 1000;
    while (!condition()) { assert.ok(Date.now() < deadline, "controlled scoped publication missing"); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const control = await f.client(); await ready(control);
    const scope = { cwd: join(f.root, "b"), limit: 10 };
    write("sa_b", scope.cwd, "before"); await f.executor.livenessReasons(); await control.subscribe(scope);
    const path = f.path + ".gap"; proxy.listen(path); await once(proxy, "listening");
    consumer = new WorkClient(path, f.root); await consumer.subscribe(scope);
    const seen: any[] = []; consumer.onChange(value => seen.push(value));
    write("sa_a", join(f.root, "a"), "unrelated"); await f.executor.livenessReasons();
    write("sa_b", scope.cwd, "after-unrelated"); await f.executor.livenessReasons();
    await wait(() => consumer!.snapshot?.rows[0]?.meta.name === "after-unrelated");
    assert.equal(seen.some(value => value.resyncReason === "sequence-gap"), false);
    seen.length = 0;
    write("sa_b", scope.cwd, "gap-one"); await f.executor.livenessReasons(); await wait(() => dropped);
    write("sa_b", scope.cwd, "gap-two"); await f.executor.livenessReasons();
    await wait(() => consumer!.snapshot?.rows[0]?.meta.name === "gap-two");
    assert.equal(dropped, true);
    assert.equal(consumer.snapshot!.resyncRequired, true, "the first complete snapshot after the dropped event reports the gap");
    assert.equal(consumer.snapshot!.resyncReason, "sequence-gap");
    assert.equal(consumer.snapshot!.status, "ready");
  } finally {
    consumer?.close(); peers.forEach(peer => peer.destroy());
    await new Promise<void>(resolve => proxy.close(() => resolve())); await f.close();
  }
});

test("identical Work identities do not share visible results across admitted roots", { timeout: 10000 }, async () => {
  const left = await fixture(), right = await fixture();
  try {
    const clients = [await left.client(), await right.client()];
    await Promise.all(clients.map(ready));
    for (const [index, f] of [left, right].entries()) {
      mkdirSync(join(f.root, "runs/sa_same"));
      writeFileSync(join(f.root, "runs/sa_same/meta.json"), JSON.stringify({ id: "sa_same", cwd: "/same-workspace",
        callbackOrigin: { cwd: "/same-workspace", sessionId: "same-session" }, status: "completed", startedAt: 1, name: `root-${index}` }));
      await f.executor.livenessReasons();
    }
    const scope = { cwd: "/same-workspace", sessionId: "same-session", id: "sa_same" };
    assert.equal((await clients[0]!.get(scope)).rows[0]!.meta.name, "root-0");
    assert.equal((await clients[1]!.get(scope)).rows[0]!.meta.name, "root-1");
    assert.equal((await clients[0]!.get({ ...scope, sessionId: "other" })).rows.length, 0);
  } finally { await left.close(); await right.close(); }
});

for (const { count, readOnEvent } of [
  ...[1, 5, 10].map(count => ({ count, readOnEvent: false })),
  { count: 10, readOnEvent: true },
]) test(readOnEvent ? "10 socket clients share publication with concurrent event-triggered reads" : `${count} socket clients share scoped query and encoding work`, { timeout: 15000 }, async () => {
  const f = await fixture();
  const scope = { cwd: join(f.root, "b"), limit: 1 };
  const write = (id: string, cwd: string, name: string) => {
    mkdirSync(join(f.root, "runs", id), { recursive: true });
    writeFileSync(join(f.root, "runs", id, "meta.json"), JSON.stringify({ id, cwd, name, status: "completed", startedAt: 1 }));
  };
  try {
    const first = await f.client(); await ready(first);
    write("sa_a", join(f.root, "a"), "a"); write("sa_b1", scope.cwd, "b1"); write("sa_b2", scope.cwd, "b2");
    await f.executor.livenessReasons();
    const clients = [first, ...await Promise.all(Array.from({ length: count - 1 }, () => f.client()))];
    for (const client of clients) await client.subscribe(scope);
    const page = await first.get(scope);
    const before = f.executor.metrics() as any;
    let events = 0;
    let phase = "metadata-update";
    const frameSummary = (value: any) => {
      const cursor = value.nextCursor ?? value.rows?.[0]?.cursor;
      let publicationScope;
      if (cursor) {
        try {
          const [key, instanceId, tokenRevision] = JSON.parse(Buffer.from(cursor, "base64url").toString());
          publicationScope = { key, instanceId, tokenRevision };
        } catch (error) { publicationScope = { decodeError: String(error) }; }
      }
      return { status: value.status, reason: value.reason, seq: value.seq, scopeRevision: value.scopeRevision,
        instanceId: value.instanceId, publicationScope, observedRevisionVector: value.observedRevisionVector,
        resyncRequired: value.resyncRequired, resyncReason: value.resyncReason,
        totalMatching: value.totalMatching, activity: value.activity, nextDeadline: value.nextDeadline,
        rows: value.rows?.map((row: any) => ({ id: row.meta.id, cwd: row.meta.cwd, name: row.meta.name,
          origin: row.meta.callbackOrigin, state: row.assignment.state, sourceRevision: row.sourceRevision })) };
    };
    const frames: Array<{ subscriber: number; phase: string; snapshot: ReturnType<typeof frameSummary> }> = [];
    const stops = clients.map((client, subscriber) => client.onChange(value => {
      events++;
      if (frames.length < 32) frames.push({ subscriber, phase, snapshot: frameSummary(value) });
    }));
    write("sa_a", join(f.root, "a"), "unrelated"); await f.executor.livenessReasons();
    phase = "log-append";
    appendFileSync(join(f.root, "runs/sa_a/output.log"), '{"type":"agent_end"}\n'); await f.executor.livenessReasons();
    phase = "workspace-move";
    write("sa_a", join(f.root, "c"), "moved"); await f.executor.livenessReasons();
    phase = "terminal-update";
    const meta = join(f.root, "runs/sa_a/meta.json");
    writeFileSync(meta, JSON.stringify({ id: "sa_a", cwd: join(f.root, "c"), status: "failed", startedAt: 1 }));
    await f.executor.livenessReasons();
    phase = "deletion";
    rmSync(join(f.root, "runs/sa_a"), { recursive: true }); await f.executor.livenessReasons();
    phase = "final-scoped-read";
    for (const client of clients) await client.get(scope);
    const unchanged = f.executor.metrics() as any;
    try { assert.equal(events, 0, "unrelated content sends no scoped frames"); }
    catch (error) {
      console.error(`Scoped publication failure: ${JSON.stringify({ scope, clients: count, events,
        omittedFrames: events - frames.length, baseline: frameSummary(page), frames,
        final: clients.map(client => frameSummary(client.snapshot)), before, after: unchanged })}`);
      throw error;
    }
    assert.equal(unchanged.queryCount, before.queryCount, "unrelated content retains the cached page");
    assert.equal(unchanged.serializationCount, before.serializationCount);
    const next = await first.get({ ...scope, cursor: page.nextCursor });
    assert.equal(next.rows.length, 1);
    const baseline = f.executor.metrics() as any;
    const eventReads: Array<Promise<any>> = [];
    const received = clients.map(client => new Promise<void>(resolve => {
      const stop = client.onChange(value => { if (value.rows.some((row: any) => row.meta.name === "changed")) {
        if (readOnEvent) eventReads.push(client.get(scope));
        stop(); resolve();
      } });
    }));
    phase = "in-scope-update";
    // A committed replacement has one epoch; partial writes are tested separately.
    await commitMetadata(join(f.root, "runs/sa_b2/meta.json"), "changed");
    await f.executor.livenessReasons(); await Promise.all(received);
    const overlapping = await Promise.all(eventReads);
    if (readOnEvent) {
      assert.equal(overlapping.length, count);
      for (const value of overlapping) assert.equal(value.rows[0]?.meta.name, "changed");
    }
    await first.get(scope);
    const changed = f.executor.metrics() as any;
    try {
      assert.equal(changed.queryCount - baseline.queryCount, 1);
      assert.equal(changed.serializationCount - baseline.serializationCount, 1);
      assert.equal(changed.eventEncoding.serializations - baseline.eventEncoding.serializations, 1);
      assert.equal(changed.eventEncoding.frames - baseline.eventEncoding.frames, count);
    } catch (error) {
      console.error(`Shared query failure: ${JSON.stringify({ scope, clients: count, baseline, changed,
        frames, final: clients.map(client => frameSummary(client.snapshot)) })}`);
      throw error;
    }
    assert.ok(changed.eventEncoding.bytes > baseline.eventEncoding.bytes);
    stops.forEach(stop => stop());
  } finally { await f.close(); }
});

test("10 socket clients share each truthful partial-write and recovery epoch", { timeout: 15000 }, async () => {
  const f = await fixture();
  const scope = { cwd: join(f.root, "b"), limit: 1 };
  const directory = join(f.root, "runs/sa_partial_b"), path = join(directory, "meta.json");
  const meta = { id: "sa_partial_b", cwd: scope.cwd, name: "verified", status: "completed", startedAt: 1 };
  let held: number | undefined;
  try {
    const first = await f.client(); await ready(first);
    mkdirSync(directory); writeFileSync(path, JSON.stringify(meta));
    await f.executor.livenessReasons();
    const clients = [first, ...await Promise.all(Array.from({ length: 9 }, () => f.client()))];
    for (const client of clients) await client.subscribe(scope);
    const initial = await first.get(scope), baseline = f.executor.metrics() as any;
    const frames: any[] = [];
    const sourceWrites: unknown[] = [];
    const stamp = (phase: string) => {
      const info = statSync(path, { bigint: true });
      sourceWrites.push({ phase, identity: `${info.dev}:${info.ino}`, bytes: String(info.size),
        mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
    };
    clients.forEach((client, subscriber) => client.onChange(value => {
      if (frames.length < 40) frames.push({ subscriber, status: value.status, reason: value.reason,
        seq: value.seq, scopeRevision: value.scopeRevision, instanceId: value.instanceId,
        observedRevisionVector: value.observedRevisionVector,
        rows: value.rows.map((row: any) => ({ id: row.meta.id, name: row.meta.name, sourceRevision: row.sourceRevision })) });
    }));
    const awaiting = (status: string) => Promise.all(clients.map(client => new Promise<void>(resolve => {
      const stop = client.onChange(value => { if (value.status === status) { stop(); resolve(); } });
    })));
    const assertSharedEpoch = (before: any, after: any) => {
      try {
        assert.equal(after.queryCount - before.queryCount, 1);
        assert.equal(after.serializationCount - before.serializationCount, 1);
        assert.equal(after.eventEncoding.serializations - before.eventEncoding.serializations, 1);
        assert.equal(after.eventEncoding.frames - before.eventEncoding.frames, clients.length);
      } catch (error) {
        console.error(`Partial-write epoch failure: ${JSON.stringify({ scope, sourceWrites, before, after, frames })}`);
        throw error;
      }
    };
    const degradedFrames = awaiting("degraded");
    held = openSync(path, "w"); writeSync(held, '{"id":');
    stamp("partial-write");
    await f.executor.livenessReasons(); await degradedFrames;
    const degraded = await Promise.all(clients.map(client => client.get(scope)));
    for (const value of degraded) {
      assert.equal(value.status, "degraded");
      assert.match(value.reason!, /SyntaxError/);
      assert.deepEqual(value.rows[0]!.meta, initial.rows[0]!.meta, "partial metadata is never published");
      assert.equal(value.rows[0]!.sourceRevision, initial.rows[0]!.sourceRevision);
      assert.equal(value.scopeRevision, degraded[0]!.scopeRevision);
    }
    const afterFailure = f.executor.metrics() as any;
    assertSharedEpoch(baseline, afterFailure);
    const readyFrames = awaiting("ready");
    writeSync(held, JSON.stringify({ ...meta, name: "changed" }), 0, "utf8");
    closeSync(held); held = undefined;
    stamp("complete-write-and-close");
    await f.executor.livenessReasons(); await readyFrames;
    const recovered = await Promise.all(clients.map(client => client.get(scope)));
    for (const value of recovered) {
      assert.equal(value.status, "ready");
      assert.equal(value.rows[0]!.meta.name, "changed");
      assert.notEqual(value.scopeRevision, degraded[0]!.scopeRevision);
      assert.equal(value.scopeRevision, recovered[0]!.scopeRevision);
    }
    assertSharedEpoch(afterFailure, f.executor.metrics());
  } finally { if (held !== undefined) closeSync(held); await f.close(); }
});

test("stalled diagnostic completion rejects when its worker exits", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client(); await ready(client);
    const busy = await f.stall();
    const rejected = assert.rejects(busy.finished, /worker exited before completing/);
    await f.worker.terminate();
    await rejected;
  } finally { await f.close(); }
});

test("slow caller cancellation preserves other clients and ignores late replies", { timeout: 10000 }, async t => {
  const f = await fixture({ timeoutMs: 700, watchdogMs: 2000,
    workerUrl: new URL("./support/cancellable-query-worker.mjs", import.meta.url) });
  let phase = "bootstrap";
  const requests: Array<Record<string, unknown>> = [];
  const observe = (client: WorkClient, owner: string) => {
    const request = client.request.bind(client);
    client.request = (type, params = {}) => {
      const began = performance.now();
      const entry: Record<string, unknown> = { owner, type, phase, scope: (params as Record<string, unknown>).scope ?? null, state: "pending" };
      if (requests.length < 16) requests.push(entry);
      return request(type, params).then(value => {
        Object.assign(entry, { state: "fulfilled", elapsedMs: performance.now() - began, status: value?.status }); return value;
      }, error => {
        Object.assign(entry, { state: "rejected", elapsedMs: performance.now() - began, error: String(error).slice(0, 512) }); throw error;
      });
    };
  };
  try {
    await f.bootstrapped;
    phase = "source-inventory-ready";
    await f.waitForSourceReady();
    phase = "client-hello";
    const a = await f.client(), b = await f.client();
    observe(a, "slow-client"); observe(b, "other-client");
    phase = "initial-ready-subscription";
    await ready(b);
    const epoch = b.snapshot!.instanceId;
    const blocked = new Promise<void>(resolve => f.worker.on("message", message => { if (message.type === "query-blocked") resolve(); }));
    const began = performance.now();
    phase = "slow-query-blocked";
    const slow = assert.rejects(a.request("runtime_get_snapshot", { scope: { id: "sa_slow" } }), /runtime-timeout: caller/);
    await blocked;
    await new Promise(resolve => setTimeout(resolve, 150));
    phase = "queued-read-and-control";
    const queued = b.request("runtime_get_snapshot", { scope: { limit: 2 } });
    const controlStart = performance.now();
    assert.equal((await b.request("ping")).ok, true);
    assert.deepEqual(await a.request("runtime_unsubscribe"), { unsubscribed: true });
    const controlMs = performance.now() - controlStart;
    phase = "expected-slow-timeout";
    await slow;
    const timeoutMs = performance.now() - began;
    phase = "queued-read-result";
    assert.equal((await queued).status, "ready", "cancellation frees execution without waiting for the slow source");
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(b.snapshot!.instanceId, epoch);
    f.worker.postMessage({ type: "release-query" });
    phase = "fresh-read-after-release";
    const fresh = await b.get({ limit: 3 });
    assert.equal(fresh.status, "ready");
    assert.equal(f.executor.metrics().executor.worker, "running");
    assert.equal(f.executor.metrics().executor.active, 0);
    assert.ok(controlMs < 500);
    t.diagnostic(JSON.stringify({ timeoutMs, controlMs, rebuilding: fresh.status, restart: f.executor.metrics().executor.restarts,
      queueMs: f.executor.metrics().executor.waitMs, executionMs: f.executor.metrics().executor.readMs }));
  } catch (error) {
    try { t.diagnostic(JSON.stringify({ slowCallerFailure: { phase, requests, executor: f.executor.metrics().executor } }).slice(0, 8192)); } catch {}
    throw error;
  } finally { await f.close(); }
});

test("an 800 ms setup subscription cannot verify a source while fixture bootstrap is held", { timeout: 10000 }, async t => {
  const queryPhaseDiagnostics = createQueryPhaseBuffer();
  let phase = "connect";
  const implementation = new URL("./support/cancellable-query-worker.mjs", import.meta.url).href;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort, workerData } from "node:worker_threads";
    const { queryPhase, recordQueryPhase } = await import(${JSON.stringify(new URL("../src/runtime/query-phase-diagnostics.mjs", import.meta.url).href)});
    const deferred = [];
    const buffer = message => {
      if (["query", "cancel"].includes(message.type)) deferred.push(message);
    };
    parentPort.on("message", buffer);
    recordQueryPhase(workerData.queryPhaseDiagnostics, queryPhase.fixtureHeld, 0, workerData.queryPhaseGeneration);
    await new Promise(resolve => {
      const release = message => {
        if (message.type !== "release-bootstrap") return;
        parentPort.off("message", release); resolve();
      };
      parentPort.on("message", release);
    });
    recordQueryPhase(workerData.queryPhaseDiagnostics, queryPhase.fixtureReleased, 0, workerData.queryPhaseGeneration);
    await import(${JSON.stringify(implementation)});
    parentPort.off("message", buffer);
    for (const message of deferred) parentPort.emit("message", message);
  `)}`);
  const f = await fixture({ timeoutMs: 800, watchdogMs: 2500, capacity: 2, workerUrl, queryPhaseDiagnostics });
  try {
    const client = await f.client();
    phase = "deliberate-held-subscription";
    await assert.rejects(ready(client), /runtime-timeout: caller read deadline exceeded; source was not verified/);
    const cold = f.executor.metrics().executor;
    assert.equal(cold.callerTimeouts, 1, "the eager setup subscription owns this deadline");
    assert.equal(cold.queueTimeouts, 0);
    assert.equal(cold.singleflightHits, 0, "shared-caller work has not begun");
    assert.equal(f.executor.observation().status, "rebuilding", "an expired setup read cannot verify the source");
    phase = "bootstrap";
    recordQueryPhase(queryPhaseDiagnostics, queryPhase.releaseSent);
    f.worker.postMessage({ type: "release-bootstrap" });
    await f.bootstrapped;
    phase = "post-bootstrap-subscription";
    await ready(client);
    assert.equal(client.snapshot?.status, "ready");
    assert.equal(f.executor.metrics().executor.callerTimeouts, 1);
    assert.equal(f.executor.metrics().executor.restarts, 0, "a setup deadline does not require a worker restart");
    t.diagnostic(JSON.stringify({ coldCallerTimeouts: cold.callerTimeouts, coldQueueTimeouts: cold.queueTimeouts,
      coldSharedHits: cold.singleflightHits, verifiedAfterBootstrap: client.snapshot?.status }));
  } catch (error) {
    try { t.diagnostic(JSON.stringify({ heldFixtureFailure: { case: 109, phase, observation: f.executor.observation(),
      executor: f.executor.metrics().executor, trace: readQueryPhases(queryPhaseDiagnostics) } }).slice(0, 8192)); } catch {}
    throw error;
  } finally { f.worker.postMessage({ type: "release-bootstrap" }); await f.close(); }
});

test("shared callers have separate deadlines and queue timeouts retain bounded admission", { timeout: 10000 }, async () => {
  const f = await fixture({ timeoutMs: 800, watchdogMs: 2500, capacity: 2,
    workerUrl: new URL("./support/cancellable-query-worker.mjs", import.meta.url) });
  try {
    // Measure caller/queue lifetimes, not cold imports before the fixture owns RPCs.
    await f.bootstrapped;
    const a = await f.client(), b = await f.client(), c = await f.client(); await ready(a);
    const first = assert.rejects(a.request("runtime_get_snapshot", { scope: { id: "sa_slow" } }), /runtime-timeout/);
    const queued = assert.rejects(c.request("runtime_get_snapshot", { scope: { limit: 2 } }), /runtime-overloaded: queued/);
    await new Promise(resolve => setTimeout(resolve, 450));
    const survivor = b.request("runtime_get_snapshot", { scope: { id: "sa_slow" } });
    await assert.rejects(c.get({ limit: 3 }), /queue is full/);
    await Promise.all([first, queued]);
    assert.equal(f.executor.metrics().executor.queued, 0);
    f.worker.postMessage({ type: "release-query" });
    assert.equal((await survivor).status, "ready");
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(f.executor.metrics().executor.singleflightHits, 1);
    assert.equal(f.executor.metrics().executor.queueTimeouts, 1);
    assert.equal(f.executor.metrics().executor.callerTimeouts, 1);
  } finally { await f.close(); }
});

test("responsive fixture imports outlive the wedge watchdog without source readiness", { timeout: 10000 }, async t => {
  const queryPhaseDiagnostics = createQueryPhaseBuffer();
  let phase = "held-heartbeats";
  const implementation = new URL("./support/cancellable-query-worker.mjs", import.meta.url).href;
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
    import { workerData } from "node:worker_threads";
    workerData.fixtureHoldBootstrap = true;
    await import(${JSON.stringify(implementation)});
  `)}`);
  const f = await fixture({ timeoutMs: 400, watchdogMs: 1200, workerUrl, queryPhaseDiagnostics });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      let heartbeats = 0;
      const cleanup = () => { clearTimeout(timeout); f.worker.off("message", message); f.worker.off("exit", exit); };
      const message = (value: any) => { if (value.type === "heartbeat" && ++heartbeats === 6) { cleanup(); resolve(); } };
      const exit = () => { cleanup(); reject(new Error("responsive fixture worker exited before bootstrap")); };
      f.worker.on("message", message); f.worker.once("exit", exit);
      timeout = setTimeout(() => { cleanup(); reject(new Error("fixture bootstrap heartbeat did not progress")); }, 3000);
    });
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(f.executor.observation().status, "rebuilding");
    phase = "bootstrap";
    recordQueryPhase(queryPhaseDiagnostics, queryPhase.releaseSent);
    f.worker.postMessage({ type: "release-bootstrap" });
    await f.bootstrapped;
    phase = "inventory-ready";
    await f.waitForSourceReady();
    phase = "post-ready-subscription";
    const client = await f.client(); await ready(client);
    assert.equal(client.snapshot?.status, "ready");
    assert.equal(f.executor.metrics().executor.restarts, 0);
  } catch (error) {
    try { t.diagnostic(JSON.stringify({ heldFixtureFailure: { case: 111, phase, observation: f.executor.observation(),
      executor: f.executor.metrics().executor, trace: readQueryPhases(queryPhaseDiagnostics) } }).slice(0, 8192)); } catch {}
    throw error;
  } finally { clearTimeout(timeout); await f.close(); }
});

test("watchdog recovers a genuinely wedged worker while socket control stays responsive", { timeout: 10000 }, async t => {
  const f = await fixture({ timeoutMs: 400, watchdogMs: 1200,
    workerUrl: new URL("./support/cancellable-query-worker.mjs", import.meta.url) });
  try {
    // The 400 ms read deadline tests the wedge, not cold worker imports.
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([f.bootstrapped, new Promise<never>((_, reject) => {
        startupTimeout = setTimeout(() => reject(new Error("query fixture did not bootstrap within budget")), 5000);
      })]);
    } finally { clearTimeout(startupTimeout); }
    await f.waitForSourceReady();
    const a = await f.client(), b = await f.client(); await ready(a); await ready(b);
    const epoch = b.snapshot!.instanceId;
    const wedged = new Promise<void>(resolve => f.worker.on("message", message => { if (message.type === "wedged") resolve(); }));
    f.worker.postMessage({ type: "wedge" }); await wedged;
    const began = performance.now();
    await assert.rejects(a.get({ limit: 1 }), /deadline exceeded/);
    const control = performance.now(); assert.equal((await b.request("ping")).ok, true);
    const controlMs = performance.now() - control;
    const until = Date.now() + 5000;
    while (b.snapshot?.instanceId === epoch || b.snapshot?.status !== "ready") {
      assert.ok(Date.now() < until, "wedged worker did not recover within budget");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.executor.metrics().executor.restarts, 1);
    assert.ok(controlMs < 500);
    t.diagnostic(JSON.stringify({ restartMs: performance.now() - began, controlMs, metrics: f.executor.metrics() }));
  } finally { await f.close(); }
});

test("cold bootstrap caller deadline does not imply a wedged read worker", { timeout: 10000 }, async t => {
  const f = await fixture({ timeoutMs: 400, watchdogMs: 2000,
    workerUrl: new URL("./support/cold-cancellable-query-worker.mjs", import.meta.url) });
  try {
    const client = await f.client();
    const began = performance.now();
    await assert.rejects(client.subscribe({}), /runtime-timeout: caller read deadline exceeded/);
    assert.equal((await client.request("ping")).ok, true);
    assert.equal(f.executor.metrics().executor.callerTimeouts, 1);
    await f.bootstrapped;
    await f.waitForSourceReady();
    await ready(client);
    assert.equal(client.snapshot?.status, "ready");
    assert.equal(f.executor.metrics().executor.restarts, 0);
    t.diagnostic(JSON.stringify({ startupMs: performance.now() - began, metrics: f.executor.metrics() }));
  } finally { await f.close(); }
});

test("responsive rebuilding outlives the watchdog without claiming source readiness", { timeout: 10000 }, async t => {
  const queryPhaseDiagnostics = createQueryPhaseBuffer();
  let phase = "bootstrap";
  const { bootstrapHeartbeat } = await import(String("./support/bootstrap-heartbeat.mjs"));
  const { port1, port2 } = new MessageChannel();
  const stop = bootstrapHeartbeat(port1);
  try {
    assert.deepEqual(receiveMessageOnPort(port2)?.message, { type: "heartbeat" },
      "bootstrap must report control liveness before waiting for the first interval or importing the model");
    assert.equal(receiveMessageOnPort(port2), undefined, "one in-flight bootstrap heartbeat");
  } finally { stop(); port1.close(); port2.close(); }
  const f = await fixture({ watchdogMs: 800, queryPhaseDiagnostics,
    workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    await f.bootstrapped;
    const a = await f.client(), b = await f.client();
    phase = "held-rebuilding";
    const began = performance.now();
    for (let i = 0; i < 6; i++) {
      assert.equal((await a.get({ limit: 1 })).status, "rebuilding");
      assert.equal((await b.request("ping")).ok, true);
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(f.executor.metrics().executor.timeouts, 0);
    assert.equal(f.executor.observation().status, "rebuilding");
    t.diagnostic(JSON.stringify({ rebuildingMs: performance.now() - began, metrics: f.executor.metrics() }));
    phase = "inventory-ready";
    recordQueryPhase(queryPhaseDiagnostics, queryPhase.releaseSent);
    f.worker.postMessage({ type: "release-inventory" });
    await f.waitForSourceReady();
    phase = "post-ready-subscription";
    await ready(b);
  } catch (error) {
    try { t.diagnostic(JSON.stringify({ heldFixtureFailure: { case: 114, phase, observation: f.executor.observation(),
      executor: f.executor.metrics().executor, trace: readQueryPhases(queryPhaseDiagnostics) } }).slice(0, 8192)); } catch {}
    throw error;
  } finally { await f.close(); }
});

test("fixture bootstrap rejects when its worker exits before installing RPC", { timeout: 10000 }, async () => {
  const workerUrl = new URL(`data:text/javascript,${encodeURIComponent(`
    import { parentPort } from "node:worker_threads";
    parentPort.on("message", message => {
      if (message.type === "check-gate") parentPort.postMessage({ type: "gate-installed" });
      else process.exit(0);
    });
  `)}`);
  const f = await fixture({ workerUrl });
  try {
    const installed = (async () => { for (;;) { const [message] = await once(f.worker, "message"); if (message.type === "gate-installed") return; } })();
    f.worker.postMessage({ type: "check-gate" });
    await installed;
    const exited = once(f.worker, "exit");
    f.worker.postMessage({ type: "exit-before-bootstrap" });
    await exited;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(Promise.race([f.bootstrapped, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("bootstrap remained pending after worker exit")), 250);
      })]), /query fixture worker exited before bootstrap/);
    } finally { clearTimeout(timer); }
  } finally { await f.close(); await f.close(); }
});

test("the original before-root setup observes disk and worker roots without requesting repair", { timeout: 10000 }, async t => {
  const f = await fixture();
  try {
    const client = await f.client(); await ready(client);
    const firstReady = client.snapshot;
    const id = "sa_metadata_gap", path = join(f.root, "runs", id, "meta.json");
    const scope = { cwd: f.root, sessionId: "parent", limit: 10 };
    await client.subscribe(scope);
    mkdirSync(join(f.root, "runs", id));
    writeFileSync(path, JSON.stringify({ id, cwd: f.root, status: "completed", startedAt: 1,
      callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "before-root" }));
    const until = Date.now() + 1000;
    assert.equal(JSON.parse(readFileSync(path, "utf8")).name, "before-root");
    const capture = new Promise<any>(resolve => {
      const timer = setTimeout(() => { f.worker.off("message", listener); resolve(undefined); }, 500);
      const listener = (message: any) => { if (message.type === "diagnostic-source-state" && message.id === "initial-setup") { clearTimeout(timer); f.worker.off("message", listener); resolve(message.state); } };
      f.worker.on("message", listener);
    });
    f.worker.postMessage({ type: "diagnostic-source-state", id: "initial-setup", scope });
    const state = await capture;
    assert.ok(state, "initial source observation was acknowledged");
    assert.equal(state.configured.agentDir, f.root);
    assert.equal(state.configured.modelOptions.baseDir, f.root);
    assert.equal(state.roots.runs, join(f.root, "runs"));
    assert.equal(state.imported, true, "first ready follows initial inventory completion");
    assert.ok(state.rawEntries.some((entry: any) => entry.meta?.id === id && entry.meta.name === "before-root"));
    while (client.snapshot?.rows[0]?.meta.name !== "before-root") {
      if (Date.now() >= until) {
        const terminal = await new Promise<any>(resolve => {
          const timer = setTimeout(() => { f.worker.off("message", listener); resolve(undefined); }, 500);
          const listener = (message: any) => { if (message.type === "diagnostic-source-state" && message.id === "initial-terminal") { clearTimeout(timer); f.worker.off("message", listener); resolve(message.state); } };
          f.worker.on("message", listener);
          f.worker.postMessage({ type: "diagnostic-source-state", id: "initial-terminal", scope });
        });
        t.diagnostic(JSON.stringify({ afterOriginalFailure: true, firstReady, setup: state, terminal }).slice(0, 32768));
      }
      assert.ok(Date.now() < until, "root gap publication missing");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { await f.close(); }
});

test("metadata present before the held initial inventory is included in the first ready publication", { timeout: 10000 }, async t => {
  const f = await fixture({ workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    const id = "sa_initial_source", path = join(f.root, "runs", id, "meta.json");
    mkdirSync(join(f.root, "runs", id));
    writeFileSync(path, JSON.stringify({ id, cwd: f.root, status: "completed", startedAt: 1, name: "present-before-inventory" }));
    const client = await f.client();
    const initial = await client.subscribe({});
    assert.equal(initial.status, "rebuilding", "source readiness cannot precede the held first inventory");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).name, "present-before-inventory");
    const capture = new Promise<any>(resolve => {
      const listener = (message: any) => { if (message.type === "initial-source-state") { f.worker.off("message", listener); resolve(message); } };
      f.worker.on("message", listener);
    });
    f.worker.postMessage({ type: "initial-source-state", id, scope: {} });
    const state = await capture;
    assert.equal(state.imported, false);
    assert.equal(state.configured.agentDir, f.root);
    assert.equal(state.configured.modelOptions.baseDir, f.root);
    assert.equal(state.runs, join(f.root, "runs"));
    assert.equal(state.path, path);
    assert.equal(state.meta.name, "present-before-inventory");
    assert.ok(state.watchers.includes(state.runs), "root watcher installation precedes inventory release");
    assert.equal(state.snapshot.status, "rebuilding");
    const firstReady = new Promise<any>(resolve => {
      const stop = client.onChange(snapshot => { if (snapshot.status === "ready") { stop(); resolve(snapshot); } });
    });
    f.worker.postMessage({ type: "release-inventory" });
    const observed = await firstReady;
    assert.equal(observed.rows[0]?.meta.name, "present-before-inventory");
    assert.ok(f.executor.metrics().inventories! >= 1);
    t.diagnostic(JSON.stringify({ beforeRelease: state, firstReady: observed }));
  } finally { await f.close(); }
});

test("an exact-ID query returns rebuilding without blocking all reads on the initial inventory", { timeout: 10000 }, async () => {
  const f = await fixture({ timeoutMs: 500, workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    const blocked = new Promise<void>(resolve => {
      f.worker.on("message", message => { if (message.type === "inventory-blocked") resolve(); });
    });
    const client = await f.client();
    await blocked;
    const [exact, other] = await Promise.all([
      client.request("runtime_get_snapshot", { scope: { id: "sa_initial_inventory", limit: 1 } }),
      client.get({ limit: 2 }),
    ]);
    assert.equal(exact.status, "rebuilding");
    assert.equal(other.status, "rebuilding");
    assert.equal(f.executor.metrics().executor.timeouts, 0);
    assert.equal(f.executor.metrics().executor.worker, "running");
    f.worker.postMessage({ type: "release-inventory" });
    await ready(client);
    assert.equal((await client.get({ id: "sa_initial_inventory", limit: 1 })).status, "ready");
  } finally { await f.close(); }
});

test("inventory block receipt waits for already-running source work", { timeout: 10000 }, async () => {
  const f = await fixture({ workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  const message = (type: string) => new Promise<any>(resolve => {
    const listener = (value: any) => { if (value.type === type) { f.worker.off("message", listener); resolve(value); } };
    f.worker.on("message", listener);
  });
  try {
    const client = await f.client(); await f.bootstrapped;
    f.worker.postMessage({ type: "release-inventory" }); await ready(client);
    const directory = join(f.root, "runs/sa_block_boundary"); mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_block_boundary", cwd: f.root, status: "completed", startedAt: 1 }));
    const held = message("scan-tail-held");
    f.worker.postMessage({ type: "hold-scan-tail", id: "sa_block_boundary" }); await held;
    const requested = message("block-requested"), blocked = message("inventory-blocked");
    f.worker.postMessage({ type: "block-inventory" });
    assert.equal((await requested).pending, true, "the control must overlap actual source work");
    f.worker.postMessage({ type: "release-scan-tail" });
    assert.equal((await blocked).pending, false, "a blocked receipt cannot leave earlier reconciliation running");
    f.worker.postMessage({ type: "release-inventory" });
  } finally { await f.close(); }
});

test("an exact-ID client waits for indexing without occupying the shared read queue", { timeout: 10000 }, async () => {
  const f = await fixture({ workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  try {
    const blocked = new Promise<void>(resolve => {
      f.worker.on("message", message => { if (message.type === "inventory-blocked") resolve(); });
    });
    const client = await f.client(); await blocked;
    f.worker.postMessage({ type: "release-inventory" });
    await ready(client);
    const indexing = new Promise<void>(resolve => {
      const listener = (message: any) => { if (message.type === "inventory-blocked") { f.worker.off("message", listener); resolve(); } };
      f.worker.on("message", listener);
    });
    f.worker.postMessage({ type: "block-inventory" }); await indexing;
    const directory = join(f.root, "runs/sa_client_retry"); mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_client_retry", sessionId: "retry", cwd: f.root,
      status: "completed", startedAt: 1 }));
    let completed = false;
    const pending = client.get({ id: "sa_client_retry", limit: 1 }).then(value => { completed = true; return value; });
    assert.equal((await client.get({ limit: 2 })).status, "ready");
    assert.equal(completed, false, "the unrelated read completes while the exact ID is still awaiting inventory");
    f.worker.postMessage({ type: "release-inventory" });
    let result = await pending;
    // get() deliberately returns rebuilding after its bounded retry window.
    // Loaded runners may spend that window initializing the real inventory.
    if (result.status === "rebuilding") {
      assert.equal(result.rows.length, 0);
      await ready(client);
      result = await client.get({ id: "sa_client_retry", limit: 1 });
    }
    assert.equal(result.status, "ready");
    assert.equal(result.rows[0]!.meta.id, "sa_client_retry");
    assert.equal(f.executor.metrics().executor.timeouts, 0);
  } finally { await f.close(); }
});

test("an exact-ID client retries indexing even when another assignment makes the inventory degraded", { timeout: 10000 }, async () => {
  const f = await fixture({ workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  const blocked = () => new Promise<void>(resolve => {
    const listener = (message: any) => { if (message.type === "inventory-blocked") { f.worker.off("message", listener); resolve(); } };
    f.worker.on("message", listener);
  });
  try {
    const initial = blocked();
    const directory = join(f.root, "runs/sa_unverified"); mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_unverified", sessionId: "unverified", cwd: f.root,
      status: "completed", startedAt: 1, operations: { conversationId: "unverified", workspace: f.root } }));
    const client = await f.client(); await initial;
    const degraded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error("unverified fixture did not become degraded")); }, 5000);
      const stop = client.onChange(value => { if (value.status === "degraded" && value.rows.length) { clearTimeout(timer); stop(); resolve(); } });
    });
    await client.subscribe({}); f.worker.postMessage({ type: "release-inventory" }); await degraded;
    const held = blocked(); f.worker.postMessage({ type: "block-inventory" }); await held;
    const next = join(f.root, "runs/sa_degraded_retry"); mkdirSync(next);
    writeFileSync(join(next, "meta.json"), JSON.stringify({ id: "sa_degraded_retry", sessionId: "new", cwd: f.root,
      status: "lost", startedAt: 2 }));
    const pending = client.get({ id: "sa_degraded_retry", limit: 1 });
    assert.equal((await client.get({ limit: 2 })).status, "degraded");
    f.worker.postMessage({ type: "release-inventory" });
    const value = await pending;
    assert.equal(value.rows[0]?.meta.id, "sa_degraded_retry");
    assert.equal(value.rows[0]?.assignment.verified, true);
    assert.equal(f.executor.metrics().executor.timeouts, 0);
  } finally { await f.close(); }
});

test("an exact-ID client stops retrying a stalled inventory within its retry budget", { timeout: 10000 }, async () => {
  const f = await fixture({ timeoutMs: 500, workerUrl: new URL("./support/blocked-inventory-worker.mjs", import.meta.url) });
  let inventoryBlocked = false;
  const earlyMessages: unknown[] = [];
  const phase = (message: any) => {
    if (message.type === "inventory-blocked") {
      inventoryBlocked = true;
      earlyMessages.push(...(message.earlyMessages ?? []).slice(0, 4 - earlyMessages.length));
    }
  };
  f.worker.on("message", phase);
  try {
    await f.bootstrapped;
    const state = new Promise<any>(resolve => {
      const listener = (message: any) => { if (message.type === "inventory-status") { f.worker.off("message", listener); resolve(message); } };
      f.worker.on("message", listener);
    });
    f.worker.postMessage({ type: "inventory-status" });
    const inventory = await state;
    assert.deepEqual(inventory, { type: "inventory-status", rpcInstalled: true, held: true, imported: false });
    inventoryBlocked = true;
    const client = await f.client();
    const began = performance.now();
    assert.equal((await client.get({ id: "sa_pending", limit: 1 })).status, "rebuilding");
    assert.ok(performance.now() - began < 5000);
    assert.equal(f.executor.metrics().executor.timeouts, 0);
    assert.equal(f.executor.metrics().executor.active, 0);
    assert.equal(f.executor.metrics().executor.worker, "running");
  } catch (error) {
    console.error(JSON.stringify({ exactReadFailure: { inventoryBlocked, earlyMessages,
      observation: f.executor.observation(), metrics: f.executor.metrics() } }));
    throw error;
  } finally { f.worker.off("message", phase); await f.close(); }
});

test("a failed worker recovers existing subscriptions under a new observation epoch", { timeout: 10000 }, async t => {
  const f = await fixture();
  let phase = "create source";
  let observedClient: WorkClient | undefined;
  try {
    const directory = join(f.root, "runs", "sa_recovery");
    const scope = { id: "sa_recovery", limit: 1 };
    const sourceWrites: any[] = [], frames: any[] = [], workerFrames: any[] = [];
    const record = (target: any[], value: any) => { if (target.length < 32) target.push(value); };
    const captureSource = () => new Promise(resolve => {
      const timer = setTimeout(() => { f.worker.off("message", listener); resolve({ error: "source diagnostic unavailable" }); }, 500);
      const listener = (message: any) => {
        if (message.type === "diagnostic-source-state" && message.id === "recovery-before-exit") {
          clearTimeout(timer); f.worker.off("message", listener); resolve(message.state);
        }
      };
      f.worker.on("message", listener);
      f.worker.postMessage({ type: "diagnostic-source-state", id: "recovery-before-exit", scope });
    });
    f.worker.on("message", message => {
      if (message.type === "event") {
        const event = JSON.parse(message.line).event;
        record(workerFrames, { connection: message.connection, generation: message.generation,
          serial: message.serial, type: event.type, previousSeq: event.previousSeq, snapshot: event.snapshot });
      }
    });
    mkdirSync(directory);
    const write = (name: string) => {
      const path = join(directory, "meta.json");
      writeFileSync(path, JSON.stringify({ id: "sa_recovery", cwd: f.root, status: "completed", startedAt: 1, name }));
      const info = statSync(path, { bigint: true });
      sourceWrites.push({ name, identity: `${info.dev}:${info.ino}`, bytes: String(info.size),
        mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) });
    };
    write("first");
    phase = "connect client";
    const client = observedClient = await f.client();
    client.onChange(snapshot => record(frames, snapshot));
    phase = "initial ready subscription";
    await ready(client);
    phase = "exact-ID subscription";
    await client.subscribe(scope);
    phase = "publish latest source to original subscription";
    write("latest");
    const until = Date.now() + 3000;
    while (client.snapshot?.rows[0]?.meta.name !== "latest") {
      if (Date.now() >= until) {
        t.diagnostic(JSON.stringify({ phase: "original-publication-before-exit", sourceWrites, frames,
          workerFrames, metrics: f.executor.metrics(), disk: JSON.parse(readFileSync(join(directory, "meta.json"), "utf8")),
          source: await captureSource() }).slice(0, 65536));
      }
      assert.ok(Date.now() < until, "the original subscription did not observe the source update");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const previous = client.snapshot!;
    assert.ok(previous.seq > 1);
    t.diagnostic(JSON.stringify({ phase: "observed-original-publication-before-exit", sourceWrites,
      frames, workerFrames, source: await captureSource() }).slice(0, 65536));
    let resynced = false;
    const recovered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error("read worker never recovered the existing subscription")); }, 3000);
      const stop = client.onChange(snapshot => {
        if (snapshot.instanceId !== previous.instanceId && snapshot.resyncRequired) resynced = true;
        if (snapshot.status === "ready" && snapshot.instanceId !== previous.instanceId && snapshot.rows[0]?.meta.name === "latest") {
          clearTimeout(timer); stop(); resolve();
        }
      });
    });
    phase = "terminate original worker";
    await f.worker.terminate();
    phase = "recover existing subscription";
    await recovered;
    assert.equal(client.closed, false);
    assert.equal(resynced, true);
    assert.equal(f.executor.metrics().executor.worker, "running");
    phase = "verify recovered exact-ID read";
    assert.equal((await client.get({ id: "sa_recovery", limit: 1 })).rows[0]!.meta.name, "latest");
  } catch (error) {
    // Cached evidence only: diagnosing a failed read must not issue another RPC
    // or give recovery more time before the original failure is reported.
    console.error(JSON.stringify({ case: "worker-subscription-recovery", phase,
      error: String(error), observation: f.executor.observation(), metrics: f.executor.metrics(),
      client: observedClient && { closed: observedClient.closed, instanceId: observedClient.snapshot?.instanceId,
        seq: observedClient.snapshot?.seq, status: observedClient.snapshot?.status, reason: observedClient.snapshot?.reason,
        rows: observedClient.snapshot?.rows.map(row => ({ id: row.meta.id, name: row.meta.name })) },
    }));
    throw error;
  } finally { await f.close(); }
});

test("repeated worker failures exhaust a bounded recovery budget", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = client.snapshot!.instanceId;
      const worker = (f.executor as unknown as { worker: Worker }).worker;
      await worker.terminate();
      if (attempt < 2) {
        const until = Date.now() + 3000;
        while (client.snapshot?.status !== "ready" || client.snapshot.instanceId === epoch) {
          assert.ok(Date.now() < until, "a permitted recovery did not finish");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
    }
    await assert.rejects(client.get({}), /recovery budget exhausted/);
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(f.executor.metrics().executor.restarts, 2);
    assert.equal(f.executor.metrics().executor.worker, "stopped");
    assert.equal(f.executor.metrics().executor.recoveryPending, false);
    assert.equal((await client.request("ping")).ok, true);
  } finally { await f.close(); }
});

test("closing an executor cancels pending recovery without starting another worker", { timeout: 5000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    await f.worker.terminate();
    assert.equal(f.executor.metrics().executor.recoveryPending, true);
    await f.executor.close();
    await new Promise(resolve => setTimeout(resolve, 700));
    assert.equal(f.executor.metrics().executor.restarts, 0);
    assert.equal(f.executor.metrics().executor.recoveryPending, false);
    assert.equal(f.executor.metrics().executor.worker, "stopped");
  } finally { await f.close(); }
});

test("slow real SQLite work leaves socket RPC responsive and overlapping reads share bounded admission", { timeout: 20000 }, async t => {
  const f = await fixture({ capacity: 2 });
  try {
    const a = await f.client(), b = await f.client(), c = await f.client();
    await ready(a);
    const busy = await f.stall();
    const first = a.get({ limit: 1 });
    const shared = b.get({ limit: 1 });
    void first.catch(() => {}); void shared.catch(() => {});
    const abandoned = c.get({ limit: 2 });
    const cancelled = assert.rejects(abandoned, /client closed|disconnected/);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const started = performance.now(); await b.request("ping"); times.push(performance.now() - started);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(f.executor.metrics().executor.active, 1);
    assert.equal(f.executor.metrics().executor.queued, 1);
    assert.equal(f.executor.metrics().executor.singleflightHits, 1);
    await assert.rejects(b.get({ limit: 3 }), /runtime-overloaded/);
    c.close(); await cancelled;
    const until = Date.now() + 1000;
    while (f.executor.metrics().executor.queued) {
      assert.ok(Date.now() < until, "disconnected queued work was not released");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const firstCancelled = assert.rejects(first, /client closed|disconnected/);
    a.close(); await firstCancelled;
    const value = await shared;
    assert.equal(value.status, "ready");
    const duration = await busy.finished;
    const ordered = [...times].sort((a, b) => a - b);
    assert.ok(ordered.at(-1)! < duration / 2, "slow SQLite must not stall main-thread socket handling");
    t.diagnostic(JSON.stringify({ sqliteMs: duration, socketMs: { p50: ordered[9], p95: ordered[18], p99: ordered[19] },
      metrics: f.executor.metrics(), cpu: process.cpuUsage(), rss: process.memoryUsage().rss }));
    const before = (await b.request("runtime_get_metrics")).queryCount;
    await b.get({ limit: 1 });
    const after = await b.request("runtime_get_metrics");
    assert.equal(after.queryCount, before, "the worker cache avoids repeated SQLite for a warmed scope");
    assert.ok(after.cacheHits > 0);
    assert.equal(after.sqlite.active, 1, "the query index owns the attached checkpoint store when no coordinator source is present");
  } finally { await f.close(); }
});

test("the worker watchdog rejects readers and bounds close while native SQLite finishes before worker exit", { timeout: 60000 }, async t => {
  const f = await fixture({ watchdogMs: 3000 });
  try {
    const client = await f.client();
    await ready(client);
    await f.stall(60000000);
    const began = performance.now();
    const exit = once(f.worker, "exit");
    const active = assert.rejects(client.get({ limit: 1 }), /deadline exceeded/);
    const queued = assert.rejects(client.get({ limit: 2 }), /deadline exceeded/);
    await Promise.all([active, queued]);
    const rejectedMs = performance.now() - began;
    assert.equal(f.executor.metrics().executor.active, 0);
    assert.equal(f.executor.metrics().executor.queued, 0);
    assert.equal(f.executor.metrics().executor.status, "degraded");
    assert.equal(f.executor.observation().status, "degraded", "cached status cannot report a failed worker as ready");
    await assert.rejects(client.get({}), /deadline exceeded/);
    assert.equal(client.snapshot!.status, "degraded", "a dead worker must never leave its cached scope authoritative");
    assert.equal((await client.request("ping")).ok, true, "the main socket remains usable after worker failure");
    assert.equal((await client.request("runtime_get_metrics")).executor.status, "degraded");
    const started = performance.now(); await f.executor.close();
    const closeMs = performance.now() - started;
    assert.ok(closeMs < 1500, "native SQLite cannot retain executor shutdown beyond its close budget");
    await exit;
    assert.equal((f.executor.metrics().sqlite as { active: number }).active, 0, "worker exit releases its actual database connections");
    assert.equal(f.executor.metrics().coordinatorConnections, 0);
    assert.equal(f.executor.metrics().indexConnections, 0);
    t.diagnostic(JSON.stringify({ rejectedMs, closeMs, workerExitMs: performance.now() - began,
      limitation: "Native SQLite completion delays worker/process exit; the guardian owns the process hard-stop budget." }));
  } finally { await f.close(); }
});

test("worker events coalesce behind one acknowledgment and scope changes discard pending old-scope frames", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client(); await ready(client);
    const post = f.worker.postMessage.bind(f.worker);
    const acknowledgments: unknown[] = [];
    let events = 0, revisions = 0, hold = true;
    f.worker.on("message", message => { if (message.type === "event") events++; if (message.type === "revision") revisions++; });
    f.worker.postMessage = (message: any) => {
      if (hold && ["event-consumed", "revision-consumed"].includes(message.type)) acknowledgments.push(message);
      else post(message);
    };
    const write = (name: string) => {
      const dir = join(f.root, "runs", "sa_credit"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "meta.json"), JSON.stringify({ id: "sa_credit", cwd: f.root, status: "completed", startedAt: 1, name }));
    };
    const until = async (name: string) => {
      const deadline = Date.now() + 5000;
      while ((await client.get({ id: "sa_credit" })).rows[0]?.meta.name !== name) {
        assert.ok(Date.now() < deadline, "external write did not reach the worker index");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    write("first"); await until("first");
    write("second"); await until("second");
    write("latest"); await until("latest");
    assert.equal(events, 1, "only one full event is in the worker mailbox without an acknowledgment");
    assert.equal(revisions, 1, "root invalidations also have bounded producer credit");
    await client.subscribe({ id: "sa_other_scope" });
    assert.equal(client.snapshot!.rows.length, 0);
    hold = false;
    acknowledgments.forEach(message => post(message));
    await client.request("ping");
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(client.snapshot!.rows.length, 0, "pending old-scope rows cannot overwrite a new subscription");
  } finally { await f.close(); }
});


test("diagnostic liveness does not wait behind SQLite while fresh idle checks still do", { timeout: 20000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    await f.executor.livenessReasons();
    const { finished } = await f.stall();
    const began = performance.now();
    const observation = f.executor.observation();
    assert.ok(performance.now() - began < 100, "diagnostics must not block on the read worker");
    assert.equal(observation.status, "ready");
    assert.ok(observation.observedAt);
    const queued = f.executor.metrics().executor.queued;
    for (let i = 0; i < 100; i++) f.executor.observation();
    assert.equal(f.executor.metrics().executor.queued, queued, "status probes enqueue no worker work");
    let checked = false;
    const fresh = f.executor.livenessReasons().then(() => { checked = true; });
    assert.equal(checked, false, "fresh shutdown checks cannot use the diagnostic cache");
    await finished;
    await fresh;
  } finally { await f.close(); }
});

test("diagnostic observation uses pushed state without initiating another inventory", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const client = await f.client();
    await ready(client);
    await f.executor.livenessReasons();
    const before = f.executor.metrics();
    assert.equal(typeof before.inventories, "number");
    f.executor.observation();
    assert.equal(f.executor.metrics().executor.completed, before.executor.completed,
      "diagnostic polling uses the pushed observation without a worker request");
    assert.equal(f.executor.metrics().inventories, before.inventories,
      "diagnostic polling must not initiate expensive fresh inventories");
  } finally { await f.close(); }
});

test('Subagents and Background share one coordinator read connection in the query worker', async t => {
  const f = await fixture();
  const { openStore } = await import(new URL('../../operation-coordinator/index.ts', import.meta.url).href);
  const store = openStore({ path: join(f.root, 'operation-coordinator.sqlite') }); store.close();
  try {
    const client = await f.client();
    await f.executor.livenessReasons();
    await client.get({ cwd: f.root, active: true });
    await client.get({ background: true, cwd: f.root, sessionId: 'shared-reader', active: true });
    assert.equal((f.executor.metrics().sqlite as any).active, 1, 'the worker composes readonly source, inboxes and checkpoints on its sole derived handle');
    assert.equal((f.executor.metrics().sqlite as any).opens, 1, 'both inbox attachments and the source reuse the existing derived handle without another constructor open');
    assert.equal((f.executor.metrics().sqlite as any).maximum, 1, 'Background attachment cannot temporarily open another worker handle');
    assert.equal(f.executor.metrics().indexConnections, 1);
    assert.equal(f.executor.metrics().coordinatorConnections, 1);
    t.diagnostic(JSON.stringify({ workerRetainedBudget: 1, sqlite: f.executor.metrics().sqlite }));
  } finally { await f.close(); }
});

test("assignment wait, resume claim, cancellation, outcome and receipt cross the real socket", { timeout: 10000 }, async t => {
  const f = await fixture({ intervalMs: 25 });
  const { openStore } = await import(new URL('../../operation-coordinator/index.ts', import.meta.url).href);
  const store = openStore({ path: join(f.root, 'operation-coordinator.sqlite') });
  const owner = { kind: "worker-conversation", sessionId: "worker", workspace: f.root };
  const recipient = { kind: "parent-session", sessionId: "parent", workspace: f.root };
  store.registerAssignment({ assignmentId: "assignment", owner, recipient });
  mkdirSync(join(f.root, "runs", "attempt"));
  writeFileSync(join(f.root, "runs", "attempt", "meta.json"), JSON.stringify({ id: "attempt", sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1,
    assignment: { assignmentId: "assignment", owner, recipient }, callbackOrigin: { cwd: f.root, sessionId: "parent" } }));
  const client = await f.client();
  const observed = async (predicate: (snapshot: any) => boolean) => {
    const current = await client.get({ id: "attempt" });
    if (predicate(current)) return current;
    return new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error("assignment socket observation did not advance")); }, 3000);
      const stop = client.onChange(snapshot => { if (predicate(snapshot)) { clearTimeout(timeout); stop(); resolve(snapshot); } });
    });
  };
  try {
    await client.subscribe({ id: "attempt" });
    await observed(s => s.status === "ready" && s.rows.length === 1);
    store.registerOperation({ operationId: "dependency", taskId: "task", launchToken: "launch", owner, observer: { kind: "background-tasks", version: "1" } });
    const wait = store.registerWait({ waitId: "wait", owner, dependencies: [{ operationId: "dependency" }], origin: { assignmentRef: "assignment", attemptId: "attempt" }, continuationNote: "Continue" }).wait;
    await observed(s => s.rows[0]?.assignment.state === "waiting" && s.activity.active === 1);
    store.recordTerminalOutcome({ operationId: "dependency", eventId: "terminal", owner, outcome: "succeeded", evidence: [{ kind: "summary", ref: "fixture-result", summary: "Completed dependency" }] });
    const claim = store.claimResume({ waitId: wait.waitId, generation: wait.generation, expectedCancelEpoch: 0, lease: { ownerId: "host" }, reservedCheckpointId: "checkpoint" }).claim;
    await observed(s => s.rows[0]?.assignment.reason === "resume-claimed");
    store.cancelWait({ waitId: wait.waitId, generation: wait.generation, owner, expectedCancelEpoch: 0, reason: "cancel" });
    assert.throws(() => store.publishResumeAttempt({ waitId: wait.waitId, generation: wait.generation, claimId: claim.claimId, claimToken: claim.claimToken, attemptId: "forbidden", launchToken: "forbidden" }), /cancel|claim|phase/i);
    store.recordAssignmentOutcome({ assignmentId: "assignment", owner, recipient, revision: 1, outcome: "cancelled", reason: "cancel", evidence: [], waits: [{ waitId: wait.waitId, generation: wait.generation, cancelEpoch: 1 }], processUncertain: false });
    await observed(s => s.rows[0]?.assignment.state === "cancelled");
    store.receiptAssignmentOutcome({ assignmentId: "assignment", recipient, revision: 1, entryId: "entry" });
    await observed(s => s.rows[0]?.recipientPending === false);
    const sqlite = f.executor.metrics().sqlite as any;
    assert.equal(sqlite.active, 1, "the full receipt journey retains the source on the sole derived handle");
    assert.equal(sqlite.maximum, 1);
    assert.equal(f.executor.metrics().coordinatorConnections, 1);
    assert.equal(f.executor.metrics().indexConnections, 1);
    assert.ok(sqlite.maximum <= 2, "inbox transactions do not open an extra SQLite handle");
    t.diagnostic(JSON.stringify({ retainedBudget: 2, sqlite }));
    assert.equal(store.getWait(wait).phase, "cancelled");
    assert.equal(store.getAssignmentOutcome("assignment").disposition, null, "derived observation must not consume a result");
    assert.equal(store.listOutbox().find((event: any) => event.type === "assignment-outcome").state, "delivered");
  } finally { store.close(); await f.close(); }
});


test("real runner timeout and canonical result supervision progress during stalled SQLite reads", { timeout: 20000 }, async t => {
  const { acquireMutationStore } = await import("../src/runtime/mutation-store.ts");
  const { RuntimeResultSupervision } = await import("../src/runtime/result-supervision.ts");
  const { createLocalSupervisor } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);
  const { supervisorTaskIdForToken } = await import(new URL("../../pi-better-background-tasks/src/supervisor/store.ts", import.meta.url).href);
  const f = await fixture({ watchdogMs: 15000 });
  const lease = acquireMutationStore(f.root);
  const directory = join(f.root, "supervisor");
  const supervisor = createLocalSupervisor({ directory });
  const token = "slow-read-deadline", taskId = supervisorTaskIdForToken(token), operationId = "slow-read-operation";
  const owner = { kind: "parent-session", sessionId: "exact-recipient", workspace: f.root };
  let host: InstanceType<typeof RuntimeResultSupervision> | undefined;
  try {
    const client = await f.client(); await ready(client);
    lease.store.registerOperation({ operationId, taskId, launchToken: token, owner,
      observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "accepted-host" }, authorityRef: "explicit-test-command" });
    lease.store.handoffResultSupervision({ operationId, expectedHostId: "accepted-host", directory,
      hostId: "server:slow-read-epoch", epoch: "slow-read-epoch",
      capability: { adapter: "background-results-v1", captured: { authorized: true }, current: { authorized: true } } });
    lease.store.registerWait({ waitId: "slow-read-wait", owner, dependencies: [{ operationId }], continuationNote: "Inspect timeout evidence" });
    host = new RuntimeResultSupervision(f.root, "slow-read-epoch");
    const busy = await f.stall(12000000);
    let readFinished = false;
    void busy.finished.then(() => { readFinished = true; }, () => {});
    const began = performance.now();
    await supervisor.start({ token, operationId, cwd: f.root, timeoutSeconds: 0.2,
      argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
    const sockets: number[] = [];
    while (lease.store.getOperation(operationId).terminalRevision === 0) {
      assert.ok(performance.now() - began < 2000, "runner deadline must reach canonical terminal state within two seconds despite slow reads");
      const started = performance.now(); await client.request("ping"); sockets.push(performance.now() - started);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const publicationMs = performance.now() - began;
    assert.equal(readFinished, false, "supervision must complete while the real SQLite query is still blocked");
    const operation = lease.store.getOperation(operationId);
    assert.equal(operation.terminalOutcome, "failed");
    assert.equal(operation.terminalRevision, 1);
    assert.equal(lease.store.listOutbox({ recipient: owner }).length, 1);
    assert.equal(lease.store.listOutbox({ recipient: { ...owner, sessionId: "foreign" } }).length, 0);
    sockets.sort((a,b)=>a-b);
    assert.ok(sockets.at(-1)! < 250, "socket control response remains within the documented rebuild budget");
    t.diagnostic(JSON.stringify({ sqliteMs: await busy.finished, publicationMs,
      socketMs: { p50: sockets[Math.floor(sockets.length*.5)], p95: sockets[Math.floor(sockets.length*.95)], p99: sockets.at(-1) } }));
  } finally {
    await supervisor.stop(taskId).catch(() => undefined);
    host?.close(); lease.release(); await f.close();
  }
});


test("explicit internal read demand recovers without foreground connections", { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    await f.executor.snapshot({});
    await f.worker.terminate();
    assert.equal(f.executor.metrics().executor.clients, 0);
    assert.equal(f.executor.metrics().executor.recoveryPending, false);
    await assert.rejects(f.executor.livenessReasons(), /runtime-unhealthy/);
    const until = Date.now() + 4000;
    while (f.executor.metrics().executor.restarts === 0) {
      assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.deepEqual(await f.executor.livenessReasons(), []);
    assert.equal(f.executor.metrics().executor.clients, 0);
    assert.equal(f.executor.metrics().executor.worker, "running");
  } finally { await f.close(); }
});

for (const outcome of ["success", "failure"]) test(`old fold ${outcome} cannot affect a replacement read worker`, { timeout: 10000 }, async () => {
  const folds: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const f = await fixture({ workerUrl: new URL("./support/fold-recovery-worker.mjs", import.meta.url),
    onTerminalLogsChanged: () => new Promise<void>((resolve, reject) => folds.push({ resolve, reject })) });
  const waitFor = async (predicate: () => boolean) => {
    const until = Date.now() + 4000;
    while (!predicate()) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    const client = await f.client(); await ready(client);
    f.worker.postMessage({ type: "diagnostic-fold", id: "old" });
    await waitFor(() => folds.length === 1);
    await f.worker.terminate();
    await waitFor(() => f.executor.metrics().executor.restarts === 1);
    const replacement = (f.executor as unknown as { worker: Worker }).worker;
    let acknowledgements = 0;
    replacement.on("message", message => { if (message.type === "diagnostic-fold-ack") acknowledgements++; });
    replacement.postMessage({ type: "diagnostic-fold", id: "new" });
    await waitFor(() => folds.length === 2);
    if (outcome === "success") folds[0]!.resolve(); else folds[0]!.reject(new Error("old fold failed"));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(acknowledgements, 0, "old completion must not acknowledge the new batch");
    assert.equal(f.executor.metrics().executor.worker, "running", "old failure must not terminate replacement");
    folds[1]!.resolve();
    await waitFor(() => acknowledgements === 1);
    assert.equal(f.executor.metrics().executor.restarts, 1);
    await client.get({});
  } finally { await f.close(); }
});


for (const rootRecreated of [false, true]) test(`a raw directory observed before metadata still publishes the original atomic writer commit (${rootRecreated ? "recreated root" : "existing root"})`, { timeout: 15000 }, async t => {
  const f = await fixture();
  const { measureEventPublication } = await import(new URL("../scripts/event-publication/measure.mjs", import.meta.url).href);
  try {
    const client = await f.client(); await ready(client);
    const id = "sa_metadata_gap", directory = join(f.root, "runs", id), metaPath = join(directory, "meta.json");
    const scope = { cwd: f.root, sessionId: "parent", limit: 10 };
    await client.subscribe(scope);
    if (rootRecreated) {
      mkdirSync(directory);
      writeFileSync(metaPath, JSON.stringify({ id, cwd: f.root, status: "completed", startedAt: 1,
        callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "before-root" }));
      const wait = async (condition: () => boolean, phase: string) => {
        const until = Date.now() + 1000;
        while (!condition()) {
          if (Date.now() >= until) {
            t.diagnostic(JSON.stringify({ phase, snapshot: client.snapshot, metrics: f.executor.metrics() }).slice(0, 32768));
            const state = new Promise(resolve => {
              const timer = setTimeout(() => { f.worker.off("message", listener); resolve({ error: "source diagnostic unavailable" }); }, 500);
              const listener = (message: any) => { if (message.type === "diagnostic-source-state" && message.id === phase) { clearTimeout(timer); f.worker.off("message", listener); resolve(message.state); } };
              f.worker.on("message", listener);
              f.worker.postMessage({ type: "diagnostic-source-state", id: phase, scope });
            });
            t.diagnostic(JSON.stringify({ phase, source: await state }).slice(0, 32768));
          }
          assert.ok(Date.now() < until, "root gap publication missing");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      await wait(() => client.snapshot?.rows[0]?.meta.name === "before-root", "initial-before-root");
      renameSync(join(f.root, "runs"), join(f.root, "retired-runs"));
      await wait(() => client.snapshot?.status === "degraded", "root-absent");
      assert.equal(client.snapshot?.rows[0]?.meta.name, "before-root");
    }
    const before = f.executor.metrics().inventories ?? 0;
    mkdirSync(directory, { recursive: true });
    const until = Date.now() + 1000;
    do {
      // Query capture refreshes metrics, never requests inventory repair.
      await client.get(scope);
      assert.ok(Date.now() < until, "raw directory creation hint was not processed");
      if ((f.executor.metrics().inventories ?? 0) > before && client.snapshot?.rows.length === 0) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    } while (true);
    writeFileSync(metaPath, JSON.stringify({ id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1,
      endedAt: Date.now(), callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "original" }));
    const report = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id,
      subscribers: 1, commits: 1, phase: rootRecreated ? "metadata-after-root-recreation" : "metadata-after-directory-hint", diagnostics: () => f.executor.metrics() });
    assert.ok(report.ms.max <= 1000, JSON.stringify(report));
    await client.get(scope);
    assert.equal(f.executor.metrics().sourceWatchers, 2);
  } finally { await f.close(); }
});

test("directory entry watchers publish repeated atomic commits without the inventory fallback", { timeout: 15000 }, async () => {
  const f = await fixture(); // fallback interval is 60 seconds, longer than this test
  const { measureEventPublication } = await import(new URL("../scripts/event-publication/measure.mjs", import.meta.url).href);
  try {
    const id = "sa_atomic", directory = join(f.root, "runs", id), metaPath = join(directory, "meta.json");
    mkdirSync(directory);
    const meta = { id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1, endedAt: Date.now(),
      callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "original" };
    writeFileSync(metaPath, JSON.stringify(meta));
    const client = await f.client(); await ready(client);
    const scope = { cwd: f.root, sessionId: "parent", limit: 10 };
    for (const subscribers of [1, 5, 10]) {
      const report = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id, subscribers, commits: 5,
        phase: "initial-directory", diagnostics: () => f.executor.metrics() });
      assert.ok(report.ms.max <= 1000, JSON.stringify(report));
      assert.equal(f.executor.metrics().sourceWatchers, 2, "one root and one raw directory, independent of clients/files");
    }
    // Replacing the directory itself must retire its old inode watcher.
    renameSync(directory, join(f.root, "old-run")); mkdirSync(directory);
    writeFileSync(metaPath, JSON.stringify({ ...meta, name: "replaced-directory" }));
    await client.subscribe(scope);
    const until = Date.now() + 1000;
    while (client.snapshot?.rows[0]?.meta.name !== "replaced-directory") {
      assert.ok(Date.now() < until, "directory replacement was not published"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const report = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id, subscribers: 1, commits: 5,
      phase: "replaced-directory", diagnostics: () => f.executor.metrics() });
    assert.ok(report.ms.max <= 1000, JSON.stringify(report));
    // The entire source root can also move while its pathname is immediately
    // recreated. Identity checks must rebind both root and child watchers.
    renameSync(join(f.root, "runs"), join(f.root, "old-runs-root"));
    mkdirSync(directory, { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ ...meta, name: "replaced-root" }));
    const rootBy = Date.now() + 1000;
    while (client.snapshot?.rows[0]?.meta.name !== "replaced-root") {
      assert.ok(Date.now() < rootBy, "root replacement was not published"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const rootReport = await measureEventPublication({ socketPath: f.path, agentDir: f.root, scope, metaPath, taskId: id, subscribers: 1, commits: 5,
      phase: "replaced-root", diagnostics: () => f.executor.metrics() });
    assert.ok(rootReport.ms.max <= 1000, JSON.stringify(rootReport));
    assert.equal(f.executor.metrics().sourceWatchers, 2);
    rmSync(directory, { recursive: true });
    const removedBy = Date.now() + 1000;
    while (client.snapshot?.rows.length) {
      assert.ok(Date.now() < removedBy, "directory deletion was not published"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    await client.get(scope);
    assert.equal(f.executor.metrics().sourceWatchers, 1, "deleted raw directories release their watchers");
  } finally { await f.close(); }
  assert.equal(f.executor.metrics().executor.worker, "stopped");
});

for (const source of ["runs", "attempts", "session-state"]) test(`source ${source} recreation after observed absence publishes without fallback`, { timeout: 10000 }, async t => {
  const f = await fixture();
  const durable = join(f.root, "durable"), sessionDir = join(durable, "sessions");
  const root = source === "runs" ? join(f.root, source) : join(durable, source);
  const id = "sa_root_gap";
  const meta = { id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1, endedAt: 2,
    name: "before-root", recipe: { version: 1, sessionId: "worker", sessionDir, cwd: f.root } };
  const archive = () => { mkdirSync(join(durable, "attempts"), { recursive: true }); writeFileSync(join(durable, "attempts", `${id}.json`), JSON.stringify({ version: 1, meta })); };
  const writeSource = (name: string) => {
    mkdirSync(root, { recursive: true });
    if (source === "runs") { mkdirSync(join(root, id)); writeFileSync(join(root, id, "meta.json"), JSON.stringify({ ...meta, name })); }
    else if (source === "attempts") writeFileSync(join(root, `${id}.json`), JSON.stringify({ version: 1, meta: { ...meta, name } }));
    else writeFileSync(join(root, "worker.json"), JSON.stringify({ version: 1, sessionId: "worker", attemptId: "sa_newer", status: "killed", startedAt: 3 }));
  };
  const wait = async (condition: () => boolean, description: string) => {
    const until = Date.now() + 1000;
    while (!condition()) { assert.ok(Date.now() < until, description); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  try {
    if (source === "session-state") archive();
    writeSource("before-root");
    const client = await f.client(); await ready(client); await client.subscribe({ cwd: f.root, limit: 10 });
    const count = source === "session-state" ? 0 : 1;
    await wait(() => client.snapshot?.rows.length === count, "initial source membership");
    const before = f.executor.metrics(), oldInode = String(statSync(root).ino);
    renameSync(root, join(f.root, `retired-${source}`));
    // This is a publication barrier, not a sleep or a forced read/inventory:
    // the worker has actually imported ENOENT before the new root is created.
    await wait(() => client.snapshot?.status === "degraded", "missing source root was not published");
    assert.equal(client.snapshot?.rows.length, count, "unavailable roots retain verified rows and marker coverage");
    writeSource("after-root");
    const newInode = String(statSync(root).ino);
    assert.notEqual(newInode, oldInode);
    await wait(() => client.snapshot?.status === "ready" && client.snapshot.rows.length === count && (count === 0 || client.snapshot.rows[0]?.meta.name === "after-root"), "recreated source root was not published");
    if (count) {
      const path = source === "runs" ? join(root, id, "meta.json") : join(root, `${id}.json`);
      const value = { ...meta, name: "after-rearm" };
      writeFileSync(path + ".tmp", JSON.stringify(source === "runs" ? value : { version: 1, meta: value }));
      renameSync(path + ".tmp", path);
      try {
        await wait(() => client.snapshot?.rows[0]?.meta.name === "after-rearm", `replacement root watcher was not rearmed: ${JSON.stringify({ source, oldInode, newInode, before })}`);
      } catch (error) {
        t.diagnostic(JSON.stringify({ source, snapshot: client.snapshot, metrics: f.executor.metrics() }));
        throw error;
      }
    }
    t.diagnostic(JSON.stringify({ source, oldInode, newInode, before, after: f.executor.metrics() }));
  } finally { await f.close(); }
});

test("root recreation after an observed absence publishes without inventory fallback", { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const id = "sa_root_gap", directory = join(f.root, "runs", id);
    const meta = { id, sessionId: "worker", cwd: f.root, status: "completed", startedAt: 1,
      endedAt: Date.now(), callbackOrigin: { cwd: f.root, sessionId: "parent" }, name: "original" };
    mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
    const client = await f.client(); await ready(client);
    await client.subscribe({ cwd: f.root, sessionId: "parent", limit: 10 });
    const waitForEvent = async (condition: () => boolean | Promise<boolean>) => {
      const deadline = Date.now() + 3000;
      while (!(await condition())) {
        assert.ok(Date.now() < deadline, `missing root event: ${JSON.stringify(f.executor.metrics())}`);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitForEvent(() => client.snapshot?.rows.length === 1);
    renameSync(join(f.root, "runs"), join(f.root, "old-runs"));
    // A missing source is not verified deletion (#799): retain the last observation.
    await waitForEvent(() => client.snapshot?.status === "degraded");
    assert.match(client.snapshot!.reason!, /Source directory unavailable; retaining verified records/);
    assert.equal(client.snapshot!.rows[0]?.meta.name, "original");
    assert.equal(client.snapshot!.rows.length, 1);
    await waitForEvent(async () => {
      // Snapshot queries return fresh metrics without requesting inventory repair.
      await client.get({ cwd: f.root, sessionId: "parent", limit: 10 });
      return f.executor.metrics().sourceWatchers === 0;
    });
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ ...meta, name: "recreated" }));
    await waitForEvent(() => client.snapshot?.status === "ready" && client.snapshot.rows[0]?.meta.name === "recreated");
    assert.equal(client.snapshot!.status, "ready");
    await waitForEvent(async () => {
      await client.get({ cwd: f.root, sessionId: "parent", limit: 10 });
      return f.executor.metrics().sourceWatchers === 2;
    });
    const retiredMeta = join(f.root, "old-runs", id, "meta.json");
    writeFileSync(retiredMeta, JSON.stringify({ ...meta, name: "retired-inode" }));
    // A current-root commit supplies the barrier: retired data must never win.
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ ...meta, name: "current-inode" }));
    await waitForEvent(() => client.snapshot?.rows[0]?.meta.name === "current-inode");
    assert.equal(f.executor.metrics().sourceWatchers, 2);
    rmSync(directory, { recursive: true });
    await waitForEvent(() => client.snapshot?.rows.length === 0);
    assert.equal(client.snapshot!.status, "ready", "deletion is verified while the source root exists");
    assert.equal(f.executor.metrics().executor.restarts, 0);
  } finally { await f.close(); }
});
