import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { readRushPlan, workflowBinding } from "../src/workflow-plan.js";

for (const owner of ["rush-issues", "resolve-issues", "fixture-workflow"])
test(`${owner} plan projects revisions and restores its owner-bound session`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rush-plan-"));
  const path = join(cwd, ".resolve-issues", "rush", "run-1", "task-plan.json");
  mkdirSync(join(cwd, ".resolve-issues", "rush", "run-1"), { recursive: true });
  const file = (revision: number, status: string) => writeFileSync(path, JSON.stringify({
    runId: "run-1", planRevision: revision, warehouseCanaryRequired: false,
    fleet: { explore: { status: "succeeded" }, implement: { status: "pending" } },
    issues: [
      { id: "214", title: "Extract shared core", stage: "self-review", status, dependsOn: [], note: "validated" },
      { id: "215", title: "Add mux support", stage: "pending", status: "pending", dependsOn: ["214"] },
    ],
  }));
  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let widget: any;
  let fullView = "";
  let notification = "";
  const ctx = {
    cwd, mode: "tui", hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus() {}, setWidget(_name: string, factory: unknown) { widget = factory; },
      notify(message: string) { notification = message; },
      custom: async (factory: any) => {
        const component = factory({ requestRender() {} }, {}, {}, () => {});
        fullView = component.render(140).join("\n");
      },
    },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;

  try {
    file(1, "in-flight");
    extension(pi);
    await handlers.get("session_start")?.({}, ctx);
    const update = tools.get("update_plan")!;
    await update.execute("generic", { plan: [{ step: "Old generic step", status: "in_progress" }] }, undefined, undefined, ctx);
    entries.push({ type: "custom", customType: "pi-better-workflow", data: {
      version: 1, kind: "set", owner: { name: owner, planOwner: "workflow" },
    } });
    pi.events.emit("pi-better-workflow:changed", { name: owner });
    const renderWidgetLines = (styled = false): string[] => widget(
      { requestRender() {} },
      { fg: (color: string, value: string) => styled ? `<${color}>${value}</${color}>` : value },
    ).render(140);
    const renderWidget = () => renderWidgetLines().join("\n");
    assert.equal(renderWidget(), "", "an unsynced Rush plan stays hidden");
    await assert.rejects(update.execute("conflict", { plan: [{ step: "Wrong", status: "pending" }] }, undefined, undefined, ctx), /owns the task plan/);
    const bind = (id: string, revision: number) => update.execute(id, { workflow: { path, revision } }, undefined, undefined, ctx);
    await assert.rejects(bind("stale", 2), /revision mismatch/);
    assert.doesNotMatch(renderWidget(), /Extract shared core/);
    await bind("bind", 1);
    assert.equal(renderWidgetLines()[0], "", "the Rush section is separated from the preceding widget");
    assert.match(renderWidgetLines(true)[1] ?? "", /^<warning>plan<\/warning><dim>  0\/2 complete/);
    assert.ok((renderWidgetLines(true)[2] ?? "").includes(`${owner} · rev 1`));
    assert.match(renderWidget(), /Extract shared core.*active/);
    assert.match(renderWidget(), /Add mux support/);
    await commands.get("plan")!.handler("", ctx);
    assert.match(fullView, /self-review · in-flight/);
    assert.match(fullView, /after: #214/);
    assert.doesNotMatch(fullView, /Old generic step/);
    const result = await tools.get("get_plan")!.execute("get", {}, undefined, undefined, ctx);
    assert.equal((result.details as any).workflowOwner, owner);
    assert.ok(fullView.includes(`${owner} · rev 1`));
    assert.equal((result.details as any).plan.planRevision, 1);
    await commands.get("plan")!.handler("clear", ctx);
    assert.match(notification, /workflow owns its plan/);

    file(2, "succeeded");
    await bind("advance", 2);
    assert.match(renderWidget(), /rev 2/);
    assert.match(renderWidget(), /✓\s+#214\s+Extract shared core/);
    file(3, "diagnosing");
    await assert.rejects(bind("wrong-revision", 2), /revision mismatch/);
    assert.equal(renderWidget(), "", "a plan rejected at sync stays hidden");
    await bind("reconciled", 3);
    await handlers.get("session_tree")?.({}, ctx);
    assert.match(renderWidget(), /rev 3/, "session restore reopens the bound run");
    entries.push({ type: "custom", customType: "pi-better-workflow-plan", data: {
      version: 1, kind: "set", owner: "different-workflow", path, runId: "run-1",
    } });
    await handlers.get("session_tree")?.({}, ctx);
    assert.equal(renderWidget(), "", "restore refuses a binding belonging to another owner");
    const mismatched = await tools.get("get_plan")!.execute("mismatched", {}, undefined, undefined, ctx);
    assert.equal((mismatched.details as any).hasPlan, false);
    await assert.rejects(update.execute("mismatched", {
      workflow: { event: "advance", changes: [{ id: "214", set: { note: "wrong owner" } }] },
    }, undefined, undefined, ctx), /No .* plan is bound/);
    await bind("rebind", 3);
    entries.push({ type: "custom", customType: "pi-better-workflow", data: {
      version: 1, kind: "set", owner: { name: owner, planOwner: "workflow" },
    } });
    pi.events.emit("pi-better-workflow:changed", { name: owner });
    await handlers.get("session_tree")?.({}, ctx);
    assert.equal(renderWidget(), "", "a new Rush invocation stays hidden and cannot inherit a previous run");
    await bind("new-run", 3);
    rmSync(path);
    const missing = await tools.get("get_plan")!.execute("missing", {}, undefined, undefined, ctx);
    assert.equal((missing.details as any).hasPlan, false);
    assert.equal(renderWidget(), "", "an unavailable persisted plan stays hidden");

    entries.push({ type: "custom", customType: "pi-better-workflow", data: { version: 1, kind: "clear" } });
    pi.events.emit("pi-better-workflow:changed", null);
    assert.equal(renderWidget(), "", "a missing released plan must not reveal the stale generic checklist");
    const released = await tools.get("get_plan")!.execute("released-missing", {}, undefined, undefined, ctx);
    assert.equal((released.details as any).readOnly, true);
    assert.equal((released.details as any).hasPlan, false);
    assert.match((released.content[0] as { text: string }).text, /read-only handoff unavailable/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

interface WorkflowSessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

function workflowHarness(cwd: string, initialEntries: WorkflowSessionEntry[] = []) {
  let entries = initialEntries;
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const events = new EventEmitter();
  let widgetFactory: any;
  let fullView = "";
  let notification = "";
  const ctx = {
    cwd, mode: "tui", hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: {
      setStatus() {}, setWidget(_name: string, factory: unknown) { widgetFactory = factory; },
      notify(message: string) { notification = message; },
      custom: async (factory: any) => {
        fullView = factory({ requestRender() {} }, {}, {}, () => {}).render(140).join("\n");
      },
    },
  } as unknown as ExtensionContext;
  extension({
    events,
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI);
  return {
    ctx,
    entries: () => entries,
    start: () => handlers.get("session_start")!({}, ctx),
    navigate: async (branch: WorkflowSessionEntry[]) => {
      entries = branch;
      await handlers.get("session_tree")!({}, ctx);
    },
    owner: (name: string | null) => {
      entries.push({ type: "custom", customType: "pi-better-workflow", data: name === null
        ? { version: 1, kind: "clear" }
        : { version: 1, kind: "set", owner: { name, planOwner: "workflow" } } });
      events.emit("pi-better-workflow:changed", name === null ? null : { name });
    },
    update: (params: unknown) => tools.get("update_plan")!.execute("update", params, undefined, undefined, ctx),
    get: async () => {
      const result = await tools.get("get_plan")!.execute("get", {}, undefined, undefined, ctx);
      return { ...result, details: result.details as { hasPlan: boolean; plan: { runId?: string; planRevision?: number } | null } };
    },
    command: (args: string, context = ctx) => commands.get("plan")!.handler(args, context),
    widget: () => widgetFactory({ requestRender() {} }, { fg: (_color: string, value: string) => value }).render(140).join("\n"),
    fullView: () => fullView,
    notification: () => notification,
  };
}

function writeLifecyclePlan(cwd: string, runId: string, revision = 1) {
  const runDir = join(cwd, ".resolve-issues", "rush", runId);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "task-plan.json");
  writeFileSync(path, JSON.stringify({
    runId, planRevision: revision, fleet: {},
    issues: [{ id: "U1", title: `Deliver ${runId}`, stage: "done", status: "succeeded", dependsOn: [] }],
  }));
  return path;
}

function workflowText(result: Awaited<ReturnType<ReturnType<typeof workflowHarness>["get"]>>) {
  return (result.content[0] as { text: string }).text;
}

test("released workflow stays inspectable but cannot write; replacement and clear persist on their branches", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "released-plan-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = writeLifecyclePlan(cwd, "handoff");
  const otherPath = writeLifecyclePlan(cwd, "other");
  const profilingPath = join(cwd, ".resolve-issues", "rush", "handoff", "profiling.jsonl");
  writeFileSync(profilingPath, "");
  const harness = workflowHarness(cwd);
  await harness.start();
  await harness.update({ plan: [{ step: "Old generic", status: "in_progress" }] });
  harness.owner("fixture-workflow");
  await harness.update({ workflow: { path, revision: 1 } });
  harness.owner(null);
  const releasedBranch = [...harness.entries()];
  assert.match(harness.widget(), /read-only handoff/);
  assert.match(harness.widget(), /Deliver handoff/);
  assert.doesNotMatch(harness.widget(), /Old generic/);
  const released = await harness.get();
  assert.equal((released.details as any).workflowOwner, "fixture-workflow");
  assert.equal((released.details as any).readOnly, true);
  assert.equal((released.details as any).plan.runId, "handoff");
  assert.match(workflowText(released), /read-only handoff/);
  await harness.command("");
  assert.match(harness.fullView(), /read-only handoff/);
  assert.match(harness.fullView(), /Deliver handoff/);
  await harness.command("", { ...harness.ctx, mode: "rpc" });
  assert.match(harness.notification(), /read-only handoff/);

  const savedFile = readFileSync(path, "utf8");
  const savedEntries = structuredClone(harness.entries());
  for (const workflow of [
    { event: "advance", revision: 1, changes: [{ id: "U1", set: { note: "must not save" } }] },
    { path, event: "advance", revision: 1, profiling: { outcome: "must not log" } },
    { changes: [{ id: "U1", set: { note: "must not save" } }] },
    { decision: { id: "D1", humanWords: "must not save", changes: "scope" } },
    { path: otherPath, revision: 1 },
  ]) {
    await assert.rejects(harness.update({ workflow }), /read-only handoff.*\/skill:fixture-workflow/);
  }
  assert.equal(readFileSync(path, "utf8"), savedFile);
  assert.equal(readFileSync(profilingPath, "utf8"), "");
  assert.deepEqual(harness.entries(), savedEntries);

  writeLifecyclePlan(cwd, "handoff", 2);
  await harness.update({ workflow: { path, revision: 2 } });
  assert.match(harness.widget(), /rev 2/);
  assert.match(harness.widget(), /read-only handoff/);
  assert.deepEqual(harness.entries(), savedEntries, "read-only reload does not rebind or write session state");
  const resumed = workflowHarness(cwd, [...releasedBranch]);
  await resumed.start();
  assert.match(resumed.widget(), /read-only handoff/);
  assert.equal((await resumed.get()).details.plan?.planRevision, 2);

  await assert.rejects(harness.update({ plan: [] }), /at least one step/);
  assert.match(harness.widget(), /read-only handoff/, "a rejected generic replacement preserves the handoff");
  await harness.update({ plan: [{ step: "New generic", status: "in_progress" }] });
  assert.match(harness.widget(), /New generic/);
  assert.doesNotMatch(workflowText(await harness.get()), /read-only handoff/);
  await harness.navigate([...harness.entries()]);
  assert.match(harness.widget(), /New generic/, "replacement survives branch reconstruction");
  await harness.navigate([...releasedBranch]);
  assert.match(harness.widget(), /read-only handoff/, "returning to the released branch restores its handoff");
  await harness.command("clear");
  assert.equal(harness.widget(), "");
  assert.equal((await harness.get()).details.hasPlan, false);
  await harness.navigate([...harness.entries()]);
  assert.equal((await harness.get()).details.hasPlan, false, "clearing a handoff is durable");
});

test("a different or newly invoked workflow invalidates a released binding without leaking it across branches", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "released-branches-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = writeLifecyclePlan(cwd, "old-run");
  const newPath = writeLifecyclePlan(cwd, "new-run");
  const harness = workflowHarness(cwd);
  await harness.start();
  harness.owner("fixture-workflow");
  await harness.update({ workflow: { path, revision: 1 } });
  const activeBranch = [...harness.entries()];
  harness.owner(null);
  const handoffBranch = [...harness.entries()];

  for (const owner of ["different-workflow", "fixture-workflow"]) {
    await harness.navigate([...handoffBranch]);
    harness.owner(owner);
    assert.equal(harness.widget(), "");
    assert.equal((await harness.get()).details.hasPlan, false);
    await assert.rejects(harness.update({ workflow: { event: "advance" } }), /No .* plan is bound/);
    harness.owner(null);
    await harness.navigate([...harness.entries()]);
    assert.equal((await harness.get()).details.hasPlan, false, "release of an unbound invocation cannot revive an old run");
  }
  await harness.navigate([...activeBranch]);
  assert.match(harness.widget(), /Deliver old-run/);
  assert.doesNotMatch(harness.widget(), /read-only handoff/);
  await harness.navigate([...handoffBranch]);
  assert.match(harness.widget(), /read-only handoff/);
  harness.owner("fixture-workflow");
  await harness.update({ workflow: { path: newPath, revision: 1 } });
  harness.owner(null);
  assert.equal((await harness.get()).details.plan?.runId, "new-run");
  assert.doesNotMatch(harness.widget(), /Deliver old-run/);
});

test("hidden generic completion cleanup does not clear a released workflow handoff", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const cwd = mkdtempSync(join(tmpdir(), "released-completion-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = writeLifecyclePlan(cwd, "handoff");
  const harness = workflowHarness(cwd);
  await harness.start();
  await harness.update({ plan: [{ step: "Old completed generic", status: "completed" }] });
  harness.owner("fixture-workflow");
  await harness.update({ workflow: { path, revision: 1 } });
  harness.owner(null);
  t.mock.timers.tick(30_000);
  assert.match(harness.widget(), /read-only handoff/);
  assert.equal((await harness.get()).details.plan?.runId, "handoff");
  await harness.navigate([...harness.entries()]);
  assert.match(harness.widget(), /read-only handoff/, "generic timer cleanup must not invalidate the persisted binding");
});

test("binding replay retains release, invalidates every invocation, and respects explicit display clearing", () => {
  const binding = { owner: "fixture-workflow", path: "/fixture/task-plan.json", runId: "run-1" };
  const bound: WorkflowSessionEntry = { type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "set", ...binding } };
  const released: WorkflowSessionEntry = { type: "custom", customType: "pi-better-workflow", data: { version: 1, kind: "clear" } };
  assert.deepEqual(workflowBinding([bound, released]), binding);
  assert.deepEqual(workflowBinding([bound, released, released]), binding);
  for (const name of [binding.owner, "different-workflow"]) {
    const invoked: WorkflowSessionEntry = { type: "custom", customType: "pi-better-workflow", data: {
      version: 1, kind: "set", owner: { name, planOwner: "workflow" },
    } };
    assert.equal(workflowBinding([bound, released, invoked, released]), null);
    assert.deepEqual(workflowBinding([bound, released, invoked, bound, released]), binding);
  }
  assert.equal(workflowBinding([bound, released, { type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "clear" } }]), null);
});

test("Rush plan reader rejects unrelated paths and invalid run identity", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rush-plan-"));
  try {
    const runDir = join(cwd, ".resolve-issues", "rush", "run-2");
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "task-plan.json");
    writeFileSync(path, JSON.stringify({ runId: "another-run", planRevision: 1, fleet: {}, issues: [] }));
    assert.throws(() => readRushPlan(path, cwd), /identity or revision/);
    const unrelated = join(cwd, "task-plan.json");
    writeFileSync(unrelated, JSON.stringify({ runId: "run-2", planRevision: 1, fleet: {}, issues: [] }));
    assert.throws(() => readRushPlan(unrelated, cwd), /must be inside this project's/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Rush plan reader accepts live units and string fleet states", () => {
  const cwd = mkdtempSync(join(tmpdir(), "rush-plan-"));
  try {
    const runDir = join(cwd, ".resolve-issues", "rush", "issue-1147-20260923T094324Z");
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "task-plan.json");
    writeFileSync(path, JSON.stringify({
      runId: "issue-1147-20260923T094324Z",
      planRevision: 1,
      warehouseCanaryRequired: false,
      fleet: { explore: "pending", implement: "pending", canary: "not-applicable" },
      units: [
        { id: "U1", title: "Explore contracts", stage: "explore", status: "in_progress", dependsOn: [] },
        { id: "U2", title: "Implement authority", stage: "pending", status: "pending", dependsOn: ["U1"] },
      ],
    }));

    const plan = readRushPlan(path, cwd);
    assert.equal(plan.planRevision, 1);
    assert.deepEqual(plan.fleet.explore, { status: "pending" });
    assert.deepEqual(plan.issues.map(({ id, dependsOn }) => ({ id, dependsOn })), [
      { id: "U1", dependsOn: [] },
      { id: "U2", dependsOn: ["U1"] },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});