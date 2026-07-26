import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import assert from "node:assert/strict";

import { collectActivitySnapshot, planBackgroundDrainWake } from "../src/activity.js";
import { reconstructGoalSnapshot } from "../src/goal-state.js";
import type { ActivitySnapshot, GoalSnapshot } from "../src/types.js";
import {
  collectSubagentActivity,
  effectiveSubagentStatus,
  type SubagentRunMeta,
} from "../src/subagents.js";

function meta(overrides: Partial<SubagentRunMeta>): SubagentRunMeta {
  return {
    id: "sa_1",
    status: "running",
    pid: 123,
    spawnPid: 999,
    cwd: "/tmp",
    promptPreview: "task",
    startedAt: 10,
    ...overrides,
  };
}

function goal(id: string, status: GoalSnapshot["status"] = "active"): GoalSnapshot {
  return {
    goalId: id,
    objective: "do work",
    status,
    tokenBudget: null,
    usage: { tokensUsed: 0, activeSeconds: 0 },
    createdAt: 1,
    updatedAt: 1,
    activeStartedAt: status === "active" ? 1 : null,
    completedAt: status === "complete" ? 1 : null,
  };
}

function activitySnapshot(active: boolean): ActivitySnapshot {
  return {
    version: 1,
    category: active ? "background-running" : "idle-waiting",
    foregroundRunning: false,
    backgroundRunning: active,
    activeBackgroundCount: active ? 1 : 0,
    unhealthyBackgroundCount: 0,
    terminalAttentionCount: 0,
    providers: [
      {
        providerId: "test",
        items: active
          ? [{ id: "work", status: "running", active: true }]
          : [{ id: "work", status: "completed", active: false, terminal: true }],
      },
    ],
    generatedAt: 1,
  };
}

test("running subagent with dead pid is reported as exited", () => {
  assert.equal(effectiveSubagentStatus(meta({ status: "running" }), () => false), "exited");
});

test("running and orphaned subagents are active background work", () => {
  const dir = join(tmpdir(), `pi-better-goal-${process.pid}-${Date.now()}`);
  const runsDir = join(dir, "runs");
  const metas = [
    meta({ id: "running", status: "running", pid: 1, spawnPid: 42, startedAt: 3 }),
    meta({ id: "orphaned", status: "orphaned", pid: 2, spawnPid: 42, startedAt: 2 }),
    meta({ id: "completed", status: "completed", pid: 3, spawnPid: 42, startedAt: 1 }),
    meta({ id: "other-parent", status: "running", pid: 4, spawnPid: 7, startedAt: 4 }),
  ];

  for (const run of metas) {
    mkdirSync(join(runsDir, run.id), { recursive: true });
    writeFileSync(join(runsDir, run.id, "meta.json"), JSON.stringify(run));
  }

  const snapshot = collectSubagentActivity({
    baseDir: dir,
    parentPid: 42,
    processExists: () => true,
  });

  const byId = new Map(snapshot.items.map((item) => [item.id, item]));
  assert.equal(snapshot.items.length, 3);
  assert.equal(byId.get("running")?.active, true);
  assert.equal(byId.get("orphaned")?.active, true);
  assert.equal(byId.get("orphaned")?.unhealthy, true);
  assert.equal(byId.get("completed")?.active, false);
  assert.equal(byId.has("other-parent"), false);
});

test("activity category prefers foreground over background", async () => {
  const snapshot = await collectActivitySnapshot(
    {} as never,
    [
      {
        id: "test",
        getActivity: () => ({
          providerId: "test",
          items: [{ id: "work", status: "running", active: true }],
        }),
      },
    ],
    true,
    100,
  );

  assert.equal(snapshot.category, "foreground-running");
  assert.equal(snapshot.backgroundRunning, true);
  assert.equal(snapshot.activeBackgroundCount, 1);
});

test("background drain wake is scoped to the goal that observed active background work", () => {
  const observed = planBackgroundDrainWake(null, goal("g1"), activitySnapshot(true));
  assert.deepEqual(observed, {
    nextTracker: { goalId: "g1", activeSignature: "work:running" },
    wakeSignature: null,
  });

  const differentGoal = planBackgroundDrainWake(observed.nextTracker, goal("g2"), activitySnapshot(false));
  assert.deepEqual(differentGoal, { nextTracker: null, wakeSignature: null });

  const sameGoalObserved = planBackgroundDrainWake(null, goal("g1"), activitySnapshot(true));
  const sameGoalDrained = planBackgroundDrainWake(sameGoalObserved.nextTracker, goal("g1"), activitySnapshot(false));
  assert.deepEqual(sameGoalDrained, {
    nextTracker: null,
    wakeSignature: "g1:work:running",
  });

  const completed = planBackgroundDrainWake(sameGoalObserved.nextTracker, goal("g1", "complete"), activitySnapshot(false));
  assert.deepEqual(completed, { nextTracker: null, wakeSignature: null });
});

test("goal reconstruction follows set, usage, and clear entries", () => {
  const entries = [
    {
      type: "custom",
      customType: "pi-better-goal",
      data: {
        kind: "set",
        goal: {
          goalId: "g1",
          objective: "do work",
          status: "active",
          tokenBudget: null,
          usage: { tokensUsed: 0, activeSeconds: 0 },
          createdAt: 1,
          updatedAt: 1,
        },
      },
    },
    {
      type: "custom",
      customType: "pi-better-goal",
      data: { kind: "usage", status: "budgetLimited" },
    },
  ];

  assert.deepEqual(reconstructGoalSnapshot(entries), {
    goalId: "g1",
    objective: "do work",
    status: "budgetLimited",
    tokenBudget: null,
    usage: { tokensUsed: 0, activeSeconds: 0 },
    createdAt: 1,
    updatedAt: 1,
    activeStartedAt: null,
    completedAt: null,
  });

  assert.equal(reconstructGoalSnapshot([...entries, { type: "custom", customType: "pi-better-goal", data: { kind: "clear" } }]), null);
});