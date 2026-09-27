import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const source = readFileSync(resolve(root, "packages/log-utils/index.ts"), "utf8");
const banner = "// Generated from packages/log-utils/index.ts. Do not edit directly.\n";
const expected = `${banner}${source}`;
const targets = [
  "packages/pi-better-background-tasks/src/shared-log-utils.ts",
  "packages/pi-better-subagents/shared-log-utils.ts",
];

test("vendored log-utils copies match packages/log-utils/index.ts", () => {
  for (const target of targets) {
    assert.equal(readFileSync(resolve(root, target), "utf8"), expected, target);
  }
});
