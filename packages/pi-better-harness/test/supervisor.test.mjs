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

function fixture(t, scenario, client = {}, render = JSON.stringify) {
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
    getProviderAuth: async () => ({ auth: {} }),
    getProvider: () => ({ streamSimple: (_model, context) => { requests.push(context); return { result: async () => {
      await wait(20);
      return { stopReason: "stop", content: [{ type: "text", text: render({ advice: "Inspect the original acceptance criterion before expanding the plan.", evidence: ["step:one", "observation"], expected: "The accepted CI work continues.", steps: ["one"] }) }] };
    } }; } }),
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
    ...client,
  }));
  const fire = (name, event) => handlers.get(name)?.forEach(fn => fn(event, ctx));
  sessionManager.appendCustomEntry(OUTCOME_ENTRY, { version: 1, outcome: { objective: "Restore CI", status: "active" } });
  sessionManager.appendCustomEntry(EXTENSION_NAME, { kind: "set", plan: { planId: "plan", steps: [{ id: "one", step: "Refactor unrelated feature", status: "pending" }] } });
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
  f.fire("session_start", {});
  read("same"); await wait(4); read("same"); read("same"); await wait(30);
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

test("shared read faults suppress duplicate delivery and verify recovery only for the original read", async t => {
  const f = fixture(t, "shared-fault", {
    sharedReadDiagnosis: async () => ({ incident: { id: "shared", recommendation: "Retry the same observer." } }),
  });
  const emit = (id, isError, text) => f.fire("tool_result", { toolName: "bg_task_log", input: { id },
    content: [{ type: "text", text }], isError });
  const failure = "runtime-unhealthy: runtime_get_snapshot timed out";
  emit("owner-task", false, failure);
  await wait(0);
  assert.equal(f.messages.length, 0);
  emit("owner-task", true, failure);
  emit("owner-task", true, failure);
  await wait(0);
  emit("owner-task", true, failure);
  await wait(0);
  assert.equal(f.messages.length, 1);
  const rows = () => f.sessionManager.getBranch().filter(e => e.customType === "pi-better-harness:shared-read-fault").map(e => e.data.state);
  emit("other-task", false, "Running");
  assert.deepEqual(rows(), ["open"]);
  emit("owner-task", false, "Running");
  assert.deepEqual(rows(), ["open", "verified"]);
});

test("only the owner UI may answer a grouped authorization request, including a denial", async t => {
  const calls = [];
  const f = fixture(t, "shared-decisions", { decision: async (action, _proposal, token, answer) => {
    calls.push([action, token, answer]);
    return action === "decision-request" ? { status: "ask", token: "t", workspace: "repo", durationMinutes: 60 } : { status: answer ?? "missing" };
  } });
  const proposal = { reference: "case1", operation: "restart", resource: "observer", host: "local", effect: "restart one observer" };
  const ctx = { ...f.ctx, isProjectTrusted: () => true, hasUI: true, ui: { select: async title => {
    assert.match(title, /restart one observer/);
    return "Deny";
  } } };
  const run = ctx => f.tools.get("supervisor_request_decision").execute("id", proposal, undefined, undefined, ctx);
  assert.equal((await run(ctx)).details.status, "denied");
  assert.deepEqual(calls[1], ["decision-answer", "t", "denied"]);
  assert.equal((await run({ ...ctx, hasUI: false })).details.status, "missing");
  f.settings(false);
  assert.equal((await run(ctx)).details.status, "disabled");
  assert.equal(calls.length, 3);
});

test("a covered owner attaches its own verification to the settled decision", async t => {
  const f = fixture(t, "shared-decisions", { decision: async () => ({ status: "approved", expires: 60000 }) });
  const proposal = { reference: "build", operation: "restore observer", host: "local", resource: "run", effect: "observe progress" };
  const ctx = { ...f.ctx, hasUI: false, isProjectTrusted: () => true };
  const run = async extra => (await f.tools.get("supervisor_request_decision").execute("decision", { ...proposal, ...extra }, undefined, undefined, ctx)).details.status;
  assert.equal(await run({}), "approved");
  assert.equal(await run({ verifyToolCallId: "later" }), "missing observed result after approval");
  f.sessionManager.appendMessage({ role: "toolResult", toolCallId: "later", toolName: "bg_task_status", content: [{ type: "text", text: "Running" }], isError: false, timestamp: Date.now() });
  assert.equal(await run({ verifyToolCallId: "later" }), "verified");
  assert.equal(await run({}), "approved · verified");
});

test("changing user scope triggers a review after the turn even without a Todo edit", async t => {
  const f = fixture(t, "scope-review");
  f.fire("agent_end", {});
  await wait(80);
  assert.equal(f.messages.length, 1);
  f.fire("agent_end", {});
  await wait(5);
  assert.equal(f.requests.length, 1);
  f.sessionManager.appendMessage({ role: "user", content: "Keep the diagnosis limited to the deployment.", timestamp: Date.now() });
  f.fire("agent_end", {});
  await wait(80);
  assert.equal(f.requests.length, 2);
  assert.match(JSON.stringify(f.requests[1].messages), /limited to the deployment/);
  assert.equal(f.messages.length, 1, "the same proposed pruning does not interrupt again");
});

test("grounded annotated evidence from a model is accepted and unfamiliar IDs are discarded", async t => {
  let unfamiliar = false;
  const render = advice => "```json\n" + JSON.stringify({ ...advice,
    evidence: [{ id: unfamiliar ? "outside-session" : "step:one", observation: "Compare this item to the Outcome." }] }) + "\n```";
  const f = fixture(t, "scope-review", {}, render);
  f.fire("agent_end", {});
  await wait(65);
  assert.deepEqual(f.messages[0].details.evidence, ["step:one"]);
  unfamiliar = true;
  f.sessionManager.appendMessage({ role: "user", content: "Keep monitoring the original run", timestamp: Date.now() });
  f.fire("agent_end", {});
  await wait(65);
  assert.equal(f.messages.length, 1);
  assert.equal(f.sessionManager.getBranch().filter(e => e.customType === "pi-better-harness:supervisor-review").length, 1);
});
