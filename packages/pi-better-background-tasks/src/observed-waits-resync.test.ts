/**
 * Owner-scoped coordinator resync after the durable hint journal was pruned.
 *
 * The host must recover its own terminal callback from operations/sidecar state,
 * not from a global terminal scan and not by waking a model. This uses the real
 * supervisor and SQLite, then deletes the hints to simulate the replay horizon
 * advancing past a disconnected client's cursor.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createObservedWaitHost,
  type ParentNotification,
} from "./observed-waits.js";
import { createLocalSupervisor } from "./supervisor/index.js";
import { CoordinatorClient } from "./coordinator/client.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "observed-waits-resync-"));
  roots.push(root);
  return root;
}

function context(root: string, sessionId: string): ExtensionContext {
  return {
    cwd: root,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => [{ id: "branch-1" }],
    },
    isIdle: () => true,
  } as unknown as ExtensionContext;
}

function harness(): ExtensionAPI {
  return {
    events: new EventEmitter(),
    on() { return () => {}; },
    registerTool(definition: unknown) { return definition; },
  } as unknown as ExtensionAPI;
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resync test timed out");
}

describe("owner-scoped coordinator resync", () => {
  it("does not subscribe or dispatch for another parent's parked worker during recovery", async () => {
    const root = workspace();
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const start = vi.spyOn(CoordinatorClient.prototype, "start").mockResolvedValue();
    const update = vi.spyOn(CoordinatorClient.prototype, "updateOwners").mockResolvedValue();
    const options = { storePath, supervisorDirectory, coordinator: true };
    const previousDurable = process.env.PI_SUBAGENT_DURABLE_DIR;
    process.env.PI_SUBAGENT_DURABLE_DIR = join(root, "durable");
    const registry = await import(/* @vite-ignore */ new URL("../../pi-better-subagents/registry.ts", import.meta.url).href);
    const { reconcileParkedWaits } = await import(/* @vite-ignore */ new URL("../../pi-better-subagents/worker-waits.ts", import.meta.url).href);
    const a = createObservedWaitHost(harness(), options);
    const b = createObservedWaitHost(harness(), options);
    const ctxA = context(root, "parent-A");
    const scope = { runId: "worker-A", conversationId: "worker-A", workspace: root, authorityReference: "authority:A", branchId: "branch-1", goalId: null };
    let deliveriesB = 0;
    const adapter = (id: string) => ({ version: 1 as const, id, onWaitReady: async () => "deferred" as const });
    try {
      a.start(ctxA);
      a.service.registerContinuationAdapter(adapter("a"));
      const launch = await a.launchForWorker(scope, { kind: "process", params: { argv: [process.execPath, "-e", "setTimeout(() => {}, 300)"], shell: false } });
      const wait = a.registerWorkerWait(scope, { taskIds: [launch.id], continuationNote: "interpret A result", attemptId: scope.runId, checkpointId: "checkpoint-A" });
      await a.checkpointWorkerWait(scope, { waitId: wait.waitId, generation: wait.generation, proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: true } });
      registry.writeMeta({
        id: scope.runId, sessionId: scope.conversationId, cwd: root, status: "completed",
        pid: 999999, spawnPid: process.pid, startedAt: Date.now(), endedAt: Date.now(),
        logPath: registry.logPathFor(scope.runId), promptPreview: "parent A parked work", callback: false,
      });
      registry.writeParkRecord(scope.runId, {
        version: 1, waitId: wait.waitId, generation: wait.generation, attemptId: scope.runId,
        phase: "waiting", ownerSessionId: "parent-A", ownerWorkspace: root,
        ownerBranchId: "branch-1", ownerGoalId: null, parkedAt: Date.now(), updatedAt: Date.now(),
      });
      a.close();
      start.mockClear();
      update.mockClear();
      b.start(context(root, "parent-B"));
      b.service.registerContinuationAdapter({ version: 1, id: "b", onWaitReady: async () => { deliveriesB += 1; return "deferred" as const; } });
      // Production startup recovery lists shared parked runs before resume's
      // parent gate. Listing must stay read-only, not subscribe B to A.
      await reconcileParkedWaits(b.service, { resume: async () => "skipped" });
      expect(b.listWorkerWaits(scope, { pendingOnly: true })).toHaveLength(1);
      await Promise.resolve();
      const bSubscriptions = [...start.mock.calls, ...update.mock.calls].map(([owners]) => owners);
      expect(bSubscriptions.some((owners) => owners.some((owner) => owner.sessionId === "worker-A"))).toBe(false);
      await until(() => createLocalSupervisor({ directory: supervisorDirectory }).inspect(launch.id)?.terminal === true);
      await b.reconcileNow();
      expect(deliveriesB).toBe(0);
      // Same-parent reload can rehydrate even on a different active branch.
      b.close();
      const reloaded = createObservedWaitHost(harness(), options);
      try {
        reloaded.start({ ...ctxA, sessionManager: { getSessionId: () => "parent-A", getBranch: () => [{ id: "other-branch" }] } } as unknown as ExtensionContext);
        reloaded.listWorkerWaits(scope, { pendingOnly: true });
        expect(update.mock.calls.at(-1)?.[0].some((owner) => owner.sessionId === "worker-A")).toBe(true);
      } finally { reloaded.close(); }
    } finally {
      a.close(); b.close();
      rmSync(registry.runDir(scope.runId), { recursive: true, force: true });
      if (previousDurable === undefined) delete process.env.PI_SUBAGENT_DURABLE_DIR;
      else process.env.PI_SUBAGENT_DURABLE_DIR = previousDurable;
    }
  });
  it("does not start a per-session scan timer when the coordinator is disabled", async () => {
    const root = workspace();
    const host = createObservedWaitHost(harness(), {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      coordinator: false,
      pollMs: 10,
    });
    host.start(context(root, "timer-owner"));
    const original = DatabaseSync.prototype.prepare;
    const statements: string[] = [];
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      statements.push(sql);
      return original.call(this, sql);
    } as typeof DatabaseSync.prototype.prepare;
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      DatabaseSync.prototype.prepare = original;
      host.close();
    }
    expect(statements.filter((sql) => /FROM operations|FROM outbox_events/.test(sql))).toEqual([]);
  });

  it("keeps a parked wait owner subscribed after its bridge run is released", () => {
    const root = workspace();
    const host = createObservedWaitHost(harness(), {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      coordinator: false,
    });
    const workerOwner = {
      kind: "worker-conversation" as const,
      sessionId: "parked-owner",
      workspace: root,
      branchId: "branch-1",
      goalId: null,
    };
    const internal = host as unknown as {
      waitOwners: Map<string, typeof workerOwner>;
      rpcRuns: Map<string, { owner: typeof workerOwner }>;
      coordinatorOwners(): typeof workerOwner[];
      rpcReleaseRun(params: Record<string, unknown>): unknown;
    };
    internal.waitOwners.set("wait_parked:1", workerOwner);
    internal.rpcRuns.set("run_parked", { owner: workerOwner });
    internal.rpcReleaseRun({ runId: "run_parked" });
    expect(internal.rpcRuns.size).toBe(0);
    expect(internal.coordinatorOwners()).toContainEqual(workerOwner);
    host.close();
  });

  it("coalesces a catch-up page to one outbox read without an owner snapshot", async () => {
    const root = workspace();
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const owner = {
      kind: "parent-session" as const,
      sessionId: "catchup-owner",
      workspace: root,
      branchId: "branch-1",
      goalId: null,
    };
    const seed = (await import("./shared-operation-coordinator/index.js")).openStore({ path: storePath });
    const changes: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 3; index += 1) {
      const operationId = `op_catchup_${index}`;
      const taskId = `bg_catchup_${index}`;
      seed.registerOperation({
        operationId,
        taskId,
        launchToken: `launch_catchup_${index}`,
        owner,
        observer: { kind: "local-supervisor", version: "1" },
      });
      seed.recordTerminalOutcome({
        operationId,
        eventId: `${taskId}:terminal`,
        outcome: "succeeded",
        owner,
        evidence: [{ kind: "terminal-record", ref: "result.json", summary: "exit 0" }],
      });
      changes.push({
        kind: "terminal",
        operationId,
        taskId,
        owner,
        waitId: null,
        generation: null,
        terminalRevision: 1,
      });
    }
    seed.close();
    const host = createObservedWaitHost(harness(), {
      storePath,
      supervisorDirectory,
      coordinator: false,
    });
    host.start(context(root, owner.sessionId));
    const original = DatabaseSync.prototype.prepare;
    const statements: string[] = [];
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
      statements.push(sql);
      return original.call(this, sql);
    } as typeof DatabaseSync.prototype.prepare;
    try {
      await (host as unknown as {
        handleCoordinatorCatchup(changes: readonly unknown[]): Promise<void>;
      }).handleCoordinatorCatchup(changes);
    } finally {
      DatabaseSync.prototype.prepare = original;
      host.close();
    }
    expect(statements.filter((sql) => /FROM operations\s+WHERE\s+owner_kind/.test(sql))).toHaveLength(0);
    expect(statements.filter((sql) => /FROM outbox_events/.test(sql))).toHaveLength(1);
  });

  it("rehydrates outstanding worker wait interest and retires it on cancellation", async () => {
    const root = workspace();
    const storePath = join(root, "operations.sqlite");
    const owner = { kind: "worker-conversation" as const, sessionId: "recovered-worker", workspace: root, branchId: "branch-1", goalId: null };
    const { openStore } = await import("./shared-operation-coordinator/index.js");
    const seed = openStore({ path: storePath });
    seed.registerOperation({ operationId: "op_recover", taskId: "bg_recover", launchToken: "launch_recover", owner, observer: { kind: "test", version: "1" } });
    const { wait } = seed.registerWait({ owner, dependencies: [{ operationId: "op_recover" }], continuationNote: "retain interpretation ownership" });
    seed.close();
    mkdirSync(join(root, "supervisor", "observed"), { recursive: true });
    writeFileSync(join(root, "supervisor", "observed", "bg_recover.json"), JSON.stringify({
      kind: "process", callback: false, parentOrigin: { cwd: root, sessionId: "parent-owner" },
    }));
    const host = createObservedWaitHost(harness(), { storePath, supervisorDirectory: join(root, "supervisor"), coordinator: false });
    host.start(context(root, "parent-owner"));
    const scope = { runId: "run_recover", conversationId: owner.sessionId, workspace: root, branchId: owner.branchId, goalId: null, authorityReference: "authority:test" };
    const internal = host as unknown as { coordinatorOwners(): typeof owner[] };
    expect(host.listWorkerWaits(scope, { pendingOnly: true })).toHaveLength(1);
    expect(internal.coordinatorOwners()).toContainEqual(owner);
    host.cancelWorkerWait(scope, { waitId: wait.waitId, generation: wait.generation, reason: "owner cancelled" });
    expect(internal.coordinatorOwners()).not.toContainEqual(owner);
    // Reading cancelled history must not re-arm its delivery interest.
    host.listWorkerWaits(scope);
    expect(internal.coordinatorOwners()).not.toContainEqual(owner);
    host.close();
  });

  it("recovers its own terminal callback after the hint journal is pruned", async () => {
    const root = workspace();
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const ctx = context(root, "resync-owner");
    const first = createObservedWaitHost(harness(), {
      storePath,
      supervisorDirectory,
      coordinator: false,
      notifyParent: () => {},
    });
    first.start(ctx);
    const launch = await first.launchParent({
      kind: "process",
      params: {
        argv: [process.execPath, "-e", 'setTimeout(() => { console.log("resync"); }, 250)'],
        shell: false,
        callback: true,
      },
      ctx,
    });
    first.close();

    const notifications: ParentNotification[] = [];
    const watcher = createObservedWaitHost(harness(), {
      storePath,
      supervisorDirectory,
      coordinator: false,
      notifyParent: (notification) => { notifications.push(notification); },
    });
    watcher.start(ctx);
    const supervisor = createLocalSupervisor({ directory: supervisorDirectory });
    await until(() => supervisor.inspect(launch.id)?.terminal === true);

    const { openStore } = await import("./shared-operation-coordinator/index.js");
    const store = openStore({ path: storePath });
    const operation = store.getOperation(launch.operationId)!;
    store.recordTerminalOutcome({
      operationId: launch.operationId,
      eventId: `${launch.id}:resync:test`,
      outcome: "succeeded",
      owner: operation.owner,
      evidence: [{ kind: "terminal-record", ref: "result.json", summary: "status=succeeded exit=0" }],
    });
    store.close();
    // Simulate the bounded journal maintenance removing hints below the
    // watcher's cursor. Only the owner snapshot may recover the callback.
    const db = new DatabaseSync(storePath);
    db.exec("DELETE FROM coordinator_changes");
    db.close();

    await watcher.resyncCoordinatorOwners();
    await until(() => notifications.length === 1);
    expect(notifications[0]?.taskId).toBe(launch.id);
    expect(notifications[0]?.status).toBe("succeeded");
    watcher.close();
  }, 30_000);
});
