import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { formatGoalClock, goalTiming, renderGoalClockLine } from "../src/goal-clock.js";
import { createGoalSnapshot, goalWithStatus } from "../src/goal-state.js";

test("goal timing tracks active and elapsed time across pause and completion", () => {
  const created = createGoalSnapshot("Ship footer clock", null, 100);

  assert.deepEqual(goalTiming(created, 130), {
    activeSeconds: 30,
    elapsedSeconds: 30,
  });

  const paused = goalWithStatus(created, "paused", 130);
  assert.deepEqual(goalTiming(paused, 160), {
    activeSeconds: 30,
    elapsedSeconds: 60,
  });

  const resumed = goalWithStatus(paused, "active", 160);
  const complete = goalWithStatus(resumed, "complete", 190);
  assert.deepEqual(goalTiming(complete, 300), {
    activeSeconds: 60,
    elapsedSeconds: 90,
  });
});

test("goal clock text shows the objective, status, and both clocks", () => {
  const goal = goalWithStatus(createGoalSnapshot("Ship footer clock", null, 100), "paused", 165);

  assert.equal(
    formatGoalClock(goal, 225),
    "Goal [paused]: Ship footer clock | active 1:05 | elapsed 2:05",
  );
});

test("goal clock line is right-aligned and preserves both clocks", () => {
  const goal = createGoalSnapshot("A deliberately long objective that must truncate", null, 100);
  const line = renderGoalClockLine(goal, 54, 225);

  assert.equal(visibleWidth(line), 54);
  assert.match(line, /active 2:05/);
  assert.match(line, /elapsed 2:05$/);
});
