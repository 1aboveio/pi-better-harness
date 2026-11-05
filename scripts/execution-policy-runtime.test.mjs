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
import { EXECUTION_POLICY_SECTION, publishExecutionPolicy } from "../packages/pi-better-harness/extensions/execution-policy.ts";

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

const policy = publishExecutionPolicy({ sections: {} }).sections[EXECUTION_POLICY_SECTION];

test("distributed policy modules publish the identical canonical section", async () => {
  for (const path of [
    "../packages/pi-better-subagents/shared-execution-policy.ts",
    "../packages/pi-better-background-tasks/src/shared-execution-policy.ts",
  ]) {
    const distributed = await import(path);
    assert.equal(distributed.EXECUTION_POLICY_SECTION, EXECUTION_POLICY_SECTION, path);
    for (const seed of [{}, { [EXECUTION_POLICY_SECTION]: "stale text" }]) {
      const options = distributed.publishExecutionPolicy({ sections: { ...seed } });
      assert.equal(options.sections[EXECUTION_POLICY_SECTION], policy, path);
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
  const forced = [];
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
  let lastSections = new Map();
  return {
    tools, commands, entries, ctx, controls, forced,
    sections: () => lastSections,
    async context() {
      let messages = [];
      for (const handler of handlers.get("context") ?? []) {
        const result = await handler({ type: "context", messages }, ctx);
        if (result?.messages) messages = result.messages;
      }
      return messages.map(message => message.content).join("\n");
    },
    // Mirrors pi's own contract: one normalized options object per turn, every
    // handler mutating `sections` in place. A handler returning `systemPrompt`
    // would set forceSystemPrompt and make the prompt opaque, so it is recorded
    // as a violation instead of being honored.
    async prompt(base = "Existing user and safety instructions.") {
      const options = { sections: {}, promptGuidelines: [], selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, appendSystemPrompt: "", contextFiles: [], skills: [], cwd: process.cwd() };
      for (const handler of handlers.get("before_agent_start") ?? []) {
        const result = await handler({ systemPromptOptions: options, systemPrompt: base }, ctx);
        if (result?.systemPrompt !== undefined) {
          forced.push(result.systemPrompt);
          options.forceSystemPrompt = result.systemPrompt;
        }
      }
      // Render the way buildSystemPromptState would: a forced prompt wins and
      // carries no sections, otherwise sections render behind the base text.
      lastSections = new Map(Object.entries(options.sections).filter(([, value]) => value));
      if (options.forceSystemPrompt !== undefined) return options.forceSystemPrompt;
      const rendered = [...lastSections.values()];
      return rendered.length ? `${base}\n\n${rendered.join("\n\n")}` : base;
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
      // pi rebuilds sections from the base options every turn, so a second turn
      // on the same base must reproduce the prompt exactly rather than stack it.
      assert.equal(await h.prompt(base), prompt);
    }
    const reloaded = await harness(order);
    assert.equal((await reloaded.prompt("Reloaded.")).split(heading).length - 1, 1);
  }
});

test("no extension forces a whole prompt, in any load order or on repeated registration", async () => {
  // A returned `systemPrompt` sets forceSystemPrompt, and pi then renders
  // `{ content }` with no sections while still diffing the sections it never
  // sends. That silently drops whichever package published last, so the ban is
  // asserted rather than assumed.
  const orders = [
    [subagents, backgroundTasks, taskContext], [subagents, taskContext, backgroundTasks],
    [backgroundTasks, subagents, taskContext], [backgroundTasks, taskContext, subagents],
    [taskContext, subagents, backgroundTasks], [taskContext, backgroundTasks, subagents],
  ];
  for (const order of orders) {
    const h = await harness(order);
    await h.prompt();
    assert.deepEqual(h.forced, [], "no extension may set a forced prompt");
  }
  for (const order of [
    [subagents, subagents, backgroundTasks], [backgroundTasks, backgroundTasks, subagents],
    [subagents, backgroundTasks, subagents, backgroundTasks],
  ]) {
    const h = await harness(order);
    const prompt = await h.prompt();
    assert.deepEqual(h.forced, [], "repeated registration must not force a prompt either");
    assert.equal(prompt.split(heading).length - 1, 1, "repeated registration must not duplicate the policy");
  }
});

test("each package owns a distinct section, so no publisher can erase another", async () => {
  const h = await harness([subagents, backgroundTasks, taskContext]);
  await h.prompt();
  assert.deepEqual([...h.sections().keys()].sort(), ["background_tasks", "harness_execution_policy", "subagents"]);
  const background = h.sections().get("background_tasks");
  assert.match(background, /Never write `sleep N` before a command when N > 3/);
  assert.match(background, /bg_task_watch/);
  assert.match(background, /wait_for_operations/);
  assert.match(background, /Nothing here diverts a foreground command for you/,
    "the section must state that nothing diverts a foreground sleep");
  assert.match(h.sections().get("subagents"), /Delegation mode: adaptive/);
  assert.equal(h.sections().get("harness_execution_policy"), policy);
});

test("a rerun rewrites identical section values, so the transcript diff stays empty", async () => {
  const h = await harness([subagents, backgroundTasks, taskContext]);
  await h.prompt();
  const first = h.sections();
  await h.prompt();
  assert.deepEqual([...h.sections()], [...first], "a fresh turn must produce byte-identical sections");
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
    await h.commands.get("subagents").handler("mode coordinator", h.ctx);
    const coordinator = await h.prompt();
    // Compare the policy paragraph only; delegation guidance may sit beside it
    // and is expected to change with settings without rewriting the policy.
    const policyBlock = (prompt) => prompt.split("\n\n").find((block) => block.startsWith(heading));
    assert.equal(policyBlock(manual), policyBlock(coordinator), "settings changes must not rewrite the static execution policy");
    // The delegation policy is carried at the end of the system prompt, not as a
    // per-request settings message, so it must be read from the prompt itself.
    assert.match(manual, /Delegation mode: manual/);
    assert.match(coordinator, /Delegation mode: coordinator/);
    assert.equal(await h.context(), "", "settings must not be injected into the request messages");
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
