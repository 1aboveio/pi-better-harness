import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import subagents from "../packages/pi-better-subagents/index.ts";
import backgroundTasks from "../packages/pi-better-background-tasks/src/index.ts";
import plan from "../packages/pi-better-plan/src/index.ts";
import { setConfigForTests } from "../packages/pi-better-subagents/config.ts";
import { appendExecutionPolicy } from "../packages/pi-better-harness/extensions/execution-policy.ts";

const heading = "Harness execution policy: concurrency is separate from subagent delegation.";

test("distributed policy modules preserve canonical append behavior on fresh and augmented prompts", async () => {
  for (const path of [
    "../packages/pi-better-subagents/shared-execution-policy.ts",
    "../packages/pi-better-background-tasks/src/shared-execution-policy.ts",
    "../packages/pi-better-plan/src/shared-execution-policy.ts",
  ]) {
    const distributed = await import(path);
    for (const prompt of ["Base instructions.", `Base instructions.\n${heading}`, appendExecutionPolicy("Base instructions.")]) {
      assert.equal(distributed.appendExecutionPolicy(prompt), appendExecutionPolicy(prompt), path);
    }
  }
});

function harness(extensions) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  const events = new EventEmitter();
  const pi = {
    events,
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
  };
  for (const extension of extensions) extension(pi);
  const ctx = {
    mode: "print", hasUI: false, cwd: process.cwd(), isIdle: () => true,
    sessionManager: { getBranch: () => entries },
    ui: { notify() {}, setWidget() {}, setStatus() {} },
  };
  return {
    tools, commands, entries, ctx,
    async prompt(base = "Existing user and safety instructions.") {
      let systemPrompt = base;
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = await handler({ systemPrompt }, ctx);
        if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
      }
      return systemPrompt;
    },
  };
}

test("each standalone execution surface delivers the shared policy without a plan or launches", async () => {
  for (const extension of [subagents, backgroundTasks, plan]) {
    const h = harness([extension]);
    const prompt = await h.prompt();
    assert.ok(prompt.startsWith("Existing user and safety instructions.\n\n"));
    assert.equal(prompt.split(heading).length - 1, 1);
    assert.equal(h.entries.length, 0, "prompt delivery must not launch work or create a plan");
  }
});

test("combined extensions inject once in every load order and again in fresh turns and runtimes", async () => {
  for (const order of [
    [subagents, backgroundTasks, plan], [subagents, plan, backgroundTasks],
    [backgroundTasks, subagents, plan], [backgroundTasks, plan, subagents],
    [plan, subagents, backgroundTasks], [plan, backgroundTasks, subagents],
  ]) {
    const h = harness(order);
    for (const base of ["Turn one.", "Turn two."]) {
      const prompt = await h.prompt(base);
      assert.equal(prompt.split(heading).length - 1, 1);
      assert.ok(prompt.startsWith(base));
      assert.equal((await h.prompt(prompt)).split(heading).length - 1, 1);
    }
    const reloaded = harness(order);
    assert.equal((await reloaded.prompt("Reloaded.")).split(heading).length - 1, 1);
  }
});

test("manual mode keeps the same execution policy while four host milestones remain independently ready", async () => {
  setConfigForTests({ delegationMode: "manual" });
  try {
    const h = harness([subagents, backgroundTasks, plan]);
    const hosts = ["ws", "r9", "jimac", "z4"];
    const steps = [
      { id: "acceptance", step: "Accept shared migration tools", status: "completed" },
      ...hosts.map((host) => ({ id: host, step: `Migrate ${host}`, status: "pending", dependsOn: ["acceptance"] })),
    ];
    await h.tools.get("update_plan").execute("plan", { plan: steps }, undefined, undefined, h.ctx);
    const result = await h.tools.get("get_plan").execute("get", {}, undefined, undefined, h.ctx);
    assert.deepEqual(result.details.progress.readyIndices, [1, 2, 3, 4]);
    const manual = await h.prompt();
    await h.commands.get("subagents").handler("mode coordinator", h.ctx);
    const coordinator = await h.prompt();
    const policyBlock = (prompt) => prompt.slice(prompt.indexOf(heading), prompt.indexOf("\n\nDelegation mode:"));
    assert.equal(policyBlock(manual), policyBlock(coordinator), "delegation changes must not change execution concurrency");
    assert.match(manual, /Delegation mode: manual/);
    assert.match(coordinator, /Delegation mode: coordinator/);
    await h.tools.get("update_plan").execute("start", {
      plan: steps.map((step) => hosts.includes(step.id) ? { ...step, status: "in_progress" } : step),
    }, undefined, undefined, h.ctx);
    const active = await h.tools.get("get_plan").execute("active", {}, undefined, undefined, h.ctx);
    assert.equal(active.details.progress.inProgress, 4);
  } finally {
    setConfigForTests(undefined);
  }
});

test("workflow ownership suppresses stale generic guidance but not the shared safety-aware policy", async () => {
  const h = harness([plan, backgroundTasks]);
  await h.tools.get("update_plan").execute("plan", {
    plan: [{ step: "Stale generic migration", status: "pending" }],
  }, undefined, undefined, h.ctx);
  h.entries.push({ type: "custom", customType: "pi-better-workflow", data: {
    version: 1, kind: "set", owner: { name: "fixture", planOwner: "workflow" },
  } });
  const prompt = await h.prompt();
  assert.equal(prompt.split(heading).length - 1, 1);
  assert.doesNotMatch(prompt, /Stale generic migration/);
  await assert.rejects(h.tools.get("update_plan").execute("overwrite", {
    plan: [{ step: "Unauthorized replacement", status: "in_progress" }],
  }, undefined, undefined, h.ctx), /owns the task plan/);
});