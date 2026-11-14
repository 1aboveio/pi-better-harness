import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import goalExtension from "../../../pi-better-goal/src/index.js";
import { reconstructGoalSnapshot, goalSetEntry, goalWithStatus } from "../../../pi-better-goal/src/goal-state.js";
import { OUTCOME_ACCEPTED_EVENT } from "../../../pi-better-goal/src/task-context.js";
import { EXTENSION_NAME } from "../../../pi-better-goal/src/types.js";
import taskExtension from "../../extensions/task-context/index.js";
import { createSettingsRegistry } from "../../extensions/settings/registry.js";
import { OUTCOME_ENTRY, restoreOutcome } from "../../extensions/task-context/outcome-state.js";

async function fixture(t: TestContext, options: { autoStart?: boolean; harnessFirst?: boolean; restored?: boolean } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const dir = mkdtempSync(join(tmpdir(), "outcome-auto-goal-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ piBetterHarness: {
    outcomeTodo: { version: 1, enabled: true },
    goal: { version: 1, autoStartFromOutcome: options.autoStart ?? true },
  } }));
  const entries: any[] = [];
  if (options.restored) entries.push({ type: "custom", customType: OUTCOME_ENTRY, data: {
    version: 1, outcome: { objective: "Ship checkout", status: "active", doneWhen: ["Checkout succeeds"] },
  } });
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: unknown[] = [];
  const events = createEventBus();
  let active: string[] = [];
  let idle = false;
  const ctx: any = {
    cwd: dir, mode: "print", hasUI: false, isIdle: () => idle,
    sessionManager: { getBranch: () => entries, getSessionId: () => "auto-goal-session" },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  };
  const pi: any = {
    events,
    registerTool(tool: any) { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    registerShortcut() {}, getCommands: () => [],
    getActiveTools: () => active, setActiveTools(names: string[]) { active = names; },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    sendMessage(...args: unknown[]) { messages.push(args); },
    sendUserMessage(...args: unknown[]) { messages.push(args); },
    on(name: string, handler: Function) { hooks.set(name, [...hooks.get(name) ?? [], handler]); },
  };
  const settings = createSettingsRegistry(pi);
  for (const extension of options.harnessFirst ? [taskExtension, goalExtension] : [goalExtension, taskExtension]) extension(pi);
  const emit = async (name: string, event: unknown = {}) => { for (const handler of hooks.get(name) ?? []) await handler(event, ctx); };
  t.after(async () => {
    await emit("session_shutdown");
    settings.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  await emit("session_start");
  settings.refresh();
  return {
    entries, ctx, events, messages, emit, settings,
    setIdle(value: boolean) { idle = value; },
    goal: () => reconstructGoalSnapshot(entries),
    outcome: () => restoreOutcome(entries),
    update: (input: unknown) => tools.get("update_todo").execute("update", input, undefined, undefined, ctx),
    getTodo: async () => (await tools.get("get_todo").execute("get", {}, undefined, undefined, ctx)).details,
    command: (args: string) => commands.get("goal").handler(args, ctx),
  };
}

const accepted = { objective: "Ship checkout", doneWhen: ["Checkout succeeds"], boundaries: ["No production writes"] };

for (const harnessFirst of [false, true]) {
  test(`accepted outcome binds one Goal without losing Todo or sending kickoff (Harness first: ${harnessFirst})`, async t => {
    const h = await fixture(t, { harnessFirst });
    await h.update({ outcome: accepted, todo: [{ step: "Verify checkout", status: "completed" }] });
    const goal = h.goal();
    assert.equal(goal?.status, "active");
    assert.equal(goal?.objective, accepted.objective);
    assert.deepEqual(h.outcome(), { ...accepted, status: "active", goalId: goal!.goalId });
    assert.equal((await h.getTodo()).progress.completed, 1);
    assert.deepEqual(h.messages, [], "the current tool turn must not queue a duplicate kickoff");
    await h.update({ outcome: { ...accepted, objective: "Ship checkout and refunds" } });
    assert.equal(h.goal()?.goalId, goal!.goalId, "a refinement does not start a second Goal");
    assert.equal(h.outcome()?.objective, "Ship checkout and refunds");
    assert.equal(h.entries.filter(e => e.customType === EXTENSION_NAME && e.data.kind === "set").length, 1);
    await h.command("complete");
    assert.equal(h.outcome()?.status, "complete", "the existing completion bridge remains authoritative");
  });
}

for (const autoContinue of [true, false]) {
  test(`an automatically created Goal respects idle continuation (enabled: ${autoContinue})`, async t => {
    const h = await fixture(t);
    await h.command(`settings auto-continue ${autoContinue ? "on" : "off"}`);
    await h.emit("agent_start");
    await h.update({ outcome: accepted });
    assert.deepEqual(h.messages, []);
    await h.emit("agent_end", { messages: [{
      role: "assistant", content: [{ type: "text", text: "Checkout verification is still pending." }], stopReason: "stop",
    }] });
    h.setIdle(true);
    await h.emit("agent_settled");
    t.mock.timers.tick(60_000);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.messages.length, autoContinue ? 1 : 0);
    assert.equal(h.goal()?.status, "active");
  });
}

test("auto-start defaults off, enabling does not replay existing state, and disabling affects future outcomes", async t => {
  const h = await fixture(t, { autoStart: false });
  await h.update({ outcome: accepted });
  assert.equal(h.goal(), null);
  const before = h.entries.length;
  const control = h.settings.controls().find(item => item.id === "goal-auto-start")!;
  assert.equal(control.label, "Auto-start Goal");
  assert.equal(control.get(), "Off");
  await control.change("On", h.ctx);
  assert.equal(control.get(), "On");
  assert.equal(h.goal(), null);
  assert.equal(h.entries.length, before, "changing a preference does not start an existing outcome");
  await h.update({ outcome: accepted });
  assert.equal(h.goal()?.status, "active");
  await h.command("complete");
  await h.command("settings auto-start-from-outcome off");
  assert.equal(control.get(), "Off");
  const completed = h.goal()!.goalId;
  await h.update({ newTask: true, outcome: { ...accepted, objective: "Investigate refunds" } });
  assert.equal(h.goal()?.goalId, completed);
  assert.equal(h.goal()?.status, "complete");
});

test("missing acceptance criteria, inactive outcomes and slash invocations do not start Goals", async t => {
  const h = await fixture(t);
  for (const outcome of [
    { objective: "Investigate checkout" },
    { ...accepted, doneWhen: [] },
    { ...accepted, doneWhen: [" "] },
    { ...accepted, status: "paused" },
    { ...accepted, status: "complete" },
    { ...accepted, status: "cancelled" },
    { ...accepted, objective: "/skill:ship checkout" },
    { ...accepted, objective: "x".repeat(8001) },
  ]) {
    await h.update({ newTask: true, outcome });
    assert.equal(h.goal(), null);
  }
  const count = h.entries.length;
  await assert.rejects(h.update({ newTask: true, outcome: accepted, todo: [{ step: "", status: "pending" }] }));
  assert.equal(h.entries.length, count, "failed Todo validation cannot partially commit a Goal");
});

for (const status of ["active", "paused", "budgetLimited"] as const) {
  test(`auto-start never replaces or resumes an existing ${status} Goal`, async t => {
    const h = await fixture(t);
    await h.update({ outcome: accepted });
    const original = h.goal()!;
    if (status !== "active") h.entries.push({ type: "custom", customType: EXTENSION_NAME,
      data: goalSetEntry(goalWithStatus(original, status), "runtime") });
    await h.update({ newTask: true, outcome: { ...accepted, objective: "Investigate another task" } });
    assert.equal(h.goal()?.goalId, original.goalId);
    assert.equal(h.goal()?.status, status);
    assert.equal(h.outcome()?.goalId, undefined, "new task memory is not rebound to an unrelated Goal");
    assert.deepEqual(h.messages, []);
  });
}

test("a new task may start after completion, but clearing a bound Goal does not rearm that outcome", async t => {
  const h = await fixture(t);
  await h.update({ outcome: accepted });
  const first = h.goal()!.goalId;
  await h.command("complete");
  await h.update({ newTask: true, outcome: { ...accepted, objective: "Investigate refunds" } });
  assert.notEqual(h.goal()?.goalId, first);
  const second = h.goal()!.goalId;
  await h.command("clear");
  await h.update({ outcome: { ...accepted, objective: "Investigate refunds", status: "active" } });
  assert.equal(h.goal(), null);
  assert.equal(h.outcome()?.goalId, second);
});

test("session restore, branch navigation and foreign session notifications do not auto-start", async t => {
  const h = await fixture(t, { restored: true });
  assert.equal(h.goal(), null);
  await h.emit("session_tree");
  assert.equal(h.goal(), null);
  h.events.emit(OUTCOME_ACCEPTED_EVENT, { sessionId: "other-session", outcome: { ...accepted, status: "active" } });
  assert.equal(h.goal(), null);
  await h.update({ outcome: accepted });
  assert.equal(h.outcome()?.goalId, h.goal()?.goalId);
});
