import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";
import { readRushPlan } from "../src/workflow-plan.js";

test("Rush plan is a read-only workflow projection across revisions and session restore", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rush-plan-"));
  const path = join(cwd, ".resolve-issues", "rush", "run-1", "task-plan.json");
  mkdirSync(join(cwd, ".resolve-issues", "rush", "run-1"), { recursive: true });
  const file = (revision: number, status: string) => writeFileSync(path, JSON.stringify({
    runId: "run-1", planRevision: revision, warehouseCanaryRequired: false,
    fleet: { explore: { status: "succeeded" }, combine: { status: "pending" } },
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
      version: 1, kind: "set", owner: { name: "rush-issues", planOwner: "workflow" },
    } });
    pi.events.emit("pi-better-workflow:changed", { name: "rush-issues" });
    const renderWidget = () => widget({ requestRender() {} }, { fg: (_color: string, value: string) => value }).render(140).join("\n");
    assert.match(renderWidget(), /waiting for task plan/);
    await assert.rejects(update.execute("conflict", { plan: [{ step: "Wrong", status: "pending" }] }, undefined, undefined, ctx), /owns the task plan/);
    const sync = tools.get("sync_workflow_plan")!;
    await assert.rejects(sync.execute("stale", { path, revision: 2 }, undefined, undefined, ctx), /revision mismatch/);
    assert.doesNotMatch(renderWidget(), /Extract shared core/);
    await sync.execute("bind", { path, revision: 1 }, undefined, undefined, ctx);
    assert.match(renderWidget(), /Extract shared core.*self-review.*in-flight/);
    assert.match(renderWidget(), /Add mux support/);
    await commands.get("plan")!.handler("", ctx);
    assert.match(fullView, /after: #214/);
    assert.doesNotMatch(fullView, /Old generic step/);
    const result = await tools.get("get_plan")!.execute("get", {}, undefined, undefined, ctx);
    assert.equal((result.details as any).plan.planRevision, 1);
    await commands.get("plan")!.handler("clear", ctx);
    assert.match(notification, /workflow owns its plan/);

    file(2, "succeeded");
    await sync.execute("advance", { path, revision: 2 }, undefined, undefined, ctx);
    assert.match(renderWidget(), /rev 2/);
    assert.match(renderWidget(), /succeeded/);
    file(3, "diagnosing");
    await assert.rejects(sync.execute("wrong-revision", { path, revision: 2 }, undefined, undefined, ctx), /revision mismatch/);
    assert.match(renderWidget(), /plan unavailable: revision mismatch/);
    await sync.execute("reconciled", { path, revision: 3 }, undefined, undefined, ctx);
    await handlers.get("session_tree")?.({}, ctx);
    assert.match(renderWidget(), /rev 3/, "session restore reopens the bound run");
    entries.push({ type: "custom", customType: "pi-better-workflow", data: {
      version: 1, kind: "set", owner: { name: "rush-issues", planOwner: "workflow" },
    } });
    pi.events.emit("pi-better-workflow:changed", { name: "rush-issues" });
    await handlers.get("session_tree")?.({}, ctx);
    assert.match(renderWidget(), /waiting for task plan/, "a new Rush invocation cannot inherit a previous run");
    await sync.execute("new-run", { path, revision: 3 }, undefined, undefined, ctx);
    rmSync(path);
    const missing = await tools.get("get_plan")!.execute("missing", {}, undefined, undefined, ctx);
    assert.equal((missing.details as any).hasPlan, false);
    assert.match(renderWidget(), /plan unavailable/);

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
    assert.throws(() => readRushPlan(join(cwd, "task-plan.json"), cwd), /ENOENT|inside/);
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
      fleet: { explore: "pending", combine: "pending", canary: "not-applicable" },
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