import assert from "node:assert/strict";
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
  const widgets = [],
    updates = [],
    notices = [];
  let editorResult,
    editorInitial,
    response = Promise.resolve(fauxAssistantMessage(JSON.stringify(reply)));
  const model = { provider: "test", id: "physical" };
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager,
    hasPendingMessages: () => false,
    modelRegistry: {
      find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
      streamSimple(model, context, options) {
        requests.push({ model, context, options });
        return { result: () => response };
      },
    },
    ui: {
      setWidget: (_key, factory) => widgets.push(factory),
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
    appendEntry: (key, data) => {
      updates.push(data);
      sessionManager.appendCustomEntry(key, data);
    },
    events: {
      on: () => () => {},
      emit: (key, data) => {
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
    widgets,
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
  assert.ok(f.widgets.at(-1));
  f.start();
  assert.ok(f.widgets.at(-1));
  assert.equal(f.requests.length, 1);
  assert.equal(await f.edit(""), "Use Chinese.");
  assert.equal(await f.edit(undefined), DEFAULT_PROMPT);
  f.answer();
  f.fire("agent_settled");
  await tick();
  assert.ok(f.requests[1].context.systemPrompt.includes(DEFAULT_PROMPT));
  assert.notEqual(f.requests[1].options.sessionId, f.requests[0].options.sessionId);
  f.switchTo("Off");
  assert.equal(f.widgets.at(-1), undefined);
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

test("restore follows the source answer and preserves a locally saved recap without a provider", async (t) => {
  const f = fixture(t);
  f.switchTo("On");
  const base = f.sessionManager.appendCustomEntry("base", {});
  f.answer();
  f.fire("agent_settled");
  await tick();
  const leaf = f.sessionManager.getLeafId();
  f.sessionManager.branch(base);
  f.fire("session_tree");
  assert.equal(f.widgets.at(-1), undefined);
  delete f.ctx.modelRegistry.streamSimple;
  f.sessionManager.branch(leaf);
  f.fire("session_tree");
  assert.ok(f.widgets.at(-1));
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
