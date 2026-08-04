import assert from "node:assert/strict";
import test from "node:test";

import { observeGoalStall } from "../src/stall.js";
import type { GoalSnapshot } from "../src/types.js";

const goal: GoalSnapshot = {
  goalId: "goal_test",
  objective: "Ship the change",
  status: "active",
  tokenBudget: null,
  usage: { tokensUsed: 0, activeSeconds: 0 },
  createdAt: 1,
  updatedAt: 1,
  activeStartedAt: 1,
  completedAt: null,
};

test("goal stall tracks changed evidence and exempts active work", () => {
  const continuation = {
    goalId: goal.goalId,
    lastEvidenceSignature: "evidence",
    lastEvidenceSummary: "bash",
    lastProgressAt: 100,
    noProgressRetries: 0,
    blocked: false,
    updatedAt: 1,
  };
  assert.equal(observeGoalStall(goal, continuation, { now: 300_100 })?.state, "stalled");
  assert.equal(observeGoalStall(goal, continuation, { now: 300_100, foregroundRunning: true })?.state, "quiet");
  assert.equal(observeGoalStall(goal, continuation, { now: 300_100, backgroundRunning: true })?.state, "quiet");
});