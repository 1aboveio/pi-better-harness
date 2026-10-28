import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import subagents from "../packages/pi-better-subagents/index.ts";
import backgroundTasks from "../packages/pi-better-background-tasks/src/index.ts";
import taskContext from "../packages/pi-better-harness/extensions/task-context/index.ts";
import { setConfigForTests } from "../packages/pi-better-subagents/config.ts";
import { appendExecutionPolicy } from "../packages/pi-better-harness/extensions/execution-policy.ts";

const heading = "Harness execution policy: concurrency is separate from subagent delegation.";

// The settings writer must never touch a developer's real agent directory, and
// the runtime only starts registering active Todo tools once the setting is read.
const settingsDir = mkdtempSync(join(tmpdir(), "execution-policy-settings-"));
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = settingsDir;
writeFileSync(join(settingsDir, "settings.json"), "{}\n");
after(() => {
  if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
  rmSync(settingsDir, { recursive: true, force: true });
});

test("distributed policy modules preserve canonical append behavior", async () => {
  for (const path of [
    "../packages/pi-better-subagents/shared-execution-policy.ts",
    "../packages/pi-better-background-tasks/src/shared-execution-policy.ts",
  ]) {
    const distributed = await import(path);
    for (const prompt of ["Base instructions.", `Base instructions.\n${heading}`, appendExecutionPolicy("Base instructions.")]) {
      assert.equal(distributed.appendExecutionPolicy(prompt), appendExecutionPolicy(prompt), path);
    }
  }
});

async function harness(extensions, options = {}) {
  if (options.enableTodo === false) {
    writeFileSync(join(settingsDir, "settings.json"), `${JSON.stringify({ piBetterHarness: { outcomeTodo: { version: 1, enabled: false } } })}\n`);
  } else {
    writeFileSync(join(settingsDir, "settings.json"), "{}\n");
  }
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const controls = new Map();
  const entries = [];
  const events = new EventEmitter();
  events.on("harness-settings:register", (candidate) => {
    if (candidate && Array.isArray(candidate.values) && typeof candidate.change === "function") {
      controls.set(candidate.id, candidate);
    }
  });
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
  const todoControl = controls.get("outcome-todo");
  if (options.enableTodo !== false && todoControl) await todoControl.change("On", ctx);
  return {
    tools, commands, entries, ctx, controls,
    async context() {
      let messages = [];
      for (const handler of handlers.get("context") ?? []) {
        const result = await handler({ type: "context", messages }, ctx);
        if (result?.messages) messages = result.messages;
      }
      return messages.map(message => message.content).join("\n");
    },
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

test("each standalone execution surface delivers the shared policy without creating a todo or launching", async () => {
  for (const extension of [subagents, backgroundTasks]) {
    const h = await harness([extension]);
    const prompt = await h.prompt();
    assert.ok(prompt.startsWith("Existing user and safety instructions.\n\n"));
    assert.equal(prompt.split(heading).length - 1, 1);
    assert.equal(h.entries.length, 0, "prompt delivery must not launch work or create a todo");
  }
});

test("the Harness execution policy still applies while Outcome & Todo defaults off", async () => {
  const h = await harness([subagents, backgroundTasks, taskContext], { enableTodo: false });
  assert.equal(h.controls.get("outcome-todo")?.get(), "Off");
  const prompt = await h.prompt();
  assert.equal(prompt.split(heading).length - 1, 1, "another Harness publisher still delivers the policy");
  assert.equal(h.entries.length, 0, "a disabled feature must not write session state to deliver the policy");
});

test("combined extensions inject once in every load order and again in fresh turns and runtimes", async () => {
  for (const order of [
    [subagents, backgroundTasks, taskContext], [subagents, taskContext, backgroundTasks],
    [backgroundTasks, subagents, taskContext], [backgroundTasks, taskContext, subagents],
    [taskContext, subagents, backgroundTasks], [taskContext, backgroundTasks, subagents],
  ]) {
    const h = await harness(order);
    for (const base of ["Turn one.", "Turn two."]) {
      const prompt = await h.prompt(base);
      assert.equal(prompt.split(heading).length - 1, 1);
      assert.ok(prompt.startsWith(base));
      assert.equal((await h.prompt(prompt)).split(heading).length - 1, 1);
    }
    const reloaded = await harness(order);
    assert.equal((await reloaded.prompt("Reloaded.")).split(heading).length - 1, 1);
  }
});

test("manual mode keeps the same execution policy while four host milestones remain independently ready", async () => {
  setConfigForTests({ delegationMode: "manual" });
  try {
    const h = await harness([subagents, backgroundTasks, taskContext]);
    const hosts = ["ws", "r9", "jimac", "z4"];
    const steps = [
      { id: "acceptance", step: "Accept shared migration tools", status: "completed" },
      ...hosts.map((host) => ({ id: host, step: `Migrate ${host}`, status: "pending", dependsOn: ["acceptance"] })),
    ];
    await h.tools.get("update_todo").execute("todo", { todo: steps }, undefined, undefined, h.ctx);
    const result = await h.tools.get("get_todo").execute("get", {}, undefined, undefined, h.ctx);
    assert.deepEqual(result.details.progress.readyIndices, [1, 2, 3, 4]);
    const manual = await h.prompt();
    const manualContext = await h.context();
    await h.commands.get("subagents").handler("mode coordinator", h.ctx);
    const coordinator = await h.prompt();
    // Compare the policy paragraph only; delegation guidance may sit beside it
    // and is expected to change with settings without rewriting the policy.
    const policyBlock = (prompt) => prompt.split("\n\n").find((block) => block.startsWith(heading));
    assert.equal(policyBlock(manual), policyBlock(coordinator), "settings changes must not rewrite the static execution policy");
    assert.match(manualContext, /Delegation mode: manual/);
    assert.match(await h.context(), /Delegation mode: coordinator/);
    await h.tools.get("update_todo").execute("start", {
      todo: steps.map((step) => hosts.includes(step.id) ? { ...step, status: "in_progress" } : step),
    }, undefined, undefined, h.ctx);
    const active = await h.tools.get("get_todo").execute("active", {}, undefined, undefined, h.ctx);
    assert.equal(active.details.progress.inProgress, 4);
  } finally {
    setConfigForTests(undefined);
  }
});

test("workflow ownership suppresses stale generic guidance but not the shared safety-aware policy", async () => {
  const h = await harness([taskContext, backgroundTasks]);
  await h.tools.get("update_todo").execute("todo", {
    todo: [{ step: "Stale generic migration", status: "pending" }],
  }, undefined, undefined, h.ctx);
  h.entries.push({ type: "custom", customType: "pi-better-workflow", data: {
    version: 1, kind: "set", owner: { name: "fixture", planOwner: "workflow" },
  } });
  const prompt = await h.prompt();
  assert.equal(prompt.split(heading).length - 1, 1);
  assert.doesNotMatch(prompt, /Stale generic migration/);
  await assert.rejects(h.tools.get("update_todo").execute("overwrite", {
    todo: [{ step: "Unauthorized replacement", status: "in_progress" }],
  }, undefined, undefined, h.ctx), /owns the task plan/);
});
