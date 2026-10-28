// Every model-facing output tool schema this repo registers or changed in
// #321/#322/#323 must avoid keywords a provider has been observed to reject
// (see PROVIDER_REJECTED_KEYWORDS; `uniqueItems` returned 400 in #327).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { findProviderRejectedKeywords } from "./provider-schema-compat.mjs";
import { registerTools } from "../packages/pi-better-background-tasks/src/tools.ts";
import {
  subagentListTool,
  subagentOutputTool,
  subagentResultTool,
  subagentStopTool,
} from "../packages/pi-better-subagents/tools.ts";
import taskContextExtension from "../packages/pi-better-harness/extensions/task-context/index.ts";

function plain(schema) {
  return JSON.parse(JSON.stringify(schema));
}

test("background-task tool schemas use only provider-accepted keywords", () => {
  const tools = new Map();
  registerTools({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  assert.deepEqual([...tools.keys()].sort(), ["bg_status", "bg_task", "bg_task_list", "bg_task_log", "bg_task_spawn", "bg_task_status", "bg_task_stop", "bg_task_watch"]);
  for (const [name, tool] of tools) {
    assert.deepEqual(findProviderRejectedKeywords(plain(tool.parameters)), [], name);
  }
  assert.ok(tools.get("bg_task_log").parameters.properties.lines, "canonical lines is offered");
  assert.ok(tools.get("bg_task_log").parameters.properties.tail_lines, "deprecated tail_lines is still offered");
  assert.ok(tools.get("bg_task_status").parameters.properties.maxBytes, "deprecated maxBytes is offered");
});

test("subagent list/output/result/stop schemas use only provider-accepted keywords", () => {
  for (const tool of [subagentListTool(Type), subagentOutputTool(Type), subagentResultTool(Type), subagentStopTool(Type)]) {
    assert.deepEqual(findProviderRejectedKeywords(plain(tool.parameters)), [], tool.name);
  }
  const result = plain(subagentResultTool(Type).parameters);
  assert.equal(result.properties.include.type, "array");
  assert.equal(result.properties.include.uniqueItems, undefined, "include uniqueness is enforced in code, not the schema");
  assert.ok(result.properties.lines && result.properties.max_bytes && result.properties.maxBytes);
});

test("Outcome & Todo tool schemas, including the optional outcome, use only provider-accepted keywords", async t => {
  const dir = mkdtempSync(join(tmpdir(), "todo-schema-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const tools = new Map();
  const hooks = new Map();
  const active = new Set();
  const events = new EventEmitter();
  taskContextExtension({
    events,
    registerTool(tool) { tools.set(tool.name, tool); active.add(tool.name); },
    getActiveTools: () => [...active],
    setActiveTools(names) { active.clear(); for (const name of names) active.add(name); },
    registerCommand() {},
    on(name, handler) { hooks.set(name, handler); },
    appendEntry() {},
  });
  const ctx = { hasUI: false, sessionManager: { getBranch: () => [] }, ui: { setStatus() {} } };
  await hooks.get("session_start")({}, ctx);
  t.after(() => hooks.get("session_shutdown")({}, ctx));
  assert.deepEqual([...tools.keys()].sort(), ["get_todo", "update_todo"]);
  assert.deepEqual([...active], [], "a fresh runtime exposes neither Todo tool before the human enables it");
  for (const [name, tool] of tools) {
    assert.deepEqual(findProviderRejectedKeywords(plain(tool.parameters)), [], name);
  }
  const update = plain(tools.get("update_todo").parameters);
  const todo = update.properties.todo;
  assert.equal(todo.type, "array");
  for (const field of ["dependsOn", "id", "status", "step"]) {
    assert.ok(todo.items.properties[field], `todo rows keep the ${field} field`);
  }
  const outcome = update.properties.outcome;
  assert.equal(outcome.type, "object");
  for (const field of ["boundaries", "doneWhen", "objective", "source", "status"]) {
    assert.ok(outcome.properties[field], `the outcome schema keeps ${field}`);
  }
  assert.equal(outcome.properties.doneWhen.type, "array", "doneWhen is a list, not a comma-joined string");
  assert.ok(!update.required?.includes("outcome"), "an outcome is optional so a checklist can stand alone");
});
