import assert from "node:assert/strict";
import test from "node:test";
import { shimmerFrameDelay } from "../extensions/minimal-output/hook.ts";

// The shimmer used to clear its timer after 400 ms with no render. That made the timer the paint
// clock: the prune only ever fired when rendering stopped, and stopping it removed the thing that
// requested renders, so the animation latched off until an unrelated render restarted it. A row in
// an unfocused window still exists, so the saving has to be a slower cadence, not a stop.
test("a row painting right now gets the fast frame interval", () => {
  assert.equal(shimmerFrameDelay(1_000, 1_000), 80);
  assert.equal(shimmerFrameDelay(1_000, 1_080), 80);
  assert.equal(shimmerFrameDelay(1_000, 1_400), 80);
});

test("a row that stopped painting slows to one frame a second instead of stopping", () => {
  assert.equal(shimmerFrameDelay(1_000, 1_401), 1_000);
  assert.equal(shimmerFrameDelay(1_000, 60_000), 1_000);
});

test("the idle cadence never returns zero or a stop signal", () => {
  for (const elapsed of [0, 1, 399, 400, 401, 5_000, 3_600_000]) {
    const delay = shimmerFrameDelay(0, elapsed);
    assert.ok(delay > 0, `elapsed ${elapsed} must keep animating`);
    assert.ok([80, 1_000].includes(delay), `elapsed ${elapsed} produced ${delay}`);
  }
});
