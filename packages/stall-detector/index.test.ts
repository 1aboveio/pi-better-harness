import assert from "node:assert/strict";
import test from "node:test";

import { observeStall, resolveStallThresholds } from "./index.js";

test("classifies observable progress deterministically", () => {
  assert.equal(observeStall({ now: 100, startedAt: 100 }).state, "healthy");
  assert.equal(observeStall({ now: 60_100, startedAt: 100 }).state, "quiet");
  assert.equal(observeStall({ now: 300_100, startedAt: 100 }).state, "stalled");
  assert.equal(observeStall({ now: 300_100 }).state, "unknown");
});

test("an active known phase suppresses a stalled verdict without hiding quiet age", () => {
  const observation = observeStall({ now: 300_100, startedAt: 100, exempt: true });
  assert.equal(observation.state, "quiet");
  assert.equal(observation.ageMs, 300_000);
});

test("normalizes invalid and inverted thresholds", () => {
  assert.deepEqual(resolveStallThresholds({ quietMs: 500, stallMs: 100 }), { quietMs: 100, stallMs: 500 });
  assert.deepEqual(resolveStallThresholds({ quietMs: -1, stallMs: 0 }), { quietMs: 60_000, stallMs: 300_000 });
});