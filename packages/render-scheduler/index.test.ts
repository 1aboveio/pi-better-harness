import assert from "node:assert/strict";
import test from "node:test";

import { createRenderScheduler } from "./index.ts";

test("render scheduler stays idle until requested and replaces pending deadlines", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let renders = 0;
  const scheduler = createRenderScheduler(() => { renders += 1; });

  t.mock.timers.tick(60_000);
  assert.equal(renders, 0);

  scheduler.schedule(10_000);
  scheduler.schedule(20_000);
  t.mock.timers.tick(19_999);
  assert.equal(renders, 0);
  t.mock.timers.tick(1);
  assert.equal(renders, 1);
  assert.equal(scheduler.pending(), false);
});

test("render scheduler cancels deadlines on event renders and disposal", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let renders = 0;
  const scheduler = createRenderScheduler(() => { renders += 1; });

  scheduler.schedule(10_000);
  scheduler.request();
  assert.equal(renders, 1);
  t.mock.timers.tick(10_000);
  assert.equal(renders, 1);

  scheduler.schedule(10_000);
  scheduler.dispose();
  t.mock.timers.tick(10_000);
  assert.equal(renders, 1);
  assert.equal(scheduler.pending(), false);
});