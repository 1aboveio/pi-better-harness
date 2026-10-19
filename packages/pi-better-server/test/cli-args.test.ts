import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgent } from "../src/cli-args.ts";

test("resolveAgent accepts the = form and the space form", () => {
  assert.equal(resolveAgent(["--agent=codex"]), "codex");
  assert.equal(resolveAgent(["--agent", "codex"]), "codex");
  assert.equal(resolveAgent(["--agent=pi"], "codex"), "pi");
});

test("resolveAgent falls back to env, then pi", () => {
  assert.equal(resolveAgent([], "codex"), "codex");
  assert.equal(resolveAgent([]), "pi");
});

test("resolveAgent rejects a missing value or unknown agent", () => {
  assert.throws(() => resolveAgent(["--agent"]), /requires a value/);
  assert.throws(() => resolveAgent(["--agent", "--other"]), /requires a value/);
  assert.throws(() => resolveAgent(["--agent="]), /Unknown --agent/);
  assert.throws(() => resolveAgent(["--agent=nope"]), /Unknown --agent nope/);
});
