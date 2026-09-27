import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.js";

interface Harness {
  cwd: string;
  runDir: string;
  path: string;
  entries: Array<{ type: string; customType?: string; data?: unknown }>;
  tools: Map<string, ToolDefinition>;
  ctx: ExtensionContext;
  widget(): string;
  own(name: string | null): void;
  update(params: unknown): Promise<any>;
  plan(): any;
  cleanup(): void;
}

function planFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-9",
    planRevision: 12,
    startedAt: "2026-09-27T09:00:00Z",
    updatedAt: "2026-09-27T09:30:00Z",
    targetBranch: "main",
    warehouseCanaryRequired: false,
    combinedPr: null,
    decisions: [{ id: "d-1", timestamp: "2026-09-27T09:01:00Z", humanWords: "Split into 3 runs.", changes: "units 1-3 only", supersedes: null }],
    fleet: { explore: { status: "succeeded", attempt: 1 }, combine: "pending", canary: "not-applicable", review: { status: "pending" }, cicd: { status: "pending" } },
    units: [
      { id: "1201", title: "Fix queue stall", stage: "validate", status: "in-flight", dependsOn: [], attempt: 1, retries: 0, diagnoses: 0, worker: 1, clock: { attemptStartedAt: "2026-09-27T09:10:00Z" }, note: "running", acceptanceCriteria: "keep me" },
      { id: "1202", title: "Parse rename edges", stage: "pending", status: "pending", dependsOn: ["1201"], attempt: 0, retries: 0, diagnoses: 0, worker: null },
    ],
    components: [{ id: "C1", units: ["1201", "1202"], dependsOn: [], pr: null, headSha: null, status: "building" }],
    ...overrides,
  };
}

async function harness(options: { plan?: Record<string, unknown>; indent?: number; profiling?: Record<string, string> } = {}): Promise<Harness> {
  const cwd = mkdtempSync(join(tmpdir(), "rush-update-"));
  const runDir = join(cwd, ".resolve-issues", "rush", "run-9");
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "task-plan.json");
  writeFileSync(path, JSON.stringify(options.plan ?? planFixture(), null, options.indent ?? 2) + "\n");
  for (const [relative, text] of Object.entries(options.profiling ?? {})) {
    mkdirSync(join(runDir, relative, ".."), { recursive: true });
    writeFileSync(join(runDir, relative), text);
  }
  const entries: Harness["entries"] = [];
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let widgetFactory: any;
  const ctx = {
    cwd, mode: "tui", hasUI: true,
    sessionManager: { getBranch: () => entries },
    ui: { setStatus() {}, setWidget(_name: string, factory: unknown) { widgetFactory = factory; }, notify() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    registerCommand() {},
    on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  await handlers.get("session_start")?.({}, ctx);
  return {
    cwd, runDir, path, entries, tools, ctx,
    widget: () => widgetFactory({ requestRender() {} }, { fg: (_c: string, v: string) => v }).render(160).join("\n"),
    own(name) {
      entries.push({ type: "custom", customType: "pi-better-workflow", data: name
        ? { version: 1, kind: "set", owner: { name, planOwner: "workflow" } }
        : { version: 1, kind: "clear" } });
      pi.events.emit("pi-better-workflow:changed", name ? { name } : null);
    },
    update: (params) => tools.get("update_plan")!.execute("update", params, undefined, undefined, ctx),
    plan: () => JSON.parse(readFileSync(path, "utf8")),
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

async function boundHarness(options: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  const h = await harness(options);
  h.own("rush-issues");
  const revision = h.plan().planRevision;
  await h.tools.get("sync_workflow_plan")!.execute("bind", { path: h.path, revision }, undefined, undefined, h.ctx);
  return h;
}

function readEvents(path: string): any[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("one workflow update saves every row change as one revision with a paired profiling event", async () => {
  const h = await boundHarness();
  try {
    const before = h.plan();
    const result = await h.update({ workflow: {
      event: "unit-validated",
      revision: 12,
      changes: [
        { id: "1201", set: { stage: "done", status: "succeeded", worker: null, headSha: "abc123", note: "validated", clock: { attemptMs: 540000 } } },
        { id: "1202", set: { stage: "implement", status: "in-flight", attempt: 1, worker: 1 } },
        { id: "C1", set: { status: "combining", headSha: "abc123" } },
        { id: "combine", set: { status: "in-flight" } },
        { set: { combinedPr: "https://github.com/o/r/pull/7" } },
      ],
      decision: { id: "d-2", humanWords: "Ship C1 alone.", changes: "C1 delivers before C2", supersedes: "d-1" },
      profiling: { outcome: "succeeded", wallMs: 540000 },
    } });

    const after = h.plan();
    assert.equal(after.planRevision, 13, "several row changes are one transition");
    assert.notEqual(after.updatedAt, before.updatedAt);
    assert.ok(!Number.isNaN(Date.parse(after.updatedAt)));
    assert.deepEqual(after.units[0], { ...before.units[0], stage: "done", status: "succeeded", worker: null, headSha: "abc123", note: "validated", clock: { attemptMs: 540000 } });
    assert.equal(after.units[0].acceptanceCriteria, "keep me", "fields the call does not name are preserved");
    assert.equal(after.units[1].status, "in-flight");
    assert.equal(after.components[0].status, "combining");
    assert.deepEqual(after.fleet.combine, "in-flight", "a bare-string fleet stage keeps its string form");
    assert.deepEqual(after.fleet.explore, before.fleet.explore);
    assert.equal(after.combinedPr, "https://github.com/o/r/pull/7");
    assert.deepEqual(after.decisions.map((d: any) => [d.id, d.supersedes]), [["d-1", null], ["d-2", "d-1"]]);
    assert.equal(after.decisions[1].timestamp, after.updatedAt);
    assert.match(readFileSync(h.path, "utf8"), /^\{\n  "runId"/, "the file keeps its indentation");

    const events = readEvents(join(h.runDir, "profiling", "run.jsonl"));
    assert.equal(events.length, 1, "one transition appends one profiling event");
    assert.equal(events[0].planRevision, after.planRevision);
    assert.equal(events[0].ts, after.updatedAt);
    assert.equal(events[0].runId, "run-9");
    assert.equal(events[0].event, "unit-validated");
    assert.equal(events[0].outcome, "succeeded");
    assert.equal(events[0].wallMs, 540000);
    assert.equal(events[0].decision, "d-2");
    assert.deepEqual(events[0].changes.map((c: any) => [c.scope, c.id]), [
      ["unit", "1201"], ["unit", "1202"], ["component", "C1"], ["fleet", "combine"], ["run", undefined],
    ]);
    assert.deepEqual(events[0].changes[0].set, { stage: "done", status: "succeeded", worker: null, headSha: "abc123", note: "validated", clock: { attemptMs: 540000 } },
      "the event carries the same status, stage, counters, clock, and HEAD as the plan");

    assert.equal(result.details.revision, 13);
    assert.match(result.content[0].text, /Saved rush-issues rev 13 \(unit-validated\): #1201, #1202, C1, combine, run; decision d-2/);
    assert.match(h.widget(), /rush-issues · rev 13/, "the widget refreshes from the saved plan");
    assert.match(h.widget(), /✓\s+#1201\s+Fix queue stall/);
    const got = await h.tools.get("get_plan")!.execute("get", {}, undefined, undefined, h.ctx);
    assert.equal((got.details as any).plan.planRevision, 13);
    assert.deepEqual(readdirSync(h.runDir).filter((name) => name.endsWith(".tmp")), [], "no temp file is left behind");

    const second = await h.update({ workflow: { event: "unit-started", changes: [{ id: "1202", target: "unit", set: { stage: "validate" } }] } });
    assert.equal(second.details.revision, 14);
    const next = readEvents(join(h.runDir, "profiling", "run.jsonl"));
    assert.deepEqual(next.map((e) => e.planRevision), [13, 14]);
    assert.equal(next[1].scope, "unit");
    assert.equal(next[1].unit, "1202", "a single-row event names its unit");
  } finally {
    h.cleanup();
  }
});

test("the profiling event goes to the log the run already uses", async () => {
  const flatOnly = await boundHarness({ profiling: { "profiling.jsonl": `{"planRevision":12,"event":"x"}\n` } });
  try {
    await flatOnly.update({ workflow: { event: "tick", changes: [{ id: "1201", set: { note: "n" } }] } });
    assert.deepEqual(readEvents(join(flatOnly.runDir, "profiling.jsonl")).map((e) => e.planRevision), [12, 13]);
    assert.equal(existsSync(join(flatOnly.runDir, "profiling", "run.jsonl")), false);
  } finally {
    flatOnly.cleanup();
  }

  const both = await boundHarness({ profiling: {
    "profiling/run.jsonl": `{"planRevision":4}\n`,
    "profiling.jsonl": `{"planRevision":11}\n{"planRevision":12}`,
  } });
  try {
    const result = await both.update({ workflow: { event: "tick", changes: [{ id: "1201", set: { note: "n" } }] } });
    assert.ok(result.details.profilingPath.endsWith(join("run-9", "profiling.jsonl")), "the log with the newer revision is the live one");
    assert.deepEqual(readEvents(join(both.runDir, "profiling.jsonl")).map((e) => e.planRevision), [11, 12, 13],
      "an unterminated last line is not merged with the new event");
    assert.deepEqual(readEvents(join(both.runDir, "profiling", "run.jsonl")).map((e) => e.planRevision), [4]);
  } finally {
    both.cleanup();
  }
});

test("rejected updates leave the plan and profiling log untouched", async () => {
  const h = await boundHarness({ profiling: { "profiling/run.jsonl": `{"planRevision":12}\n` } });
  try {
    const planBefore = readFileSync(h.path, "utf8");
    const logPath = join(h.runDir, "profiling", "run.jsonl");
    const logBefore = readFileSync(logPath, "utf8");
    const cases: Array<[unknown, RegExp]> = [
      [{ event: "x", changes: [{ id: "9999", set: { status: "succeeded" } }] }, /unknown unit, component, or fleet stage id "9999"\. Known: 1201, 1202, C1, explore/],
      [{ event: "x", changes: [{ id: "C1", target: "unit", set: { status: "succeeded" } }] }, /unknown unit id "C1"/],
      [{ event: "x", changes: [{ id: "1201", set: { status: "done" } }] }, /invalid status "done"; use one of pending, in-flight/],
      [{ event: "x", changes: [{ id: "1201", set: { stage: "review" } }] }, /invalid stage "review"/],
      [{ event: "x", changes: [{ id: "C1", set: { status: "in-flight" } }] }, /invalid status "in-flight"; use one of building/],
      [{ event: "x", changes: [{ id: "review", set: { stage: "done" } }] }, /stage applies to units only/],
      [{ event: "x", changes: [{ id: "1201", set: { id: "1300" } }] }, /id cannot be changed/],
      [{ event: "x", changes: [{ set: { planRevision: 99 } }] }, /planRevision cannot be changed/],
      [{ event: "x", changes: [{ id: "1201", set: {} }] }, /must list at least one field/],
      [{ event: "x", changes: [{ id: "1201", set: { note: "a" } }, { id: "1201", set: { status: "blocked" } }] }, /repeats unit 1201/],
      [{ event: "x", revision: 11, changes: [{ id: "1201", set: { note: "a" } }] }, /revision mismatch: expected 11, found 12/],
      [{ event: " ", changes: [{ id: "1201", set: { note: "a" } }] }, /workflow.event must name the transition/],
      [{ event: "x" }, /at least one change or a decision/],
      [{ event: "x", decision: { id: "d-1", humanWords: "again", changes: "none" } }, /Decision d-1 already exists/],
      [{ event: "x", decision: { id: "d-9", humanWords: "w", changes: "c", supersedes: "d-404" } }, /supersedes names unknown decision/],
      [{ event: "x", changes: [{ id: "1201", set: { note: "a" } }], profiling: { planRevision: 1 } }, /profiling cannot set planRevision/],
      // A valid change followed by an invalid one: nothing is saved.
      [{ event: "x", changes: [{ id: "1201", set: { status: "succeeded" } }, { id: "1202", set: { status: "nope" } }] }, /changes\[1\].*invalid status/],
    ];
    for (const [workflow, pattern] of cases) {
      await assert.rejects(h.update({ workflow }), pattern, JSON.stringify(workflow));
      assert.equal(readFileSync(h.path, "utf8"), planBefore, `plan unchanged after ${JSON.stringify(workflow)}`);
      assert.equal(readFileSync(logPath, "utf8"), logBefore, `profiling unchanged after ${JSON.stringify(workflow)}`);
    }
  } finally {
    h.cleanup();
  }
});

test("an ambiguous id needs a target", async () => {
  const plan = planFixture({ components: [{ id: "review", units: ["1201"], status: "building" }] });
  const h = await boundHarness({ plan });
  try {
    await assert.rejects(h.update({ workflow: { event: "x", changes: [{ id: "review", set: { status: "blocked" } }] } }), /names more than one row \(component, fleet\); add target/);
    await h.update({ workflow: { event: "x", changes: [{ id: "review", target: "fleet", set: { status: "blocked" } }] } });
    assert.equal(h.plan().fleet.review.status, "blocked");
    assert.equal(h.plan().components[0].status, "building");
  } finally {
    h.cleanup();
  }
});

test("a failed profiling append leaves the plan at its old revision with no temp file", async () => {
  const h = await boundHarness();
  try {
    // A directory where the profiling log should be makes the append fail after the temp plan is written.
    mkdirSync(join(h.runDir, "profiling", "run.jsonl"), { recursive: true });
    const before = readFileSync(h.path, "utf8");
    await assert.rejects(h.update({ workflow: { event: "x", changes: [{ id: "1201", set: { status: "succeeded" } }] } }), /EISDIR|illegal operation/);
    assert.equal(readFileSync(h.path, "utf8"), before);
    assert.deepEqual(readdirSync(h.runDir).filter((name) => name.endsWith(".tmp")), []);
    assert.match(h.widget(), /rev 12/, "the widget still shows the saved revision");
  } finally {
    h.cleanup();
  }
});

test("a plan edited by someone else after the last sync is re-read, and a stale expected revision is refused", async () => {
  const h = await boundHarness();
  try {
    writeFileSync(h.path, JSON.stringify({ ...h.plan(), planRevision: 20 }, null, 2) + "\n");
    await assert.rejects(h.update({ workflow: { event: "x", revision: 12, changes: [{ id: "1201", set: { note: "late" } }] } }), /expected 12, found 20/);
    const result = await h.update({ workflow: { event: "x", changes: [{ id: "1201", set: { note: "late" } }] } });
    assert.equal(result.details.revision, 21, "without an expected revision the saved revision is the base");
  } finally {
    h.cleanup();
  }
});

test("workflow updates are gated on rush-issues ownership and a bound plan; generic plans are unaffected", async () => {
  const h = await harness();
  try {
    const original = readFileSync(h.path, "utf8");
    const change = { workflow: { event: "x", changes: [{ id: "1201", set: { status: "succeeded" } }] } };
    await assert.rejects(h.update(change), /No workflow owns the task plan; send plan instead of workflow/);
    await assert.rejects(h.update({}), /plan is required/);
    const generic = await h.update({ plan: [{ step: "Generic", status: "in_progress" }] });
    assert.equal((generic.details as any).plan.steps[0].step, "Generic");

    h.own("fixture");
    await assert.rejects(h.update(change), /fixture owns the task plan and does not accept/);
    h.own(null);

    h.own("rush-issues");
    await assert.rejects(h.update(change), /No rush-issues plan is bound; call sync_workflow_plan/);
    await h.tools.get("sync_workflow_plan")!.execute("bind", { path: h.path, revision: 12 }, undefined, undefined, h.ctx);
    await assert.rejects(h.update({ plan: [{ step: "Wrong", status: "pending" }] }), /Send workflow \(bound with sync_workflow_plan\) instead of plan/);
    await assert.rejects(h.update({ ...change, plan: [{ step: "Both", status: "pending" }] }), /either plan or workflow, not both/);
    assert.equal(readFileSync(h.path, "utf8"), original);
    await h.update(change);
    assert.equal(h.plan().planRevision, 13);

    h.own(null);
    await assert.rejects(h.update(change), /No workflow owns/, "releasing ownership stops workflow writes");
    const restored = await h.tools.get("get_plan")!.execute("get", {}, undefined, undefined, h.ctx);
    assert.match((restored.content[0] as { text: string }).text, /Generic/, "the generic checklist comes back unchanged");
    assert.equal(h.plan().planRevision, 13);
  } finally {
    h.cleanup();
  }
});
