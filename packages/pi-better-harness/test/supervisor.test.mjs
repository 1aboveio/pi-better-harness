import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { setTimeout as wait } from "node:timers/promises";
import { installSupervisor } from "../extensions/supervisor/index.ts";
import { updateHarnessSetting } from "../extensions/shared-harness-settings.ts";
import { OUTCOME_ENTRY } from "../extensions/task-context/outcome-state.ts";
import { EXTENSION_NAME } from "../extensions/task-context/types.ts";

function fixture(t, scenario) {
  const dir = mkdtempSync(join(tmpdir(), "pi-supervisor-extension-"));
  const prev = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });
  const settings = enabled => updateHarnessSetting("supervisorMode", () => ({ enabled, scenarios: [scenario] }));
  settings(true);
  const sessionManager = SessionManager.inMemory();
  const handlers = new Map(), tools = new Map(), messages = [], requests = [];
  const ctx = { sessionManager, cwd: dir, modelRegistry: {
    find: () => ({ id: "model", provider: "test" }),
    streamSimple: (_model, context) => { requests.push(context); return { result: async () => {
      await wait(20);
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ advice: "Inspect the original acceptance criterion before expanding the plan." }) }] };
    } }; },
  } };
  const pi = {
    on(name, callback) { handlers.set(name, [...(handlers.get(name) ?? []), callback]); },
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand() {},
    appendEntry: (key, data) => sessionManager.appendCustomEntry(key, data),
    sendMessage: m => messages.push(m),
  };
  installSupervisor(pi, async () => ({
    close() {}, review: async () => ({ status: "admitted", token: "one" }),
    role: async () => ({ instructions: "Diagnose", model: "test/model", revision: "r1" }),
  }));
  const fire = (name, event) => handlers.get(name)?.forEach(fn => fn(event, ctx));
  sessionManager.appendCustomEntry(OUTCOME_ENTRY, { version: 1, outcome: { objective: "Restore CI", status: "active" } });
  sessionManager.appendCustomEntry(EXTENSION_NAME, { kind: "set", plan: { steps: [{ id: "one", step: "Refactor unrelated feature", status: "pending" }] } });
  return { settings, messages, requests, sessionManager, fire, ctx, tools };
}

test("scope-only review steers the owner once against the current plan and suppresses queued advice on disable", async t => {
  const f = fixture(t, "scope-review");
  const event = { toolName: "update_todo", input: { todo: [] }, content: [], isError: false };
  f.fire("tool_result", event);
  await wait(60);
  assert.equal(f.messages.length, 1);
  assert.match(JSON.stringify(f.requests[0].messages), /Refactor unrelated feature/);
  f.fire("tool_result", event);
  await wait(40);
  assert.equal(f.requests.length, 1);
  f.sessionManager.appendMessage({ role: "user", content: "Review new boundaries", timestamp: 5 });
  f.fire("tool_result", event);
  await wait(2);
  f.settings(false);
  await wait(60);
  assert.equal(f.messages.length, 1);
});

test("stalled identical successful reads get one review while changing evidence and external observation remain quiet", async t => {
  const prev = process.env.PI_BETTER_STALL_MS;
  process.env.PI_BETTER_STALL_MS = "1";
  t.after(() => { if (prev === undefined) delete process.env.PI_BETTER_STALL_MS; else process.env.PI_BETTER_STALL_MS = prev; });
  const f = fixture(t, "stall-diagnosis");
  const read = text => f.fire("tool_result", { toolName: "read", input: { path: "source" }, isError: false, content: [{ type: "text", text }] });
  for (const v of ["a", "b", "c"]) read(v);
  for (let i = 0; i < 4; i++) f.fire("tool_result", { toolName: "bg_task_list", input: {}, isError: false, content: [] });
  assert.equal(f.requests.length, 0);
  read("same"); await wait(4); read("same"); read("same"); await wait(60); read("same"); await wait(40);
  assert.equal(f.requests.length, 1);
  assert.equal(f.messages.length, 1);
});

test("a follow-up query reuses the commitment; verification requires distinct observed results", async t => {
  const f = fixture(t, "commitment-followup");
  const tool = p => f.tools.get("supervisor_followup").execute("id", p, undefined, undefined, f.ctx);
  const accept = { action: "accept", recovery: "Resume observation", verification: "Read the current CI stage" };
  const response = await tool(accept);
  const id = response.content[0].text.split(" ")[0];
  assert.deepEqual(await tool(accept), response);
  const evidence = (id, text) => f.sessionManager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
  await assert.rejects(tool({ id, action: "attempt", toolCallId: "invented", observation: "started" }));
  evidence("start", "Watcher attached");
  assert.match((await tool({ id, action: "attempt", toolCallId: "start", observation: "Attached" })).content[0].text, /attempted/);
  evidence("check", "Building");
  assert.match((await tool({ id, action: "verify", toolCallId: "check", observation: "CI stage is Building" })).content[0].text, /verified/);
  assert.match((await tool({ id, action: "status" })).content[0].text, /CI stage is Building/);
  assert.equal(f.messages.length, 0);
});
