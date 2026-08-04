import { describe, expect, it } from "vitest";
import { collectBackgroundTaskGoalActivity } from "./goal-provider.js";
import type { BackgroundTaskMeta } from "./types.js";

function meta(overrides: Partial<BackgroundTaskMeta>): BackgroundTaskMeta {
  return {
    id: "bg_test_1",
    kind: "process",
    status: "running",
    startedAt: 100,
    lastProgressAt: Date.now(),
    logPath: "/tmp/bg_test_1.log",
    cwd: "/tmp/project",
    spawnPid: 123,
    ...overrides,
  };
}

describe("goal provider", () => {
  it("reports running background tasks as active goal activity", () => {
    const snapshot = collectBackgroundTaskGoalActivity([
      meta({ id: "running", status: "running", name: "watch pr" }),
      meta({ id: "succeeded", status: "succeeded", endedAt: 200 }),
      meta({ id: "failed", status: "failed", endedAt: 300 }),
      meta({ id: "dismissed", status: "failed", dismissedAt: 400 }),
    ]);

    expect(snapshot.providerId).toBe("background-tasks");
    expect(snapshot.items.map((item) => item.id)).toEqual(["running", "succeeded", "failed"]);
    expect(snapshot.items.find((item) => item.id === "running")).toMatchObject({
      label: "watch pr",
      status: "running",
      active: true,
      terminal: false,
      attention: false,
    });
    expect(snapshot.items.find((item) => item.id === "succeeded")).toMatchObject({
      status: "succeeded",
      active: false,
      terminal: true,
      attention: false,
    });
    expect(snapshot.items.find((item) => item.id === "failed")).toMatchObject({
      status: "failed",
      active: false,
      terminal: true,
      attention: true,
    });
  });

  it("scopes activity to the active cwd and session", () => {
    const snapshot = collectBackgroundTaskGoalActivity([
      meta({ id: "active-session", status: "running", callbackOrigin: { cwd: "/tmp/project", sessionId: "session-a" } }),
      meta({ id: "other-session", status: "running", callbackOrigin: { cwd: "/tmp/project", sessionId: "session-b" } }),
      meta({ id: "other-cwd", status: "running", callbackOrigin: { cwd: "/tmp/other", sessionId: "session-a" } }),
      meta({ id: "legacy", status: "running" }),
    ], context("/tmp/project", "session-a"));

    expect(snapshot.items.map((item) => item.id)).toEqual(["active-session"]);
  });

  it("drops old terminal rows from goal attention", () => {
    const now = 1_000_000;
    const snapshot = collectBackgroundTaskGoalActivity([
      meta({ id: "recent-failure", status: "failed", endedAt: now - 10_000, callbackOrigin: { cwd: "/tmp/project", sessionId: "session-a" } }),
      meta({ id: "old-failure", status: "failed", endedAt: now - 31_000, callbackOrigin: { cwd: "/tmp/project", sessionId: "session-a" } }),
      meta({ id: "running", status: "running", callbackOrigin: { cwd: "/tmp/project", sessionId: "session-a" } }),
    ], context("/tmp/project", "session-a"), now);

    expect(snapshot.items.map((item) => item.id)).toEqual(["recent-failure", "running"]);
  });
});

function context(cwd: string, sessionId?: string) {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never;
}