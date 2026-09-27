// Every model-facing output tool schema this repo registers or changed in
// #321/#322/#323 must avoid keywords a provider has been observed to reject
// (see PROVIDER_REJECTED_KEYWORDS; `uniqueItems` returned 400 in #327).
import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { findProviderRejectedKeywords } from "./provider-schema-compat.mjs";
import { registerTools } from "../packages/pi-better-background-tasks/src/tools.ts";
import {
  subagentListTool,
  subagentOutputTool,
  subagentResultTool,
  subagentStopTool,
} from "../packages/pi-better-subagents/tools.ts";
import planExtension from "../packages/pi-better-plan/src/index.ts";

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

test("plan tool schemas, including update_plan's workflow transition, use only provider-accepted keywords", () => {
  const tools = new Map();
  planExtension({
    events: { on: () => () => {} },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    on() {},
    appendEntry() {},
  });
  assert.deepEqual([...tools.keys()].sort(), ["get_plan", "sync_workflow_plan", "update_plan"]);
  for (const [name, tool] of tools) {
    assert.deepEqual(findProviderRejectedKeywords(plain(tool.parameters)), [], name);
  }
  const workflow = plain(tools.get("update_plan").parameters).properties.workflow;
  assert.deepEqual(Object.keys(workflow.properties).sort(), ["changes", "decision", "event", "profiling", "revision"]);
});
