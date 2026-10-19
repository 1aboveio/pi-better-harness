import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import extension, { toolContext } from "./extension-fixture.js";
import { currentContinuationState, currentGoalSnapshot } from "../src/goal-state.js";
import { currentWorkflowOwner } from "../src/workflow.js";
import { runScheduler, schedulerWaitUntil, waitUntil } from "../src/workflow-gates.js";

/** Stands in for resolve-issues' next-actions.mjs: prints the run's stub.json stdout and exits with its status. */
const STUB_SCHEDULER = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const run = process.argv[process.argv.indexOf("--run") + 1];
for (const flag of ["--slots", "--peek", "--json"]) if (!process.argv.includes(flag)) { process.stderr.write("missing " + flag); process.exit(2); }
const { exit, stdout, stderr } = JSON.parse(readFileSync(run + "/stub.json", "utf8"));
if (stderr) process.stderr.write(stderr);
if (stdout !== undefined) process.stdout.write(typeof stdout === "string" ? stdout : JSON.stringify(stdout));
process.exit(exit);
`;

interface Due { action: string; unit: string | null; detail: string }
type Unit = Record<string, unknown>;

const timersMocked = new WeakSet<TestContext>();

function setup(t: TestContext, skill = "rush-issues") {
  if (!timersMocked.has(t)) {
    timersMocked.add(t);
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  }
  const dir = mkdtempSync(join(tmpdir(), "pi-goal-gates-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const skillDir = join(dir, "skills", skill);
  mkdirSync(join(skillDir, "scripts"), { recursive: true });
  const skillPath = join(skillDir, "SKILL.md");
  writeFileSync(skillPath, `---\nname: ${skill}\nmetadata:\n  workflow-role: coordinator\n---\n# ${skill}\nCoordinate.\n`);
  writeFileSync(join(skillDir, "scripts", "next-actions.mjs"), STUB_SCHEDULER);
  chmodSync(join(skillDir, "scripts", "next-actions.mjs"), 0o755);
  const runDir = join(dir, ".resolve-issues", "rush", "run-1");
  mkdirSync(runDir, { recursive: true });
  const planPath = join(runDir, "task-plan.json");

  const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, { handler(args: string, ctx: ExtensionContext): Promise<void> | void }>();
  const tools = new Map<string, ToolDefinition>();
  const userMessages: string[] = [];
  const notices: string[] = [];
  const ctx = {
    cwd: dir, hasUI: false, isIdle: () => true,
    sessionManager: { getBranch: () => entries, getSessionId: () => "gates-session" },
    ui: { notify: (text: string) => notices.push(text), setStatus() {}, setWidget() {} },
  } as unknown as ExtensionContext;
  const pi = {
    events: new EventEmitter(),
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
    getCommands: () => [{ name: `skill:${skill}`, source: "skill", sourceInfo: { path: skillPath } }],
    sendMessage() {},
    sendUserMessage(content: string) { userMessages.push(content); },
    registerCommand(name: string, command: { handler(args: string, ctx: ExtensionContext): Promise<void> | void }) { commands.set(name, command); },
    registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); },
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
  extension(pi);
  t.after(async () => { await handlers.get("session_shutdown")?.({}, ctx); });

  const scheduler = (due: Due[], exit = due.length > 0 ? 1 : 0) =>
    writeFileSync(join(runDir, "stub.json"), JSON.stringify({ exit, stdout: { due, waiting: [], mode: "full" } }));
  const plan = (units: Unit[]) => writeFileSync(planPath, JSON.stringify({ units }));
  const bindPlan = () => entries.push({ type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "set", owner: skill, path: planPath, runId: "run-1" } });
  const run = (name: string, params: object = {}) => tools.get(name)!.execute(name, params, undefined, undefined, toolContext(ctx));
  const text = (result: { content: Array<{ type: string; text?: string }> }) => result.content.map((block) => block.text ?? "").join("\n");
  const startGoal = async () => {
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await commands.get("goal")?.handler(`/skill:${skill} #1`, ctx);
    bindPlan();
  };
  return { ctx, entries, handlers, commands, userMessages, notices, scheduler, plan, startGoal, run, text, runDir, skillDir };
}

function setupRealScheduler(t: TestContext) {
  const h = setup(t);
  cpSync(new URL("./fixtures/resolve-issues/scripts/", import.meta.url), join(h.skillDir, "scripts"), { recursive: true });
  cpSync(new URL("./fixtures/engineering-runtime/", import.meta.url), join(h.skillDir, "..", "engineering-runtime"), { recursive: true });
  const bin = join(h.ctx.cwd, "bin");
  mkdirSync(bin);
  const responsePath = join(bin, "response.json");
  const callsPath = join(bin, "calls.jsonl");
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const response = JSON.parse(readFileSync(${JSON.stringify(responsePath)}, "utf8"));
process.stdout.write(JSON.stringify(response.followupError && process.argv.includes("after=next")
  ? { errors: [{ message: "follow-up unavailable" }] } : response));
`);
  chmodSync(join(bin, "gh"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${previousPath ?? ""}`;
  t.after(() => { process.env.PATH = previousPath; });
  const rawIssue = (number: number, state: string, children: object[] = []) => ({
    number, state, title: `Issue ${number}`, repository: { nameWithOwner: "fixture/repo" },
    labels: { totalCount: 0, nodes: [] }, blockedBy: { totalCount: 0, nodes: [] },
    subIssues: { totalCount: children.length, nodes: children, pageInfo: { hasNextPage: false } },
  });
  const tree = (open = false, extra = false) => writeFileSync(responsePath, JSON.stringify({ data: {
    repository: { issue: rawIssue(1, open || extra ? "OPEN" : "CLOSED", [
      rawIssue(2, open ? "OPEN" : "CLOSED"), ...(extra ? [rawIssue(3, "OPEN")] : []),
    ]) },
  } }));
  const plan = (units: Unit[]) => writeFileSync(join(h.runDir, "task-plan.json"), JSON.stringify({
    skill: "rush-issues", spec: "fixture/repo#1", units,
  }));
  const script = join(h.skillDir, "scripts", "next-actions.mjs");
  const cli = (...args: string[]) => JSON.parse(execFileSync("node", [script, "--run", h.runDir, "--slots", "1", "--peek", "--json", ...args], { encoding: "utf8" }));
  const calls = () => existsSync(callsPath) ? readFileSync(callsPath, "utf8").trim().split("\n").length : 0;
  const failFetch = () => writeFileSync(responsePath, JSON.stringify({ errors: [{ message: "API rate limit exceeded" }] }));
  const partialFetch = () => {
    const response = { data: { repository: { issue: rawIssue(1, "CLOSED") } }, followupError: true };
    const root = response.data.repository.issue;
    Object.assign(root.subIssues.pageInfo, { hasNextPage: true, endCursor: "next" });
    // The real tree fetcher's follow-up fails, yielding a partial tree with errors.
    writeFileSync(responsePath, JSON.stringify(response));
  };
  return { ...h, plan, tree, cli, calls, failFetch, partialFetch, script };
}

function runFiles(runDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${key}/`);
      else files[key] = readFileSync(join(dir, entry.name), "utf8");
    }
  };
  walk(runDir);
  return files;
}

const FINISH: Due = { action: "finish", unit: null, detail: "every unit is delivered: write the handoff" };

for (const tool of ["update_goal", "release_workflow"]) {
  test(`real scheduler: ${tool} closes a settled GitHub run after live finish without writing run inputs`, async (t) => {
    const h = setupRealScheduler(t);
    await h.startGoal();
    h.plan([{ id: "2", status: "succeeded" }]);
    h.tree();
    assert.deepEqual(h.cli("--sync").due.map((a: Due) => a.action), ["finish"]);
    assert.deepEqual(h.cli().due.map((a: Due) => a.action), ["sync"], "a prior live finish is not live evidence in a later call");
    const before = runFiles(h.runDir);
    const result = await h.run(tool, tool === "update_goal" ? { status: "complete" } : {});
    assert.equal(currentGoalSnapshot(h.ctx)?.status, tool === "update_goal" ? "complete" : "paused", h.text(result));
    assert.equal(currentWorkflowOwner(h.entries), null);
    assert.doesNotMatch(h.text(result), /Warning:/, "success comes from finish, not the fail-open fallback");
    assert.equal(h.calls(), 2, "one initial CLI fetch and one gate fetch");
    assert.deepEqual(runFiles(h.runDir), before, "live gate leaves task plan, tree, and scheduler bookkeeping unchanged");
  });
}


for (const tool of ["update_goal", "release_workflow"]) {
  for (const scenario of ["cached fallback", "partial live tree", "new issue", "missing tree"] as const) {
    test(`real scheduler: ${tool} refuses ${scenario} without a fail-open warning`, async (t) => {
      const h = setupRealScheduler(t);
      await h.startGoal();
      h.plan([{ id: "2", status: "succeeded" }]);
      h.tree();
      if (scenario !== "missing tree") h.cli("--sync");
      if (scenario === "new issue") h.tree(false, true);
      else if (scenario === "partial live tree") h.partialFetch();
      else h.failFetch();
      const before = runFiles(h.runDir);
      const result = await h.run(tool, tool === "update_goal" ? { status: "complete" } : {});
      assert.equal(currentGoalSnapshot(h.ctx)?.status, "active", h.text(result));
      assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
      assert.match(h.text(result), scenario === "new issue" ? /add-unit.*3/s : /sync.*issue tree/s);
      assert.doesNotMatch(h.text(result), /Warning:/);
      assert.equal(h.calls(), scenario === "missing tree" ? 1 : scenario === "partial live tree" ? 3 : 2);
      assert.deepEqual(runFiles(h.runDir), before);
    });
  }
}

test("real scheduler: cached due work and heartbeat probes never fetch GitHub", async (t) => {
  const h = setupRealScheduler(t);
  await h.startGoal();
  h.plan([{ id: "2", status: "pending" }]);
  h.tree(true);
  h.cli("--sync");
  const result = await h.run("update_goal", { status: "complete" });
  assert.match(h.text(result), /fill-slot/);
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "active");
  assert.match(h.text(await h.run("release_workflow")), /fill-slot/);
  h.plan([{ id: "2", status: "succeeded" }]);
  const owner = currentWorkflowOwner(h.entries)!;
  for (let probe = 0; probe < 3; probe++) {
    assert.equal(await schedulerWaitUntil(h.entries, owner), undefined);
    const cached = await runScheduler(h.script, h.runDir);
    assert.ok(cached.ok);
    assert.deepEqual(cached.due.map((a) => a.action), ["sync"]);
  }
  assert.equal(h.calls(), 1, "only the explicit setup sync used GitHub");
});

test("real scheduler: running workers still block completion and a genuine human hold can hand back", async (t) => {
  const h = setupRealScheduler(t);
  await h.startGoal();
  h.plan([{ id: "2", status: "in-flight", worker: "impl-2", workerKind: "implement" }]);
  h.tree(true);
  h.cli("--sync");
  assert.match(h.text(await h.run("update_goal", { status: "complete" })), /workers are still running/);
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "active");
  assert.equal(h.calls(), 1);
  h.plan([{ id: "2", status: "blocked", blockedReason: "human-decision", humanItem: 3, humanNeed: "Credentials unavailable" }]);
  const result = await h.run("release_workflow");
  assert.equal((result.details as { released: boolean }).released, true, h.text(result));
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "paused");
  assert.doesNotMatch(h.text(result), /Warning:/);
  assert.equal(h.calls(), 2);
});

test("real scheduler: retryable blocked work remains due after a live settlement check", async (t) => {
  const h = setupRealScheduler(t);
  await h.startGoal();
  h.plan([{ id: "2", status: "blocked", blockedReason: "retry-ci" }]);
  h.tree(true);
  h.cli("--sync");
  for (const tool of ["update_goal", "release_workflow"]) {
    const result = await h.run(tool, tool === "update_goal" ? { status: "complete" } : {});
    assert.match(h.text(result), /retry-blocked/);
    assert.equal(currentGoalSnapshot(h.ctx)?.status, "active");
    assert.doesNotMatch(h.text(result), /Warning:/);
  }
  assert.equal(h.calls(), 3);
});

test("update_goal complete is refused while the scheduler has work due, and the goal stays active", async (t) => {
  const h = setup(t);
  await h.startGoal();
  h.scheduler([{ action: "retry-blocked", unit: "261", detail: `unit 261 is blocked (retry-ci) and its cause may have cleared ${"x".repeat(400)}` }]);
  const result = await h.run("update_goal", { status: "complete" });
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "active");
  assert.equal((result.details as { ok: boolean }).ok, false);
  const message = h.text(result);
  assert.match(message, /retry-blocked \(unit 261\): unit 261 is blocked \(retry-ci\)/);
  assert.ok(message.length < 700, "each detail is cut to about 200 characters");
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues", "a refused completion keeps the workflow bound");
});

test("update_goal complete is allowed once the scheduler reports finish", async (t) => {
  const h = setup(t);
  await h.startGoal();
  h.scheduler([FINISH]);
  const result = await h.run("update_goal", { status: "complete" });
  assert.equal(h.text(result), "Goal marked complete.");
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "complete");
  assert.equal(currentWorkflowOwner(h.entries), null);
});

test("update_goal complete is refused when the scheduler prints nothing due, because workers are still running", async (t) => {
  const h = setup(t);
  await h.startGoal();
  h.scheduler([]);
  const result = await h.run("update_goal", { status: "complete" });
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "active");
  assert.equal((result.details as { ok: boolean }).ok, false);
  assert.match(h.text(result), /workers are still running; the scheduler has not reported finish/);
});

test("update_goal fails open with a warning when the scheduler errors, is missing, or the plan is unbound", async (t) => {
  const failing = setup(t);
  await failing.startGoal();
  writeFileSync(join(failing.runDir, "stub.json"), JSON.stringify({ exit: 2, stderr: "next-actions: plan is corrupt" }));
  const errored = await failing.run("update_goal", { status: "complete" });
  assert.equal(currentGoalSnapshot(failing.ctx)?.status, "complete");
  assert.match(failing.text(errored), /Goal marked complete\. Warning: could not check the rush-issues run \(the scheduler failed \(next-actions: plan is corrupt\)\)/);

  const garbled = setup(t);
  await garbled.startGoal();
  writeFileSync(join(garbled.runDir, "stub.json"), JSON.stringify({ exit: 0, stdout: "not json" }));
  assert.match(garbled.text(await garbled.run("update_goal", { status: "complete" })), /Warning: .*not JSON/);

  const missing = setup(t);
  await missing.startGoal();
  rmSync(join(missing.runDir, "..", "..", "..", "skills", "rush-issues", "scripts"), { recursive: true, force: true });
  assert.match(missing.text(await missing.run("update_goal", { status: "complete" })), /Warning: rush-issues ships no scheduler/);
  assert.equal(currentGoalSnapshot(missing.ctx)?.status, "complete");

  const unbound = setup(t);
  await unbound.handlers.get("session_start")?.({ reason: "startup" }, unbound.ctx);
  await unbound.commands.get("goal")?.handler("/skill:rush-issues #1", unbound.ctx);
  assert.match(unbound.text(await unbound.run("update_goal", { status: "complete" })), /Warning: no task plan is bound for rush-issues/);
  assert.equal(currentGoalSnapshot(unbound.ctx)?.status, "complete");
});

test("an unrelated goal is never gated", async (t) => {
  const h = setup(t);
  await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
  await h.commands.get("goal")?.handler("write the docs", h.ctx);
  assert.equal(h.text(await h.run("update_goal", { status: "complete" })), "Goal marked complete.");
});

test("release_workflow is refused for a block the run retries itself, and allowed for a human hold", async (t) => {
  const retry = setup(t);
  await retry.startGoal();
  retry.plan([{ id: "261", status: "blocked", blockedReason: "retry-ci" }, { id: "a", status: "succeeded" }]);
  retry.scheduler([{ action: "retry-blocked", unit: "261", detail: "unit 261 is blocked (retry-ci)" }]);
  const refused = await retry.run("release_workflow");
  assert.match(retry.text(refused), /unit 261 is blocked retry-ci; the run retries it itself/);
  assert.equal((refused.details as { released: boolean }).released, false);
  assert.equal(currentGoalSnapshot(retry.ctx)?.status, "active");
  assert.equal(currentWorkflowOwner(retry.entries)?.name, "rush-issues");

  const hold = setup(t);
  await hold.startGoal();
  hold.plan([{ id: "7", status: "blocked", blockedReason: "human-decision", humanItem: 3 }, { id: "a", status: "succeeded" }]);
  hold.scheduler([{ action: "unblock", unit: "7", detail: "unit 7 is blocked human-decision" }]);
  const released = await hold.run("release_workflow");
  assert.equal((released.details as { released: boolean }).released, true);
  assert.equal(currentGoalSnapshot(hold.ctx)?.status, "paused");
  assert.equal(currentGoalSnapshot(hold.ctx)?.pauseReason, "handback");

  const decision = setup(t);
  await decision.startGoal();
  decision.plan([{ id: "8", status: "blocked", blockedReason: "human-decision", humanItem: 1 }]);
  decision.scheduler([{ action: "unblock", unit: "8", detail: "decide it" }]);
  assert.match(decision.text(await decision.run("release_workflow")), /unit 8 is blocked human-decision item 1/);
  assert.equal(currentGoalSnapshot(decision.ctx)?.status, "active");
});

test("release_workflow lets a quiet unit through and fails open when the scheduler cannot run", async (t) => {
  const quiet = setup(t);
  await quiet.startGoal();
  quiet.plan([{ id: "9", status: "in-flight" }, { id: "7", status: "blocked", blockedReason: "human-decision", humanItem: 2 }]);
  quiet.scheduler([]);
  assert.equal(((await quiet.run("release_workflow")).details as { released: boolean }).released, true);

  const failing = setup(t);
  await failing.startGoal();
  failing.plan([{ id: "261", status: "blocked", blockedReason: "retry-ci" }]);
  writeFileSync(join(failing.runDir, "stub.json"), JSON.stringify({ exit: 2, stderr: "boom" }));
  const result = await failing.run("release_workflow");
  assert.equal((result.details as { released: boolean }).released, true);
  assert.match(failing.text(result), /Warning: could not check the rush-issues run/);
});

test("invoking rush-issues or resolve-issues with no goal binds one without re-running the skill", async (t) => {
  const h = setup(t);
  await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
  await h.handlers.get("input")?.({ source: "interactive", text: "  /skill:rush-issues #312 --fast  " }, h.ctx);
  const goal = currentGoalSnapshot(h.ctx);
  assert.equal(goal?.status, "active");
  assert.equal(goal?.objective, "/skill:rush-issues #312 --fast");
  assert.equal(goal?.command?.name, "skill:rush-issues");
  assert.equal(goal?.command?.source, "skill");
  assert.equal(currentWorkflowOwner(h.entries)?.name, "rush-issues");
  assert.deepEqual(h.userMessages, [], "the user's own message already runs the skill");

  await h.handlers.get("input")?.({ source: "interactive", text: "/skill:rush-issues #400" }, h.ctx);
  assert.equal(currentGoalSnapshot(h.ctx)?.goalId, goal?.goalId, "an active goal is kept, not replaced");

  await h.commands.get("goal")?.handler("pause", h.ctx);
  await h.handlers.get("input")?.({ source: "interactive", text: "/skill:rush-issues #401" }, h.ctx);
  assert.equal(currentGoalSnapshot(h.ctx)?.goalId, goal?.goalId, "a paused goal stays paused and is not replaced");
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "paused");
});

test("auto-bind skips other skills, synthetic input, and completed goals are replaced", async (t) => {
  const other = setup(t, "fixture");
  await other.handlers.get("session_start")?.({ reason: "startup" }, other.ctx);
  await other.handlers.get("input")?.({ source: "interactive", text: "/skill:fixture work" }, other.ctx);
  assert.equal(currentGoalSnapshot(other.ctx), null, "only the issue workflows bind a goal");

  const h = setup(t);
  await h.handlers.get("session_start")?.({ reason: "startup" }, h.ctx);
  await h.handlers.get("input")?.({ source: "extension", text: "/skill:rush-issues #1" }, h.ctx);
  assert.equal(currentGoalSnapshot(h.ctx), null);
  await h.handlers.get("input")?.({ source: "interactive", text: "/skill:rush-issues #1" }, h.ctx);
  const first = currentGoalSnapshot(h.ctx);
  await h.run("update_goal", { status: "complete" });
  await h.handlers.get("input")?.({ source: "interactive", text: "/skill:rush-issues #2" }, h.ctx);
  assert.notEqual(currentGoalSnapshot(h.ctx)?.goalId, first?.goalId);
  assert.equal(currentGoalSnapshot(h.ctx)?.status, "active");
});

test("a scheduler wait wakes the goal at the stated time and is not counted as no progress", async (t) => {
  const h = setup(t);
  await h.startGoal();
  const waitingUntil = () => new Date(Date.now() + 600_000).toISOString();
  const waiting = () => h.scheduler([{ action: "wait", unit: "261", detail: `unit 261 is blocked (retry-ci); its next automatic attempt is at ${waitingUntil()}: keep a heartbeat` }]);
  const goalId = currentGoalSnapshot(h.ctx)!.goalId;
  const before = h.userMessages.length;

  for (let cycle = 0; cycle < 3; cycle += 1) {
    waiting();
    await h.handlers.get("agent_settled")?.({}, h.ctx);
    t.mock.timers.tick(540_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.userMessages.length, before + cycle, `cycle ${cycle}: nothing is sent before the stated time`);
    t.mock.timers.tick(120_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(h.userMessages.length, before + cycle + 1, `cycle ${cycle}: the wake sends one continuation`);
    assert.match(h.userMessages.at(-1) ?? "", /Continue the existing goal/);
    await h.handlers.get("agent_start")?.({}, h.ctx);
    await h.handlers.get("agent_end")?.({ messages: [] }, h.ctx);
  }
  const state = currentContinuationState(h.ctx, goalId);
  assert.equal(state?.noProgressRetries ?? 0, 0);
  assert.notEqual(state?.blocked, true);
});

test("a wait with other due actions, or no parseable time, keeps the ordinary retry schedule", async (t) => {
  const h = setup(t);
  await h.startGoal();
  const before = h.userMessages.length;
  h.scheduler([
    { action: "wait", unit: "261", detail: `its next automatic attempt is at ${new Date(Date.now() + 3_600_000).toISOString()}` },
    { action: "start-review", unit: "9", detail: "review it" },
  ]);
  await h.handlers.get("agent_settled")?.({}, h.ctx);
  t.mock.timers.tick(61_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.userMessages.length, before + 1, "other work due means the normal one-minute continuation");
});

test("waitUntil reads the earliest attempt time only when wait is the sole due action", () => {
  const wait = (iso: string): Due => ({ action: "wait", unit: "1", detail: `x; its next automatic attempt is at ${iso}: keep a heartbeat` });
  assert.equal(waitUntil([wait("2026-10-18T10:00:00.000Z"), wait("2026-10-18T09:00:00.000Z")]), Date.parse("2026-10-18T09:00:00.000Z"));
  assert.equal(waitUntil([wait("2026-10-18T10:00:00.000Z"), { action: "fill-slot", unit: "2", detail: "" }]), undefined);
  assert.equal(waitUntil([{ action: "wait", unit: "1", detail: "no time here" }]), undefined);
  assert.equal(waitUntil([]), undefined);
});
