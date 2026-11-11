import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  createObservedWaitHost,
  formatWaitView,
  getObservedWaitService,
  observedWaitServiceUnavailableReason,
  OBSERVED_WAITS_READY_CHANNEL,
  OBSERVED_WAITS_RPC_CHANNEL,
  type BackgroundOperationService,
  type ContinuationAdapter,
  type ObservedWaitHost,
  type ParentDelivery,
  type ParentNotification,
  type WorkerRunScope,
} from "./observed-waits.js";
import {
  FOREGROUND_SANDBOX_POLICY_CHANNEL,
  FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
} from "./sandbox.js";
import type { LocalSupervisor, SupervisorStartOptions } from "./supervisor/index.js";
import { supervisorTaskIdForToken } from "./supervisor/index.js";
import { advertiseBackgroundAdapter, BACKGROUND_ADAPTER_REQUEST } from "./adapter-contract.js";
import { readProcessStartToken } from "./process-identity.js";
import { openStore } from "./shared-operation-coordinator/index.js";
import { registerTools } from "./tools.js";

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
};

interface Harness {
  pi: ExtensionAPI;
  events: EventEmitter;
  tools: Map<string, AnyTool>;
  close: () => void;
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `observed-waits-${name}-`));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function createHarness(): Harness {
  const events = new EventEmitter();
  const tools = new Map<string, AnyTool>();
  const pi = {
    events,
    registerTool(definition: AnyTool) {
      tools.set(definition.name, definition);
      return definition;
    },
    on() { return () => {}; },
  } as unknown as ExtensionAPI;
  return { pi, events, tools, close: () => { events.removeAllListeners(); } };
}

function createCtx(cwd: string, sessionId = "session-1", branchId = "branch-1"): ExtensionContext {
  return createBranchCtx(cwd, sessionId, [branchId]);
}

function createMutableBranchCtx(cwd: string, sessionId: string, branchIds: readonly string[]): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branchIds.map((id) => ({ id })),
    },
    isIdle: () => true,
  } as unknown as ExtensionContext;
}

function createBranchCtx(cwd: string, sessionId: string, branchIds: readonly string[]): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branchIds.map((id) => ({ id })),
    },
    isIdle: () => true,
  } as unknown as ExtensionContext;
}

function startHost(options: {
  harness?: Harness;
  root: string;
  supervisor?: LocalSupervisor;
  notifyParent?: (notification: ParentNotification) => void;
  ctx?: ExtensionContext;
}): { host: ObservedWaitHost; pi: ExtensionAPI; notifications: ParentNotification[] } {
  const harness = options.harness ?? createHarness();
  const notifications: ParentNotification[] = [];
  const host = createObservedWaitHost(harness.pi, {
    storePath: join(options.root, "operations.sqlite"),
    supervisorDirectory: join(options.root, "supervisor"),
    pollMs: 0,
    ...(options.supervisor ? { supervisor: options.supervisor } : {}),
    notifyParent: options.notifyParent ?? ((notification) => { notifications.push(notification); }),
  });
  host.start(options.ctx ?? createCtx(options.root));
  cleanups.push(() => host.close());
  return { host, pi: harness.pi, notifications };
}

async function until(host: ObservedWaitHost, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await host.reconcileNow();
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  throw new Error("observed-waits test timed out waiting for a durable transition");
}

function nodeCommand(script: string): string[] {
  return [process.execPath, "-e", script];
}

function recordTerminalFromChild(
  root: string,
  operationId: string,
  owner: unknown,
  eventId: string,
): void {
  const storeModule = new URL("./shared-operation-coordinator/index.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", `
    import { openStore } from ${JSON.stringify(storeModule)};
    const store = openStore({ path: ${JSON.stringify(join(root, "operations.sqlite"))} });
    try {
      store.recordTerminalOutcome({
        operationId: ${JSON.stringify(operationId)},
        eventId: ${JSON.stringify(eventId)},
        outcome: "succeeded",
        owner: ${JSON.stringify(owner)},
        evidence: [{ kind: "terminal-record", ref: "cross/result.json", summary: "exit 0" }],
      });
    } finally {
      store.close();
    }
  `], { cwd: process.cwd(), encoding: "utf8", timeout: 60_000 });
  expect(child.status, child.stderr || child.stdout).toBe(0);
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((entry) => entry.text).join("\n");
}

function revisions(view: { dependencies: ReadonlyArray<{ operationId: string; terminalRevision: number }> }) {
  return view.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision }));
}

function sandboxPublisher(events: EventEmitter) {
  let payload: Record<string, unknown> | undefined;
  const publish = () => { if (payload) events.emit(FOREGROUND_SANDBOX_POLICY_CHANNEL, payload); };
  events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, publish);
  return {
    announce(background: Record<string, unknown>) {
      payload = Object.freeze({
        state: "disabled",
        denyWrite: Object.freeze([]),
        reason: "test policy",
        background: Object.freeze({ denyWrite: Object.freeze([]), reason: "test background policy", ...background }),
      });
      publish();
    },
  };
}

describe("parent durable launches", () => {
  it("retries reconciliation after coordinator write contention", async () => {
    const root = workspace("store-busy");
    const supervisor = fakeSupervisor(root, "lost");
    const inspect = supervisor.inspect.bind(supervisor);
    supervisor.inspect = (taskId) => ({ ...inspect(taskId)!, status: "running", terminal: false });
    const { host } = startHost({ root, supervisor });
    const ctx = createCtx(root);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("process.exit(0)"), shell: false, callback: false },
      ctx,
    });
    const store = openStore({ path: join(root, "operations.sqlite") });
    store.recordSupervision({ operationId: launch.operationId, owner: launch.owner, health: "unmonitored", reason: "test recovery" });
    store.close();
    const blocker = new DatabaseSync(join(root, "operations.sqlite"));
    try {
      blocker.exec("BEGIN IMMEDIATE");
      await expect(host.reconcileNow()).resolves.toBeUndefined();
      expect(host.statusForParent(ctx, launch.id).phase).toBe("running");
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
    await host.reconcileNow();
    const recovered = openStore({ path: join(root, "operations.sqlite") });
    try {
      expect(recovered.getOperation(launch.operationId)?.health).toBe("active");
    } finally {
      recovered.close();
    }
    supervisor.inspect = inspect;
    await host.reconcileNow();
    expect(host.statusForParent(ctx, launch.id).terminalOutcome).toBe("lost");
  }, 15_000);

  it("runs a local process through the real supervisor and reconciles one terminal revision", async () => {
    const root = workspace("process");
    const marker = join(root, "ran.txt");
    const { host, notifications } = startHost({ root });
    const ctx = createCtx(root);

    const launch = await host.launchParent({
      kind: "process",
      params: {
        name: "durable probe",
        argv: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ok")`),
        shell: false,
        callback: true,
      },
      ctx,
    });

    expect(launch.id).toMatch(/^bgs_[0-9a-f]{20}$/);
    expect(host.isDurableTask(launch.id)).toBe(true);
    await until(host, () => host.statusForParent(ctx, launch.id).phase === "terminal");
    const status = host.statusForParent(ctx, launch.id);
    expect(status.status).toBe("succeeded");
    expect(status.exitCode).toBe(0);
    expect(status.terminalRevision).toBe(1);
    expect(status.sandbox?.confinement).toBe("unconfined");
    expect(host.formatStatus(status)).toContain("sandbox: unconfined");
    expect(readFileSync(marker, "utf8")).toBe("ok");

    const revision = status.terminalRevision;
    await host.reconcileNow();
    expect(host.statusForParent(ctx, launch.id).terminalRevision).toBe(revision);
    // Callback on, no wait: one parent completion notification, not a wait delivery.
    await until(host, () => notifications.length === 1);
    expect(notifications[0]?.waitId).toBeUndefined();
    expect(notifications[0]?.status).toBe("succeeded");
    expect(host.formatStatus(status)).toContain("succeeded");
  });

  it("registers a wait before completion, delivers once, requires an evidence read, then consumes it", async () => {
    const root = workspace("wait-before");
    const { host, notifications } = startHost({ root });
    const ctx = createCtx(root);

    const launch = await host.launchParent({
      kind: "process",
      params: {
        argv: nodeCommand('setTimeout(() => { console.log("slept"); process.exit(3); }, 500)'),
        shell: false,
        callback: false,
      },
      ctx,
    });
    const waiting = host.waitForParent(ctx, [launch.id], "Interpret the exit code.");
    expect(waiting.phase).toBe("waiting");
    expect(waiting.settled).toBe(false);

    await until(host, () => host.listWaitsForParent(ctx, { pendingOnly: true })
      .some((wait) => wait.waitId === waiting.waitId && wait.settled));
    const settled = host.listWaitsForParent(ctx, { pendingOnly: true }).find((wait) => wait.waitId === waiting.waitId)!;
    expect(settled.phase).toBe("ready");
    expect(settled.dependencies[0]?.terminalOutcome).toBe("failed");
    await until(host, () => notifications.length === 1);
    expect(notifications[0]?.waitId).toBe(waiting.waitId);
    expect(notifications[0]?.status).toBe("failed");

    expect(() => host.acknowledgeForParent(ctx, {
      waitId: waiting.waitId,
      generation: waiting.generation,
      terminalRevisions: revisions(settled),
      disposition: "continue",
      note: "exit 3 is a real failure",
    })).toThrow(/has not been read/);

    const log = host.logForParent(ctx, launch.id, { lines: 20 });
    expect(log.stdout).toContain("slept");
    const ack = host.acknowledgeForParent(ctx, {
      waitId: waiting.waitId,
      generation: waiting.generation,
      terminalRevisions: revisions(settled),
      disposition: "continue",
      note: "exit 3 is a real failure",
    });
    expect(ack.phase).toBe("consumed");
    expect(ack.releasedPinIds.length).toBeGreaterThan(0);
    expect(host.listWaitsForParent(ctx, { pendingOnly: true })).toHaveLength(0);
    expect(() => host.acknowledgeForParent(ctx, {
      waitId: waiting.waitId,
      generation: waiting.generation,
      terminalRevisions: revisions(settled),
      disposition: "continue",
      note: "again",
    })).toThrow(/consumed/);
  });

  it("registers a wait on an already-terminal task and offers its evidence immediately", async () => {
    const root = workspace("wait-after");
    const { host } = startHost({ root });
    const ctx = createCtx(root);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("process.exit(0)"), shell: false, callback: false },
      ctx,
    });
    await until(host, () => host.statusForParent(ctx, launch.id).phase === "terminal");

    const wait = host.waitForParent(ctx, [launch.id], "Read success.");
    expect(wait.phase).toBe("ready");
    expect(wait.settled).toBe(true);
    expect(wait.evidence.some((entry) => entry.kind === "terminal-record")).toBe(true);
    expect(formatWaitView(wait)).toContain("all dependencies settled");
  });

  it("cancels one wait generation without stopping the operation and lists only live waits", async () => {
    const root = workspace("cancel");
    const { host } = startHost({ root });
    const ctx = createCtx(root);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 5000)"), shell: false, callback: false },
      ctx,
    });
    const wait = host.waitForParent(ctx, [launch.id], "temporary observation");
    expect(host.listWaitsForParent(ctx, { pendingOnly: true })).toHaveLength(1);

    const cancelled = host.cancelWaitForParent(ctx, wait.waitId, wait.generation, "no longer needed");
    expect(cancelled.phase).toBe("cancelled");
    expect(host.listWaitsForParent(ctx, { pendingOnly: true })).toHaveLength(0);
    expect(host.listWaitsForParent(ctx)).toHaveLength(1);

    const stopped = await host.stopForParent(ctx, launch.id);
    expect(stopped.status).toBe("cancelled");
    expect(stopped.terminalOutcome).toBe("cancelled");
  });

  it("stops a durable task and moves its pending wait to ready with a cancelled outcome", async () => {
    const root = workspace("stop");
    const { host } = startHost({ root });
    const ctx = createCtx(root);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 8000)"), shell: false, callback: false },
      ctx,
    });
    const wait = host.waitForParent(ctx, [launch.id], "watch the cancellation");
    const stopped = await host.stopForParent(ctx, launch.id);
    expect(stopped.status).toBe("cancelled");
    const ready = host.listWaitsForParent(ctx, { pendingOnly: true }).find((entry) => entry.waitId === wait.waitId)!;
    expect(ready.phase).toBe("ready");
    expect(ready.dependencies[0]?.terminalOutcome).toBe("cancelled");
  });

  it("runs a durable command watch and returns its first check", async () => {
    const root = workspace("watch");
    const { host } = startHost({ root });
    const ctx = createCtx(root);
    const launch = await host.launchParent({
      kind: "watch",
      params: {
        argv: nodeCommand('console.log("ready")'),
        shell: false,
        interval_seconds: 0.1,
        timeout_seconds: 5,
        success_when: { type: "stdout_contains", value: "ready" },
        callback: false,
      },
      ctx,
    });
    expect(launch.firstCheck).toBeDefined();
    expect(launch.firstCheck?.stdout).toContain("ready");
    await until(host, () => host.statusForParent(ctx, launch.id).phase === "terminal");
    const status = host.statusForParent(ctx, launch.id);
    expect(status.status).toBe("succeeded");
    expect(status.matchedCondition).toEqual({ type: "stdout_contains", value: "ready" });
  });

  it("records a lost operation as lost, never as success", async () => {
    const root = workspace("lost");
    const supervisor: LocalSupervisor = fakeSupervisor(root, "lost");
    const { host } = startHost({ root, supervisor });
    const ctx = createCtx(root);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("process.exit(0)"), shell: false, callback: false },
      ctx,
    });
    await host.reconcileNow();
    const status = host.statusForParent(ctx, launch.id);
    expect(status.status).toBe("lost");
    expect(status.phase).toBe("terminal");
    expect(status.terminalOutcome).toBe("lost");
    const wait = host.waitForParent(ctx, [launch.id], "interpret the loss");
    expect(wait.dependencies[0]?.terminalOutcome).toBe("lost");
    expect(wait.evidence.some((entry) => entry.ref === "lost.json" && entry.detailLost)).toBe(true);
  });

  it("refuses a legacy task id as a durable dependency", async () => {
    const root = workspace("legacy");
    const { host } = startHost({ root });
    const ctx = createCtx(root);
    expect(host.isDurableTask("bg_missing")).toBe(false);
    expect(() => host.waitForParent(ctx, ["bg_missing"], "nope")).toThrow(/not a durable local operation/);
  });
});

function fakeSupervisor(root: string, outcome: "lost"): LocalSupervisor {
  const inspectionFor = (taskId: string, token: string) => {
    const now = Date.now();
    return {
      taskId,
      token,
      kind: "process" as const,
      status: "lost" as const,
      terminal: true,
      launch: {
        taskId,
        token,
        kind: "process" as const,
        createdAt: now,
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: root,
        requestHash: "fake-lost",
      },
      lost: {
        version: 1,
        taskId,
        token,
        status: "lost" as const,
        reason: "the runner disappeared without terminal evidence",
        recordedAt: now,
      },
      taskDir: join(root, "fake-lost"),
      logs: { stdout: "", stderr: "", events: "" },
      observedAt: now,
    };
  };
  return {
    async start(options) {
      const taskId = supervisorTaskIdForToken(options.token);
      void outcome;
      return {
        taskId,
        token: options.token,
        started: true,
        claimed: true,
        status: "running",
        taskDir: join(root, "fake-lost"),
        inspection: { ...inspectionFor(taskId, options.token), status: "running", terminal: false, lost: undefined },
      };
    },
    inspect(taskId) {
      return inspectionFor(taskId, "token");
    },
    snapshot(taskId) {
      return inspectionFor(taskId, "token");
    },
    async stop() { return undefined; },
  };
}

function fakeRunningSupervisor(): LocalSupervisor & { inspections: number } {
  let inspections = 0;
  const inspectionFor = (taskId: string): ReturnType<LocalSupervisor["inspect"]> => {
    const now = Date.now();
    return {
      taskId,
      token: "fake-running",
      kind: "process",
      status: "running",
      terminal: false,
      launch: {
        taskId,
        token: "fake-running",
        kind: "process",
        createdAt: now,
        argv: [process.execPath, "-e", "process.exit(0)"],
        cwd: process.cwd(),
        requestHash: "fake-running",
      },
      taskDir: join(tmpdir(), "fake-running"),
      logs: { stdout: "", stderr: "", events: "" },
      observedAt: now,
    };
  };
  return {
    get inspections() {
      return inspections;
    },
    async start() {
      throw new Error("the reconciliation authority fixture does not launch");
    },
    inspect(taskId) {
      inspections += 1;
      return inspectionFor(taskId);
    },
    snapshot(taskId) {
      return inspectionFor(taskId);
    },
    async stop() {
      return undefined;
    },
  };
}

describe("supervision authority", () => {
  it("does not rewrite supervision while overlapping live hosts reconcile unchanged operations", async () => {
    const root = workspace("supervision-authority");
    const storePath = join(root, "operations.sqlite");
    const owner = { kind: "parent-session" as const, sessionId: "owner-a", workspace: root, branchId: "branch-1", goalId: null };
    const store = openStore({ path: storePath });
    const taskIds = Array.from({ length: 14 }, (_, index) => `bgs_${(index + 1).toString(16).padStart(20, "0")}`);
    try {
      taskIds.forEach((taskId, index) => {
        store.registerOperation({
          operationId: `op_authority_${index}`,
          taskId,
          launchToken: `launch_authority_${index}`,
          owner,
          observer: { kind: "background-tasks", version: "1" },
        });
      });
    } finally {
      store.close();
    }

    // The trigger observes every SQLite update, not only this host's cached view.
    const db = new DatabaseSync(storePath);
    db.exec("CREATE TABLE probe_updates (host TEXT)");
    db.exec(`CREATE TRIGGER probe_update AFTER UPDATE ON operations BEGIN
      INSERT INTO probe_updates VALUES (json_extract(NEW.supervision_json, '$.hostId'));
    END`);
    const countUpdates = (): number => {
      const row = db.prepare("SELECT count(*) AS count FROM probe_updates").get();
      return Number(row?.count ?? 0);
    };
    const clearUpdates = (): void => { db.exec("DELETE FROM probe_updates"); };

    try {
      const ownerSupervisor = fakeRunningSupervisor();
      const ownerHost = startHost({
        root,
        supervisor: ownerSupervisor,
        ctx: createCtx(root, "owner-a"),
      }).host;
      await ownerHost.reconcileNow();
      clearUpdates();

      for (let pass = 0; pass < 10; pass += 1) await ownerHost.reconcileNow();
      expect(countUpdates(), "an unchanged operation under one live host is not rewritten").toBe(0);
      const ownerInspectionsBefore = ownerSupervisor.inspections;

      const unrelatedSupervisor = fakeRunningSupervisor();
      const unrelatedHost = startHost({
        root,
        supervisor: unrelatedSupervisor,
        ctx: createCtx(root, "unrelated-b"),
      }).host;
      await unrelatedHost.reconcileNow();
      clearUpdates();
      const unrelatedInspectionsBefore = unrelatedSupervisor.inspections;

      for (let pass = 0; pass < 5; pass += 1) {
        await ownerHost.reconcileNow();
        await unrelatedHost.reconcileNow();
      }

      expect(countUpdates(), "a live unrelated host must not replace the recorded supervisor").toBe(0);
      expect(
        unrelatedSupervisor.inspections - unrelatedInspectionsBefore,
        "an unrelated host does not inspect another live host's healthy operations",
      ).toBe(0);
      expect(
        ownerSupervisor.inspections - ownerInspectionsBefore,
        "the recorded supervisor still performs exactly one inspection per operation per pass",
      ).toBe(taskIds.length * 5);
    } finally {
      db.close();
    }
  }, 30_000);

  it("releases a closed host's running authority for a replacement host", async () => {
    const root = workspace("supervision-release");
    const storePath = join(root, "operations.sqlite");
    const owner = { kind: "parent-session" as const, sessionId: "owner-a", workspace: root, branchId: null, goalId: null };
    const store = openStore({ path: storePath });
    try {
      store.registerOperation({
        operationId: "op_release",
        taskId: "bgs_00000000000000000001",
        launchToken: "launch_release",
        owner,
        observer: { kind: "background-tasks", version: "1" },
      });
    } finally {
      store.close();
    }

    const ownerHost = startHost({
      root,
      supervisor: fakeRunningSupervisor(),
      ctx: createCtx(root, "owner-a"),
    }).host;
    await ownerHost.reconcileNow();
    const claimed = openStore({ path: storePath });
    try {
      expect(claimed.getOperation("op_release")?.health).toBe("active");
      expect(claimed.getOperation("op_release")?.supervision?.hostId).toBeTruthy();
    } finally {
      claimed.close();
    }

    ownerHost.close();
    const released = openStore({ path: storePath });
    try {
      expect(released.getOperation("op_release")?.supervision).toBeNull();
      expect(released.getOperation("op_release")?.health).toBe("unmonitored");
      expect(released.getOperation("op_release")?.healthReason).toMatch(/closed/);
    } finally {
      released.close();
    }

    const replacementSupervisor = fakeRunningSupervisor();
    const replacement = startHost({
      root,
      supervisor: replacementSupervisor,
      ctx: createCtx(root, "replacement-b"),
    }).host;
    await replacement.reconcileNow();
    expect(replacementSupervisor.inspections).toBeGreaterThan(0);
    const takenOver = openStore({ path: storePath });
    try {
      expect(takenOver.getOperation("op_release")?.health).toBe("active");
      expect(takenOver.getOperation("op_release")?.supervision?.hostId).toBeTruthy();
    } finally {
      takenOver.close();
    }
  }, 30_000);
});

describe("worker operation service", () => {
  function runScope(root: string, conversationId = "conv-1"): WorkerRunScope {
    return {
      runId: "run-1",
      conversationId,
      workspace: root,
      authorityReference: "worker-authority-ref",
      branchId: "worker-branch-1",
    };
  }

  it("publishes a versioned service on the event bus", () => {
    const root = workspace("service");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    const service = getObservedWaitService(harness.pi);
    expect(service?.version).toBe(1);
    expect(service?.serviceId).toBe(host.service.serviceId);
    expect(service?.available).toBe(true);
    expect(service?.continuationReady).toBe(false);
  });

  it("resolves before session activation so extension load order cannot hide the service", () => {
    const root = workspace("service-load-order");
    const harness = createHarness();
    const host = createObservedWaitHost(harness.pi, {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
      notifyParent: () => {},
    });
    cleanups.push(() => host.close());
    const service = getObservedWaitService(harness.pi);
    expect(service?.version).toBe(1);
    expect(service?.serviceId).toBe(host.service.serviceId);
    expect(host.available).toBe(false); // the store opens on first use or activation
  });

  it("clears the published service on close and reopens on the next activation", () => {
    const root = workspace("service-lifecycle");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    expect(getObservedWaitService(harness.pi)).toBeDefined();
    host.close();
    expect(getObservedWaitService(harness.pi)).toBeUndefined();
    host.start(createCtx(root));
    expect(host.available).toBe(true);
    expect(getObservedWaitService(harness.pi)).toBeDefined();
  });

  it("launches a worker-owned process, refuses parking without an adapter, then drives the adapter", async () => {
    const root = workspace("worker");
    const { host, pi, notifications } = startHost({ root });
    const ctx = createCtx(root);
    host.start(ctx);
    const service = getObservedWaitService(pi) ?? host.service;
    const run = runScope(root);

    expect(() => service.registerWorkerWait(run, {
      taskIds: ["bgs_aaaaaaaaaaaaaaaaaaaa"],
      continuationNote: "x",
      attemptId: "attempt-1",
      checkpointId: "checkpoint-1",
    })).toThrow(/continuation adapter/);

    const ready: Array<{ waitId: string; taskIds: readonly string[]; evidence: readonly { operationId: string; terminalRevision: number }[] }> = [];
    const adapter: ContinuationAdapter = {
      version: 1,
      id: "subagents-test",
      onWaitReady(event) { ready.push(event); },
    };
    service.registerContinuationAdapter(adapter);
    expect(host.service.continuationReady).toBe(true);

    const launch = await service.launchForWorker(run, {
      kind: "process",
      params: {
        argv: nodeCommand('setTimeout(() => { console.log("worker-done"); }, 500)'),
        shell: false,
        callback: false,
      },
    });
    expect(launch.owner.kind).toBe("worker-conversation");
    expect(launch.owner.sessionId).toBe("conv-1");
    expect(service.ownsTask(run, launch.id)).toBe(true);
    expect(service.ownsTask(runScope(root, "other-conversation"), launch.id)).toBe(false);

    const wait = service.registerWorkerWait(run, {
      taskIds: [launch.id],
      continuationNote: "Read the worker result.",
      attemptId: "attempt-1",
      checkpointId: "checkpoint-1",
      writerLeaseId: "lease-1",
    });
    expect(wait.phase).toBe("parking");
    await expect(service.checkpointWorkerWait(run, {
      waitId: wait.waitId,
      generation: wait.generation,
      proof: { checkpointRecorded: false, writerLeaseReleased: true, writerPidGone: true },
    })).rejects.toThrow(/proven checkpoint/);
    const checkpointed = await service.checkpointWorkerWait(run, {
      waitId: wait.waitId,
      generation: wait.generation,
      proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: true },
    });
    expect(checkpointed.phase).toBe("waiting");

    await until(host, () => ready.length === 1);
    expect(ready[0]?.taskIds).toEqual([launch.id]);
    expect(ready[0]?.evidence.length).toBeGreaterThan(0);
    // The parent callback belongs to the parent owner; a worker wait is not a
    // parent callback, so the two delivery paths stay separate.
    expect(notifications).toHaveLength(0);

    const status = service.statusForWorker(run, launch.id);
    expect(status.status).toBe("succeeded");
    expect(status.phase).toBe("terminal");
    const ack = service.acknowledgeForWorker(run, {
      waitId: wait.waitId,
      generation: wait.generation,
      terminalRevisions: ready[0]!.evidence.map((entry) => ({ operationId: entry.operationId, revision: entry.terminalRevision })),
      disposition: "continue",
      note: "worker result interpreted",
    });
    expect(ack.phase).toBe("consumed");
  });

  it("applies the worker sandbox admission and hands the confined argv to the supervisor", async () => {
    const root = workspace("worker-confined");
    mkdirSync(join(root, "sub"), { recursive: true });
    const starts: SupervisorStartOptions[] = [];
    const supervisor: LocalSupervisor = {
      async start(options) {
        starts.push(options);
        const taskId = supervisorTaskIdForToken(options.token);
        return {
          taskId,
          token: options.token,
          started: true,
          claimed: true,
          status: "running",
          taskDir: join(root, "fake-task"),
          inspection: {
            taskId,
            token: options.token,
            kind: options.kind ?? "process",
            status: "running",
            terminal: false,
            launch: {
              taskId,
              token: options.token,
              kind: options.kind ?? "process",
              createdAt: Date.now(),
              argv: [...options.argv],
              cwd: options.cwd ?? root,
              requestHash: "fake",
            },
            taskDir: join(root, "fake-task"),
            logs: { stdout: "", stderr: "", events: "" },
            observedAt: Date.now(),
          },
        };
      },
      inspect() { return undefined; },
      snapshot() { return undefined; },
      async stop() { return undefined; },
    };
    const { host } = startHost({ root, supervisor });
    const ctx = createCtx(root);
    host.start(ctx);
    const run = runScope(root);
    const policy = {
      root,
      denyWrite: [join(root, ".env")],
      permissions: {
        projectFiles: "read" as const,
        outsideProject: "off" as const,
        storedCredentials: "read" as const,
        commands: true,
        network: false,
        shell: false,
        commandTimeoutSeconds: 7,
      },
    };

    const launched = await host.service.launchForWorker(run, {
      kind: "process",
      params: { cwd: "sub", argv: ["/usr/bin/true"], shell: false, callback: false },
      policy,
    });
    const confinedView = host.service.statusForWorker(run, launched.id);
    expect(confinedView.sandbox).toMatchObject({ confinement: "confined", policySource: "background" });
    expect(host.formatStatus(confinedView)).toMatch(/sandbox: confined(?:; [^;]+)?; source: background/);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.argv[0]).toBe(process.platform === "linux" ? "/usr/bin/bwrap" : "/usr/bin/sandbox-exec");
    const wrapped = JSON.parse(starts[0]!.argv.at(-1)!) as { executable: string; args: string[] };
    expect({ executable: wrapped.executable, args: wrapped.args }).toEqual({ executable: "/usr/bin/true", args: [] });
    expect(starts[0]?.commandTimeoutSeconds).toBe(7);
    // The relative worker cwd is resolved against the worker workspace before
    // admission, confinement and supervisor execution.
    expect(starts[0]?.cwd).toBe(realpathSync.native(join(root, "sub")));
    expect(starts[0]?.env?.PATH).toBe("/usr/bin:/bin");

    await expect(host.service.launchForWorker(run, {
      kind: "process",
      params: { command: "echo hi", shell: true, callback: false },
      policy,
    })).rejects.toThrow(/disables shell commands/);
    expect(starts).toHaveLength(1);
  });

  it("exposes resume claim, release and publish through the object service", async () => {
    const root = workspace("worker-resume");
    const { host } = startHost({ root });
    const run = runScope(root);
    const ready: string[] = [];
    host.service.registerContinuationAdapter({
      version: 1,
      id: "subagents-object-resume",
      onWaitReady(event) { ready.push(event.waitId); },
    });
    const launch = await host.service.launchForWorker(run, {
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 5000)"), shell: false, callback: false },
    });
    const wait = host.service.registerWorkerWait(run, {
      taskIds: [launch.id],
      continuationNote: "resume once ready",
      attemptId: "attempt-resume-object",
      checkpointId: "checkpoint-resume-object",
    });
    await host.service.checkpointWorkerWait(run, {
      waitId: wait.waitId,
      generation: wait.generation,
      proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: true },
    });
    await host.service.stopForWorker(run, launch.id);
    await until(host, () => host.service.listWorkerWaits(run, { pendingOnly: true })
      .some((entry) => entry.waitId === wait.waitId && entry.phase === "ready"));
    expect(ready).toContain(wait.waitId);
    const snapshot = host.service.listWorkerWaits(run, { pendingOnly: true })
      .find((entry) => entry.waitId === wait.waitId)!;

    const first = host.service.claimResumeForWorker(run, {
      waitId: snapshot.waitId,
      generation: snapshot.generation,
      expectedCancelEpoch: snapshot.cancelEpoch,
      lease: { ownerId: "subagents:object-test", pid: process.pid },
      reservedCheckpointId: "checkpoint-resume-object",
    });
    expect(first.state).toBe("claimed");
    const released = host.service.releaseResumeForWorker(run, {
      waitId: snapshot.waitId,
      generation: snapshot.generation,
      claimId: first.claimId,
      claimToken: first.claimToken,
      outcome: "ready",
      reason: "capacity unavailable before spawn",
    });
    expect(released.state).toBe("released");
    expect(released.phase).toBe("ready");

    const second = host.service.claimResumeForWorker(run, {
      waitId: snapshot.waitId,
      generation: snapshot.generation,
      expectedCancelEpoch: snapshot.cancelEpoch,
      lease: { ownerId: "subagents:object-test", pid: process.pid },
      reservedCheckpointId: "checkpoint-resume-object",
    });
    const published = host.service.publishResumeForWorker(run, {
      waitId: snapshot.waitId,
      generation: snapshot.generation,
      claimId: second.claimId,
      claimToken: second.claimToken,
      attemptId: "resumed-attempt",
      launchToken: "resumed-launch-token",
    });
    expect(published).toMatchObject({ state: "published", attemptId: "resumed-attempt", phase: "resuming" });
    const cancelled = host.service.cancelWorkerWait(run, {
      waitId: snapshot.waitId,
      generation: snapshot.generation,
      reason: "owner cancelled the resumed assignment",
    });
    expect(cancelled.phase).toBe("cancelled");
  });

  it("refuses a parking wait when no continuation adapter is registered", async () => {
    const root = workspace("park-off");
    const { host } = startHost({ root });
    expect(() => host.service.registerWorkerWait(runScope(root), {
      taskIds: ["bgs_aaaaaaaaaaaaaaaaaaaa"],
      continuationNote: "x",
      attemptId: "a",
      checkpointId: "c",
    })).toThrow(/continuation adapter/);
  });
});

describe("parent tool integration", () => {
  it("routes spawn, status, log, wait and acknowledge through the durable host", async () => {
    const root = workspace("tools");
    const marker = join(root, "tool.txt");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    host.start(createCtx(root));
    registerTools(harness.pi);
    const ctx = createCtx(root);

    const spawn = harness.tools.get("bg_task_spawn")!;
    const launched = await spawn.execute("call-1", {
      name: "tool probe",
      argv: nodeCommand(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "tool")`),
      shell: false,
      callback: false,
    }, undefined, undefined, ctx);
    const launchText = textOf(launched);
    expect(launchText).toContain("Started durable background process");
    const taskId = /Started durable background process (bgs_[0-9a-f]{20})/.exec(launchText)?.[1];
    expect(taskId).toBeTruthy();

    await until(host, () => host.statusForParent(ctx, taskId!).phase === "terminal");
    const status = await harness.tools.get("bg_task_status")!.execute("call-2", { id: taskId }, undefined, undefined, ctx);
    expect(textOf(status)).toContain("succeeded");

    const wait = await harness.tools.get("wait_for_operations")!.execute("call-3", {
      task_ids: [taskId],
      continuation_note: "Read the tool result.",
    }, undefined, undefined, ctx);
    const waitView = wait.details as { waitId: string; generation: number; dependencies: Array<{ operationId: string; terminalRevision: number }> };
    expect(textOf(wait)).toContain("all dependencies settled");

    // The status read above happened before this wait existed. Read the exact
    // terminal evidence again after registeration: acknowledgement requires it.
    await harness.tools.get("bg_task_log")!.execute("call-4", { id: taskId, lines: 10 }, undefined, undefined, ctx);
    const ack = await harness.tools.get("acknowledge_operation_result")!.execute("call-5", {
      wait_id: waitView.waitId,
      generation: waitView.generation,
      terminal_revisions: waitView.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
      disposition: "continue",
      note: "tool path verified",
    }, undefined, undefined, ctx);
    expect(textOf(ack)).toContain("phase consumed");
    expect(readFileSync(marker, "utf8")).toBe("tool");
  });

  it("lets the bg_task wrapper use the same durable route", async () => {
    const root = workspace("wrapper");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    host.start(createCtx(root));
    registerTools(harness.pi);
    const ctx = createCtx(root);

    const spawned = await harness.tools.get("bg_task")!.execute("call-1", {
      action: "spawn",
      argv: nodeCommand("process.exit(0)"),
      shell: false,
      callback: false,
    }, undefined, undefined, ctx);
    const text = textOf(spawned);
    const taskId = /Started durable background process (bgs_[0-9a-f]{20})/.exec(text)?.[1];
    expect(taskId).toBeTruthy();
    await until(host, () => host.statusForParent(ctx, taskId!).phase === "terminal");
    const status = await harness.tools.get("bg_task")!.execute("call-2", { action: "status", id: taskId }, undefined, undefined, ctx);
    expect(textOf(status)).toContain("succeeded");
  });

  it("keeps the legacy route when the durable host could not open", async () => {
    const root = workspace("unavailable");
    const harness = createHarness();
    const host = createObservedWaitHost(harness.pi, {
      storePath: root, // a directory, so SQLite refuses to open
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    });
    host.start(createCtx(root));
    cleanups.push(() => host.close());
    expect(host.available).toBe(false);
    expect(host.reason).toBeTruthy();
    registerTools(harness.pi);

    const wait = await harness.tools.get("wait_for_operations")!.execute("call-1", {
      task_ids: ["bgs_aaaaaaaaaaaaaaaaaaaa"],
      continuation_note: "x",
    }, undefined, undefined, createCtx(root));
    expect(textOf(wait)).toMatch(/unavailable/i);
    expect(getObservedWaitService(harness.pi)).toBeUndefined();
    expect(observedWaitServiceUnavailableReason(harness.pi)).toBeTruthy();
  });

  it("registers the delivery observer through the durable wait path", () => {
    const root = workspace("delivery");
    const harness = createHarness();
    startHost({ root, harness });
    registerTools(harness.pi);
    expect(harness.tools.has("watch_delivery")).toBe(true);
  });

  it("refuses a parent shell launch through the published Background profile", async () => {
    const root = workspace("parent-shell");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    sandboxPublisher(harness.events).announce({
      state: "enabled",
      writableRoot: root,
      permissions: {
        enabled: true,
        projectFiles: "read-write",
        outsideProject: "read",
        storedCredentials: "read",
        commands: true,
        network: true,
        shell: false,
      },
    });
    await expect(host.launchParent({
      kind: "process",
      params: { command: "echo hi", shell: true, callback: false },
      ctx: createCtx(root),
    })).rejects.toThrow(/disables shell commands/);
  });
});

// ---- Subagents request/reply compatibility --------------------------------

function rpcClient(events: EventEmitter) {
  let counter = 0;
  return function call(method: string, params: Record<string, unknown>, timeoutMs = 8_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`observed-waits RPC ${method} timed out`));
      }, timeoutMs);
      const reply = (value: { ok?: boolean; value?: unknown; code?: string; reason?: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value?.ok === true && value.value && typeof value.value === "object") resolve(value.value as Record<string, unknown>);
        else reject(Object.assign(new Error(value?.reason ?? "refused"), { code: value?.code ?? "refused" }));
      };
      events.emit(OBSERVED_WAITS_RPC_CHANNEL, {
        version: 1,
        id: `rpc-test-${++counter}`,
        method,
        params,
        reply,
      });
    });
  };
}

function workerPolicy(root: string, tools: string[]) {
  return {
    version: 1,
    sandbox: null,
    tools,
    clean: false,
    deadlineAt: null,
    authorityReference: "rpc-authority-ref",
    workspace: root,
  };
}

describe("Subagents request/reply surface", () => {
  it("registers a run, executes a tool, stages then releases a checkpoint, and acknowledges", async () => {
    const root = workspace("rpc");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    const call = rpcClient(harness.events);
    const readyEvents: Array<Record<string, unknown>> = [];
    harness.events.on(OBSERVED_WAITS_READY_CHANNEL, (value: unknown) => readyEvents.push(value as Record<string, unknown>));

    expect(await call("status", {})).toMatchObject({ version: 1, workerOperations: true });

    const runId = "run-rpc";
    const conversationId = "conv-rpc";
    const tools = ["bg_task_spawn", "bg_task_status", "bg_task_log", "wait_for_operations", "acknowledge_operation_result"];
    await call("register-run", {
      runId,
      conversationId,
      attemptId: "attempt-rpc",
      workspace: root,
      authorityReference: "rpc-authority-ref",
      policy: workerPolicy(root, tools),
      tools,
      capabilities: {
        background: { spawn: true, watch: true, status: true, log: true },
        wait: true,
        acknowledge: true,
        parking: true,
      },
    });

    const launch = await call("execute-tool", {
      runId,
      conversationId,
      tool: "bg_task_spawn",
      params: {
        argv: nodeCommand('setTimeout(() => { console.log("rpc-done"); }, 600)'),
        shell: false,
        callback: false,
      },
    });
    const taskId = String(launch.id);
    expect(taskId).toMatch(/^bgs_[0-9a-f]{20}$/);
    expect(launch.owner).toMatchObject({ kind: "worker-conversation", sessionId: conversationId });

    const admitted = await call("wait-admission", {
      runId,
      conversationId,
      taskIds: [taskId],
      attemptId: "attempt-rpc",
      continuationNote: "Read the RPC worker result.",
      owner: { kind: "worker-conversation", sessionId: conversationId, workspace: root, branchId: null, goalId: null },
      origin: { workspace: root, authorityReference: "rpc-authority-ref" },
    });
    expect(admitted.park).toBe(true);
    expect(admitted.phase).toBe("parking");
    const waitId = String(admitted.waitId);
    const generation = Number(admitted.generation);

    // Stage while the child is alive: the wait must not look parked yet.
    const staged = await call("checkpoint", {
      runId,
      waitId,
      generation,
      toolCallId: "tool-call-1",
      attemptId: "attempt-rpc",
      evidence: {
        version: 1,
        sessionId: "conv-rpc",
        sessionFile: join(root, "session.jsonl"),
        toolCallId: "tool-call-1",
        waitId,
        generation,
        entryId: "entry-1",
        prefixBytes: 10,
        prefixSha256: "a".repeat(64),
      },
    });
    expect(staged).toMatchObject({ checkpointed: true, phase: "parking", staged: true });
    expect((await call("wait-snapshot", { waitId, generation })).phase).toBe("parking");

    await until(host, () => (host as unknown as {
      operationForTask(id: string): { terminalRevision: number } | undefined;
    }).operationForTask(taskId)?.terminalRevision === 1);

    const released = await call("checkpoint", {
      runId,
      waitId,
      generation,
      writerLeaseReleased: true,
      writerPidGone: true,
    });
    expect(released).toMatchObject({ checkpointed: true, phase: "ready", staged: false });
    const snapshot = await call("wait-snapshot", { waitId, generation });
    expect(snapshot.phase).toBe("ready");
    expect(typeof snapshot.cancelEpoch).toBe("number");
    expect(snapshot.claim).toBeNull();
    expect(readyEvents.some((event) => event.waitId === waitId && event.version === 1)).toBe(true);

    const beforeRead = await call("acknowledge", {
      runId,
      owner: { kind: "worker-conversation", sessionId: conversationId, workspace: root },
      wait_id: waitId,
      generation,
      terminal_revisions: [{ operation_id: String((snapshot.dependencies as Array<Record<string, unknown>>)[0].operationId), revision: 1 }],
      disposition: "continue",
      note: "rpc ack before read",
    }).then(() => "unexpected", (error: { code?: string }) => error.code);
    expect(beforeRead).toBe("evidence-read-required");

    await call("execute-tool", { runId, conversationId, tool: "bg_task_log", params: { id: taskId, lines: 10 } });
    const ack = await call("acknowledge", {
      runId,
      owner: { kind: "worker-conversation", sessionId: conversationId, workspace: root },
      wait_id: waitId,
      generation,
      terminal_revisions: (snapshot.dependencies as Array<Record<string, unknown>>).map((dep) => ({
        operation_id: dep.operationId,
        revision: dep.terminalRevision,
      })),
      disposition: "continue",
      note: "rpc worker result interpreted",
    });
    expect(ack.phase).toBe("consumed");
    expect(await call("release-run", { runId })).toMatchObject({ released: true });
  });

  it("claims, publishes, releases and cancels resume generations through the service", async () => {
    const root = workspace("rpc-resume");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    const call = rpcClient(harness.events);
    const runId = "run-resume";
    const conversationId = "conv-resume";
    const tools = ["bg_task_spawn", "bg_task_status", "bg_task_stop", "wait_for_operations", "acknowledge_operation_result"];
    await call("register-run", {
      runId,
      conversationId,
      attemptId: "attempt-resume",
      workspace: root,
      authorityReference: "resume-ref",
      policy: workerPolicy(root, tools),
      tools,
      capabilities: { background: { spawn: true, watch: false, status: true, log: true }, wait: true, acknowledge: true, parking: true },
    });
    const launch = await call("execute-tool", {
      runId,
      conversationId,
      tool: "bg_task_spawn",
      params: { argv: nodeCommand("setTimeout(() => {}, 3000)"), shell: false, callback: false },
    });
    const taskId = String(launch.id);
    const admitted = await call("wait-admission", {
      runId,
      conversationId,
      taskIds: [taskId],
      attemptId: "attempt-resume",
      continuationNote: "resume the parked worker",
      owner: { kind: "worker-conversation", sessionId: conversationId, workspace: root, branchId: null, goalId: null },
    });
    const waitId = String(admitted.waitId);
    const generation = Number(admitted.generation);
    await call("checkpoint", {
      runId, waitId, generation, writerLeaseReleased: true, writerPidGone: true,
      evidence: {
        version: 1, sessionId: conversationId, sessionFile: join(root, "s.jsonl"), toolCallId: "t",
        waitId, generation, entryId: "e", prefixBytes: 1, prefixSha256: "b".repeat(64),
      },
    });
    expect((await call("wait-snapshot", { waitId, generation })).phase).toBe("waiting");

    // Settle the dependency so the generation becomes ready for continuation.
    await call("execute-tool", { runId, conversationId, tool: "bg_task_stop", params: { id: taskId } });
    await until(host, () => true);
    expect((await call("wait-snapshot", { waitId, generation })).phase).toBe("ready");

    // Unpublished claim can be released back to ready by the pre-spawn admission.
    const first = await call("claim-resume", {
      runId, waitId, generation,
      expectedCancelEpoch: Number((await call("wait-snapshot", { waitId, generation })).cancelEpoch),
      lease: { ownerId: "subagents:test", pid: process.pid },
      reservedCheckpointId: "entry-1",
    });
    expect(typeof first.claimId).toBe("string");
    expect(typeof first.claimToken).toBe("string");
    const released = await call("release-resume", {
      runId, waitId, generation,
      claimId: first.claimId,
      claimToken: first.claimToken,
      outcome: "ready",
      reason: "capacity unavailable before spawn",
    });
    expect(released.state).toBe("released");
    expect(released.phase).toBe("ready");

    // A second claim can be published before spawn.
    const second = await call("claim-resume", {
      runId, waitId, generation,
      expectedCancelEpoch: Number((await call("wait-snapshot", { waitId, generation })).cancelEpoch),
      lease: { ownerId: "subagents:test", pid: process.pid },
      reservedCheckpointId: "entry-1",
    });
    const published = await call("publish-resume", {
      runId, waitId, generation,
      claimId: second.claimId,
      claimToken: second.claimToken,
      attemptId: "attempt-resumed",
      launchToken: "launch-token-resumed",
    });
    expect(published).toMatchObject({ state: "published", attemptId: "attempt-resumed", published: true });
    expect((await call("wait-snapshot", { waitId, generation })).claim).toMatchObject({
      state: "published",
      attemptId: "attempt-resumed",
    });

    // Cancellation fences the published claim and consumes no evidence.
    const cancelled = await call("cancel-wait", {
      runId, waitId, generation,
      expectedCancelEpoch: Number((await call("wait-snapshot", { waitId, generation })).cancelEpoch),
      reason: "owner cancelled the parked assignment",
    });
    expect(cancelled.phase).toBe("cancelled");
    expect((await call("wait-snapshot", { waitId, generation })).claim).toBeNull();
  });

  it("refuses foreign task ids and unregistered runs", async () => {
    const root = workspace("rpc-refusal");
    const harness = createHarness();
    startHost({ root, harness });
    const call = rpcClient(harness.events);
    await expect(call("execute-tool", {
      runId: "missing-run",
      conversationId: "conv",
      tool: "bg_task_status",
      params: { id: "bgs_aaaaaaaaaaaaaaaaaaaa" },
    })).rejects.toThrow(/not registered/);
    await expect(call("wait-snapshot", { waitId: "wait_missing", generation: 1 })).rejects.toThrow(/Unknown wait/);
  });
});

describe("actual Subagents client integration", () => {
  it("resolves and drives the published object service through the sibling client", async () => {
    let sibling: { getWorkerOperationService(pi: unknown): {
      version: number;
      continuationReady: boolean;
      launchForWorker(run: Record<string, unknown>, input: Record<string, unknown>): Promise<{ id: string; owner: { kind: string; sessionId: string } }>;
      statusForWorker(run: Record<string, unknown>, taskId: string): { status: string; phase: string };
      ownsTask(run: Record<string, unknown>, taskId: string): boolean;
      registerContinuationAdapter(adapter: Record<string, unknown>): void;
      registerWorkerWait(run: Record<string, unknown>, input: Record<string, unknown>): { waitId: string; generation: number; phase: string; park: boolean };
      checkpointWorkerWait(run: Record<string, unknown>, input: Record<string, unknown>): Promise<{ phase: string }>;
      listWorkerWaits(run: Record<string, unknown>, options?: { pendingOnly?: boolean }): Array<{
        waitId: string;
        generation: number;
        dependencies: Array<{ operationId: string; terminalRevision: number }>;
      }>;
      acknowledgeForWorker(run: Record<string, unknown>, input: Record<string, unknown>): { phase: string };
    } | undefined };
    try {
      sibling = await import(/* @vite-ignore */ new URL("../../pi-better-subagents/worker-waits.ts", import.meta.url).href);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return;
      throw error;
    }
    const root = workspace("subagents-client");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    const service = sibling.getWorkerOperationService(harness.pi);
    expect(service?.version).toBe(1);
    expect(service?.continuationReady).toBe(false);
    const run = {
      runId: "sa-integration",
      conversationId: "conv-integration",
      workspace: root,
      authorityReference: "subagents-integration-ref",
      branchId: null,
      goalId: null,
    };
    const ready: string[] = [];
    service!.registerContinuationAdapter({
      version: 1,
      id: "subagents-integration-adapter",
      onWaitReady(event: { waitId: string }) { ready.push(event.waitId); },
    });
    const launch = await service!.launchForWorker(run, {
      kind: "process",
      params: { argv: nodeCommand('setTimeout(() => { console.log("integration"); }, 400)'), shell: false, callback: false },
      policy: null,
    });
    expect(service!.ownsTask(run, launch.id)).toBe(true);
    const wait = service!.registerWorkerWait(run, {
      taskIds: [launch.id],
      continuationNote: "integration wait",
      attemptId: "attempt-integration",
      checkpointId: "checkpoint-integration",
    });
    expect(wait).toMatchObject({ phase: "parking", park: true });
    await service!.checkpointWorkerWait(run, {
      waitId: wait.waitId,
      generation: wait.generation,
      proof: { checkpointRecorded: true, writerLeaseReleased: true, writerPidGone: true },
    });
    await until(host, () => ready.includes(wait.waitId));
    expect(service!.statusForWorker(run, launch.id)).toMatchObject({ status: "succeeded", phase: "terminal" });
    const settled = service!.listWorkerWaits(run, { pendingOnly: true })
      .find((entry) => entry.waitId === wait.waitId)!;
    const ack = service!.acknowledgeForWorker(run, {
      waitId: wait.waitId,
      generation: wait.generation,
      terminalRevisions: settled.dependencies.map((dep) => ({
        operationId: dep.operationId,
        revision: dep.terminalRevision,
      })),
      disposition: "continue",
      note: "integration acknowledged",
    });
    expect(ack.phase).toBe("consumed");
  });
});

describe("durable read-only projections", () => {
  it("does not decode another session's historical operations when listing", () => {
    const root = workspace("projection-history");
    const { host } = startHost({ root });
    const store = openStore({ path: join(root, "operations.sqlite") });
    try {
      store.registerOperation({
        operationId: "foreign-history", taskId: "foreign-history-task", launchToken: "foreign-token",
        owner: { kind: "parent-session", sessionId: "foreign-session", workspace: root },
        observer: { kind: "background-tasks", version: "1" },
      });
    } finally {
      store.close();
    }
    const db = new DatabaseSync(join(root, "operations.sqlite"));
    try {
      db.exec("UPDATE operations SET supervision_json = 'invalid-json' WHERE operation_id = 'foreign-history'");
    } finally {
      db.close();
    }
    expect(host.listDurableTasks({ cwd: root, sessionId: "current-session" })).toEqual([]);
    expect(host.listDurableTasks({ cwd: root })).toEqual([]);
  });

  it("keeps unchanged panel projections off unrelated history after warm-up", async () => {
    const root = workspace("projection-cache");
    const { host } = startHost({ root });
    const store = openStore({ path: join(root, "operations.sqlite") });
    try {
      for (let index = 0; index < 3_140; index += 1) {
        store.registerOperation({
          operationId: `op-history-${index}`,
          taskId: `bgs_${index.toString(16).padStart(20, "0")}`,
          launchToken: `launch_history_${index}`,
          owner: {
            kind: "parent-session",
            sessionId: `historical-session-${index % 37}`,
            workspace: root,
            branchId: `branch-${index % 5}`,
            goalId: null,
          },
          observer: { kind: "background-tasks", version: "1" },
        });
      }
      for (const [index, branchId] of ["main", "side", "other"].entries()) {
        store.registerOperation({
          operationId: `op-current-${index}`,
          taskId: `bgs_${(0x100000 + index).toString(16).padStart(20, "0")}`,
          launchToken: `launch_current_${index}`,
          owner: { kind: "parent-session", sessionId: "current-session", workspace: root, branchId, goalId: null },
          observer: { kind: "background-tasks", version: "1" },
        });
      }
    } finally {
      store.close();
    }

    const origin = { cwd: root, sessionId: "current-session" };
    host.resetDurableProjectionMetrics();
    const first = host.listDurableTasks(origin, { retentionMs: 30_000 });
    expect(first).toHaveLength(3);
    expect(host.getDurableProjectionMetrics()).toEqual({
      listCalls: 1,
      queries: 1,
      rowsRead: 3,
      projectionsBuilt: 3,
      cacheHits: 0,
    });

    for (let render = 0; render < 25; render += 1) {
      expect(host.listDurableTasks(origin, { retentionMs: 30_000 })).toHaveLength(3);
    }
    expect(host.getDurableProjectionMetrics()).toEqual({
      listCalls: 26,
      queries: 1,
      rowsRead: 3,
      projectionsBuilt: 3,
      cacheHits: 25,
    });
  }, 120_000);

  it("invalidates a cached projection when another process records the terminal revision", async () => {
    const root = workspace("projection-cross-process");
    const { host } = startHost({ root });
    const ctx = createCtx(root, "session-projection-cross");
    const origin = { cwd: root, sessionId: "session-projection-cross" };
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 5000)"), shell: false, callback: false },
      ctx,
    });
    try {
      await host.reconcileNow();
      expect(host.listDurableTasks(origin)[0]).toMatchObject({ id: launch.id, status: "running", terminal: false });
      let changes = 0;
      const off = host.onDurableTaskChange(() => { changes += 1; });
      try {
        recordTerminalFromChild(root, launch.operationId, launch.owner, "cross-process-terminal");
        const beforeReconcile = changes;
        host.resetDurableProjectionMetrics();
        await host.reconcileNow();
        expect(changes).toBeGreaterThan(beforeReconcile);
        expect(host.listDurableTasks(origin)[0]).toMatchObject({ id: launch.id, status: "succeeded", terminal: true });
        expect(host.getDurableProjectionMetrics().queries).toBe(1);
        expect(host.getDurableProjectionMetrics().rowsRead).toBe(1);
      } finally {
        off();
      }
    } finally {
      await host.stopDurableTask(origin, launch.id);
    }
  });

  it("leaves a warmed active projection untouched for foreign-session discovery and terminal changes", async () => {
    const root = workspace("projection-foreign-isolation");
    const { host } = startHost({ root });
    const ctx = createCtx(root, "session-current");
    const origin = { cwd: root, sessionId: "session-current" };
    const current = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
      ctx,
    });
    const foreignTaskId = `bgs_${"f".repeat(20)}`;
    const foreignOwner = {
      kind: "parent-session" as const,
      sessionId: "session-foreign",
      workspace: root,
      branchId: "foreign-branch",
      goalId: null,
    };
    try {
      await host.reconcileNow();
      expect(host.listDurableTasks(origin).map((task) => task.id)).toEqual([current.id]);
      host.resetDurableProjectionMetrics();
      const changes: Array<{ sessionId: string; workspace: string }> = [];
      const off = host.onDurableTaskChange((change) => { changes.push(change); });
      try {
        const store = openStore({ path: join(root, "operations.sqlite") });
        try {
          store.registerOperation({
            operationId: "op-foreign",
            taskId: foreignTaskId,
            launchToken: "launch-foreign",
            owner: foreignOwner,
            observer: { kind: "background-tasks", version: "1" },
          });
        } finally {
          store.close();
        }
        mkdirSync(join(root, "supervisor", "observed"), { recursive: true });
        writeFileSync(join(root, "supervisor", "observed", `${foreignTaskId}.json`), "{}");

        await host.reconcileNow();
        expect(changes).toEqual([]);
        expect(host.listDurableTasks(origin)).toHaveLength(1);
        expect(host.getDurableProjectionMetrics()).toMatchObject({ queries: 0, rowsRead: 0, cacheHits: 1 });

        recordTerminalFromChild(root, "op-foreign", foreignOwner, "foreign-terminal");
        host.resetDurableProjectionMetrics();
        await host.reconcileNow();
        expect(changes).toEqual([]);
        expect(host.listDurableTasks(origin)?.map((task) => task.id)).toEqual([current.id]);
        expect(host.getDurableProjectionMetrics()).toMatchObject({ queries: 0, rowsRead: 0, cacheHits: 1 });

        recordTerminalFromChild(root, current.operationId, current.owner, "own-terminal");
        host.resetDurableProjectionMetrics();
        await host.reconcileNow();
        expect(changes).toEqual([{ sessionId: "session-current", workspace: root }]);
        expect(host.listDurableTasks(origin)[0]).toMatchObject({ id: current.id, status: "succeeded", terminal: true });
        expect(host.getDurableProjectionMetrics()).toMatchObject({ queries: 1, rowsRead: 1 });
      } finally {
        off();
      }
    } finally {
      await host.stopDurableTask(origin, current.id);
    }
  });

  it("projects only the exact parent origin, never a worker or foreign session", async () => {
    const root = workspace("projection");
    const { host } = startHost({ root });
    const ctx = createCtx(root, "session-projection");
    const origin = { cwd: root, sessionId: "session-projection" };
    let changes = 0;
    const off = host.onDurableTaskChange(() => { changes += 1; });
    try {
      const launch = await host.launchParent({
        kind: "process",
        params: { name: "projection-task", argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
        ctx,
      });
      const listed = host.listDurableTasks(origin);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        id: launch.id,
        name: "projection-task",
        status: "running",
        active: true,
        terminal: false,
        owner: { sessionId: "session-projection", workspace: root },
      });
      expect(changes).toBeGreaterThan(0);

      expect(host.ownsDurableTask(launch.id)).toBe(true);
      expect(host.listDurableTasks({ cwd: root, sessionId: "foreign-session" })).toEqual([]);
      expect(host.listDurableTasks({ cwd: root })).toEqual([]);
      expect(host.readDurableTask({ cwd: root, sessionId: "foreign-session" }, launch.id)).toBeUndefined();
      expect(host.readDurableTaskLog({ cwd: root, sessionId: "foreign-session" }, launch.id)).toBeUndefined();
      expect(await host.stopDurableTask({ cwd: root, sessionId: "foreign-session" }, launch.id)).toBeUndefined();
      expect(host.dismissDurableTask({ cwd: root, sessionId: "foreign-session" }, launch.id)).toBe(false);

      // A worker-owned operation is not a parent projection.
      const worker = host.service.launchForWorker({
        runId: "projection-run",
        conversationId: "projection-conv",
        workspace: root,
        authorityReference: "projection-ref",
      }, {
        kind: "process",
        params: { argv: nodeCommand("process.exit(0)"), shell: false, callback: false },
        policy: null,
      });
      const workerLaunch = await worker;
      expect(host.readDurableTask(origin, workerLaunch.id)).toBeUndefined();
      expect(host.ownsDurableTask(workerLaunch.id)).toBe(false);
      // A different active session cannot claim the owner's durable task.
      host.start(createCtx(root, "foreign-session", "foreign-branch"));
      expect(host.ownsDurableTask(launch.id)).toBe(false);
      host.start(ctx);
      expect(host.ownsDurableTask(launch.id)).toBe(true);

      await host.stopDurableTask(origin, launch.id);
      await until(host, () => host.readDurableTask(origin, launch.id)?.terminal === true);
      const terminal = host.readDurableTask(origin, launch.id)!;
      expect(terminal.status).toBe("cancelled");
      expect(terminal.active).toBe(false);
      expect(terminal.terminal).toBe(true);
    } finally {
      off();
    }
  });

  it("keeps read-only log access from satisfying acknowledgement evidence", async () => {
    const root = workspace("projection-read");
    const { host } = startHost({ root });
    const ctx = createCtx(root, "session-projection-read");
    const origin = { cwd: root, sessionId: "session-projection-read" };
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand('console.log("projection-evidence")'), shell: false, callback: false },
      ctx,
    });
    const wait = host.waitForParent(ctx, [launch.id], "read evidence");
    await until(host, () => host.readDurableTask(origin, launch.id)?.terminal === true);

    const log = host.readDurableTaskLog(origin, launch.id, 10)!;
    expect(log.stdout).toContain("projection-evidence");
    const view = host.waitViewForParent(ctx, wait.waitId) ?? host.listWaitsForParent(ctx, { pendingOnly: true })
      .find((entry) => entry.waitId === wait.waitId)!;
    expect(() => host.acknowledgeForParent(ctx, {
      waitId: view.waitId,
      generation: view.generation,
      terminalRevisions: view.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
      disposition: "continue",
      note: "read-only projection must not count",
    })).toThrow(/has not been read/);

    // The real status read is still the evidence read that unlocks acknowledgement.
    host.statusForParent(ctx, launch.id);
    expect(host.acknowledgeForParent(ctx, {
      waitId: view.waitId,
      generation: view.generation,
      terminalRevisions: view.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
      disposition: "continue",
      note: "status read is the evidence read",
    }).phase).toBe("consumed");
  });

  it("dismisses only terminal owned operations and keeps their evidence readable", async () => {
    const root = workspace("projection-dismiss");
    const { host } = startHost({ root });
    const ctx = createCtx(root, "session-projection-dismiss");
    const origin = { cwd: root, sessionId: "session-projection-dismiss" };
    const launch = await host.launchParent({
      kind: "process",
      params: { name: "dismiss-me", argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
      ctx,
    });
    expect(host.dismissDurableTask(origin, launch.id)).toBe(false); // still running
    await host.stopDurableTask(origin, launch.id);
    await until(host, () => host.readDurableTask(origin, launch.id)?.terminal === true);

    let changes = 0;
    const off = host.onDurableTaskChange(() => { changes += 1; });
    try {
      expect(host.dismissDurableTask(origin, launch.id)).toBe(true);
      expect(changes).toBeGreaterThan(0);
      expect(host.listDurableTasks(origin)).toEqual([]);
      expect(host.listDurableTasks(origin, { includeDismissed: true })).toHaveLength(1);
      expect(host.readDurableTask(origin, launch.id)?.dismissedAt).toBeTypeOf("number");
      const evidence = host.readDurableTaskLog(origin, launch.id, 10);
      expect(evidence).toBeDefined();
      expect(host.readDurableTask(origin, launch.id)?.terminalOutcome).toBe("cancelled");
    } finally {
      off();
    }
  });
});

describe("durable adapter admission", () => {
  it("admits an owned durable stop as a registry operation and refuses foreign or worker ids", async () => {
    const root = workspace("adapter");
    const harness = createHarness();
    const { host } = startHost({ root, harness });
    const ctxA = createCtx(root, "adapter-owner", "adapter-branch");
    host.start(ctxA);
    const parent = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
      ctx: ctxA,
    });
    const worker = await host.service.launchForWorker({
      runId: "adapter-run",
      conversationId: "adapter-conversation",
      workspace: root,
      authorityReference: "adapter-ref",
      branchId: null,
    }, {
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
      policy: null,
    });
    advertiseBackgroundAdapter(harness.pi, new Map<string, object>([["bg_task_stop", {}]]));
    const reply = (id: string) => {
      let value: { admission?: string } | undefined;
      harness.events.emit(BACKGROUND_ADAPTER_REQUEST, {
        version: 1,
        name: "bg_task_stop",
        input: { id },
        reply: (next: { admission?: string }) => { value = next; },
      });
      return value;
    };

    expect(reply(parent.id)?.admission).toBe("registry");
    host.start(createCtx(root, "adapter-other", "other-branch"));
    expect(reply(parent.id)).toBeUndefined();
    expect(reply(worker.id)).toBeUndefined();
    expect(reply("bg_missing")).toBeUndefined();
    host.start(ctxA);
    expect(reply(parent.id)?.admission).toBe("registry");

    await host.stopForParent(ctxA, parent.id);
    await host.service.stopForWorker({
      runId: "adapter-run",
      conversationId: "adapter-conversation",
      workspace: root,
      authorityReference: "adapter-ref",
      branchId: null,
    }, worker.id);
  });
});

describe("callback origin and delivery receipt", () => {
  type PendingCall = {
    notification: ParentNotification;
    delivery: ParentDelivery;
    delivered: boolean;
  };
  function deferredNotifier() {
    const calls: PendingCall[] = [];
    return {
      calls,
      notify: (notification: ParentNotification, delivery: ParentDelivery) => {
        calls.push({ notification, delivery, delivered: false });
      },
      deliver(call: PendingCall) {
        if (call.delivered) return;
        call.delivered = true;
        call.delivery.delivered();
      },
      defer(call: PendingCall, reason = "origin inactive") {
        if (call.delivered) return;
        call.delivered = true;
        call.delivery.defer(reason);
      },
    };
  }

  it("keeps an inactive origin pending and never leaks it to the current session", async () => {
    const root = workspace("origin-gate");
    const notifier = deferredNotifier();
    const harness = createHarness();
    const host = createObservedWaitHost(harness.pi, {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
      notifyParent: notifier.notify,
    });
    cleanups.push(() => host.close());
    const ctxA = createCtx(root, "origin-a", "branch-a");
    host.start(ctxA);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand('console.log("origin")'), shell: false, callback: true },
      ctx: ctxA,
    });
    await until(host, () => host.readDurableTask({ cwd: root, sessionId: "origin-a" }, launch.id)?.terminal === true);
    await until(host, () => notifier.calls.length === 1);

    // Session B is active; A's pending result must not be routed to B.
    host.start(createCtx(root, "origin-b", "branch-b"));
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(1);
    // The real batcher suppresses an inactive owner; this returns the delivery
    // to pending for the right owner instead of routing it to B.
    notifier.defer(notifier.calls[0]!, "origin session is not active");

    // A reactivates: the pending delivery is offered again and receipts only on
    // the batcher's explicit handoff.
    host.start(ctxA);
    await until(host, () => notifier.calls.length === 2);
    notifier.deliver(notifier.calls[1]!);
    host.start(createCtx(root, "origin-b", "branch-b"));
    host.start(ctxA);
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(2);
  });

  it("requires the recorded branch anchor to remain on the active branch", async () => {
    const root = workspace("branch-gate");
    const notifier = deferredNotifier();
    const harness = createHarness();
    const host = createObservedWaitHost(harness.pi, {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
      notifyParent: notifier.notify,
    });
    cleanups.push(() => host.close());
    const ctxA = createBranchCtx(root, "branch-owner", ["anchor-1"]);
    host.start(ctxA);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("process.exit(0)"), shell: false, callback: true },
      ctx: ctxA,
    });
    await until(host, () => host.readDurableTask({ cwd: root, sessionId: "branch-owner" }, launch.id)?.terminal === true);
    await until(host, () => notifier.calls.length === 1);

    // An abandoned fork does not contain the anchor.
    host.start(createBranchCtx(root, "branch-owner", ["other-fork"]));
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(1);
    notifier.defer(notifier.calls[0]!, "branch anchor is not on the active branch");

    // A descendant branch still contains the anchor and is eligible.
    host.start(createBranchCtx(root, "branch-owner", ["anchor-1", "descendant"]));
    await until(host, () => notifier.calls.length === 2);
    notifier.deliver(notifier.calls[1]!);
  });

  it("recovers a busy terminal callback after reload and receipts it exactly once", async () => {
    const root = workspace("callback-reload");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const harness = createHarness();
    const ctxA = createCtx(root, "callback-owner", "callback-branch");
    const first = deferredNotifier();
    let host = createObservedWaitHost(harness.pi, { ...options, notifyParent: first.notify });
    host.start(ctxA);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand('console.log("callback")'), shell: false, callback: true },
      ctx: ctxA,
    });
    await until(host, () => host.readDurableTask({ cwd: root, sessionId: "callback-owner" }, launch.id)?.terminal === true);
    await until(host, () => first.calls.length === 1);
    expect(first.calls[0]!.delivered).toBe(false);
    host.close();

    const second = deferredNotifier();
    host = createObservedWaitHost(harness.pi, { ...options, notifyParent: second.notify });
    cleanups.push(() => host.close());
    // B is active first: the pending callback is not delivered there.
    host.start(createCtx(root, "callback-other", "other-branch"));
    await host.reconcileNow();
    expect(second.calls).toHaveLength(0);

    // The right owner activates: one fresh handoff, then durable receipt.
    host.start(ctxA);
    await until(host, () => second.calls.length === 1);
    second.deliver(second.calls[0]!);
    // The abandoned first offer must not be able to receipt a second time.
    first.deliver(first.calls[0]!);

    host.start(createCtx(root, "callback-other", "other-branch"));
    host.start(ctxA);
    await host.reconcileNow();
    expect(second.calls).toHaveLength(1);
  });

  it("keeps a claimed wait delivery pending across reload and acknowledges separately", async () => {
    const root = workspace("outbox-reload");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const harness = createHarness();
    const ctxA = createCtx(root, "outbox-owner", "outbox-branch");
    const first = deferredNotifier();
    let host = createObservedWaitHost(harness.pi, { ...options, notifyParent: first.notify });
    host.start(ctxA);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
      ctx: ctxA,
    });
    const wait = host.waitForParent(ctxA, [launch.id], "durable wait receipt");
    await host.stopForParent(ctxA, launch.id);
    await until(host, () => host.listWaitsForParent(ctxA, { pendingOnly: true })
      .some((entry) => entry.waitId === wait.waitId && entry.phase === "ready"));
    await until(host, () => first.calls.length === 1);
    expect(first.calls[0]!.delivered).toBe(false);
    host.close();

    const second = deferredNotifier();
    host = createObservedWaitHost(harness.pi, { ...options, notifyParent: second.notify });
    cleanups.push(() => host.close());
    host.start(createCtx(root, "outbox-other", "other-branch"));
    await host.reconcileNow();
    expect(second.calls).toHaveLength(0);

    host.start(ctxA);
    await until(host, () => second.calls.length === 1);
    second.deliver(second.calls[0]!);
    first.deliver(first.calls[0]!);

    const ready = host.listWaitsForParent(ctxA, { pendingOnly: true }).find((entry) => entry.waitId === wait.waitId)!;
    const ack = host.acknowledgeForParent(ctxA, {
      waitId: ready.waitId,
      generation: ready.generation,
      terminalRevisions: ready.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
      disposition: "continue",
      note: "delivery and acknowledgement are separate",
    });
    expect(ack.phase).toBe("consumed");
    host.start(createCtx(root, "outbox-other", "other-branch"));
    host.start(ctxA);
    await host.reconcileNow();
    expect(second.calls).toHaveLength(1);
  });

  it("catches the outbox up from a handoff that landed after the store closed", async () => {
    const root = workspace("outbox-after-close");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const harness = createHarness();
    const ctxA = createCtx(root, "after-close-owner", "after-close-branch");
    const first = deferredNotifier();
    let host = createObservedWaitHost(harness.pi, { ...options, notifyParent: first.notify });
    host.start(ctxA);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
      ctx: ctxA,
    });
    const wait = host.waitForParent(ctxA, [launch.id], "handoff after close");
    await host.stopForParent(ctxA, launch.id);
    await until(host, () => first.calls.length === 1);
    host.close();

    // The batcher hands off after the reload began: the sidecar records the
    // handoff even though the old store can no longer mark the outbox.
    first.deliver(first.calls[0]!);

    const second = deferredNotifier();
    host = createObservedWaitHost(harness.pi, { ...options, notifyParent: second.notify });
    cleanups.push(() => host.close());
    host.start(ctxA);
    await host.reconcileNow();
    expect(second.calls).toHaveLength(0);
    const ready = host.listWaitsForParent(ctxA, { pendingOnly: true }).find((entry) => entry.waitId === wait.waitId)!;
    const ack = host.acknowledgeForParent(ctxA, {
      waitId: ready.waitId,
      generation: ready.generation,
      terminalRevisions: ready.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
      disposition: "continue",
      note: "handoff after close is not duplicated",
    });
    expect(ack.phase).toBe("consumed");
  });

  it("does not let a standalone callback receipt receipt a later wait", async () => {
    const root = workspace("receipt-scope");
    const notifier = deferredNotifier();
    const harness = createHarness();
    const host = createObservedWaitHost(harness.pi, {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
      notifyParent: notifier.notify,
    });
    cleanups.push(() => host.close());
    const ctx = createCtx(root, "receipt-owner", "receipt-branch");
    host.start(ctx);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand('console.log("standalone")'), shell: false, callback: true },
      ctx,
    });
    await until(host, () => notifier.calls.length === 1);
    expect(notifier.calls[0]?.notification.waitId).toBeUndefined();
    notifier.deliver(notifier.calls[0]!); // standalone callback receipted

    const wait = host.waitForParent(ctx, [launch.id], "later wait");
    await until(host, () => notifier.calls.length === 2);
    expect(notifier.calls[1]?.notification.waitId).toBe(wait.waitId);
    expect(notifier.calls[1]?.notification.origin?.sessionId).toBe("receipt-owner");
    notifier.deliver(notifier.calls[1]!);
    host.statusForParent(ctx, launch.id);
    const view = host.listWaitsForParent(ctx, { pendingOnly: true }).find((entry) => entry.waitId === wait.waitId)!;
    expect(host.acknowledgeForParent(ctx, {
      waitId: view.waitId,
      generation: view.generation,
      terminalRevisions: view.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
      disposition: "continue",
      note: "later wait handoff was independent",
    }).phase).toBe("consumed");
  });

  it("gives every sequential wait generation its own handoff", async () => {
    const root = workspace("receipt-generations");
    const notifier = deferredNotifier();
    const harness = createHarness();
    const host = createObservedWaitHost(harness.pi, {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
      notifyParent: notifier.notify,
    });
    cleanups.push(() => host.close());
    const ctx = createCtx(root, "generation-owner", "generation-branch");
    host.start(ctx);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand('console.log("generation")'), shell: false, callback: false },
      ctx,
    });
    await until(host, () => host.readDurableTask({ cwd: root, sessionId: "generation-owner" }, launch.id)?.terminal === true);

    for (let round = 1; round <= 2; round += 1) {
      const wait = host.waitForParent(ctx, [launch.id], `generation ${round}`);
      await until(host, () => notifier.calls.some((call) => call.notification.waitId === wait.waitId));
      const call = notifier.calls.find((entry) => entry.notification.waitId === wait.waitId)!;
      notifier.deliver(call);
      host.statusForParent(ctx, launch.id);
      const view = host.listWaitsForParent(ctx, { pendingOnly: true }).find((entry) => entry.waitId === wait.waitId)!;
      expect(host.acknowledgeForParent(ctx, {
        waitId: view.waitId,
        generation: view.generation,
        terminalRevisions: view.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
        disposition: "continue",
        note: `generation ${round} consumed`,
      }).phase).toBe("consumed");
    }
    expect(notifier.calls).toHaveLength(2);
  });


  it("never steals an old outbox claim from a live process identity", async () => {
    const root = workspace("claim-live-outbox");
    const harness = createHarness();
    const ctx = createCtx(root, "claim-owner", "claim-branch");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const first = deferredNotifier();
    let host = createObservedWaitHost(harness.pi, { ...options, notifyParent: first.notify });
    host.start(ctx);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: false },
      ctx,
    });
    const wait = host.waitForParent(ctx, [launch.id], "live claim");
    await host.stopForParent(ctx, launch.id);
    await until(host, () => first.calls.length === 1);
    host.close();

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const token = readProcessStartToken(child.pid!);
    const foreignHostId = `${child.pid}:${token ? encodeURIComponent(token) : ""}:foreign-instance`;
    const direct = openStore({ path: options.storePath, now: () => Date.now() - 120_000 });
    for (const event of direct.listOutbox({ state: "claimed" })) {
      if (event.dispatchClaim) {
        direct.releaseOutbox({ eventId: event.eventId, claimToken: event.dispatchClaim.token, reason: "test reset" });
      }
    }
    direct.claimOutbox({
      waitId: wait.waitId,
      generation: wait.generation,
      claimToken: "foreign-claim",
      claimedBy: foreignHostId,
      limit: 1,
    });
    direct.close();

    const second = deferredNotifier();
    host = createObservedWaitHost(harness.pi, { ...options, notifyParent: second.notify });
    cleanups.push(() => host.close());
    host.start(ctx);
    await host.reconcileNow();
    // The claim is old (>30s) but its live process identity must keep it.
    expect(second.calls).toHaveLength(0);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    host.start(ctx);
    await until(host, () => second.calls.length === 1);
    second.deliver(second.calls[0]!);
    host.statusForParent(ctx, launch.id);
    const view = host.listWaitsForParent(ctx, { pendingOnly: true }).find((entry) => entry.waitId === wait.waitId)!;
    expect(host.acknowledgeForParent(ctx, {
      waitId: view.waitId,
      generation: view.generation,
      terminalRevisions: view.dependencies.map((dep) => ({ operationId: dep.operationId, revision: dep.terminalRevision })),
      disposition: "continue",
      note: "recovered only after the foreign owner died",
    }).phase).toBe("consumed");
  });

  it("never steals an old standalone callback claim from a live process identity", async () => {
    const root = workspace("claim-live-callback");
    const harness = createHarness();
    const ctx = createCtx(root, "callback-claim-owner", "callback-claim-branch");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const first = deferredNotifier();
    let host = createObservedWaitHost(harness.pi, { ...options, notifyParent: first.notify });
    host.start(ctx);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand('console.log("claim")'), shell: false, callback: true },
      ctx,
    });
    await until(host, () => first.calls.length === 1);
    host.close();

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const token = readProcessStartToken(child.pid!);
    const foreignHostId = `${child.pid}:${token ? encodeURIComponent(token) : ""}:foreign-instance`;
    const sidecar = join(root, "supervisor", "observed", `${launch.id}.json`);
    const record = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    record.callbackPendingAt = Date.now() - 120_000;
    record.callbackClaimedBy = foreignHostId;
    record.callbackClaimedAt = Date.now() - 120_000;
    delete record.callbackDeliveredAt;
    writeFileSync(sidecar, JSON.stringify(record));

    const second = deferredNotifier();
    host = createObservedWaitHost(harness.pi, { ...options, notifyParent: second.notify });
    cleanups.push(() => host.close());
    host.start(ctx);
    await host.reconcileNow();
    expect(second.calls).toHaveLength(0);

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    host.start(ctx);
    await until(host, () => second.calls.length === 1);
    second.deliver(second.calls[0]!);
    host.start(ctx);
    await host.reconcileNow();
    expect(second.calls).toHaveLength(1);
  });


  it("retries a terminal callback recorded before an active context is restored", async () => {
    const root = workspace("no-active-context");
    const notifier = deferredNotifier();
    const harness = createHarness();
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const ctx = createCtx(root, "no-active-owner", "no-active-branch");
    const first = createObservedWaitHost(harness.pi, { ...options, notifyParent: notifier.notify });
    first.start(ctx);
    const launch = await first.launchParent({
      kind: "process",
      params: { argv: nodeCommand('setTimeout(() => { console.log("late"); }, 300)'), shell: false, callback: true },
      ctx,
    });
    first.close();

    // A replacement host can open the store before session_start restores a
    // context (for example an RPC capability probe). Terminal evidence then lands
    // with no active owner.
    const host = createObservedWaitHost(harness.pi, { ...options, notifyParent: notifier.notify });
    cleanups.push(() => host.close());
    host.start();
    await until(host, () => (host as unknown as {
      operationForTask(id: string): { terminalRevision: number } | undefined;
    }).operationForTask(launch.id)?.terminalRevision === 1);
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(0);

    // The real active context arrives; the pending callback is handed off once.
    host.start(ctx);
    await until(host, () => notifier.calls.length === 1);
    notifier.deliver(notifier.calls[0]!);
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(1);
  });

  it("discovers a terminal result recorded after this host's initial scan", async () => {
    const root = workspace("late-terminal-discovery");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const ctx = createCtx(root, "late-discovery-owner", "late-discovery-branch");
    // B is active before the task exists and never observes it running.
    const watcherHarness = createHarness();
    const notifier = deferredNotifier();
    const watcher = createObservedWaitHost(watcherHarness.pi, { ...options, notifyParent: notifier.notify });
    cleanups.push(() => watcher.close());
    watcher.start(ctx);
    await watcher.reconcileNow();

    // A separate launcher registers/starts the task, then another host with no
    // session identity records terminal while the watcher is not reconciling.
    const launcherHarness = createHarness();
    const launcher = createObservedWaitHost(launcherHarness.pi, { ...options, notifyParent: () => {} });
    launcher.start(ctx);
    const launch = await launcher.launchParent({
      kind: "process",
      params: { argv: nodeCommand('setTimeout(() => { console.log("late-terminal"); }, 300)'), shell: false, callback: true },
      ctx,
    });
    launcher.close();
    const recorderHarness = createHarness();
    const recorder = createObservedWaitHost(recorderHarness.pi, { ...options, notifyParent: () => {} });
    cleanups.push(() => recorder.close());
    const anonymous = {
      cwd: root,
      sessionManager: { getSessionId: () => undefined, getBranch: () => [] },
      isIdle: () => true,
    } as unknown as ExtensionContext;
    recorder.start(anonymous);
    await until(recorder, () => (recorder as unknown as {
      operationForTask(id: string): { terminalRevision: number } | undefined;
    }).operationForTask(launch.id)?.terminalRevision === 1);

    // The watcher did not see the running phase. Normal reconcile discovers the
    // new shared sidecar/terminal result and hands off exactly once.
    await until(watcher, () => notifier.calls.length === 1);
    notifier.deliver(notifier.calls[0]!);
    await watcher.reconcileNow();
    expect(notifier.calls).toHaveLength(1);
  });

  it("protects a reopened host's live claim from a host created while it was closed", async () => {
    const root = workspace("reopened-claim");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), pollMs: 0 };
    const ctx = createCtx(root, "reopened-owner", "reopened-branch");
    const notifier = deferredNotifier();
    const host = createObservedWaitHost(createHarness().pi, { ...options, notifyParent: notifier.notify });
    cleanups.push(() => host.close());
    host.start(ctx);
    host.close();
    const competingNotifier = deferredNotifier();
    const competing = createObservedWaitHost(createHarness().pi, { ...options, notifyParent: competingNotifier.notify });
    cleanups.push(() => competing.close());
    competing.start(ctx);
    host.start(ctx);
    const launch = await host.launchParent({ kind: "process", params: { argv: nodeCommand('console.log("reopened")'), shell: false, callback: true }, ctx });
    await until(host, () => notifier.calls.length === 1);
    const path = join(root, "supervisor", "observed", `${launch.id}.json`);
    const before = JSON.parse(readFileSync(path, "utf8"));
    await competing.reconcileNow();
    expect(competingNotifier.calls).toHaveLength(0);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.callbackClaimedBy).toBe(before.callbackClaimedBy);
    expect(after.callbackClaimToken).toBe(before.callbackClaimToken);
    notifier.deliver(notifier.calls[0]!);
    expect(JSON.parse(readFileSync(path, "utf8")).callbackDeliveredAt).toBeTypeOf("number");
  });

  it.each(["defer", "delivered"] as const)("does not use a cached claim when %s encounters an unreadable journal", async (action) => {
    const root = workspace(`unreadable-${action}`);
    const notifier = deferredNotifier();
    const host = createObservedWaitHost(createHarness().pi, { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), pollMs: 0, notifyParent: notifier.notify });
    cleanups.push(() => host.close());
    const ctx = createCtx(root, "unreadable-owner", "unreadable-branch");
    host.start(ctx);
    const launch = await host.launchParent({ kind: "process", params: { argv: nodeCommand('console.log("unreadable")'), shell: false, callback: true }, ctx });
    await until(host, () => notifier.calls.length === 1);
    const path = join(root, "supervisor", "observed", `${launch.id}.json`);
    writeFileSync(path, "{partial");
    const delivery = notifier.calls[0]!.delivery;
    if (action === "defer") delivery.defer("journal unreadable");
    else delivery.delivered();
    expect(readFileSync(path, "utf8")).toBe("{partial");
  });

  it("preserves a newer host claim when a stale host delivery callback fires", async () => {
    const root = workspace("claim-overlap");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const ctx = createCtx(root, "overlap-owner", "overlap-branch");
    const firstHarness = createHarness();
    const firstNotifier = deferredNotifier();
    const first = createObservedWaitHost(firstHarness.pi, { ...options, notifyParent: firstNotifier.notify });
    cleanups.push(() => first.close());
    first.start(ctx);
    const launch = await first.launchParent({
      kind: "process",
      params: { argv: nodeCommand('console.log("overlap")'), shell: false, callback: true },
      ctx,
    });
    await until(first, () => firstNotifier.calls.length === 1);
    const stale = firstNotifier.calls[0]!;
    const sidecarPath = join(root, "supervisor", "observed", `${launch.id}.json`);

    // A replacement host takes over the shared sidecar and claim.
    const secondHarness = createHarness();
    const secondNotifier = deferredNotifier();
    const second = createObservedWaitHost(secondHarness.pi, { ...options, notifyParent: secondNotifier.notify });
    cleanups.push(() => second.close());
    second.start(ctx);
    await until(second, () => secondNotifier.calls.length === 1);
    const claimed = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;

    // A stale host can reconcile before its old delivery closure fires. That
    // attempt must read the fresh shared claim and write nothing.
    await first.reconcileNow();
    const afterReconcile = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
    expect(afterReconcile.callbackClaimToken).toBe(claimed.callbackClaimToken);
    expect(afterReconcile.callbackClaimedBy).toBe(claimed.callbackClaimedBy);
    expect(afterReconcile.callbackDeliveredAt).toBeUndefined();
    expect(afterReconcile.callbackAttemptedAt).toBe(claimed.callbackAttemptedAt);
    expect(afterReconcile.callbackSkipReason).toBe(claimed.callbackSkipReason);

    // The old host's delivery closures still carry its old claim token. They
    // must not clear or receipt the newer host's claim in the shared sidecar.
    stale.delivery.defer("stale defer");
    stale.delivery.delivered();
    const afterStale = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
    expect(afterStale.callbackClaimToken).toBe(claimed.callbackClaimToken);
    expect(afterStale.callbackClaimedBy).toBe(claimed.callbackClaimedBy);
    expect(afterStale.callbackDeliveredAt).toBeUndefined();
    expect(afterStale.callbackDeferredReason).not.toBe("stale defer");

    secondNotifier.deliver(secondNotifier.calls[0]!);
    const delivered = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
    expect(delivered.callbackDeliveredAt).toBeTypeOf("number");
    stale.delivery.delivered();
    const afterLate = JSON.parse(readFileSync(sidecarPath, "utf8")) as Record<string, unknown>;
    expect(afterLate.callbackDeliveredAt).toBe(delivered.callbackDeliveredAt);
  });

  it("recovers a callback when a watched running task leaves the running set on another host", async () => {
    const root = workspace("watched-transition");
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const ctx = createCtx(root, "watched-owner", "watched-branch");
    const launcherHarness = createHarness();
    const launcher = createObservedWaitHost(launcherHarness.pi, { ...options, notifyParent: () => {} });
    launcher.start(ctx);
    const launch = await launcher.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 500)"), shell: false, callback: true },
      ctx,
    });
    launcher.close();

    // The active host watches the operation while it is running.
    const watcherHarness = createHarness();
    const notifier = deferredNotifier();
    const watcher = createObservedWaitHost(watcherHarness.pi, { ...options, notifyParent: notifier.notify });
    cleanups.push(() => watcher.close());
    watcher.start(ctx);
    await watcher.reconcileNow();

    // A different host with no session identity records the terminal revision.
    const recorderHarness = createHarness();
    const recorder = createObservedWaitHost(recorderHarness.pi, { ...options, notifyParent: () => {} });
    cleanups.push(() => recorder.close());
    const anonymous = {
      cwd: root,
      sessionManager: { getSessionId: () => undefined, getBranch: () => [] },
      isIdle: () => true,
    } as unknown as ExtensionContext;
    recorder.start(anonymous);
    await until(recorder, () => (recorder as unknown as {
      operationForTask(id: string): { terminalRevision: number } | undefined;
    }).operationForTask(launch.id)?.terminalRevision === 1);
    await recorder.reconcileNow();
    expect(notifier.calls).toHaveLength(0);

    // The active watcher sees the task leave the running set and recovers the
    // callback from the durable sidecar, then hands it off once.
    await until(watcher, () => notifier.calls.length === 1);
    notifier.deliver(notifier.calls[0]!);
    await watcher.reconcileNow();
    expect(notifier.calls).toHaveLength(1);
  });

  it("keeps a callback pending while the active context has no session identity, then delivers", async () => {
    const root = workspace("anonymous-context");
    const notifier = deferredNotifier();
    const harness = createHarness();
    const options = {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
    };
    const ctx = createCtx(root, "anonymous-owner", "anonymous-branch");
    const first = createObservedWaitHost(harness.pi, { ...options, notifyParent: notifier.notify });
    first.start(ctx);
    const launch = await first.launchParent({
      kind: "process",
      params: { argv: nodeCommand('setTimeout(() => { console.log("anonymous"); }, 300)'), shell: false, callback: true },
      ctx,
    });
    first.close();

    const anonymous = {
      cwd: root,
      sessionManager: {
        getSessionId: () => undefined,
        getBranch: () => [],
      },
      isIdle: () => true,
    } as unknown as ExtensionContext;
    const host = createObservedWaitHost(harness.pi, { ...options, notifyParent: notifier.notify });
    cleanups.push(() => host.close());
    host.start(anonymous);
    await until(host, () => (host as unknown as {
      operationForTask(id: string): { terminalRevision: number } | undefined;
    }).operationForTask(launch.id)?.terminalRevision === 1);
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(0); // unknown identity must never authorize

    host.start(ctx); // the live real session identity arrives
    await until(host, () => notifier.calls.length === 1);
    notifier.deliver(notifier.calls[0]!);
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(1);
  });

  it("retries a pending terminal callback when the live branch settles after activation", async () => {
    const root = workspace("live-branch");
    const notifier = deferredNotifier();
    const harness = createHarness();
    const host = createObservedWaitHost(harness.pi, {
      storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"),
      pollMs: 0,
      notifyParent: notifier.notify,
    });
    cleanups.push(() => host.close());
    const anchorIds = ["anchor-live"];
    const ctxAnchor = createMutableBranchCtx(root, "live-branch-owner", anchorIds);
    host.start(ctxAnchor);
    const launch = await host.launchParent({
      kind: "process",
      params: { argv: nodeCommand("setTimeout(() => {}, 30000)"), shell: false, callback: true },
      ctx: ctxAnchor,
    });

    // Reload/activation settles before the SDK's in-memory branch history is
    // available. The task then reaches terminal while the live branch is empty.
    const liveIds: string[] = [];
    const ctxLive = createMutableBranchCtx(root, "live-branch-owner", liveIds);
    host.start(ctxLive);
    await host.stopForParent(ctxLive, launch.id);
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(0);

    // An abandoned fork never becomes eligible, even across retries.
    liveIds.push("other-fork");
    await host.reconcileNow();
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(0);

    // The same live context later exposes the recorded anchor; no session_tree,
    // reload or replacement start occurs. The reconcile retry delivers once.
    liveIds.splice(0, liveIds.length, "anchor-live");
    await host.reconcileNow();
    expect(notifier.calls).toHaveLength(1);
    await host.reconcileNow();
    await host.reconcileNow();
    expect(notifier.calls, "a claimed callback is not offered twice").toHaveLength(1);
    notifier.deliver(notifier.calls[0]!);
    await host.reconcileNow();
    expect(notifier.calls, "the actual handoff removes the pending id").toHaveLength(1);
  });

  it("resolves worker cwd against the worker workspace, not the parent cwd", async () => {
    let sibling: { getWorkerOperationService(pi: unknown): {
      launchForWorker(run: Record<string, unknown>, input: Record<string, unknown>): Promise<{ id: string }>;
      statusForWorker(run: Record<string, unknown>, taskId: string): { phase: string };
    } | undefined };
    try {
      sibling = await import(/* @vite-ignore */ new URL("../../pi-better-subagents/worker-waits.ts", import.meta.url).href);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return;
      throw error;
    }
    const parentRoot = workspace("cwd-parent");
    const workerRoot = workspace("cwd-worker");
    mkdirSync(join(workerRoot, "sub"), { recursive: true });
    const harness = createHarness();
    const { host } = startHost({ root: parentRoot, harness });
    host.start(createCtx(parentRoot, "cwd-parent-session", "cwd-branch"));
    const service = sibling.getWorkerOperationService(harness.pi)!;
    const run = {
      runId: "cwd-run",
      conversationId: "cwd-conversation",
      workspace: workerRoot,
      authorityReference: "cwd-ref",
      branchId: null,
      goalId: null,
    };
    const script = 'require("node:fs").writeFileSync("where.txt", process.cwd())';
    const omitted = await service.launchForWorker(run, {
      kind: "process",
      params: { argv: nodeCommand(script), shell: false, callback: false },
      policy: null,
    });
    await until(host, () => service.statusForWorker(run, omitted.id).phase === "terminal");
    expect(readFileSync(join(workerRoot, "where.txt"), "utf8")).toBe(realpathSync.native(workerRoot));
    expect(existsSync(join(parentRoot, "where.txt"))).toBe(false);

    const relative = await service.launchForWorker(run, {
      kind: "process",
      params: { cwd: "sub", argv: nodeCommand(script), shell: false, callback: false },
      policy: null,
    });
    await until(host, () => service.statusForWorker(run, relative.id).phase === "terminal");
    expect(readFileSync(join(workerRoot, "sub", "where.txt"), "utf8")).toBe(realpathSync.native(join(workerRoot, "sub")));

    await expect(service.launchForWorker(run, {
      kind: "process",
      params: { cwd: "../cwd-parent", argv: nodeCommand(script), shell: false, callback: false },
      policy: null,
    })).rejects.toThrow(/outside the registered workspace/);
  });
});
