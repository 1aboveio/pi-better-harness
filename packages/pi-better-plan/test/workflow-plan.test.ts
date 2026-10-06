import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { readRushPlan } from "../src/workflow-plan.js";

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
    assert.match(renderWidget(), /Old generic step/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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