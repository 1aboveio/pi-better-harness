import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import installGoal from "pi-better-goal/src/index.ts";
import { sessionIdleEvent } from "pi-better-goal/src/types.ts";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import recapExtension from "../extensions/recap/index.ts";
import { DEFAULT_PROMPT, ENTRY, latestAnswer, parseSummary, summarize } from "../extensions/recap/summary.ts";

const reply = { recap: "PR merged. Local Pi still uses 0.51.3.", next: "Verify the staged install." };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-recap-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  });
  const sessionManager = SessionManager.inMemory();
  const requests = [],
    settings = new Map(),
    handlers = new Map(),
    commands = new Map();
  const renderers = new Map(), bus = new EventEmitter(),
    updates = [],
    notices = [];
  let editorResult,
    editorInitial,
    response = Promise.resolve(fauxAssistantMessage(JSON.stringify(reply)));
  const model = { provider: "test", id: "physical" };
  const ctx = {
    cwd: dir,
    mode: "tui",
    hasUI: true,
    sessionManager,
    isIdle: () => true,
    hasPendingMessages: () => false,
    modelRegistry: {
      find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
      streamSimple(model, context, options) {
        requests.push({ model, context, options });
        return { result: () => response };
      },
    },
    ui: {
      setWidget: key => assert.notEqual(key, ENTRY, "Recap belongs in the transcript"),
      notify: (...args) => notices.push(args),
      editor: async (_title, value) => {
        editorInitial = value;
        return editorResult;
      },
    },
  };
  const fire = (name, event = {}) => handlers.get(name)?.(event, ctx);
  const pi = {
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (name, cmd) => commands.set(name, cmd),
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
    appendEntry: (key, data) => {
      updates.push(data);
      sessionManager.appendCustomEntry(key, data);
    },
    events: {
      on: (key, handler) => { bus.on(key, handler); return () => bus.off(key, handler); },
      emit: (key, data) => {
        bus.emit(key, data);
        if (key === "harness-settings:register") settings.set(data.id, data);
      },
    },
  };
  const start = () => {
    recapExtension(pi);
    fire("session_start");
  };
  start();
  function answer(question = "Ship", text = "PR merged.") {
    fire("agent_start");
    sessionManager.appendMessage({ role: "user", content: question, timestamp: 1 });
    const message = { ...fauxAssistantMessage(text), provider: model.provider, model: model.id };
    const id = sessionManager.appendMessage(message);
    fire("agent_end", { messages: [message] });
    return id;
  }
  return {
    ctx,
    sessionManager,
    fire,
    answer,
    requests,
    bus, pi,
    rendered(expanded = false, width = 80) {
      const result = [];
      for (const entry of sessionManager.getBranch()) {
        if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
        const render = renderers.get(ENTRY);
        const component = render(entry, { expanded }, { fg: (_, text) => text });
        if (component) result.push(...component.render(width).map(line => line.trimEnd()));
      }
      return result;
    },
    updates,
    notices,
    settings,
    start,
    switchTo: (value) => settings.get("session-recap").change(value, ctx),
    async edit(value) {
      editorResult = value;
      await settings.get("recap-prompt").open(ctx);
      return editorInitial;
    },
    respond(value) {
      response = value;
    },
  };
}

test("settings edit, cancel and restore the auxiliary prompt without changing foreground context", async (t) => {
  const f = fixture(t);
  f.answer();
  f.fire("agent_settled");
  assert.equal(f.requests.length, 0);
  assert.equal(await f.edit("Use Chinese."), DEFAULT_PROMPT);
  assert.equal(await f.edit(undefined), "Use Chinese.");
  f.switchTo("On");
  f.start();
  assert.equal(f.settings.get("session-recap").get(), "On");
  const id = f.answer();
  const before = f.sessionManager.buildSessionContext();
  f.fire("agent_settled");
  f.fire("agent_settled");
  await tick();
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].context.systemPrompt, /Use Chinese\./);
  assert.equal(f.requests[0].context.tools, undefined);
  assert.notEqual(f.requests[0].options.sessionId, f.sessionManager.getSessionId());
  assert.deepEqual(f.sessionManager.buildSessionContext(), before);
  assert.equal(f.updates[0].sourceId, id);
  assert.equal(f.updates[0].next, reply.next);
  assert.ok(f.rendered().some(line => line.includes(reply.recap)));
  f.start();
  assert.ok(f.rendered().some(line => line.includes(reply.recap)));
  assert.equal(f.requests.length, 1);
  assert.equal(await f.edit(""), "Use Chinese.");
  assert.equal(await f.edit(undefined), DEFAULT_PROMPT);
  f.answer();
  f.fire("agent_settled");
  await tick();
  assert.ok(f.requests[1].context.systemPrompt.includes(DEFAULT_PROMPT));
  assert.notEqual(f.requests[1].options.sessionId, f.requests[0].options.sessionId);
  f.switchTo("Off");
  assert.equal(f.rendered(false, 20).length, 2, "each saved recap occupies one transcript line");
  assert.ok(f.rendered(true).some(line => line.includes(reply.next)));
});

test("late replies cannot write to an abandoned branch, a new run, or a disabled session", async (t) => {
  const f = fixture(t);
  f.switchTo("On");
  const base = f.sessionManager.appendCustomEntry("base", {});
  for (const reason of ["branch", "new-run", "off", "shutdown"]) {
    let finish;
    f.respond(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    f.answer();
    f.fire("agent_settled");
    const req = f.requests.at(-1);
    if (reason === "branch") {
      f.sessionManager.branch(base);
      f.fire("session_tree");
    }
    if (reason === "new-run") f.fire("agent_start");
    if (reason === "off") f.switchTo("Off");
    if (reason === "shutdown") f.fire("session_shutdown");
    assert.equal(req.options.signal.aborted, true);
    finish(fauxAssistantMessage(JSON.stringify(reply)));
    await tick();
    assert.equal(f.updates.length, 0);
    f.switchTo("On");
  }
});

test("transcript replay follows the source answer and preserves a locally saved recap without a provider", async (t) => {
  const f = fixture(t);
  f.switchTo("On");
  const base = f.sessionManager.appendCustomEntry(ENTRY, { version: 1, recap: "Legacy turn widget" });
  assert.deepEqual(f.rendered(), [], "old widget entries lack verified idle evidence");
  f.answer();
  f.fire("agent_settled");
  await tick();
  const leaf = f.sessionManager.getLeafId();
  f.sessionManager.branch(base);
  f.fire("session_tree");
  assert.equal(f.rendered().length, 0);
  delete f.ctx.modelRegistry.streamSimple;
  f.sessionManager.branch(leaf);
  f.fire("session_tree");
  assert.ok(f.rendered().some(line => line.includes(reply.recap)));
  f.answer();
  f.fire("agent_settled");
  await tick();
  assert.equal(f.requests.length, 1);
});

test("skips busy, aborted and noninteractive settlements; rejected or malformed output never produces a panel", async (t) => {
  const f = fixture(t);
  f.switchTo("On");
  f.answer();
  f.fire("agent_settled", { aborted: true });
  f.ctx.hasPendingMessages = () => true;
  f.answer();
  f.fire("agent_settled");
  f.ctx.hasPendingMessages = () => false;
  for (const mode of ["rpc", "json", "print"]) {
    f.ctx.mode = mode;
    f.answer();
    f.fire("agent_settled");
  }
  assert.equal(f.requests.length, 0);
  f.ctx.mode = "tui";
  for (const output of ["invalid", "{}", '{"recap":"bad\\u001b[2J"}', JSON.stringify({ recap: "a".repeat(501) })]) {
    f.respond(Promise.resolve(fauxAssistantMessage(output)));
    f.answer();
    f.fire("agent_settled");
    await tick();
  }
  f.respond(Promise.reject(new Error("unavailable")));
  f.answer();
  f.fire("agent_settled");
  await tick();
  assert.equal(f.updates.length, 0);
  assert.deepEqual(parseSummary({ recap: "Done" }), { recap: "Done" });
});

test("Recap waits for both the real Goal and this session's workers, then appears once in the transcript", async (t) => {
  const f = fixture(t);
  const handlers = new Map(), commands = new Map();
  installGoal({ ...f.pi,
    on(event, handler) { const group = handlers.get(event) ?? []; group.push(handler); handlers.set(event, group); },
    registerCommand: (name, command) => commands.set(name, command),
    registerTool() {}, sendMessage() {}, sendUserMessage() {},
    appendEntry: (type, data) => f.sessionManager.appendCustomEntry(type, data),
  });
  const fireGoal = async (event, data = {}) => {
    for (const handler of handlers.get(event) ?? []) await handler(data, f.ctx);
  };
  let running = true, coverage = "verified", notify;
  f.bus.emit("pi-better-goal:register-provider", {
    id: "subagents", activityVersion: 1,
    getActivity: () => ({ providerId: "subagents", coverage, nextDeadline: null,
      items: running ? [{ id: "worker", status: "running", active: true }] : [] }),
    onActivityChanged(callback) { notify = callback; return () => {}; },
  });
  await fireGoal("session_start");
  t.after(() => fireGoal("session_shutdown"));
  f.switchTo("On");
  const command = args => commands.get("goal").handler(args, f.ctx);
  await command("Ship the change");
  await fireGoal("agent_start");
  f.answer();
  f.fire("agent_settled");
  await fireGoal("agent_settled");
  assert.equal(f.requests.length, 0);
  await command("pause");
  for (let i = 0; i < 16; ++i) f.bus.emit(sessionIdleEvent("other-" + i), true);
  assert.equal(f.requests.length, 0, "a paused Goal with an active worker still waits");
  let unrelatedUpdates = 0;
  for (let i = 0; i < 16; ++i) f.bus.on(sessionIdleEvent("other-" + i), () => unrelatedUpdates++);
  coverage = "unverified"; running = false; notify(); await tick();
  assert.equal(f.requests.length, 0);
  coverage = "verified"; notify(); await tick();
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].context.systemPrompt, /Goal is now paused/);
  assert.equal(f.updates.length, 1);
  notify(); await tick();
  assert.equal(f.requests.length, 1);

  await command("resume");
  await fireGoal("agent_start");
  f.answer();
  await fireGoal("agent_settled");
  f.fire("agent_settled");
  assert.equal(f.requests.length, 1, "an active Goal still waits with zero workers");
  await command("complete"); await tick();
  assert.match(f.requests[1].context.systemPrompt, /Goal is now complete/);
  assert.equal(f.updates.length, 2);
  assert.equal(unrelatedUpdates, 0, "only the owning session was notified");
});

test("an interrupted, paused Goal summarizes visible progress from this exchange only", async t => {
  const f = fixture(t);
  f.switchTo("On");
  const channel = sessionIdleEvent(f.sessionManager.getSessionId());
  f.bus.on(channel + ":inspect", state => { state.idle = true; });
  f.sessionManager.appendCustomEntry("pi-better-goal", {
    kind: "set", goal: { goalId: "paused", objective: "Verify the migration", status: "paused" },
  });
  for (const progress of [undefined, "First migration check passed."]) {
    f.fire("agent_start");
    f.sessionManager.appendMessage({ role: "user", content: "Check the migration", timestamp: 1 });
    if (progress) f.sessionManager.appendMessage({
      ...fauxAssistantMessage(progress), provider: "test", model: "physical", stopReason: "toolUse",
    });
    const aborted = { ...fauxAssistantMessage(""), provider: "test", model: "physical", stopReason: "aborted" };
    f.sessionManager.appendMessage(aborted);
    f.fire("agent_end", { messages: [aborted] });
    f.fire("agent_settled", { aborted: true });
    await tick();
    assert.equal(f.requests.length, progress ? 1 : 0);
  }
  assert.match(f.requests[0].context.systemPrompt, /turn was interrupted/);
  assert.match(f.requests[0].context.messages[0].content, /First migration check passed/);
});

test("work resuming during generation drops the late summary and waits for the next idle transition", async (t) => {
  const f = fixture(t);
  const channel = sessionIdleEvent(f.sessionManager.getSessionId());
  let idle = true, finish;
  f.bus.on(channel + ":inspect", state => { state.idle = idle; });
  f.switchTo("On");
  f.respond(new Promise(resolve => { finish = resolve; }));
  f.answer(); f.fire("agent_settled");
  idle = false; f.bus.emit(channel, idle);
  assert.equal(f.requests[0].options.signal.aborted, true);
  finish(fauxAssistantMessage(JSON.stringify(reply))); await tick();
  assert.equal(f.updates.length, 0);
  f.respond(Promise.resolve(fauxAssistantMessage(JSON.stringify(reply))));
  idle = true; f.bus.emit(channel, idle); await tick();
  assert.equal(f.updates.length, 1);
  assert.equal(f.bus.listenerCount(channel), 0);
});

test("a completed summary waits through unconfirmed activity without another model request", async t => {
  const f = fixture(t);
  const channel = sessionIdleEvent(f.sessionManager.getSessionId());
  let idle = true, finish;
  f.bus.on(channel + ":inspect", state => { state.idle = idle; });
  f.switchTo("On");
  f.respond(new Promise(resolve => { finish = resolve; }));
  f.answer(); f.fire("agent_settled");
  idle = "checking"; f.bus.emit(channel, idle);
  finish(fauxAssistantMessage(JSON.stringify(reply))); await tick();
  assert.equal(f.requests[0].options.signal.aborted, false);
  assert.equal(f.updates.length, 0);
  idle = true; f.bus.emit(channel, idle);
  assert.equal(f.requests.length, 1);
  assert.equal(f.updates.length, 1);
});

test("the configured provider retains foreground inputs and warm-cache reads across a real auxiliary call", async (t) => {
  const f = fixture(t);
  const core = createFauxCore({ tokensPerSecond: 10000 });
  const model = core.getModel();
  f.ctx.modelRegistry.find = () => model;
  const observed = [];
  f.ctx.modelRegistry.streamSimple = (m, c, o) => {
    observed.push({ m, c, o });
    return core.streamSimple(m, c, o);
  };
  const main = {
    systemPrompt: "Steady main rules",
    messages: [{ role: "user", content: "long stable prefix ".repeat(350), timestamp: 1 }],
    tools: [],
  };
  const next = { ...main, messages: [...main.messages, { role: "user", content: "continue", timestamp: 2 }] };
  async function foreground(key, context) {
    core.appendResponses([fauxAssistantMessage("ok")]);
    const response = await f.ctx.modelRegistry.streamSimple(model, context, { sessionId: key }).result();
    return response.usage.cacheRead;
  }
  await foreground("baseline", main);
  const baseline = await foreground("baseline", next);
  const key = f.sessionManager.getSessionId();
  await foreground(key, main);
  f.sessionManager.appendCustomEntry(ENTRY, { recap: "OLD-RECAP" });
  f.sessionManager.appendMessage({
    role: "toolResult",
    toolName: "test",
    toolCallId: "1",
    content: [{ type: "text", text: "TOOL-SECRET" }],
    timestamp: 0,
  });
  f.answer([
    { type: "text", text: "U".repeat(11000) },
    { type: "image", data: "IMAGE-SECRET", mimeType: "image/png" },
  ]);
  const branch = f.sessionManager.getBranch();
  core.appendResponses([fauxAssistantMessage(JSON.stringify(reply))]);
  const result = await summarize(
    f.ctx,
    branch,
    latestAnswer(branch),
    "PRIVATE RECAP PROMPT",
    AbortSignal.timeout(1000),
  );
  f.sessionManager.appendCustomEntry(ENTRY, result);
  const aux = observed.at(-1);
  assert.notEqual(aux.o.sessionId, key);
  assert.equal(aux.o.transport, "sse");
  assert.doesNotMatch(JSON.stringify(aux.c), /TOOL-SECRET|IMAGE-SECRET|OLD-RECAP/);
  assert.ok(aux.c.messages[0].content.length < 12000);
  assert.equal(await foreground(key, next), baseline);
  assert.ok(baseline > 0);
  assert.deepEqual(observed.at(-1).c, observed[1].c);
  assert.equal(observed.at(-1).o.sessionId, key);
});
