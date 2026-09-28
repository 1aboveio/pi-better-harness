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

// #321/#323: both tool families resolve output controls and cursor scopes
// through the vendored copy, so the copies must behave identically.
for (const target of targets) {
  test(`${target}: shared output controls and scope keys`, async () => {
    const utils = await import(resolve(root, target));
    assert.deepEqual(utils.readOutputControls({ max_bytes: 512, maxBytes: 64, tail_lines: 4 }), { maxBytes: 512, lines: 4 });
    const origin = { cwd: "/w", sessionId: "s" };
    assert.equal(utils.sessionScopeKey({ origin }), `session:${utils.originScopeDigest(origin)}`);
    assert.equal(utils.sessionScopeKey({ unavailable: true, origin }), "session:unavailable");
    assert.deepEqual([...utils.readOutputInclude(["cost", "tools", "x"]).include], ["cost", "tools"]);
  });
}
