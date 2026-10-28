import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../../extensions/task-context/index.js";

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "todo-lifecycle-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const entries: any[] = [];
  const tools = new Map<string, any>();
  const hooks = new Map<string, any>();
  const events = new EventEmitter();
  let active = ["read"];
  let setting: any;
  let turns = 0;
  events.on("harness-settings:register", value => { if (value.id === "outcome-todo") setting = value; });
  const ctx: any = { cwd: dir, mode: "print", hasUI: false, sessionManager: { getBranch: () => entries }, ui: { setWidget() {}, setStatus() {}, notify() {} } };
  extension({
    events,
    registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand() {},
    on(name: string, handler: any) { hooks.set(name, handler); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; },
    sendMessage() { turns++; }, sendUserMessage() { turns++; },
  } as any);
  t.after(async () => {
    await hooks.get("session_shutdown")({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  await hooks.get("session_start")({}, ctx);
  await setting.change("On", ctx);
  const update = (input: unknown) => tools.get("update_todo").execute("update", input, undefined, undefined, ctx);
  const get = async () => (await tools.get("get_todo").execute("get", {}, undefined, undefined, ctx)).details;
  const trigger = (action: string, status: string) => {
    entries.push({ type: "custom", customType: "pi-better-goal", data: { kind: "set", goal: { goalId: "goal-one", objective: "Original user invocation", status } } });
    events.emit("pi-better-harness:task-context", { action, goalId: "goal-one", objective: "Original user invocation" });
  };
  return { entries, ctx, hooks, update, get, trigger, setting, turns: () => turns };
}

test("refining a Goal outcome preserves its binding; re-enable reconciles completion that happened while off", async t => {
  const f = await fixture(t);
  f.trigger("start", "active");
  await f.update({ outcome: { objective: "Customers can complete checkout", doneWhen: ["A payment succeeds"] } });
  assert.equal((await f.get()).outcome.goalId, "goal-one");
  f.trigger("pause", "paused");
  assert.equal((await f.get()).outcome.status, "paused");
  assert.equal(f.hooks.get("context")({ messages: [] }), undefined);
  f.trigger("resume", "active");
  assert.deepEqual((await f.get()).outcome.doneWhen, ["A payment succeeds"]);
  f.trigger("start", "active");
  assert.equal((await f.get()).outcome.objective, "Customers can complete checkout", "a replayed trigger must not replace the refined outcome");
  await f.setting.change("Off", f.ctx);
  f.trigger("complete", "complete");
  await f.setting.change("On", f.ctx);
  assert.equal((await f.get()).outcome.status, "complete");
  assert.equal(f.hooks.get("context")({ messages: [] }), undefined);
  assert.equal(f.turns(), 0, "restoring task memory must not start or resume an agent turn");
});

test("starting unrelated work detaches the old Todo and Goal without letting the old trigger pause the new task", async t => {
  const f = await fixture(t);
  f.trigger("start", "active");
  await f.update({ todo: [{ id: "checkout", step: "Verify checkout", status: "completed" }] });
  assert.equal((await f.get()).outcome.status, "active", "checklist completion is not outcome completion");
  await f.update({ newTask: true, outcome: { objective: "Investigate refunds" } });
  const task = await f.get();
  assert.equal(task.outcome.goalId, undefined);
  assert.equal(task.hasPlan, false);
  f.trigger("pause", "paused");
  assert.equal((await f.get()).outcome.status, "active");
  assert.equal((await f.get()).outcome.objective, "Investigate refunds");
});

test("a rejected checklist or workflow operation cannot partially replace the outcome", async t => {
  const f = await fixture(t);
  await f.update({ outcome: { objective: "Deliver checkout", boundaries: ["No production writes"] }, todo: [{ step: "Build", status: "in_progress" }] });
  const before = await f.get();
  const count = f.entries.length;
  await assert.rejects(f.update({ newTask: true, outcome: { objective: "Uncommitted change" }, todo: [{ step: "", status: "pending" }] }));
  await assert.rejects(f.update({ outcome: { objective: "Uncommitted change" }, workflow: { path: join(f.ctx.cwd, "missing.json"), revision: 1 } }));
  assert.equal(f.entries.length, count);
  assert.deepEqual(await f.get(), before);
});
