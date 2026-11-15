import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "./extension-fixture.js";
import { currentGoalSnapshot } from "../src/goal-state.js";
import { OPERATION_RESUME_ADMISSION, type OperationResumeGate } from "../src/operation-admission.js";
import { operationResumeSchedulerGate } from "../src/workflow-gates.js";

function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-admission-scheduler-"));
  const skill = join(root, "skill");
  mkdirSync(join(skill, "scripts"), { recursive: true });
  const planPath = join(root, "task-plan.json");
  writeFileSync(planPath, JSON.stringify({ units: [] }));
  const owner = { name: "rush-issues", path: join(skill, "SKILL.md"), role: "coordinator" as const, planOwner: "workflow" as const };
  writeFileSync(owner.path, "---\nname: rush-issues\nmetadata:\n  workflow-role: coordinator\n---\nCoordinate.\n");
  const script = join(skill, "scripts", "next-actions.mjs");
  writeFileSync(script, `
import { appendFileSync, existsSync, readFileSync, watch } from "node:fs";
const root = process.argv[process.argv.indexOf("--run") + 1];
appendFileSync(root + "/launches", process.pid + "\\n");
const watcher = watch(root, () => finish());
let finished = false;
function finish() {
  if (finished || !existsSync(root + "/release")) return;
  finished = true;
  watcher.close();
  const response = JSON.parse(readFileSync(root + "/release", "utf8"));
  process.stdout.write(JSON.stringify({ due: response.due ?? [] }));
  process.exitCode = response.exit ?? 0;
}
finish();
`);
  const entries: any[] = [{ type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "set", owner: owner.name, path: planPath } }];
  const launches = () => existsSync(join(root, "launches")) ? readFileSync(join(root, "launches"), "utf8").trim().split("\n").length : 0;
  const release = (response: object = {}) => {
    writeFileSync(join(root, "release.tmp"), JSON.stringify(response));
    renameSync(join(root, "release.tmp"), join(root, "release"));
  };
  const waitForLaunches = async (count: number) => {
    const deadline = Date.now() + 10_000;
    while (launches() < count) {
      assert.ok(Date.now() < deadline, `expected ${count} scheduler launches, saw ${launches()}`);
      await delay(10);
    }
  };
  t.after(() => { release(); rmSync(root, { recursive: true, force: true }); });
  return { root, owner, entries, planPath, script, launches, release, waitForLaunches };
}

test("overlapping admissions share one scheduler and the next admission reads fresh evidence", async (t) => {
  const h = setup(t);
  const pending = Array.from({ length: 16 }, () => operationResumeSchedulerGate(h.entries, h.owner));
  await h.waitForLaunches(1);
  h.release();
  assert.ok((await Promise.all(pending)).every((gate) => gate.ok));
  assert.equal(h.launches(), 1, "one run must not multiply scheduler traversal by candidate count");
  h.release({ due: [{ action: "wait", unit: null, detail: "next automatic attempt is at 2099-01-01T00:00:00Z" }] });
  const next = await operationResumeSchedulerGate(h.entries, h.owner);
  assert.ok(next.ok);
  assert.equal(next.waitUntil, Date.parse("2099-01-01T00:00:00Z"));
  assert.equal(h.launches(), 2, "settled permission must not be cached");
});

for (const input of ["task-plan.json", "issue-tree.json", "reviews/1-r1.json", "results/worker.json"]) {
  test(`changing ${input} while checking holds the batch and invalidates released evidence`, async (t) => {
    const h = setup(t);
    mkdirSync(join(h.root, "reviews"));
    mkdirSync(join(h.root, "results"));
    const pending = Array.from({ length: 16 }, () => operationResumeSchedulerGate(h.entries, h.owner));
    await h.waitForLaunches(1);
    writeFileSync(join(h.root, input), JSON.stringify({ revision: 2 }));
    h.release();
    assert.ok((await Promise.all(pending)).every((gate) => !gate.ok), "changed inputs cannot authorize any member of the batch");
    assert.equal(h.launches(), 1);
    const fresh = await operationResumeSchedulerGate(h.entries, h.owner);
    assert.ok(fresh.ok && fresh.isCurrent());
    writeFileSync(join(h.root, input), JSON.stringify({ revision: 3 }));
    assert.equal(fresh.isCurrent(), false, "dispatch must reject evidence invalidated after the reply");
  });
}

test("admission isolates authority, execution revision, timeout and run while sharing equivalent checks", async (t) => {
  const h = setup(t);
  const other = setup(t);
  const scope = {};
  const options = { scope, revision: "execution-1" };
  const pending = [
    operationResumeSchedulerGate(h.entries, h.owner, options),
    operationResumeSchedulerGate(h.entries, h.owner, options),
    operationResumeSchedulerGate(h.entries, h.owner, { ...options, scope: {} }),
    operationResumeSchedulerGate(h.entries, h.owner, { ...options, revision: "execution-2" }),
    operationResumeSchedulerGate(h.entries, h.owner, { ...options, timeoutMs: 10_000 }),
    operationResumeSchedulerGate(other.entries, h.owner, options),
  ];
  await Promise.all([h.waitForLaunches(4), other.waitForLaunches(1)]);
  h.release(); other.release();
  assert.ok((await Promise.all(pending)).every((gate) => gate.ok));
  assert.equal(h.launches(), 4);
  assert.equal(other.launches(), 1);
});

for (const failure of ["error", "timeout"] as const) {
  test(`${failure} holds every waiter and releases the check for retry`, async (t) => {
    const h = setup(t);
    const options = { timeoutMs: failure === "timeout" ? 3_000 : 10_000 };
    const pending = Array.from({ length: 16 }, () => operationResumeSchedulerGate(h.entries, h.owner, options));
    if (failure === "error") {
      await h.waitForLaunches(1);
      h.release({ exit: 2 });
    }
    const gates = await Promise.all(pending);
    assert.ok(gates.every((gate) => !gate.ok));
    if (failure === "timeout") assert.ok(gates.every((gate) => !gate.ok && /timed out/.test(gate.reason)));
    assert.equal(h.launches(), 1);
    const child = Number(readFileSync(join(h.root, "launches"), "utf8").trim());
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" }, "a failed check must not retain a scheduler child");
    h.release();
    assert.ok((await operationResumeSchedulerGate(h.entries, h.owner, options)).ok);
    assert.equal(h.launches(), 2);
  });
}

test("rebinding the same plan in a fresh branch snapshot invalidates an outstanding check", async (t) => {
  const h = setup(t);
  let branch = [...h.entries];
  const pending = operationResumeSchedulerGate(branch, h.owner, { getEntries: () => branch });
  await h.waitForLaunches(1);
  branch = [...branch, { type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "set", owner: h.owner.name, path: h.planPath } }];
  h.release();
  assert.equal((await pending).ok, false);
});

async function setupExtension(t: TestContext) {
  const h = setup(t);
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const events = new EventEmitter();
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  const ctx = { cwd: h.root, hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => h.entries, getSessionId: () => "admission-parent" },
    ui: { notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionContext;
  const pi = { events, on: (name: string, handler: any) => handlers.set(name, handler),
    getCommands: () => [{ name: "skill:rush-issues", source: "skill", sourceInfo: { path: h.owner.path } }],
    registerCommand: (name: string, command: any) => commands.set(name, command), registerTool() {}, registerShortcut() {}, sendMessage() {},
    appendEntry: (customType: string, data: unknown) => h.entries.push({ type: "custom", customType, data }) } as unknown as ExtensionAPI;
  extension(pi);
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  await handlers.get("session_start")({}, ctx);
  await commands.get("goal").handler("/skill:rush-issues #1", ctx);
  h.entries.push({ type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "set", owner: h.owner.name, path: h.planPath } });
  const owner = { sessionId: "admission-parent", workspace: h.root, goalId: currentGoalSnapshot(ctx)!.goalId };
  const ask = () => new Promise<OperationResumeGate>((reply) => events.emit(OPERATION_RESUME_ADMISSION, { version: 1, owner, reply }));
  return { ...h, ask, handlers, commands, ctx };
}

test("the real admission handler coalesces candidates and invalidates a grant on pause", async (t) => {
  const h = await setupExtension(t);
  const pending = Array.from({ length: 16 }, h.ask);
  await h.waitForLaunches(1);
  h.release();
  const gates = await Promise.all(pending);
  assert.ok(gates.every((gate) => gate.allowed && gate.isCurrent?.()));
  assert.equal(h.launches(), 1);
  await h.commands.get("goal").handler("pause", h.ctx);
  assert.ok(gates.every((gate) => !gate.isCurrent?.()));
  assert.equal((await h.ask()).allowed, false);
});

for (const change of ["pause", "session switch", "workflow rebind", "agent start", "shutdown"] as const) {
  test(`the real admission handler holds all pending requests after ${change}`, async (t) => {
    const h = await setupExtension(t);
    const pending = Array.from({ length: 16 }, h.ask);
    await h.waitForLaunches(1);
    if (change === "pause") await h.commands.get("goal").handler("pause", h.ctx);
    else if (change === "session switch") await h.handlers.get("session_start")({}, {
      ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "different-parent" },
    });
    else if (change === "workflow rebind") h.entries.push({ type: "custom", customType: "pi-better-workflow", data: { version: 1, kind: "set", owner: h.owner } });
    else await h.handlers.get(change === "shutdown" ? "session_shutdown" : "agent_start")({}, h.ctx);
    h.release();
    assert.ok((await Promise.all(pending)).every((gate) => !gate.allowed));
    assert.equal(h.launches(), 1);
  });
}
