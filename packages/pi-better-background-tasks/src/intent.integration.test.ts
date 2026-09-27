/**
 * #325: structured intent on background tasks. `operation_id` and `expected_exit_codes` are
 * declared by the parent agent that launches the task, validated before launch by the same
 * validator the subagent task runtime's bash uses, and used for expected classification and
 * cross-task recovery of a modified retry. Real processes and the real registry/journal.
 */
import { rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterAll, describe, expect, it } from "vitest";
import { failurePath, terminalFailureAttention } from "./failures.js";
import { activeFailures, failureCounts, readFailureState } from "./shared-failure-observations.js";
import { listMetasForOrigin, readMeta, taskDir, writeMeta } from "./registry.js";
import { spawnTask, startWatchTask } from "./runtime.js";
import { registerTools } from "./tools.js";
import { FakeRemoteRunner } from "./test-support/fake-remote-runner.js";
// @ts-expect-error untyped repo script shared with the subagent schema test (#327)
import { findProviderRejectedKeywords } from "../../../scripts/provider-schema-compat.mjs";

const origin = { cwd: process.cwd(), sessionId: `intent-tests-${process.pid}-${Date.now()}` };
const pi = { sendMessage: () => undefined } as unknown as ExtensionAPI;
const ids: string[] = [];
afterAll(() => { for (const id of ids) rmSync(taskDir(id), { recursive: true, force: true }); });

async function terminal(id: string) {
  for (let i = 0; i < 250; i++) {
    const meta = readMeta(id);
    if (meta && meta.status !== "running") return meta;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`task ${id} did not finish`);
}
function spawn(command: string, intent: { operation_id?: string; expected_exit_codes?: number[] } = {}) {
  const meta = spawnTask(pi, { command, callback: false, ...intent }, origin.cwd, origin, () => origin);
  ids.push(meta.id);
  return meta;
}
const state = (id: string) => readFailureState(failurePath(id));

describe("#325 background task structured intent", () => {
  it("a declared exit code is an expected failure, not an incident needing action; an undeclared one stays actionable", async () => {
    const probe = spawn("exit 1", { expected_exit_codes: [1] });
    expect(readMeta(probe.id)).toMatchObject({ expectedExitCodes: [1] });
    await terminal(probe.id);
    expect(activeFailures(state(probe.id))).toEqual([expect.objectContaining({ status: "expected", summary: expect.stringMatching(/code 1 \(declared expected\)/) })]);
    expect(terminalFailureAttention(probe.id)).toBeUndefined();
    const other = spawn("exit 2", { expected_exit_codes: [1] });
    await terminal(other.id);
    expect(activeFailures(state(other.id))).toEqual([expect.objectContaining({ status: "unresolved", category: "exit" })]);
    expect(terminalFailureAttention(other.id)?.incidents).toHaveLength(1);
  });

  it("explicit-null intent fields are undeclared: the task launches normally through Pi's own argument validation", async () => {
    const tools: Record<string, any> = {};
    registerTools({ on() {}, registerTool(tool: any) { tools[tool.name] = tool; } } as any);
    const raw = { command: "exit 3", callback: false, operation_id: null, expected_exit_codes: null };
    const args = validateToolArguments({ name: "bg_task_spawn", parameters: tools.bg_task_spawn.parameters } as any,
      { type: "toolCall", id: "spawn", name: "bg_task_spawn", arguments: structuredClone(raw) } as any);
    expect(args).toEqual(raw);
    const meta = spawnTask(pi, args, origin.cwd, origin, () => origin);
    ids.push(meta.id);
    expect(readMeta(meta.id)).not.toHaveProperty("expectedExitCodes");
    expect(readMeta(meta.id)).not.toHaveProperty("operationId");
    await terminal(meta.id);
    expect(activeFailures(state(meta.id))).toEqual([expect.objectContaining({ status: "unresolved", category: "exit" })]);
    const watch = startWatchTask(pi, { command: "true", callback: false, success_when: { type: "exit_code", equals: 0 }, operation_id: null, expected_exit_codes: null },
      origin.cwd, origin, () => origin);
    ids.push(watch.id);
    expect((await terminal(watch.id)).status).toBe("succeeded");
    // A genuinely malformed declaration is still refused before launch, by Pi's schema check.
    expect(() => validateToolArguments({ name: "bg_task_spawn", parameters: tools.bg_task_spawn.parameters } as any,
      { type: "toolCall", id: "bad", name: "bg_task_spawn", arguments: { command: "true", expected_exit_codes: [0] } } as any)).toThrow(/expected_exit_codes/);
  });

  it("malformed intent is rejected before anything is launched", () => {
    const before = listMetasForOrigin(origin).length;
    for (const intent of [{ expected_exit_codes: [0] }, { expected_exit_codes: [1, 1] }, { expected_exit_codes: [] }, { operation_id: "has space" }]) {
      expect(() => spawnTask(pi, { command: "touch should-not-run", callback: false, ...intent }, origin.cwd, origin, () => origin))
        .toThrow(/Invalid command intent: (expected_exit_codes|operation_id) .*The task was not started/);
      expect(() => startWatchTask(pi, { command: "true", callback: false, success_when: { type: "exit_code", equals: 0 }, ...intent },
        origin.cwd, origin, () => origin)).toThrow(/Invalid command intent/);
    }
    expect(listMetasForOrigin(origin)).toHaveLength(before);
  });

  it("a later task with the same operation_id that succeeds recovers an earlier failed attempt; nothing else does", async () => {
    const full = spawn("echo full suite; exit 3", { operation_id: "unit-tests" });
    const unrelated = spawn("exit 4", { operation_id: "lint" });
    const undeclared = spawn("exit 5");
    await Promise.all([terminal(full.id), terminal(unrelated.id), terminal(undeclared.id)]);
    // A different operation succeeding, or a success without a declared operation, recovers nothing.
    await terminal(spawn("true", { operation_id: "build" }).id);
    await terminal(spawn("true").id);
    expect(activeFailures(state(full.id))).toHaveLength(1);
    // The modified retry (different command) of the declared operation.
    const scoped = spawn("echo scoped suite", { operation_id: "unit-tests" });
    await terminal(scoped.id);
    expect(activeFailures(state(full.id))).toHaveLength(0);
    expect(failureCounts(state(full.id)).recovered).toBe(1);
    expect(activeFailures(state(unrelated.id))).toHaveLength(1);
    expect(activeFailures(state(undeclared.id))).toHaveLength(1);
    // A task that started before the failure cannot be its recovery evidence.
    const slowPass = spawn("sleep 0.3", { operation_id: "e2e" });
    const quickFail = spawn("exit 6", { operation_id: "e2e" });
    await Promise.all([terminal(slowPass.id), terminal(quickFail.id)]);
    expect(activeFailures(state(quickFail.id))).toHaveLength(1);
  });

  it("declared recovery never crosses sessions, including two sessionless sessions in one cwd", async () => {
    const run = (command: string, origin: { cwd: string; sessionId?: string }, extra: Record<string, unknown> = {}) => {
      const meta = spawnTask(pi, { command, callback: false, operation_id: "cross", ...extra }, origin.cwd, origin, () => origin);
      ids.push(meta.id);
      return meta;
    };
    const other = { cwd: origin.cwd, sessionId: `${origin.sessionId}-other` };
    const failedHere = run("exit 3", origin);
    await terminal(failedHere.id);
    await terminal(run("true", other).id);
    expect(activeFailures(state(failedHere.id))).toHaveLength(1);
    // Sessionless: same cwd, but a different spawning process owns the earlier task.
    const sessionless = { cwd: origin.cwd };
    const foreign = run("exit 4", sessionless);
    await terminal(foreign.id);
    writeMeta({ ...readMeta(foreign.id)!, spawnPid: 1, spawnPidStartTime: "another-process" });
    const mine = run("exit 5", sessionless);
    await terminal(mine.id);
    await terminal(run("true", sessionless).id);
    expect(activeFailures(state(foreign.id))).toHaveLength(1);
    expect(activeFailures(state(mine.id))).toHaveLength(0);
  });

  it("a watch poll exiting with a declared code is expected, not an actionable poll failure", async () => {
    let sequence = 0;
    const poll = (exitCode: number, stdout: string) => ({ stdout, stderr: "", exitCode, signal: null, startedAt: Date.now() + ++sequence, endedAt: Date.now() + sequence });
    const runner = new FakeRemoteRunner([poll(1, "no match yet"), poll(0, "ready")]);
    const meta = startWatchTask(pi, { command: "grep -q ready status", ssh: { host: "example.test" }, callback: false, interval_seconds: 1, timeout_seconds: 5,
      success_when: { type: "stdout_contains", value: "ready" }, expected_exit_codes: [1] }, origin.cwd, origin, () => origin, { remoteRunner: runner });
    ids.push(meta.id);
    expect((await terminal(meta.id)).status).toBe("succeeded");
    expect(Object.values(state(meta.id).observations)).toEqual([expect.objectContaining({ operation: "watch-poll", status: "expected" })]);
  });

  it("bg_task_spawn, bg_task_watch, and the bg_task wrapper expose the intent fields with provider-safe schemas", () => {
    const tools: Record<string, any> = {};
    registerTools({ on() {}, registerTool(tool: any) { tools[tool.name] = tool; } } as any);
    for (const name of ["bg_task_spawn", "bg_task_watch", "bg_task"]) {
      const properties = tools[name].parameters.properties;
      // Each field admits an explicit null ("not declared"), which models routinely send.
      expect(properties.operation_id.anyOf).toEqual([{ type: "null" }, { type: "string" }]);
      expect(properties.expected_exit_codes.anyOf).toEqual([{ type: "array", items: { type: "integer", minimum: 1, maximum: 255 }, minItems: 1, maxItems: 16 }, { type: "null" }]);
      // Provider-rejected keywords (#327): distinctness and the id format are validated in code instead.
      const intent = JSON.parse(JSON.stringify({ properties: { operation_id: properties.operation_id, expected_exit_codes: properties.expected_exit_codes } }));
      expect(findProviderRejectedKeywords(intent)).toEqual([]);
      expect(JSON.stringify(intent)).not.toMatch(/"(pattern|format)":/);
    }
    // Every background tool schema passes the shared provider check.
    for (const tool of Object.values(tools)) expect(findProviderRejectedKeywords(JSON.parse(JSON.stringify(tool.parameters)))).toEqual([]);
  });
});
