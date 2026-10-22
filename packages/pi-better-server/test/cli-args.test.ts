import assert from "node:assert/strict";
import { test } from "node:test";
import { parseManagedStartupArgs, resolveAgent } from "../src/cli-args.ts";

test("managed startup parses manifest and state paths literally in both option forms", () => {
  const manifest = "/managed/quoted ' runtime/runtime.json";
  const values = parseManagedStartupArgs(["--agent=pi", `--desired-runtime=${manifest}`, "--server-dir", "/custom state", "--operation-id", "observer", "--require-capability", "native-client-v1"]);
  assert.equal(values["desired-runtime"], manifest);
  assert.equal(values["server-dir"], "/custom state");
  assert.equal(values["operation-id"], "observer");
  assert.deepEqual(values["require-capability"], ["native-client-v1"]);
  assert.equal(parseManagedStartupArgs(["--runtime", manifest]).runtime, manifest);
  assert.throws(() => parseManagedStartupArgs(["--runtime"]), /argument/);
  assert.throws(() => parseManagedStartupArgs(["--unrecognised"]), /Unknown option/);
});

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
