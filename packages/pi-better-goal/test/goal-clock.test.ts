import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import { formatGoalClock, goalTiming, isGoalClockVisible, renderGoalClockLine } from "../src/goal-clock.js";
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

test("completed goal clock stays visible for 30 seconds, then hides", () => {
  const complete = goalWithStatus(createGoalSnapshot("Ship footer clock", null, 100), "complete", 190);

  assert.equal(isGoalClockVisible(complete, 219), true);
  assert.equal(isGoalClockVisible(complete, 220), false);
  assert.equal(isGoalClockVisible(createGoalSnapshot("Still active", null, 100), 10_000), true);
});

test("goal clock text shows the objective, status, and both clocks", () => {
  const goal = goalWithStatus(createGoalSnapshot("Ship footer clock", null, 100), "paused", 165);

  assert.equal(
    formatGoalClock(goal, 225),
    "Goal [paused]: Ship footer clock | active 1:05 | elapsed 2:05",
  );
});

test("goal clock line renders as a top-level rail heading", () => {
  const goal = createGoalSnapshot("A deliberately long objective that must truncate", null, 100);
  const line = renderGoalClockLine(goal, 54, 225);

  assert.equal(visibleWidth(line), 54);
  assert.match(line, /^▸ goal active 2:05 A deliberately long objective/);
  assert.doesNotMatch(line, /elapsed/);
});

test("goal clock line accents the first-level rail heading when themed", () => {
  const goal = createGoalSnapshot("Ship footer clock", null, 100);
  const line = renderGoalClockLine(goal, 80, 225, (color, value) => `<${color}>${value}</>`);

  assert.ok(visibleWidth(line) <= 80);
  assert.match(line, /^<dim>▸<\/> <warning>goal active<\/> <dim>2:05 Ship footer clock<\/>$/);
});
