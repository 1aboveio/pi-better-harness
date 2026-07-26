import { describe, expect, it } from "vitest";
import { evaluateCondition, resolveJsonPath } from "./conditions.js";
import type { CommandResult } from "./types.js";

const baseResult: CommandResult = {
  exitCode: 0,
  signal: null,
  stdout: '{"status":"done","items":[{"name":"first"}],"nested":{"count":2}}',
  stderr: "",
  startedAt: 1,
  endedAt: 2,
};

describe("resolveJsonPath", () => {
  it("resolves dot and array paths", () => {
    expect(resolveJsonPath(baseResult.stdout, "$.items[0].name")).toEqual({ ok: true, value: "first" });
    expect(resolveJsonPath(baseResult.stdout, "$.nested.count")).toEqual({ ok: true, value: 2 });
  });

  it("reports unsupported paths", () => {
    expect(resolveJsonPath(baseResult.stdout, "status")).toMatchObject({ ok: false });
    expect(resolveJsonPath(baseResult.stdout, "$.missing.value")).toMatchObject({ ok: false });
  });
});

describe("evaluateCondition", () => {
  it("matches exit code and stdout", () => {
    expect(evaluateCondition({ type: "exit_code", equals: 0 }, baseResult).matched).toBe(true);
    expect(evaluateCondition({ type: "stdout_contains", value: "done" }, baseResult).matched).toBe(true);
  });

  it("matches JSON path equality and existence", () => {
    expect(evaluateCondition({ type: "json_path_equals", path: "$.status", value: "done" }, baseResult).matched).toBe(true);
    expect(evaluateCondition({ type: "json_path_exists", path: "$.items[0]" }, baseResult).matched).toBe(true);
  });
});