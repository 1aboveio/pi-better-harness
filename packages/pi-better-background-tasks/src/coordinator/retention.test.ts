/**
 * Disposable retention fixtures: real filesystem artifacts, real SQLite, and
 * the legacy registry. No test touches a live user registry; each gets a private
 * temporary root, and the suite's global setup isolates TMPDIR per test file.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyTaskRetention,
  inspectSupervisorArtifact,
  previewTaskRetention,
  recoverTaskRetention,
  runScheduledTaskMaintenance,
} from "./retention.js";
import {
  openStore,
  type OwnerIdentity,
  type Store,
} from "../shared-operation-coordinator/index.js";
import { supervisorPaths, supervisorTaskIdForToken } from "../supervisor/index.js";
import { baseDir, logPathFor, readMeta, taskDir, writeMeta } from "../registry.js";
import type { BackgroundTaskMeta } from "../types.js";

const cleanups: Array<() => void | Promise<void>> = [];
const DAY = 24 * 60 * 60 * 1000;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pi-retention-${name}-`));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return root;
}

function owner(root: string, sessionId = "retention-owner"): OwnerIdentity {
  return { kind: "parent-session", sessionId, workspace: root, branchId: "branch", goalId: null };
}

interface DurableFixture {
  root: string;
  storePath: string;
  supervisorDirectory: string;
  store: Store;
  taskId: string;
  operationId: string;
  taskDir: string;
  sidecar: string;
}

function durableFixture(name: string, options: {
  callback?: boolean;
  delivered?: boolean;
  launchRecord?: boolean;
  symlink?: boolean;
} = {}): DurableFixture {
  const root = workspace(name);
  const storePath = join(root, "operations.sqlite");
  const supervisorDirectory = join(root, "supervisor");
  const store = openStore({ path: storePath });
  cleanups.push(() => store.close());
  const token = `retention_fixture_${name}_${Math.random()}`;
  const taskId = supervisorTaskIdForToken(token);
  const operationId = `op_${taskId}`;
  const taskDir = supervisorPaths(supervisorDirectory, taskId).dir;
  mkdirSync(join(taskDir), { recursive: true });
  if (options.launchRecord !== false) {
    writeFileSync(join(taskDir, "launch.json"), JSON.stringify({ version: 1, taskId, token, kind: "process" }));
  }
  writeFileSync(join(taskDir, "stdout.log"), "discarded fixture output\n");
  const sidecar = join(supervisorDirectory, "observed", `${taskId}.json`);
  mkdirSync(join(supervisorDirectory, "observed"), { recursive: true });
  writeFileSync(sidecar, JSON.stringify({
    kind: "process",
    callback: options.callback ?? false,
    ...(options.delivered ? { callbackDeliveredAt: Date.now() } : {}),
    cwd: root,
  }));
  store.registerOperation({
    operationId,
    taskId,
    launchToken: token,
    owner: owner(root),
    observer: { kind: "local-supervisor", version: "1" },
  });
  store.recordTerminalOutcome({
    operationId,
    eventId: `${taskId}:fixture:succeeded`,
    outcome: "succeeded",
    owner: owner(root),
    evidence: [{ kind: "terminal-record", ref: "result.json", summary: "status=succeeded exit=0" }],
  });
  return { root, storePath, supervisorDirectory, store, taskId, operationId, taskDir, sidecar };
}

function legacyFixture(name: string, options: {
  callback?: boolean;
  delivered?: boolean;
  old?: boolean;
} = {}): BackgroundTaskMeta {
  const id = `bg_retention_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  cleanups.push(() => rmSync(taskDir(id), { recursive: true, force: true }));
  const now = Date.now();
  const meta: BackgroundTaskMeta = {
    id,
    kind: "process",
    status: "succeeded",
    startedAt: now - (options.old === false ? DAY : 9 * DAY),
    endedAt: now - (options.old === false ? DAY : 8 * DAY),
    logPath: logPathFor(id),
    callback: options.callback ?? false,
    callbackOrigin: { cwd: workspace("legacy-origin"), sessionId: name },
    cwd: "/tmp",
    spawnPid: process.pid,
    ...(options.delivered ? { callbackSentAt: now - 8 * DAY } : {}),
  };
  writeMeta(meta);
  return meta;
}

describe("durable retention over real artifacts", () => {
  it("previews and applies one eligible terminal operation and its validated task directory", () => {
    const fixture = durableFixture("eligible");
    const cutoff = Date.now() + 1;
    const preview = previewTaskRetention({
      store: fixture.store,
      supervisorDirectory: fixture.supervisorDirectory,
      cutoff,
      limit: 10,
    });
    expect(preview.preview.candidates.map((entry) => entry.operationId)).toContain(fixture.operationId);
    expect(preview.artifactProtected).toEqual([]);
    expect(existsSync(fixture.taskDir)).toBe(true);

    const result = applyTaskRetention({
      store: fixture.store,
      supervisorDirectory: fixture.supervisorDirectory,
      cutoff,
      limit: 10,
    });
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.state).toBe("complete");
    expect(existsSync(fixture.taskDir)).toBe(false);
    expect(fixture.store.getOperation(fixture.operationId)).toBeNull();
    expect(fixture.store.retentionUnit(fixture.operationId)?.state).toBe("complete");
  });

  it("protects a running task, an undelivered callback, and a malformed artifact", () => {
    const running = durableFixture("running");
    // Re-registering a fresh running operation in the same store is enough; the
    // fixture's terminal one is not the subject.
    const token = `retention_running_${Math.random()}`;
    const runningTask = supervisorTaskIdForToken(token);
    const runningOperation = `op_${runningTask}`;
    running.store.registerOperation({
      operationId: runningOperation,
      taskId: runningTask,
      launchToken: token,
      owner: owner(running.root, "running-owner"),
      observer: { kind: "local-supervisor", version: "1" },
    });

    const undelivered = durableFixture("undelivered", { callback: true, delivered: false });
    const malformed = durableFixture("malformed", { launchRecord: false });

    const cutoff = Date.now() + 1;
    const preview = previewTaskRetention({
      store: running.store,
      supervisorDirectory: running.supervisorDirectory,
      cutoff,
      limit: 20,
    });
    const previewUndelivered = previewTaskRetention({
      store: undelivered.store,
      supervisorDirectory: undelivered.supervisorDirectory,
      cutoff,
      limit: 20,
    });
    const previewMalformed = previewTaskRetention({
      store: malformed.store,
      supervisorDirectory: malformed.supervisorDirectory,
      cutoff,
      limit: 20,
    });

    expect(preview.preview.protected.find((entry) => entry.operationId === runningOperation)?.reasons).toContain("nonterminal");
    expect(previewUndelivered.artifactProtected[0]?.reason).toBe("undelivered-standalone-callback");
    expect(previewMalformed.artifactProtected[0]?.reason).toBe("supervisor-launch-record-missing-or-malformed");

    for (const [fixture, reason] of [
      [undelivered, "undelivered-standalone-callback"],
      [malformed, "supervisor-launch-record-missing-or-malformed"],
    ] as const) {
      const result = applyTaskRetention({
        store: fixture.store,
        supervisorDirectory: fixture.supervisorDirectory,
        cutoff,
        limit: 20,
      });
      expect(result.units).toHaveLength(0);
      expect(result.preview.candidates.map((entry) => entry.operationId)).toContain(fixture.operationId);
      expect(existsSync(fixture.taskDir)).toBe(true);
      expect(fixture.store.getOperation(fixture.operationId)?.terminalRevision).toBe(1);
      void reason;
    }
    expect(existsSync(running.taskDir)).toBe(true);
  });

  it("preserves a symlinked or unreadable task directory instead of following it", () => {
    const fixture = durableFixture("symlink", { launchRecord: false });
    // Replace the owned task directory with a symlink to a file outside it.
    rmSync(fixture.taskDir, { recursive: true, force: true });
    const target = join(fixture.root, "outside.txt");
    writeFileSync(target, "outside-owned");
    // Use a directory symlink so rmSync could otherwise be destructive.
    const outside = join(fixture.root, "outside-dir");
    mkdirSync(outside);
    symlinkSync(outside, fixture.taskDir);
    const inspection = inspectSupervisorArtifact(fixture.supervisorDirectory, fixture.taskId);
    expect(inspection.protection).toMatch(/not-a-directory|launch-record/);
    expect(existsSync(outside)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("outside-owned");
  });

  it("does not follow a symlinked supervisor tasks root", () => {
    const fixture = durableFixture("tasks-root-link", { callback: false });
    const outside = join(fixture.root, "outside-tasks");
    mkdirSync(join(outside, fixture.taskId), { recursive: true });
    writeFileSync(
      join(outside, fixture.taskId, "launch.json"),
      JSON.stringify({ version: 1, taskId: fixture.taskId, token: "outside" }),
    );
    rmSync(join(fixture.supervisorDirectory, "tasks"), { recursive: true, force: true });
    symlinkSync(outside, join(fixture.supervisorDirectory, "tasks"));

    const inspection = inspectSupervisorArtifact(fixture.supervisorDirectory, fixture.taskId);
    expect(inspection.protection).toBe("supervisor-tasks-root-not-owned");
    const result = applyTaskRetention({
      store: fixture.store,
      supervisorDirectory: fixture.supervisorDirectory,
      cutoff: Date.now() + 1,
      limit: 10,
    });
    expect(result.units).toHaveLength(0);
    expect(existsSync(join(outside, fixture.taskId, "launch.json"))).toBe(true);
    expect(fixture.store.getOperation(fixture.operationId)?.terminalRevision).toBe(1);
  });

  it("protects malformed callback delivery timestamps instead of treating them as delivered", () => {
    for (const marker of [null, "0", -1]) {
      const fixture = durableFixture(`callback-marker-${String(marker)}`, { callback: true });
      writeFileSync(fixture.sidecar, JSON.stringify({
        kind: "process",
        callback: true,
        callbackDeliveredAt: marker,
        cwd: fixture.root,
      }));
      const preview = previewTaskRetention({
        store: fixture.store,
        supervisorDirectory: fixture.supervisorDirectory,
        cutoff: Date.now() + 1,
        limit: 10,
      });
      expect(preview.artifactProtected.find((entry) => entry.operationId === fixture.operationId)?.reason)
        .toBe("observed-callback-delivery-malformed");
      const result = applyTaskRetention({
        store: fixture.store,
        supervisorDirectory: fixture.supervisorDirectory,
        cutoff: Date.now() + 1,
        limit: 10,
      });
      expect(result.units).toHaveLength(0);
      expect(existsSync(fixture.taskDir)).toBe(true);
      expect(fixture.store.getOperation(fixture.operationId)?.terminalRevision).toBe(1);
    }
  });

  it("does not delete a task after a protection appears between preview and reservation", () => {
    const fixture = durableFixture("race");
    const cutoff = Date.now() + 1;
    const preview = fixture.store.previewRetention({ cutoff, limit: 1 });
    expect(preview.candidates).toHaveLength(1);
    fixture.store.registerWait({
      owner: owner(fixture.root),
      dependencies: [{ operationId: fixture.operationId }],
      continuationNote: "a human started interpreting while cleanup was previewing",
    });
    expect(() => fixture.store.reserveRetention({
      operationId: fixture.operationId,
      cutoff,
      token: "retention_race",
    })).toThrow(/reserved for retention|protected/);
    expect(existsSync(fixture.taskDir)).toBe(true);
  });

  it("finishes a crash after the deletion fence and before filesystem removal", () => {
    const fixture = durableFixture("interrupted-fence");
    const cutoff = Date.now() + 1;
    const unit = fixture.store.reserveRetention({
      operationId: fixture.operationId,
      cutoff,
      token: "retention_interrupted",
      artifactRef: fixture.taskDir,
    });
    // The durable fence is committed, then the process dies before rmSync.
    fixture.store.markRetentionDeletionStarted(unit.operationId, unit.token);
    fixture.store.close();

    const reopened = openStore({ path: fixture.storePath });
    cleanups.push(() => reopened.close());
    const recovered = recoverTaskRetention({
      store: reopened,
      supervisorDirectory: fixture.supervisorDirectory,
    });
    expect(recovered.completed).toBe(1);
    expect(recovered.held).toBe(0);
    expect(existsSync(fixture.taskDir)).toBe(false);
    expect(reopened.getOperation(fixture.operationId)).toBeNull();
    expect(reopened.retentionUnit(fixture.operationId)?.state).toBe("complete");
  });

  it("releases only a reservation that never crossed the deletion fence", () => {
    const fixture = durableFixture("interrupted-reserved");
    fixture.store.reserveRetention({
      operationId: fixture.operationId,
      cutoff: Date.now() + 1,
      token: "retention_interrupted_reserved",
      artifactRef: fixture.taskDir,
    });
    const recovered = recoverTaskRetention({
      store: fixture.store,
      supervisorDirectory: fixture.supervisorDirectory,
    });
    expect(recovered.released).toBe(1);
    expect(fixture.store.retentionUnit(fixture.operationId)).toBeNull();
    expect(existsSync(fixture.taskDir)).toBe(true);
    expect(fixture.store.getOperation(fixture.operationId)?.terminalRevision).toBe(1);
    // The operation is still eligible after the safe release.
    expect(fixture.store.previewRetention({ cutoff: Date.now() + 1, limit: 1 }).candidates).toHaveLength(1);
  });

  it("finishes a crash after filesystem removal but before the progress marker", () => {
    const fixture = durableFixture("interrupted-files");
    const cutoff = Date.now() + 1;
    const unit = fixture.store.reserveRetention({
      operationId: fixture.operationId,
      cutoff,
      token: "retention_interrupted_files",
      artifactRef: fixture.taskDir,
    });
    fixture.store.markRetentionDeletionStarted(unit.operationId, unit.token);
    rmSync(fixture.taskDir, { recursive: true, force: true });
    fixture.store.close();

    const reopened = openStore({ path: fixture.storePath });
    cleanups.push(() => reopened.close());
    const recovered = recoverTaskRetention({
      store: reopened,
      supervisorDirectory: fixture.supervisorDirectory,
    });
    expect(recovered.completed).toBe(1);
    expect(reopened.getOperation(fixture.operationId)).toBeNull();
    expect(reopened.retentionUnit(fixture.operationId)?.state).toBe("complete");
  });

  it("holds a partial/uncertain deletion fenced instead of reopening references", () => {
    const fixture = durableFixture("interrupted-unknown");
    const unit = fixture.store.reserveRetention({
      operationId: fixture.operationId,
      cutoff: Date.now() + 1,
      token: "retention_interrupted_unknown",
      artifactRef: fixture.taskDir,
    });
    fixture.store.markRetentionDeletionStarted(unit.operationId, unit.token);
    fixture.store.markRetentionDeletionUnknown(
      unit.operationId,
      unit.token,
      "simulated partial rmSync failure",
    );
    const recovered = recoverTaskRetention({
      store: fixture.store,
      supervisorDirectory: fixture.supervisorDirectory,
    });
    expect(recovered.held).toBe(0);
    expect(fixture.store.retentionUnit(unit.operationId)?.state).toBe("deletion-unknown");
    expect(fixture.store.getOperation(fixture.operationId)?.terminalRevision).toBe(1);
    expect(existsSync(fixture.taskDir)).toBe(true);
  });

  it("keeps the deletion fence when the progress marker write is interrupted after rm", () => {
    const fixture = durableFixture("marker-interrupted");
    const original = fixture.store.markRetentionFilesRemoved;
    fixture.store.markRetentionFilesRemoved = () => {
      throw new Error("simulated crash before files-removed marker");
    };
    let result: ReturnType<typeof applyTaskRetention>;
    try {
      result = applyTaskRetention({
        store: fixture.store,
        supervisorDirectory: fixture.supervisorDirectory,
        cutoff: Date.now() + 1,
        limit: 10,
      });
    } finally {
      fixture.store.markRetentionFilesRemoved = original;
    }
    expect(result.units).toHaveLength(0);
    expect(result.failed[0]?.error).toMatch(/files-removed marker/);
    expect(fixture.store.retentionUnit(fixture.operationId)?.state).toBe("deletion-unknown");
    expect(fixture.store.getOperation(fixture.operationId)?.terminalRevision).toBe(1);
    expect(() => fixture.store.registerWait({
      owner: owner(fixture.root),
      dependencies: [{ operationId: fixture.operationId }],
      continuationNote: "uncertain evidence must stay fenced",
    })).toThrow(/reserved for retention|protected/);
  });

  it("runs the legacy sweep through the same protection authority", () => {
    const root = workspace("legacy-store");
    const store = openStore({ path: join(root, "operations.sqlite") });
    cleanups.push(() => store.close());
    // An earlier durable apply in this file may already have run the daily pass.
    rmSync(join(baseDir(), "maintenance-state.json"), { force: true });
    const eligible = legacyFixture("legacy-eligible", { callback: false });
    const protectedPending = legacyFixture("legacy-pending", { callback: true, delivered: false });
    const recentlyDelivered = legacyFixture("legacy-delivered", { callback: true, delivered: true, old: false });

    const preview = previewTaskRetention({
      store,
      supervisorDirectory: join(root, "supervisor"),
      cutoff: Date.now() + 1,
      limit: 1,
    });
    expect(preview.legacy.eligible).toContain(eligible.id);
    expect(preview.legacy.protected.some((entry) => entry.id === protectedPending.id)).toBe(true);
    expect(preview.legacy.eligible).not.toContain(recentlyDelivered.id);

    runScheduledTaskMaintenance({
      store,
      supervisorDirectory: join(root, "supervisor"),
      now: Date.now(),
    });
    expect(readMeta(eligible.id)).toBeUndefined();
    expect(readMeta(protectedPending.id)?.status).toBe("succeeded");
    expect(readMeta(recentlyDelivered.id)?.status).toBe("succeeded");
  });

  it("does not physically prune durable history unless the coordinator policy is opted in", () => {
    const fixture = durableFixture("opt-in");
    const db = new DatabaseSync(fixture.storePath);
    db.prepare("UPDATE operations SET terminal_at = ? WHERE operation_id = ?")
      .run(Date.now() - 30 * DAY, fixture.operationId);
    db.close();
    const previousApply = process.env.PI_BG_DURABLE_RETENTION_APPLY;
    const previousRetention = process.env.PI_BG_RETENTION_MS;
    try {
      delete process.env.PI_BG_DURABLE_RETENTION_APPLY;
      runScheduledTaskMaintenance({
        store: fixture.store,
        supervisorDirectory: fixture.supervisorDirectory,
        now: Date.now(),
      });
      expect(fixture.store.getOperation(fixture.operationId)?.terminalRevision).toBe(1);
      expect(existsSync(fixture.taskDir)).toBe(true);

      process.env.PI_BG_DURABLE_RETENTION_APPLY = "1";
      process.env.PI_BG_RETENTION_MS = "0";
      runScheduledTaskMaintenance({
        store: fixture.store,
        supervisorDirectory: fixture.supervisorDirectory,
        now: Date.now(),
      });
      expect(fixture.store.getOperation(fixture.operationId)).toBeNull();
      expect(existsSync(fixture.taskDir)).toBe(false);
    } finally {
      if (previousApply === undefined) delete process.env.PI_BG_DURABLE_RETENTION_APPLY;
      else process.env.PI_BG_DURABLE_RETENTION_APPLY = previousApply;
      if (previousRetention === undefined) delete process.env.PI_BG_RETENTION_MS;
      else process.env.PI_BG_RETENTION_MS = previousRetention;
    }
  });
});
