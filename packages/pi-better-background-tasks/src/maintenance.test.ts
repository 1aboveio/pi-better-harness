import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskMaintenance } from "./maintenance.js";
import { logPathFor, readMeta, taskDir, writeMeta } from "./registry.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta } from "./types.js";

const created: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

afterEach(() => {
  for (const id of created.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
});

describe("background task registry maintenance", () => {
  it("marks a foreign command watcher terminal when its spawning process is gone", () => {
    const meta = fixture("running", { kind: "command_watch", spawnPid: 900_001 });
    writeMeta(meta);

    const result = runTaskMaintenance({
      now: meta.startedAt + DAY,
      activeOrigin: { cwd: "/tmp/project", sessionId: "active" },
      processIdentityAlive: () => false,
      metas: [meta],
      force: true,
    });

    expect(result.reconciled).toBe(1);
    expect(readMeta(meta.id)).toMatchObject({
      status: "failed",
      error: "task supervisor is no longer alive; execution result is unavailable",
    });
  });

  it("preserves active-session and remote tmux tasks without adjudicating them", () => {
    const origin = { cwd: "/tmp/project", sessionId: "active" };
    const active = fixture("running", { callbackOrigin: origin, spawnPid: 900_002 });
    const remote = fixture("running", {
      callbackOrigin: { cwd: "/tmp/project", sessionId: "foreign" },
      spawnPid: 900_003,
      ssh: { host: "example.com", target: "example.com" },
      remote: { command: "work", session: "tmux", sessionName: "durable" },
    });
    writeMeta(active);
    writeMeta(remote);

    const result = runTaskMaintenance({
      now: active.startedAt + DAY,
      activeOrigin: origin,
      processIdentityAlive: () => false,
      metas: [active, remote],
      force: true,
    });

    expect(result.reconciled).toBe(0);
    expect(readMeta(active.id)?.status).toBe("running");
    expect(readMeta(remote.id)?.status).toBe("running");
  });

  it("removes terminal task directories older than seven days", () => {
    const now = Date.now();
    const old = fixture("succeeded", { startedAt: now - 9 * DAY, endedAt: now - 8 * DAY });
    writeMeta(old);

    const result = runTaskMaintenance({ now, metas: [old], force: true });

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(readMeta(old.id)).toBeUndefined();
  });
});

function fixture(
  status: BackgroundTaskMeta["status"],
  overrides: Partial<BackgroundTaskMeta> = {},
): BackgroundTaskMeta {
  const id = `bg_maintenance_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  created.push(id);
  const startedAt = Date.now();
  const callbackOrigin: BackgroundTaskCallbackOrigin = { cwd: "/tmp/project", sessionId: `session-${id}` };
  return {
    id,
    kind: "process",
    status,
    startedAt,
    ...(status === "running" ? {} : { endedAt: startedAt }),
    logPath: logPathFor(id),
    callback: false,
    callbackOrigin,
    cwd: callbackOrigin.cwd,
    spawnPid: process.pid,
    ...overrides,
  };
}