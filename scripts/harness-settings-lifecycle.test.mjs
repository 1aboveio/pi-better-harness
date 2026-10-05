import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import harnessSettings from "../packages/pi-better-harness/extensions/settings/index.ts";
import { writeEnabled } from "../packages/pi-better-harness/extensions/prompt-suggestions/preferences.ts";
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function fixture(t, { enabled = true, heldAuth = false, holdResponse = false, response = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "harness-lifecycle-"));
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; rmSync(dir, { recursive: true, force: true }); });
  writeEnabled(enabled);
  const handlers = new Map();
  const events = new EventEmitter();
  const entries = [];
  let editor;
  let factory;
  let idle = true;
  let pending = false;
  let blocked = false;
  const requests = [];
  const auth = Promise.withResolvers();
  const model = { provider: "test", api: "test-api", id: "recording", headers: {} };
  const provider = { streamSimple(_model, _context, options) {
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", content: [{ type: "text", text: "Run tests" }], stopReason: "stop", api: model.api,
      provider: model.provider, model: model.id, timestamp: 0, usage: { input: 3, output: 2, totalTokens: 5, cost: { total: 0.25 } }, ...response };
    const item = { options, finish() { stream.push({ type: "done", reason: message.stopReason, message }); stream.end(message); } };
    requests.push(item);
    if (!holdResponse) item.finish();
    return stream;
  } };
  const identity = value => value;
  const theme = { borderColor: identity, selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity } };
  const host = { terminal: { rows: 40, columns: 80 }, requestRender() {} };
  const ctx = { mode: "tui", model, isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getBranch: () => [
      { role: "user", content: "Implement the fix" },
      { role: "assistant", content: [{ type: "text", text: "Implemented the fix" }], stopReason: "stop" },
    ] },
    modelRegistry: { getRegisteredNativeProvider: () => provider, getProviderAuthStatus: () => ({ source: "test" }),
      getProvider: () => provider, getApiKeyAndHeaders: async () => { if (heldAuth) await auth.promise; return { ok: true, apiKey: "fake" }; },
      getProviderAuth: async () => ({ auth: {} }),
    },
    ui: { notify() {}, theme: { fg: (_key, value) => value }, getEditorComponent: () => factory, setEditorComponent(next) {
      const text = editor?.getText() ?? "";
      factory = next;
      editor = next ? next(host, theme, new KeybindingsManager()) : new CustomEditor(host, theme, new KeybindingsManager());
      editor.onChange = () => {};
      editor.setText(text);
      editor.focused = true;
    } },
  };
  const pi = { on(name, fn) { handlers.set(name, fn); }, registerCommand() {}, appendEntry(type, data) { entries.push({ type, data }); },
    events: { on(name, fn) { events.on(name, fn); return () => events.off(name, fn); }, emit: (name, value) => events.emit(name, value) } };
  const contribution = { id: "goal", blocked: () => blocked };
  events.on("harness-suggestions:request", () => events.emit("harness-suggestions:register", contribution));
  harnessSettings(pi);
  handlers.get("session_start")({}, ctx);
  t.after(() => { handlers.get("session_shutdown")({}, ctx); auth.resolve(); for (const request of requests) request.finish(); });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  return { ctx, entries, requests, auth, get editor() { return editor; }, setIdle(value) { idle = value; }, setPending(value) { pending = value; }, setBlocked(value) { blocked = value; },
    emit(name, event = {}) { return handlers.get(name)(event, ctx); },
    settle() { handlers.get("input")({ source: "interactive", text: "Implement the fix" }, ctx); handlers.get("agent_start")({}, ctx); handlers.get("agent_settled")({}, ctx); },
    async tick(ms = 300) { t.mock.timers.tick(ms); await flush(); },
  };
}

test("default-off and fresh dispatch eligibility make no auxiliary requests", async t => {
  const disabled = fixture(t, { enabled: false });
  disabled.settle(); await disabled.tick();
  assert.equal(disabled.requests.length, 0);
});

for (const change of ["focus", "busy", "pending", "goal", "draft", "boundary"]) {
  test(`settlement followed by ${change} during quiet window suppresses inference`, async t => {
    const f = fixture(t);
    f.settle();
    if (change === "focus") f.editor.focused = false;
    if (change === "busy") f.setIdle(false);
    if (change === "pending") f.setPending(true);
    if (change === "goal") f.setBlocked(true);
    if (change === "draft") f.editor.setText("my unfinished draft");
    if (change === "boundary") f.emit("session_before_switch");
    await f.tick();
    assert.equal(f.requests.length, 0);
    if (change === "draft") assert.equal(f.editor.getText(), "my unfinished draft");
  });
}

test("loss of focus while asynchronous auth resolves prevents provider dispatch", async t => {
  const f = fixture(t, { heldAuth: true });
  f.settle(); await f.tick();
  f.editor.focused = false;
  f.auth.resolve(); await flush();
  assert.equal(f.requests.length, 0);
});

test("reported usage survives truncated output while ghost and retry remain suppressed", async t => {
  const f = fixture(t, { response: { stopReason: "length" } });
  f.settle(); await f.tick();
  assert.doesNotMatch(f.editor.render(80).join("\n"), /Run tests/);
  assert.equal(f.entries.filter(entry => entry.data.reportedRequests).length, 1);
  assert.equal(f.entries.find(entry => entry.data.reportedRequests).data.cost, 0.25);
  f.settle(); await f.tick();
  assert.equal(f.requests.length, 1, "a provider failure pauses requests");
});

test("live Goal hold prevents acceptance of an already rendered candidate", async t => {
  const f = fixture(t);
  f.settle(); await f.tick();
  assert.match(f.editor.render(80).join("\n"), /Run tests/);
  f.setBlocked(true);
  f.editor.handleInput("\t");
  assert.equal(f.editor.getText(), "");
});

test("late cancelled response records available usage without reviving ghost text", async t => {
  const f = fixture(t, { holdResponse: true });
  f.settle(); await f.tick();
  f.editor.setText("my draft");
  f.requests[0].finish(); await flush();
  assert.equal(f.editor.getText(), "my draft");
  assert.equal(f.entries.filter(entry => entry.data.reportedRequests).length, 1);
});

test("late response from a previous session cannot write usage into the new session", async t => {
  const f = fixture(t, { holdResponse: true });
  f.settle(); await f.tick();
  f.emit("session_before_switch");
  f.emit("session_start");
  const count = f.entries.length;
  f.requests[0].finish(); await flush();
  assert.equal(f.entries.length, count);
  assert.doesNotMatch(f.editor.render(80).join("\n"), /Run tests/);
});