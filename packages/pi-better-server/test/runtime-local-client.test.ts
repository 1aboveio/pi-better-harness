import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkQueryExecutor } from "../src/runtime/query-executor.ts";
import { createLocalWorkClient } from "../src/runtime/local-client.ts";
import { SessionActivity } from "../src/session-activity.ts";
import { backgroundObservation, closeBackgroundObservation } from "../../pi-better-background-tasks/src/work-observation.ts";

test("hosted Background reads share the executor without a registered socket and close on reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-work-"));
  const executor = new WorkQueryExecutor(root, "local-instance", {
    modelOptions: { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 },
  });
  const clients: ReturnType<typeof createLocalWorkClient>[] = [];
  const hosts = Array.from({ length: 2 }, () => new SessionActivity(() => {}, undefined, undefined, () => {
    const client = createLocalWorkClient(executor, root); clients.push(client); return client;
  }));
  const apis = hosts.map(host => ({ events: host.runtimeEvents }) as any);
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "hosted" } } as any;
  try {
    const snapshots = await Promise.all(apis.map(api => backgroundObservation(api, ctx)));
    assert.ok(snapshots.every(snapshot => snapshot.status === "ready" && snapshot.instanceId === "local-instance"));
    assert.equal(executor.metrics().executor.clients, 2);
    const again = await backgroundObservation(apis[0], ctx);
    assert.equal(again.scopeRevision, snapshots[0].scopeRevision);
    assert.equal(clients.length, 2, "reads reuse the hosted client");
    hosts[0]!.resetRuntime();
    assert.equal(clients[0]!.closed, true);
    assert.equal(executor.metrics().executor.clients, 1);
    await assert.rejects(backgroundObservation(apis[0], ctx), /closed|disconnected/);
    apis[0] = { events: hosts[0]!.runtimeEvents };
    await backgroundObservation(apis[0], ctx);
    assert.equal(clients.length, 3, "reloaded consumers obtain a fresh connection");
    hosts[1]!.revokeRuntime();
    assert.equal(clients[1]!.closed, true);
    await assert.rejects(backgroundObservation({ events: hosts[1]!.runtimeEvents } as any, ctx), /revoked/);
  } finally {
    apis.forEach(closeBackgroundObservation);
    hosts.forEach(host => host.dispose());
    await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});


test("hosted overload is returned without falling back to standalone setup", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-overload-"));
  const executor = new WorkQueryExecutor(root, "limited", { maxConnections: 1 });
  const first = createLocalWorkClient(executor, root);
  const host = new SessionActivity(() => {}, undefined, undefined, () => createLocalWorkClient(executor, root));
  const api = { events: host.runtimeEvents } as any;
  try {
    await first.ready;
    await assert.rejects(backgroundObservation(api, { cwd: root } as any), /runtime-overloaded/);
    assert.equal(executor.metrics().executor.clients, 1);
  } finally {
    closeBackgroundObservation(api); host.dispose(); first.close(); await executor.close();
    rmSync(root, { recursive: true, force: true });
  }
});
