import assert from "node:assert/strict";
import test from "node:test";

import { selectPackedResult } from "./stage-harness-dependencies.mjs";

const packed = { filename: "pi-better-goal-0.1.9.tgz", files: [] };

test("selectPackedResult accepts npm pack JSON output shapes", () => {
  assert.deepEqual(selectPackedResult(JSON.stringify([packed])), packed);
  assert.deepEqual(selectPackedResult(JSON.stringify(packed)), packed);
  assert.deepEqual(selectPackedResult(JSON.stringify({ package: packed })), packed);
});