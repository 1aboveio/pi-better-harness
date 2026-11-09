/**
 * Shared coordinator: real SQLite, real supervisor, owner-scoped hints.
 *
 * The multiprocess acceptance lives in `coordinator.multiprocess.test.ts`; this
 * file exercises the same protocol in-process for fast failure localization and
 * measures that the running-set scan is central rather than per client.
 */
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { CoordinatorClient } from "./client.js";
import { CoordinatorServer } from "./server.js";
import { coordinatorIdentityKey, coordinatorPaths } from "./paths.js";
import { createLocalSupervisor, supervisorRunnerEntry, supervisorTaskIdForToken } from "../supervisor/index.js";
import type { CoordinatorChange, OwnerIdentity } from "../shared-operation-coordinator/index.js";
import type { SupervisorTaskStatus } from "../supervisor/types.js";

const cleanups: Array<() => void | Promise<void>> = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
});

function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pi-coordinator-${name}-`));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  // Yield while Windows releases socket/watch handles closed by earlier cleanups.
  cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function owner(sessionId: string, workspacePath: string): OwnerIdentity {
  return {
    kind: "parent-session",
    sessionId,
    workspace: workspacePath,
    branchId: "branch",
    goalId: null,
  };
}

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("coordinator test timed out");
}

function startClient(root: string, rootStore: string, supervisorDirectory: string, sessionId: string): {
  client: CoordinatorClient;
  changes: CoordinatorChange[];
} {
  const changes: CoordinatorChange[] = [];
  const client = new CoordinatorClient({
    storePath: rootStore,
    supervisorDirectory,
    stateDirectory: coordinatorPaths(rootStore, supervisorDirectory).stateDirectory,
    spawnServer: false,
  });
  client.onChange((change) => changes.push(change));
  cleanups.push(() => client.close());
  return { client, changes };
}

describe("shared coordinator process", () => {
  it("does not turn a missing supervisor root into evidence that an unknown task is dead", async () => {
    const root = workspace("missing-root-unknown");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), safetyIntervalMs: 60_000, now: () => Date.now() + 60_000 };
    const server = (await CoordinatorServer.start(options)).server!;
    cleanups.push(() => server.close());
    await rm(options.supervisorDirectory, { recursive: true });
    server.storeHandle.registerOperation({ operationId: "op_missing_root", taskId: supervisorTaskIdForToken("missing_root_unknown"), launchToken: "missing_root_unknown", owner: owner("unknown", root), observer: { kind: "local-supervisor", version: "1" } });
    for (let scan = 0; scan < 3; scan++) await server.reconcileOnce();
    expect(server.storeHandle.getOperation("op_missing_root")?.phase).toBe("running");
    expect(server.storeHandle.getOperation("op_missing_root")?.terminalOutcome).toBe(null);
    expect(existsSync(options.supervisorDirectory)).toBe(false);
  });

  it("does not recreate removed supervisor roots during scans or hints and resumes watching a legitimate launch", async () => {
    const root = workspace("removed-root");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), safetyIntervalMs: 60_000 };
    const server = (await CoordinatorServer.start(options)).server!;
    cleanups.push(() => server.close());
    const taskRoot = join(options.supervisorDirectory, "tasks");
    expect(existsSync(taskRoot)).toBe(true);
    for (const path of [taskRoot, options.supervisorDirectory]) {
      await rm(path, { recursive: true });
      for (let scan = 0; scan < 3; scan++) {
        await server.reconcileOnce();
        expect(existsSync(path)).toBe(false);
      }
      const scans = server.currentStats.runningScans;
      const taskOwner = owner("hint-owner", root);
      const suffix = path === taskRoot ? "tasks" : "supervisor";
      server.storeHandle.registerOperation({ operationId: `op_removed_${suffix}`, taskId: `task_removed_${suffix}`, launchToken: `removed_${suffix}`, owner: taskOwner, observer: { kind: "test", version: "1" } });
      server.storeHandle.recordTerminalOutcome({ operationId: `op_removed_${suffix}`, eventId: `removed_terminal_${suffix}`, outcome: "succeeded", reason: "disposable fixture", owner: taskOwner });
      await until(() => server.currentStats.runningScans > scans, 3_000);
      expect(existsSync(path)).toBe(false);
    }
    const taskOwner = owner("launch-owner", root);
    const client = new CoordinatorClient({ ...options, spawnServer: false });
    cleanups.push(() => client.close());
    const changes: CoordinatorChange[] = [];
    client.onChange((change) => changes.push(change));
    await client.start([taskOwner]);
    const token = `removed_root_${Date.now()}`;
    const taskId = supervisorTaskIdForToken(token);
    server.storeHandle.registerOperation({ operationId: "op_removed_launch", taskId, launchToken: token, owner: taskOwner, observer: { kind: "local-supervisor", version: "1" } });
    const supervisor = createLocalSupervisor({ directory: options.supervisorDirectory, runnerPath: supervisorRunnerEntry() });
    await supervisor.start({ token, argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"], cwd: root, kind: "process" });
    await until(() => changes.some((change) => change.operationId === "op_removed_launch" && change.kind === "terminal"), 5_000);
    expect(existsSync(taskRoot)).toBe(true);
    expect(server.storeHandle.getOperation("op_removed_launch")?.terminalOutcome).toBe("succeeded");
  }, 15_000);

  it.each(Array.from({ length: 30 }, (_, index) => index))("coalesces operation WAL hints into a central owner-scoped update without waiting for safety recovery (startup %i)", async () => {
    const root = workspace("wal-input");
    const trace: string[] = [];
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), safetyIntervalMs: 60_000, logger: (line: string) => trace.push(line) };
    const server = (await CoordinatorServer.start(options)).server!;
    cleanups.push(() => server.close());
    const a = owner("a", root), b = owner("b", root);
    const clientA = new CoordinatorClient({ ...options, spawnServer: false });
    const clientB = new CoordinatorClient({ ...options, spawnServer: false });
    cleanups.push(() => clientA.close(), () => clientB.close());
    const changesA: CoordinatorChange[] = [], changesB: CoordinatorChange[] = [];
    clientA.onChange((change) => changesA.push(change));
    clientB.onChange((change) => changesB.push(change));
    await clientA.start([a]);
    await clientB.start([b]);
    expect(trace).toContain(`input watch ready: ${options.storePath}-wal`);
    const before = server.currentStats.runningScans;
    for (let index = 0; index < 20; index++) {
      const operationId = `op_wal_${index}`;
      server.storeHandle.registerOperation({ operationId, taskId: `task_wal_${index}`, launchToken: `wal_${index}`, owner: a, observer: { kind: "test", version: "1" } });
      server.storeHandle.recordTerminalOutcome({ operationId, eventId: `terminal_wal_${index}`, outcome: "succeeded", reason: "disposable fixture", owner: a });
    }
    await until(() => changesA.filter((change) => change.kind === "terminal").length === 20, 3_000).catch((error) => {
      console.error("WAL input failure", JSON.stringify({ stats: server.currentStats, watches: server.activeWatchCount,
        durableSeq: server.storeHandle.latestChangeSeq(), received: changesA, trace }));
      throw error;
    });
    expect(changesB).toHaveLength(0);
    expect(server.currentStats.runningScans - before).toBe(1);
  });

  it.skipIf(process.platform === "win32")("keeps identity stable through missing parents and refuses a symlink state directory", async () => {
    const root = workspace("identity");
    const actual = join(root, "actual"), alias = join(root, "alias");
    mkdirSync(actual);
    symlinkSync(actual, alias);
    const before = coordinatorIdentityKey(join(alias, "nested", "store.sqlite"), join(alias, "nested", "supervisor"));
    mkdirSync(join(actual, "nested", "supervisor"), { recursive: true });
    expect(coordinatorIdentityKey(join(actual, "nested", "store.sqlite"), join(actual, "nested", "supervisor"))).toBe(before);
    await expect(CoordinatorServer.start({ storePath: join(root, "store.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: alias })).rejects.toThrow("unsafe coordinator path");
  });

  it("does not infer that malformed legacy leadership is dead", async () => {
    const root = workspace("unknown-leader");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state") };
    mkdirSync(options.stateDirectory, { mode: 0o700 });
    writeFileSync(join(options.stateDirectory, "leader.lock"), "");
    expect((await CoordinatorServer.start(options)).leader).toBe(false);
  });

  it("replays more than 500 hints and the history of a newly added owner", async () => {
    const root = workspace("pages");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const options = { storePath, supervisorDirectory, stateDirectory: join(root, "state"), safetyIntervalMs: 60_000 };
    const server = (await CoordinatorServer.start(options)).server!;
    cleanups.push(() => server.close());
    const a = owner("a", root), b = owner("b", root);
    const seedStartedAt = Date.now();
    for (let index = 0; index < 601; index++) {
      server.storeHandle.registerOperation({ operationId: `op_page_${index}`, taskId: `task_page_${index}`,
        launchToken: `page_${index}`, owner: index === 0 ? b : a, observer: { kind: "test", version: "1" } });
      server.storeHandle.recordTerminalOutcome({ operationId: `op_page_${index}`, eventId: `terminal_${index}`, outcome: "succeeded", reason: "disposable fixture", owner: index === 0 ? b : a });
    }
    const seedMs = Date.now() - seedStartedAt;
    const client = new CoordinatorClient({ ...options, spawnServer: false });
    cleanups.push(() => client.close());
    const hints: CoordinatorChange[] = [];
    client.onCatchup((changes) => hints.push(...changes));
    const replayStartedAt = Date.now();
    await client.start([a]);
    const replayMs = Date.now() - replayStartedAt;
    expect(replayMs).toBeLessThan(5_000);
    expect(new Set(hints.map((hint) => hint.operationId)).size).toBe(600);
    const ownerStartedAt = Date.now();
    await client.updateOwners([a, b]);
    const ownerMs = Date.now() - ownerStartedAt;
    expect(ownerMs).toBeLessThan(5_000);
    expect(hints.some((hint) => hint.operationId === "op_page_0")).toBe(true);
    console.info("675 history fixture timings", JSON.stringify({ seedMs, replayMs, ownerMs }));
  }, 30_000);

  it.each([0, 1])("resets a pruned cursor to individual owner-scoped hints with %i journal entries retained", async (keepLatest) => {
    const root = workspace("trim");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state") };
    const server = (await CoordinatorServer.start(options)).server!;
    cleanups.push(() => server.close());
    const a = owner("a", root);
    for (let index = 0; index < 4; index++) {
      server.storeHandle.registerOperation({
      operationId: `op_trim_${index}`, taskId: `task_trim_${index}`, launchToken: `trim_${index}`,
      owner: a, observer: { kind: "test", version: "1" },
    });
      server.storeHandle.recordTerminalOutcome({ operationId: `op_trim_${index}`, eventId: `trim_terminal_${index}`, outcome: "succeeded", reason: "disposable fixture", owner: a });
    }
    server.storeHandle.pruneChangesBefore(Date.now() + 1, keepLatest);
    const client = new CoordinatorClient({ ...options, spawnServer: false });
    cleanups.push(() => client.close());
    const hints: CoordinatorChange[] = [];
    client.onCatchup((changes) => hints.push(...changes));
    await client.start([a]);
    expect(new Set(hints.map((hint) => hint.operationId)).size).toBe(4);
  });

  it("rejects bounded unavailability and cancels recovery on close", async () => {
    const root = workspace("unavailable");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), spawnServer: false };
    const client = new CoordinatorClient(options);
    cleanups.push(() => client.close());
    await expect(client.start([])).rejects.toThrow("unavailable after 8 attempts");
    expect(client.unavailable).toContain("unavailable");
    const closing = client.start([]);
    client.close();
    await expect(closing).rejects.toThrow("closed");
    expect(client.connected).toBe(false);
  }, 15_000);

  it("reports a missing entry without repeatedly spawning", async () => {
    const root = workspace("missing-entry");
    const logs: string[] = [];
    const client = new CoordinatorClient({ storePath: join(root, "operations.sqlite"),
      supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"),
      entryPath: join(root, "missing.mjs"), onLog: (line) => logs.push(line) });
    cleanups.push(() => client.close());
    await expect(client.start([])).rejects.toThrow("unavailable after 8 attempts");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("executable is missing");
  }, 15_000);

  it("rejects an incompatible peer and exposes unavailability", async () => {
    const root = workspace("incompatible");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), spawnServer: false };
    const paths = coordinatorPaths(options.storePath, options.supervisorDirectory);
    mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 });
    const peer = createServer((socket) => socket.write(JSON.stringify({ type: "hello", version: -1 }) + "\n"));
    cleanups.push(() => { peer.close(); });
    await new Promise<void>((resolve) => peer.listen(paths.socket, resolve));
    const client = new CoordinatorClient(options);
    cleanups.push(() => client.close());
    await expect(client.start([])).rejects.toThrow("disconnected");
    expect(client.unavailable).toContain("incompatible");
  });

  it("uses filesystem hints to deliver real terminal evidence with a 60s safety interval and closes its watches", async () => {
    const root = workspace("scoped");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const started = await CoordinatorServer.start({
      storePath,
      supervisorDirectory,
      stateDirectory: coordinatorPaths(storePath, supervisorDirectory).stateDirectory,
      safetyIntervalMs: 60_000,
      maintenanceIntervalMs: 60_000,
    });
    expect(started.leader).toBe(true);
    const server = started.server!;
    cleanups.push(() => server.close());

    const ownerA = owner("session-a", root);
    const ownerB = owner("session-b", root);
    const a = startClient(root, storePath, supervisorDirectory, ownerA.sessionId);
    const b = startClient(root, storePath, supervisorDirectory, ownerB.sessionId);
    await a.client.start([ownerA]);
    await b.client.start([ownerB]);

    const token = `coordinator_${Date.now()}_${Math.random()}`;
    const taskId = supervisorTaskIdForToken(token);
    const operationId = `op_${token}`;
    server.storeHandle.registerOperation({
      operationId,
      taskId,
      launchToken: token,
      owner: ownerA,
      observer: { kind: "local-supervisor", version: "1" },
      supervision: { hostId: "test" },
    });
    const supervisor = createLocalSupervisor({ directory: supervisorDirectory, runnerPath: supervisorRunnerEntry() });
    const startedAt = Date.now();
    await supervisor.start({
      token,
      argv: [process.execPath, "-e", "setTimeout(() => process.exit(0), 250)"],
      cwd: root,
      kind: "process",
    });

    await until(() => a.changes.some((change) => change.operationId === operationId && change.kind === "terminal"), 5_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(b.changes.some((change) => change.operationId === operationId)).toBe(false);
    const terminal = a.changes.find((change) => change.operationId === operationId && change.kind === "terminal")!;
    expect(terminal.owner.sessionId).toBe(ownerA.sessionId);
    expect(server.storeHandle.getOperation(operationId)?.terminalRevision).toBe(1);
    expect(server.storeHandle.getOperation(operationId)?.terminalOutcome).toBe("succeeded");
    expect(server.activeWatchCount).toBeGreaterThanOrEqual(2);
    const scansAtClose = server.currentStats.runningScans;
    server.close();
    expect(server.activeWatchCount).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(server.currentStats.runningScans).toBe(scansAtClose);
  }, 30_000);

  it("keeps one central scan per interval with many idle clients", async () => {
    const root = workspace("idle");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const started = await CoordinatorServer.start({
      storePath,
      supervisorDirectory,
      stateDirectory: coordinatorPaths(storePath, supervisorDirectory).stateDirectory,
      safetyIntervalMs: 100,
      maintenanceIntervalMs: 60_000,
    });
    const server = started.server!;
    cleanups.push(() => server.close());
    const clients: CoordinatorClient[] = [];
    for (let index = 0; index < 17; index += 1) {
      const client = new CoordinatorClient({
        storePath,
        supervisorDirectory,
        stateDirectory: coordinatorPaths(storePath, supervisorDirectory).stateDirectory,
        spawnServer: false,
      });
      await client.start([owner(`idle-${index}`, root)]);
      clients.push(client);
      cleanups.push(() => client.close());
    }
    const before = (await clients[0]!.stats()).runningScans;
    await new Promise((resolve) => setTimeout(resolve, 550));
    const after = (await clients[0]!.stats()).runningScans;
    expect(after - before).toBeGreaterThanOrEqual(2);
    // 17 clients did not each scan: one central interval-driven scan remains.
    expect(after - before).toBeLessThanOrEqual(12);
    expect((await clients[0]!.stats()).connectedClients).toBe(17);
  }, 30_000);

  it("recovers a terminal task after a client disconnects and reconnects", async () => {
    const root = workspace("reconnect");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const started = await CoordinatorServer.start({
      storePath,
      supervisorDirectory,
      stateDirectory: coordinatorPaths(storePath, supervisorDirectory).stateDirectory,
      safetyIntervalMs: 100,
      maintenanceIntervalMs: 60_000,
    });
    const server = started.server!;
    cleanups.push(() => server.close());
    const ownerA = owner("reconnect-a", root);
    const first = startClient(root, storePath, supervisorDirectory, ownerA.sessionId);
    await first.client.start([ownerA]);
    first.client.close();

    const token = `coordinator_reconnect_${Date.now()}_${Math.random()}`;
    const taskId = supervisorTaskIdForToken(token);
    const operationId = `op_${token}`;
    server.storeHandle.registerOperation({
      operationId,
      taskId,
      launchToken: token,
      owner: ownerA,
      observer: { kind: "local-supervisor", version: "1" },
    });
    const supervisor = createLocalSupervisor({ directory: supervisorDirectory, runnerPath: supervisorRunnerEntry() });
    await supervisor.start({ token, argv: [process.execPath, "-e", "process.exit(0)"], cwd: root, kind: "process" });
    await until(() => server.storeHandle.getOperation(operationId)?.terminalRevision === 1);

    const second = startClient(root, storePath, supervisorDirectory, ownerA.sessionId);
    const catchup: CoordinatorChange[] = [];
    second.client.onCatchup((changes) => catchup.push(...changes));
    await second.client.start([ownerA]);
    await until(() => second.changes.length + catchup.length > 0);
    expect([...second.changes, ...catchup].some((change) => change.operationId === operationId)).toBe(true);
  }, 30_000);

  it("serializes concurrent leaders with verified process identity", async () => {
    const root = workspace("leaders");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const options = {
      storePath,
      supervisorDirectory,
      stateDirectory: coordinatorPaths(storePath, supervisorDirectory).stateDirectory,
      safetyIntervalMs: 5_000,
      maintenanceIntervalMs: 60_000,
    };
    const [first, second] = await Promise.all([
      CoordinatorServer.start(options),
      CoordinatorServer.start(options),
    ]);
    const leaders = [first, second].filter((entry) => entry.leader);
    expect(leaders).toHaveLength(1);
    expect((await CoordinatorServer.start({ ...options, stateDirectory: join(root, "other-state") })).leader).toBe(false);
    cleanups.push(() => first.server?.close());
    cleanups.push(() => second.server?.close());
  }, 30_000);

  it("reports task status without treating age alone as a dead runner", async () => {
    const root = workspace("liveness");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const started = await CoordinatorServer.start({
      storePath,
      supervisorDirectory,
      stateDirectory: coordinatorPaths(storePath, supervisorDirectory).stateDirectory,
      safetyIntervalMs: 100,
      maintenanceIntervalMs: 60_000,
    });
    const server = started.server!;
    cleanups.push(() => server.close());
    const token = `coordinator_live_${Date.now()}_${Math.random()}`;
    const taskId = supervisorTaskIdForToken(token);
    const operationId = `op_${token}`;
    const ownerA = owner("live-a", root);
    server.storeHandle.registerOperation({
      operationId,
      taskId,
      launchToken: token,
      owner: ownerA,
      observer: { kind: "local-supervisor", version: "1" },
    });
    const supervisor = createLocalSupervisor({ directory: supervisorDirectory, runnerPath: supervisorRunnerEntry() });
    await supervisor.start({
      token,
      argv: [process.execPath, "-e", "setTimeout(() => {}, 1500)"],
      cwd: root,
      kind: "process",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const inspection = supervisor.snapshot(taskId);
    expect(inspection?.terminal).toBe(false);
    expect(["running", "starting"] as SupervisorTaskStatus[]).toContain(inspection?.status);
    expect(server.storeHandle.getOperation(operationId)?.phase).toBe("running");
    await supervisor.stop(taskId);
  }, 30_000);
});
