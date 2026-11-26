import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
// @ts-expect-error Generated Background supervisor module.
import { createLocalSupervisor, supervisorTaskIdForToken } from "../src/runtime/domain/background-service/supervisor/index.domain.mjs";
// @ts-expect-error Generated Background supervisor module.
import { writeLostRecord, writeStopRequest } from "../src/runtime/domain/background-service/supervisor/store.domain.mjs";
// @ts-expect-error Generated Background supervisor module.
import { processGroupAlive, processGroupExitVerified } from "../src/runtime/domain/background-service/supervisor/identity.domain.mjs";
// @ts-expect-error Generated Background supervisor module.
import { DEFAULT_STOP_WAIT_MS, SUPERVISOR_GROUP_CLEANUP_DEADLINE_MS, SUPERVISOR_TERMINATION_GRACE_MS } from "../src/runtime/domain/background-service/supervisor/types.domain.mjs";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";
import { startDaemon } from "../src/server.ts";
import { ENTITY_BUDGET } from "../src/runtime/work-budget.ts";
import { makeEnv, waitFor } from "./helpers.ts";
import { RuntimeResultSupervision } from "../src/runtime/result-supervision.ts";

test("Windows PID and legacy group-empty records cannot verify a process tree", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    assert.equal(processGroupExitVerified(process.pid), false);
    assert.equal(processGroupExitVerified(process.pid, true), false);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

for (const scenario of ["fresh", "stop-requested", "lost"] as const) test(`restarted supervision cleans up exact assignment work (${scenario})`, { timeout: 30000, skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "assignment-cleanup-"));
  const directory = join(root, "supervisor");
  const supervisor = createLocalSupervisor({ directory });
  const lease = acquireMutationStore(root);
  const owner = { kind: "worker-conversation", sessionId: "shared-conversation", workspace: root };
  const recipient = { kind: "parent-session", sessionId: "parent", workspace: root };
  const tasks = ["ending", "independent"].map(id => ({ id, token: `token-${id}`, taskId: supervisorTaskIdForToken(`token-${id}`) }));
  let host: RuntimeResultSupervision | undefined;
  let pausedRunner: number | undefined;
  try {
    for (const { id, token, taskId } of tasks) {
      lease.store.registerAssignment({ assignmentId: id, attemptId: `attempt-${id}`, owner, recipient });
      lease.store.registerOperation({ operationId: id, taskId, launchToken: token, owner, assignmentAttemptId: `attempt-${id}`,
        observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "original" }, authorityRef: "test" });
      lease.store.handoffResultSupervision({ operationId: id, expectedHostId: "original", directory,
        hostId: "server:previous", epoch: "previous",
        capability: { adapter: "background-results-v1", captured: { authorized: true }, current: { authorized: true } } });
      await supervisor.start({ operationId: id, token, cwd: root, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
    }
    assert.deepEqual(lease.store.listAssignmentCleanupOperations(10), []);
    const target = tasks[0]!;
    const deadline = Date.now() + 8000;
    let running = supervisor.inspect(target.taskId);
    while (!running?.command?.alive && Date.now() < deadline) {
      await delay(25);
      running = supervisor.inspect(target.taskId);
    }
    assert.ok(running?.command?.alive && running.claim?.alive);
    const pgid = running.command.pgid ?? running.command.pid;
    if (scenario === "lost") {
      process.kill(running.claim.pid, "SIGKILL");
      writeLostRecord(directory, { version: 1, taskId: target.taskId, token: target.token, status: "lost",
        reason: "Runner exited before publishing", recordedAt: Date.now(), command: running.command });
    } else if (scenario === "stop-requested") {
      process.kill(running.claim.pid, "SIGSTOP");
      pausedRunner = running.claim.pid;
      writeStopRequest(directory, { version: 1, taskId: target.taskId, token: target.token,
        requestedAt: Date.now(), reason: "Stop accepted before restart" });
    }
    lease.store.recordAssignmentOutcome({ assignmentId: "ending", revision: 1, owner, recipient, outcome: "succeeded",
      reason: "Done", processUncertain: false, evidence: [], waits: [] });
    host = new RuntimeResultSupervision(root, "replacement");
    if (scenario === "lost") {
      // The first pass adopted the old grant. Wrap the cleanup cursor and start the stop.
      host.reconcile();
      host.reconcile();
      assert.equal(host.busy, true);
      assert.equal(lease.store.getOperation("ending").terminalOutcome, "lost");
      const closed = host.close();
      assert.equal(host.close(), closed);
      await closed;
      assert.equal(host.busy, false);
      assert.equal(processGroupAlive(pgid), false);
      host = new RuntimeResultSupervision(root, "after-drain");
    }
    if (pausedRunner !== undefined) {
      const stopDeadline = Date.now() + DEFAULT_STOP_WAIT_MS + SUPERVISOR_TERMINATION_GRACE_MS + SUPERVISOR_GROUP_CLEANUP_DEADLINE_MS + 4000;
      while (!supervisor.snapshot(target.taskId)?.cleanup && Date.now() < stopDeadline) await delay(25);
      assert.ok(supervisor.snapshot(target.taskId)?.cleanup?.signals.includes("SIGTERM"), host.reason);
      process.kill(pausedRunner, "SIGCONT");
      pausedRunner = undefined;
    }
    const settlementDeadline = Date.now() + 5000;
    while (lease.store.listAssignmentCleanupOperations(10).length && Date.now() < settlementDeadline) await delay(25);
    assert.equal(lease.store.getOperation("ending").terminalOutcome, scenario === "lost" ? "lost" : "cancelled", host.reason);
    assert.equal(processGroupAlive(pgid), false);
    assert.equal(supervisor.inspect(tasks[1]!.taskId)?.terminal, false);
    assert.equal(lease.store.getOperation("independent").terminalRevision, 0);
    assert.deepEqual(lease.store.listAssignmentCleanupOperations(10), []);
  } finally {
    await host?.close();
    if (pausedRunner !== undefined) {
      try { process.kill(pausedRunner, "SIGCONT"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    for (const { taskId, token } of tasks) await supervisor.stop(taskId, { token }).catch(() => undefined);
    lease.release();
    rmSync(root, { recursive: true, force: true });
  }
});

test("idle shutdown drains queued lost groups and leaves unverifiable and foreign tasks recoverable", { timeout: 30000, skip: process.platform === "win32" }, async () => {
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  let now = 1000;
  const daemon = await startDaemon({ serverDir: env.serverDir, runtimeIdleMs: 60000, startupGraceMs: 0, now: () => now });
  const lease = acquireMutationStore(env.agentDir);
  const directory = join(env.root, "supervisor");
  const supervisor = createLocalSupervisor({ directory });
  const owner = { kind: "worker-conversation", workspace: env.cwd, sessionId: "worker" };
  const recipient = { kind: "parent-session", workspace: env.cwd, sessionId: "parent" };
  const groups = new Map<string, number>();
  const launched: string[] = [];
  const unverified = Array.from({ length: ENTITY_BUDGET }, (_, i) => `z-missing-${i.toString().padStart(2, "0")}`);
  try {
    lease.store.registerAssignment({ assignmentId: "ending", attemptId: "attempt", owner, recipient });
    lease.store.registerAssignment({ assignmentId: "unverified", attemptId: "other-attempt", owner, recipient });
    for (const id of [...unverified, "b-first-group", "c-second-group", "foreign"]) {
      const taskId = supervisorTaskIdForToken(id);
      lease.store.registerOperation({ operationId: id, taskId, launchToken: id, owner, assignmentAttemptId: id.startsWith("z-") ? "other-attempt" : "attempt",
        observer: { kind: "local-supervisor", version: "1" }, supervision: { hostId: "frontend" } });
      if (id !== "foreign") lease.store.handoffResultSupervision({ operationId: id, expectedHostId: "frontend", directory,
        hostId: "server:previous", epoch: "previous", capability: { adapter: "background-results-v1", captured: true, current: true } });
      if (id.endsWith("-group")) {
        launched.push(id);
        await supervisor.start({ operationId: id, token: id, cwd: env.cwd, argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
        const running = await waitFor("live command", () => {
          const state = supervisor.inspect(taskId);
          return state?.command?.alive && state.claim?.alive && state;
        });
        groups.set(id, running.command.pgid ?? running.command.pid);
        process.kill(running.claim.pid, "SIGKILL");
        writeLostRecord(directory, { version: 1, taskId, token: id, status: "lost",
          reason: "Runner died with a live command", recordedAt: Date.now(), command: running.command });
      }
      lease.store.recordTerminalOutcome({ operationId: id, eventId: id, owner, outcome: "lost", reason: "Lost runner" });
    }
    const decision = { revision: 1, owner, recipient, outcome: "cancelled", reason: "Ended", processUncertain: true, evidence: [], waits: [] };
    lease.store.recordAssignmentOutcome({ ...decision, assignmentId: "unverified" });
    assert.equal(lease.store.resultSupervisions(true).length, 0);
    now += 60000;
    await daemon.sweepIdle();
    assert.equal(existsSync(daemon.socketPath), true, "a full unverified page yields before the idle decision");
    const revision = lease.store.serverAssignmentCleanupRevision();
    // Both lost groups enter the queue before the saved idle cursor.
    lease.store.recordAssignmentOutcome({ ...decision, assignmentId: "ending" });
    assert.ok(lease.store.serverAssignmentCleanupRevision() > revision);
    await daemon.sweepIdle();
    assert.equal(existsSync(daemon.socketPath), true, "terminal operations with actionable cleanup keep the daemon alive");
    await waitFor("both lost groups to exit before idle shutdown", async () => {
      await daemon.sweepIdle();
      return !existsSync(daemon.socketPath);
    });
    for (const pgid of groups.values()) assert.equal(processGroupAlive(pgid), false);
    assert.deepEqual(lease.store.listAssignmentCleanupOperations(256).map((op: any) => op.operationId), ["foreign", ...unverified]);
  } finally {
    await daemon.stop();
    for (const id of launched) await supervisor.stop(supervisorTaskIdForToken(id), { token: id });
    lease.release();
  }
});
