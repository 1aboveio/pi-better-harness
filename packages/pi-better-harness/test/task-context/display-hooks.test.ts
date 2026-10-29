import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createGoalSnapshot, goalSetEntry } from "pi-better-goal/src/goal-state.ts";
import goalExtension from "../../../pi-better-goal/src/index.js";
import extension from "../../extensions/task-context/index.js";
import { planSetEntry, replacePlan } from "../../extensions/task-context/plan-state.js";

async function fixture(t: TestContext, preferences?: { enabled: boolean; display: boolean }, withState = true) {
  const dir = mkdtempSync(join(tmpdir(), "todo-display-hooks-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const settingsPath = join(dir, "settings.json");
  if (preferences) writeFileSync(settingsPath, JSON.stringify({ quietStartup: true, piBetterHarness: { keep: 7, outcomeTodo: { version: 1, ...preferences } } }));
  const goal = createGoalSnapshot("/skill:resolve-issues #42", null);
  const outcome = { objective: "Customers can finish checkout", status: "active", goalId: goal.goalId, doneWhen: ["Payment succeeds"], boundaries: ["No production writes"] };
  const plan = replacePlan(null, [{ step: "Verify checkout", status: "in_progress" }]);
  const entries = [
    { type: "custom", customType: "pi-better-goal", data: goalSetEntry(goal, "command") },
    { type: "custom", customType: "pi-better-harness:outcome", data: { version: 1, outcome } },
    { type: "custom", customType: "pi-better-plan", data: planSetEntry(plan) },
  ];
  if (!withState) entries.length = 0;
  const events = new EventEmitter();
  const settings = new Map<string, any>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const hooks = new Map<string, any>();
  const widgets = new Map<string, any>();
  let fullView = "";
  let active = ["read"];
  const theme = { fg: (_color: string, value: string) => value };
  events.on("harness-settings:register", control => settings.set(control.id, control));
  const ctx: any = { cwd: dir, hasUI: true, mode: "tui", isIdle: () => true, sessionManager: { getBranch: () => entries, getSessionId: () => "display-hooks" }, ui: {
    setStatus() {}, notify() {},
    setWidget(key: string, content: any) { widgets.set(key, content?.({ requestRender() {} }, theme)); },
    async custom(factory: any) { fullView = factory({ requestRender() {} }, theme, {}, () => {}).render(80).join("\n"); },
  } };
  const pi: any = { events,
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: any) { hooks.set(name, handler); },
    appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
    getActiveTools: () => active, setActiveTools: (value: string[]) => { active = value; },
  };
  extension(pi);
  t.after(async () => {
    await hooks.get("session_shutdown")({}, ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  await hooks.get("session_start")({}, ctx);
  return { dir, settingsPath, ctx, entries, goal, outcome, events, settings, tools, commands, hooks, pi, widgets,
    active: () => active, render: (width = 80) => widgets.get("pi-better-plan").render(width), fullView: () => fullView };
}

test("saved task display defaults on without enabling hooks or writing configuration or session entries", async t => {
  const f = await fixture(t);
  const before = structuredClone(f.entries);
  assert.equal(f.settings.get("outcome-todo-display").get(), "On");
  assert.equal(f.settings.get("outcome-todo").get(), "Off");
  assert.deepEqual(f.active(), ["read"]);
  assert.equal(existsSync(f.settingsPath), false);
  for (const width of [40, 100]) {
    const lines = f.render(width);
    assert.match(lines[1], /^todo\s+0\/1 complete\s+active\s+\d+:\d\d$/);
    assert.equal(lines[2], "  Customers can finish checkout");
    assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join("\n"), /resolve-issues|Outcome \(/);
  }
  f.events.emit("pi-better-harness:task-context", { action: "pause", goalId: f.goal.goalId });
  f.events.emit("pi-better-harness:task-context", { action: "start", goalId: "another", objective: "Do not capture" });
  assert.deepEqual(f.entries, before);
  assert.equal(f.hooks.get("context")({ messages: [] }), undefined);
  await assert.rejects(f.tools.get("update_todo").execute("", { outcome: { objective: "Blocked capture" } }, undefined, undefined, f.ctx), /off/);
  await f.commands.get("todo").handler("", f.ctx);
  assert.match(f.fullView(), /Customers can finish checkout/);
  assert.match(f.fullView(), /Payment succeeds/);
  assert.match(f.fullView(), /No production writes/);
});

test("an empty session stays invisible without placeholders, state writes, or implicit Goal ownership", async t => {
  const f = await fixture(t, undefined, false);
  assert.deepEqual(f.render(), []);
  assert.equal(f.entries.length, 0);
  assert.equal(existsSync(f.settingsPath), false);
  const request: any = { action: "inspect", goalId: f.goal.goalId };
  f.events.emit("pi-better-harness:task-context", request);
  assert.equal(request.display, false);
});

test("all display and hooks combinations keep visual ownership independent of capture", async t => {
  for (const display of [false, true]) for (const enabled of [false, true]) {
    await t.test(`display ${display}, hooks ${enabled}`, async t => {
      const f = await fixture(t, { display, enabled });
      const request: any = { action: "inspect", goalId: f.goal.goalId, width: 80 };
      f.events.emit("pi-better-harness:task-context", request);
      assert.equal(request.enabled, enabled);
      assert.equal(request.display, display);
      assert.equal(f.active().includes("update_todo"), enabled);
      assert.equal(f.render().length > 0, display);
      if (enabled) {
        await f.tools.get("update_todo").execute("", { outcome: { objective: "Updated accepted outcome" } }, undefined, undefined, f.ctx);
        const reminder = f.hooks.get("context")({ messages: [] });
        assert.match(reminder.messages.at(-1).content, /Updated accepted outcome/);
      }
    });
  }
});

test("display changes preserve hooks and unrelated preferences, and hidden Todo releases Goal ownership", async t => {
  const f = await fixture(t, { display: true, enabled: true });
  await f.settings.get("outcome-todo-display").change("Off", f.ctx);
  assert.deepEqual(JSON.parse(readFileSync(f.settingsPath, "utf8")), { quietStartup: true, piBetterHarness: { keep: 7, outcomeTodo: { version: 1, enabled: true, display: false } } });
  assert.ok(f.active().includes("update_todo"));
  await f.settings.get("outcome-todo-display").change("On", f.ctx);
  await f.settings.get("outcome-todo").change("Off", f.ctx);
  assert.ok(f.render().length > 0);
  const inspect = (goalId = f.goal.goalId) => {
    const request: any = { action: "inspect", goalId, width: 80 };
    f.events.emit("pi-better-harness:task-context", request);
    return request;
  };
  assert.equal(inspect().display, true);
  assert.equal(inspect("another").display, false);
  await f.commands.get("todo").handler("hide", f.ctx);
  assert.deepEqual(f.render(), []);
  assert.equal(inspect().display, false);
  await f.commands.get("todo").handler("show", f.ctx);
  assert.equal(inspect().display, true);
});

test("both real extensions hand the clock back across narrow resize boundaries", async t => {
  const f = await fixture(t, { display: true, enabled: false });
  f.entries.push({ type: "custom", customType: "pi-better-goal", data: goalSetEntry({ ...f.goal, objective: "Original resume trigger" }, "command") });
  const goalHooks = new Map<string, any>();
  goalExtension({ ...f.pi, on(name: string, handler: any) { goalHooks.set(name, handler); } });
  t.after(async () => {
    f.widgets.get("pi-better-goal")?.dispose?.();
    await goalHooks.get("session_shutdown")({}, f.ctx);
  });
  await goalHooks.get("session_start")({}, f.ctx);
  const widget = f.widgets.get("pi-better-goal");
  for (const width of [40, 17, 40]) {
    const standalone = widget.render(width).join("\n");
    const combined = f.render(width).join("\n");
    if (width === 17) {
      assert.match(standalone, /^goal active \d+:\d\d/);
      assert.doesNotMatch(combined, /\d+:\d\d/);
    } else {
      assert.equal(standalone, "");
      assert.match(combined, /active\s+\d+:\d\d/);
    }
  }
});

test("the full view retains long outcomes and all acceptance criteria beyond the compact subtitle", async t => {
  const f = await fixture(t, { display: true, enabled: true });
  const objective = `${"A long accepted outcome. ".repeat(50)}Final objective marker`;
  await f.tools.get("update_todo").execute("", { outcome: { objective, doneWhen: ["First criterion", "Second criterion", "Third criterion", "Last criterion"] } }, undefined, undefined, f.ctx);
  assert.doesNotMatch(f.render(40).join("\n"), /Final objective marker/);
  await f.commands.get("todo").handler("", f.ctx);
  assert.match(f.fullView(), /Final\s+objective\s+marker/);
  assert.match(f.fullView(), /Last criterion/);
});