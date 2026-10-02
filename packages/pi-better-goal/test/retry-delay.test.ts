import assert from "node:assert/strict";
import test from "node:test";
import { clearTimeout, setTimeout } from "node:timers";

import { idleContinuationDelay } from "../src/index.js";

// Node's scheduling contract, independent of the goal implementation:
// https://nodejs.org/api/timers.html#settimeoutcallback-delay-args
const NODE_TIMER_LIMIT_MS = 2_147_483_647;

test("the default base follows the linear 60s through 600s schedule", () => {
  const expectedDelays = [60_000, 120_000, 180_000, 240_000, 300_000, 360_000, 420_000, 480_000, 540_000, 600_000];
  assert.deepEqual(
    expectedDelays.map((_, retries) => idleContinuationDelay(retries)),
    expectedDelays,
  );
});

test("delays below and exactly at Node's timer limit remain unchanged", () => {
  for (const [retries, baseMs, expected] of [
    [0, 1_100_000_000, 1_100_000_000],
    [1, 1_000_000_000, 2_000_000_000],
    [0, NODE_TIMER_LIMIT_MS, NODE_TIMER_LIMIT_MS],
    [1, NODE_TIMER_LIMIT_MS / 2, NODE_TIMER_LIMIT_MS],
  ] as const) {
    assert.equal(idleContinuationDelay(retries, baseMs), expected);
  }
});

test("multiplying a valid base past Node's timer limit saturates", () => {
  assert.equal(idleContinuationDelay(1, 1_100_000_000), NODE_TIMER_LIMIT_MS);
});

test("huge finite inputs saturate even when their product overflows", () => {
  for (const [retries, baseMs] of [
    [1, Number.MAX_VALUE],
    [0, Number.MAX_VALUE],
    [Number.MAX_VALUE, 1],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ] as const) {
    const delay = idleContinuationDelay(retries, baseMs);
    assert.ok(Number.isFinite(delay), `delay must remain finite for retries=${retries}, baseMs=${baseMs}`);
    assert.equal(delay, NODE_TIMER_LIMIT_MS);
  }
});

test("a zero base stays immediate even with huge finite retry counts", () => {
  for (const retries of [0, 1, 9, Number.MAX_VALUE]) {
    assert.equal(idleContinuationDelay(retries, 0), 0);
  }
});

test("native timers accept returned positive delays without shortening them", () => {
  for (const [retries, baseMs] of [
    [0, 30_000],
    [0, NODE_TIMER_LIMIT_MS],
    [1, NODE_TIMER_LIMIT_MS / 2],
    [1, 1_100_000_000],
    [Number.MAX_VALUE, Number.MAX_VALUE],
  ] as const) {
    const delay = idleContinuationDelay(retries, baseMs);
    const timer = setTimeout(() => {}, delay);
    try {
      // Observe Node's stored delay without waiting for the timer to fire.
      assert.equal((timer as NodeJS.Timeout & { _idleTimeout: number })._idleTimeout, delay);
    } finally {
      clearTimeout(timer);
    }
  }
});
