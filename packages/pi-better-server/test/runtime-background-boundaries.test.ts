import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
import { BackgroundObservation } from "../src/runtime/background.ts";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

test("Background history queries observe work completed between shared active refreshes", { timeout: 15000 }, async () => {
  const root = mkdtempSync("/tmp/p754-history-");
  const writer = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const executor = new WorkQueryExecutor(root, "history-instance", {
    modelOptions: { baseDir: join(root, "subagents"), durableDir: join(root, "archives"), intervalMs: 50 },
  });
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0, write: () => true });
  const client = executor.connect(socket as unknown as Socket);
  const scope = { background: true, backgroundHistory: true, cwd: root, sessionId: "parent" };
  const read = async () => JSON.parse((await client.handle({ type: "runtime_get_snapshot", scope })).json);
  try {
    await read(); await delay(200);
    assert.equal((await read()).rows.length, 0);
    const owner = { kind: "parent-session", sessionId: "parent", workspace: root };
    writer.registerOperation({ operationId: "history-op", taskId: "bgs_00000000000000000000", launchToken: "history-token",
      owner, observer: { kind: "local-supervisor", version: "1" } });
    writer.recordTerminalOutcome({ operationId: "history-op", eventId: "history-complete", owner,
      outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: "history-complete" }] });
    await delay(200);
    const history = await read();
    assert.equal(history.rows.length, 1, "a warmed history scope must include a newly completed operation");
    assert.equal(history.rows[0].meta.status, "succeeded");
  } finally {
    client.close(); await executor.close(); writer.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("Background fences replaced or removed coordinator connections", () => {
  const root = mkdtempSync("/tmp/p754-source-");
  const path = join(root, "operation-coordinator.sqlite");
  const writer = openStore({ path });
  writer.registerOperation({ operationId: "old-op", taskId: "bgs_00000000000000000001", launchToken: "old-token",
    owner: { kind: "parent-session", sessionId: "parent", workspace: root }, observer: { kind: "local-supervisor", version: "1" } });
  writer.close();
  const observation = new BackgroundObservation(root);
  try {
    assert.equal(observation.read({ cwd: root, sessionId: "parent" }).length, 1);
    assert.equal(observation.status, "ready");
    const replacement = join(root, "replacement.sqlite");
    openStore({ path: replacement }).close();
    renameSync(replacement, path);
    observation.refresh();
    assert.equal(observation.read({ cwd: root, sessionId: "parent" }).length, 0, "replacement facts must supersede the retained database");
    unlinkSync(path);
    observation.refresh();
    assert.equal(observation.status, "degraded");
    observation.refresh();
    assert.equal(observation.status, "degraded", "missing known authority cannot become a healthy empty source on retry");
    openStore({ path }).close();
    observation.refresh();
    assert.equal(observation.status, "ready");
  } finally { observation.close(); rmSync(root, { recursive: true, force: true }); }
});

test("one-shot Background origins have a fixed retained-scope budget", () => {
  const root = mkdtempSync("/tmp/p754-scopes-");
  const observation = new BackgroundObservation(root);
  try {
    const key = JSON.stringify([root, "subscribed-parent"]);
    const release = observation.retain({ cwd: root, sessionId: "subscribed-parent" });
    for (let i = 0; i < 500; i++) observation.read({ cwd: root, sessionId: `session-${i}` });
    const scopes = (observation as unknown as { legacy: Map<string, unknown> }).legacy;
    assert.ok(scopes.size <= 128, "past sessions must not accumulate permanent polling work");
    assert.ok(scopes.has(key), "a live subscription keeps its observation while one-shot scopes churn");
    release(); release();
    for (let i = 500; i < 700; i++) observation.read({ cwd: root, sessionId: `session-${i}` });
    assert.equal(scopes.has(key), false, "disconnect releases the scope for bounded eviction");
  } finally { observation.close(); rmSync(root, { recursive: true, force: true }); }
});
