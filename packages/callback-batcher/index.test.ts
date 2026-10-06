// @covers background-callback.batch
// @level unit
// @fails-without-fix background-callback.batch
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  CALLBACK_BATCH_BUDGET_BYTES,
  CALLBACK_BATCH_MAX_BYTES,
  CALLBACK_SETTINGS_ENTRY,
  callbackBatchBudget,
  changeCallbackSetting,
  createCallbackBatcher,
  getCallbackBatcher,
  getCallbackSettings,
  saveCallbackDefault,
  setCallbackBatchContext,
  formatCallbackBatch,
  formatUrgentCallback,
  packCallbackBatch,
  utf8ByteLength,
  type CallbackBatchEvent,
  type CallbackBatchHost,
} from "./index.ts";

function event(
  id: string,
  overrides: Partial<CallbackBatchEvent> = {},
): CallbackBatchEvent {
  return {
    source: "subagent",
    id,
    label: `worker ${id}`,
    status: "completed",
    detailTool: "subagent_result",
    callback: true,
    ...overrides,
  };
}

function recordingHost() {
  const messages: Array<{
    message: { customType: string; content: string; display: boolean };
    options: Record<string, unknown>;
  }> = [];
  const host: CallbackBatchHost = {
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  return { host, messages };
}

function preferencesFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "callback-settings-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seams = { agentDir: () => dir };
  const path = join(dir, "extensions", "pi-better-callback-preferences.json");
  const write = (text: string) => {
    mkdirSync(join(dir, "extensions"), { recursive: true });
    writeFileSync(path, text);
  };
  const branch: unknown[] = [];
  const ctx = { isIdle: () => false, sessionManager: { getBranch: () => branch } };
  const { host: base, messages } = recordingHost();
  const host = { ...base, appendEntry(customType: string, data: unknown) {
    branch.push({ type: "custom", customType, data });
  } };
  return { seams, path, write, branch, ctx, host, messages };
}

function settingEntry(mode: string, version = 1) {
  return { type: "custom", customType: CALLBACK_SETTINGS_ENTRY, data: { version, mode } };
}

test("latest valid current-branch setting wins without reading even a corrupt user default", (t) => {
  const f = preferencesFixture(t);
  f.write("not JSON");
  const invalid = [null, [], {}, { version: 2, mode: "steer" }, { version: 1, mode: "STEER" },
    { version: 1, mode: " steer " }, { version: 1, mode: "hold", extra: true }];
  f.branch.push(settingEntry("hold"), settingEntry("steer"),
    { type: "message", customType: CALLBACK_SETTINGS_ENTRY, data: { version: 1, mode: "hold" } },
    { type: "custom", customType: "unrelated", data: { version: 1, mode: "hold" } },
    ...invalid.map((data) => ({ type: "custom", customType: CALLBACK_SETTINGS_ENTRY, data })));
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "steer", source: "session" });
  assert.deepEqual(getCallbackSettings(f.ctx, { agentDir() { throw new Error("must not read default"); } }),
    { mode: "steer", source: "session" });
  f.branch.splice(1);
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "hold", source: "session" });
  f.branch.length = 0;
  assert.throws(() => getCallbackSettings(f.ctx, f.seams), /Invalid callback default/);
});

test("missing defaults fall back to hold; invalid branch entries fall back to the saved default", (t) => {
  const f = preferencesFixture(t);
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "hold", source: "default" });
  saveCallbackDefault("steer", f.seams);
  f.branch.push(settingEntry("hold", 2), settingEntry("bad"));
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "hold", source: "default" });
  assert.deepEqual(getCallbackSettings({ sessionManager: { getBranch: () => f.branch } }, f.seams), { mode: "steer", source: "default" });
  f.branch.push(settingEntry("hold"));
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "hold", source: "session" });
});

test("saved defaults require exact versioned JSON and surface malformed/read errors", (t) => {
  const f = preferencesFixture(t);
  for (const text of ["{", "null", "[]", "{}", '{"mode":"steer"}', '{"version":1}',
    '{"version":"1","mode":"steer"}', '{"version":2,"mode":"steer"}',
    '{"version":1,"mode":"invalid"}', '{"version":1,"mode":"steer","extra":true}']) {
    f.write(text);
    assert.throws(() => getCallbackSettings(f.ctx, f.seams), (error: Error) => {
      assert.match(error.message, /Invalid callback default/);
      assert.ok(error.message.includes(f.path), "error identifies the file to repair");
      return true;
    });
  }
  rmSync(f.path);
  mkdirSync(f.path);
  assert.throws(() => getCallbackSettings(f.ctx, f.seams), /Cannot read callback default/);
});

test("session changes autosave only the branch; explicit default saves survive a fresh session", async (t) => {
  const f = preferencesFixture(t);
  const batcher = getCallbackBatcher(f.host, { windowMs: 10_000 });
  t.after(() => batcher.cancel());
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  batcher.setForegroundRunning(true);
  batcher.enqueue(event("session_only"));
  changeCallbackSetting(f.host, f.ctx, "steer");
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "steer", source: "session" });
  assert.deepEqual(getCallbackSettings({}, f.seams), { mode: "hold", source: "default" });
  assert.equal(await batcher.flush(), true);
  assert.deepEqual(f.messages[0]!.options, { deliverAs: "steer", triggerTurn: true });

  saveCallbackDefault("steer", f.seams);
  changeCallbackSetting(f.host, f.ctx, "hold");
  batcher.enqueue(event("current_still_hold"));
  saveCallbackDefault("steer", f.seams);
  assert.equal(await batcher.flush(), false, "saving a default cannot change current-session delivery");
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "hold", source: "session" });
  const fresh = recordingHost();
  const freshCtx = { isIdle: () => false, sessionManager: { getBranch: () => [] } };
  setCallbackBatchContext(fresh.host, freshCtx, f.seams);
  const restarted = getCallbackBatcher(fresh.host);
  t.after(() => restarted.cancel());
  restarted.setForegroundRunning(true);
  restarted.enqueue(event("future_session"));
  assert.deepEqual(getCallbackSettings(freshCtx, f.seams), { mode: "steer", source: "default" });
  assert.equal(await restarted.flush(), true);
  assert.deepEqual(fresh.messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
});

test("settings restore from the real SDK branch and survive session file reopen", (t) => {
  const f = preferencesFixture(t);
  const dir = f.seams.agentDir();
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  const ctx = { ...f.ctx, sessionManager };
  const host = { ...f.host, appendEntry(customType: string, data: unknown) {
    sessionManager.appendCustomEntry(customType, data);
  } };
  changeCallbackSetting(host, ctx, "hold");
  const root = sessionManager.getLeafId()!;
  // Pi flushes its first session file when the first assistant message arrives.
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }],
    api: "anthropic-messages", provider: "test", model: "test", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  changeCallbackSetting(host, ctx, "steer");
  const abandoned = sessionManager.getLeafId()!;
  sessionManager.branch(root);
  assert.deepEqual(getCallbackSettings(ctx, f.seams), { mode: "hold", source: "session" });
  changeCallbackSetting(host, ctx, "hold");
  const reopened = SessionManager.open(sessionManager.getSessionFile()!);
  assert.ok(reopened.getEntries().some((entry) => entry.id === abandoned), "abandoned setting remains in history");
  assert.deepEqual(getCallbackSettings({ sessionManager: reopened }, f.seams), { mode: "hold", source: "session" });
  reopened.branch(abandoned);
  assert.deepEqual(getCallbackSettings({ sessionManager: reopened }, f.seams), { mode: "steer", source: "session" });
  t.after(() => getCallbackBatcher(host).cancel());
});

test("a real SDK disk failure cannot restore the rejected in-memory setting", async (t) => {
  const f = preferencesFixture(t);
  const dir = f.seams.agentDir();
  const sessionManager = SessionManager.create(dir, join(dir, "sessions"));
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }],
    api: "anthropic-messages", provider: "test", model: "test", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const ctx = { ...f.ctx, sessionManager };
  const host = { ...f.host, appendEntry(customType: string, data: unknown) {
    sessionManager.appendCustomEntry(customType, data);
  } };
  setCallbackBatchContext(host, ctx, f.seams);
  const batcher = getCallbackBatcher(host);
  t.after(() => batcher.cancel());
  batcher.setForegroundRunning(true);
  batcher.enqueue(event("must_stay_held"));
  const previousLeaf = sessionManager.getLeafId();
  const file = sessionManager.getSessionFile()!;
  rmSync(file);
  mkdirSync(file);
  assert.throws(() => changeCallbackSetting(host, ctx, "steer"), /EISDIR/);
  assert.notEqual(sessionManager.getLeafId(), previousLeaf, "the SDK really advanced its in-memory branch before the failure");
  assert.deepEqual(getCallbackSettings(ctx, f.seams), { mode: "hold", source: "default" });
  setCallbackBatchContext(host, ctx, f.seams);
  assert.equal(await batcher.flush(), false);
  assert.equal(f.messages.length, 0, "a failed edit cannot enable steering on a later lifecycle event");
});

test("a future-session default does not leak into an already-open session without an override", async (t) => {
  const f = preferencesFixture(t);
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  const batcher = getCallbackBatcher(f.host);
  t.after(() => batcher.cancel());
  batcher.setForegroundRunning(true);
  saveCallbackDefault("steer", f.seams);
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "hold", source: "default" });
  batcher.enqueue(event("existing_session"));
  assert.equal(await batcher.flush(), false);
  assert.equal(f.messages.length, 0);
  const freshCtx = { isIdle: () => false, sessionManager: { getBranch: () => [] } };
  const fresh = recordingHost();
  setCallbackBatchContext(fresh.host, freshCtx, f.seams);
  const future = getCallbackBatcher(fresh.host);
  t.after(() => future.cancel());
  future.setForegroundRunning(true);
  future.enqueue(event("future_session"));
  assert.deepEqual(getCallbackSettings(freshCtx, f.seams), { mode: "steer", source: "default" });
  assert.equal(await future.flush(), true);
  assert.equal(fresh.messages.length, 1);
  assert.deepEqual(fresh.messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
});

test("returning from an overridden branch retains the original session default", (t) => {
  const f = preferencesFixture(t);
  saveCallbackDefault("steer", f.seams);
  f.branch.push(settingEntry("hold"));
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  t.after(() => getCallbackBatcher(f.host).cancel());
  saveCallbackDefault("hold", f.seams);
  f.branch.length = 0;
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "steer", source: "default" });
  const fresh = { sessionManager: { getBranch: () => [] } };
  assert.deepEqual(getCallbackSettings(fresh, f.seams), { mode: "hold", source: "default" });
});

test("a reused manager captures a new default when its session identity changes", (t) => {
  const f = preferencesFixture(t);
  let id = "first";
  const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => id } };
  assert.deepEqual(getCallbackSettings(ctx, f.seams), { mode: "hold", source: "default" });
  saveCallbackDefault("steer", f.seams);
  assert.deepEqual(getCallbackSettings(ctx, f.seams), { mode: "hold", source: "default" });
  id = "second";
  assert.deepEqual(getCallbackSettings(ctx, f.seams), { mode: "steer", source: "default" });
});

test("Harness package-specifier settings changes update both producers' live shared singleton", async (t) => {
  const f = preferencesFixture(t);
  const subagents = await import("../pi-better-subagents/shared-callback-batcher.ts");
  const harness = await import("pi-better-background-tasks/src/shared-callback-batcher.ts");
  const background = await import("../pi-better-background-tasks/src/shared-callback-batcher.ts");
  f.branch.push(settingEntry("hold"));
  const subagentHost = { ...f.host, events: {} };
  const backgroundHost = { ...f.host, events: {} };
  const harnessHost = { ...f.host, events: {} };
  subagents.setCallbackBatchContext(subagentHost, f.ctx, f.seams);
  background.setCallbackBatchContext(backgroundHost, f.ctx, f.seams);
  const batcher = subagents.getCallbackBatcher(subagentHost);
  t.after(() => batcher.cancel());
  batcher.setForegroundRunning(true);
  batcher.toolStarted("tool");
  batcher.enqueue(event("subagent"));
  background.getCallbackBatcher(backgroundHost).enqueue(event("background", {
    source: "background-task", detailTool: "bg_task_status",
  }));
  harness.changeCallbackSetting(harnessHost, f.ctx, "steer");
  assert.equal(harness.getCallbackBatcher(harnessHost), batcher);
  assert.equal(background.getCallbackBatcher(backgroundHost), batcher);
  assert.deepEqual(subagents.getCallbackSettings(f.ctx, f.seams), { mode: "steer", source: "session" });
  assert.equal(await batcher.flush(), false, "changing mode cannot clear producer tool IDs");
  await background.getCallbackBatcher(backgroundHost).toolEnded("tool");
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0]!.message.content, /^2 background completions are ready:/);
  assert.deepEqual(f.messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
  harness.changeCallbackSetting(harnessHost, f.ctx, "hold");
  batcher.enqueue(event("held"));
  assert.equal(await background.getCallbackBatcher(backgroundHost).flush(), false);
  assert.equal(f.messages.length, 1);
});

test("failed appends and invalid modes leave the branch, pending timer, and live mode untouched", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = preferencesFixture(t);
  const batcher = getCallbackBatcher(f.host, { windowMs: 25, isAvailable: () => false });
  t.after(() => batcher.cancel());
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  batcher.setForegroundRunning(true);
  changeCallbackSetting(f.host, f.ctx, "steer");
  batcher.enqueue(event("pending"));
  const before = [...f.branch];
  let appends = 0;
  const failingHost = { ...f.host, appendEntry() { appends++; throw new Error("disk full"); } };
  assert.throws(() => changeCallbackSetting(failingHost, f.ctx, "hold"), /disk full/);
  assert.throws(() => changeCallbackSetting(failingHost, f.ctx, "invalid" as never), /Invalid callback delivery mode/);
  assert.throws(() => batcher.setWhileBusy("invalid" as never), /Invalid callback delivery mode/);
  assert.equal(appends, 1, "validation happens before append");
  assert.deepEqual(f.branch, before);
  t.mock.timers.tick(25);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.messages.length, 1);
  assert.deepEqual(f.messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
});

test("live hold/steer switches replace pending retry/debounce timers and retain dedupe", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = false;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 100, isAvailable: () => idle });
  t.after(() => batcher.cancel());
  batcher.setForegroundRunning(true);
  const item = event("switch");
  batcher.enqueue(item);
  t.mock.timers.tick(10);
  batcher.setWhileBusy("steer");
  assert.equal(batcher.enqueue(item), false);
  t.mock.timers.tick(24);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 0);
  batcher.setWhileBusy("hold");
  t.mock.timers.tick(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 0, "an obsolete steer timer cannot send after switching to hold");
  assert.equal(batcher.pendingCount(), 1);
  batcher.setWhileBusy("steer");
  t.mock.timers.tick(25);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1, "switching to steer must not wait for the old retry deadline");
  assert.deepEqual(messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
  batcher.setWhileBusy("hold");
  batcher.enqueue(item);
  idle = true;
  batcher.setAvailability(() => idle);
  await batcher.flush();
  assert.equal(messages.length, 1, "changing modes cannot discard handoff dedupe");
});

test("branch/context restore preserves active tools, foreground state, and failed receipt handoffs", async (t) => {
  const f = preferencesFixture(t);
  const batcher = getCallbackBatcher(f.host, { windowMs: 10_000 });
  t.after(() => batcher.cancel());
  f.branch.push(settingEntry("steer"));
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  batcher.setForegroundRunning(true);
  let writable = false;
  let receipts = 0;
  batcher.enqueue(event("receipt", { onDelivered() {
    if (!writable) throw new Error("receipt unavailable");
    receipts++;
  } }));
  assert.equal(await batcher.flush(), false);
  assert.equal(f.messages.length, 1);
  batcher.toolStarted("outer");
  batcher.toolStarted("outer/1");
  batcher.enqueue(event("pending"));
  f.branch.splice(0, f.branch.length, settingEntry("hold"));
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  await batcher.toolEnded("outer/1");
  assert.equal(await batcher.flush(), false);
  f.branch.splice(0, f.branch.length, settingEntry("steer"));
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  assert.equal(await batcher.flush(), false, "branch navigation must not clear the active outer tool");
  writable = true;
  await batcher.toolEnded("outer");
  assert.equal(f.messages.length, 2, "restored foreground state permits the final tool's steer");
  assert.equal(receipts, 1);
  assert.match(f.messages[1]!.message.content, /id=pending/);
  assert.doesNotMatch(f.messages[1]!.message.content, /id=receipt/);
});

test("corrupt defaults and unreadable branch restores fail closed instead of leaking prior session steer", async (t) => {
  const f = preferencesFixture(t);
  const batcher = getCallbackBatcher(f.host, { windowMs: 10_000 });
  t.after(() => batcher.cancel());
  f.branch.push(settingEntry("steer"));
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  batcher.setForegroundRunning(true);
  batcher.enqueue(event("queued"));
  f.write("broken JSON");
  const notices: Array<[string, string]> = [];
  const ctx = { isIdle: () => false, sessionManager: { getBranch: () => [] },
    ui: { notify(message: string, type: string) { notices.push([message, type]); } } };
  assert.throws(() => getCallbackSettings(ctx, f.seams), /Invalid callback default/);
  setCallbackBatchContext(f.host, ctx, f.seams);
  assert.equal(await batcher.flush(), false);
  assert.equal(f.messages.length, 0);
  assert.equal(batcher.pendingCount(), 1);
  assert.match(notices[0]![0], /restored to hold.*Invalid callback default/);
  assert.equal(notices[0]![1], "error");

  setCallbackBatchContext(f.host, f.ctx, f.seams);
  saveCallbackDefault("steer", f.seams);
  const unreadable = { ...ctx, sessionManager: { getBranch(): unknown[] { throw new Error("branch unreadable"); } } };
  assert.throws(() => getCallbackSettings(unreadable, f.seams), /branch unreadable/);
  setCallbackBatchContext(f.host, unreadable, f.seams);
  assert.equal(await batcher.flush(), false, "an unreadable branch cannot enable the saved steer default");
  assert.match(notices[1]![0], /branch unreadable/);
  setCallbackBatchContext(f.host, f.ctx, f.seams);
  f.write("bad again");
  setCallbackBatchContext(f.host, { ...ctx, ui: { notify() { throw new Error("UI unavailable"); } } }, f.seams);
  assert.equal(await batcher.flush(), false, "notification failure cannot prevent fail-closed restoration");
});

test("live mode changes cannot bypass the deferred idle-run guard", async (t) => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, isAvailable: () => true });
  t.after(() => batcher.cancel());
  batcher.setForegroundRunning(true);
  batcher.enqueue(event("idle"));
  await batcher.flush();
  batcher.enqueue(event("awaiting_run"));
  batcher.setWhileBusy("steer");
  batcher.setWhileBusy("hold");
  batcher.setWhileBusy("steer");
  assert.equal(await batcher.flush(), false);
  assert.equal(messages.length, 1);
});

test("switching to hold during an in-flight steer retains receipts and holds later callbacks", async (t) => {
  let finish!: () => void;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher({ sendMessage(message, options) {
    host.sendMessage(message, options);
    return new Promise<void>((resolve) => { finish = resolve; });
  } }, { windowMs: 10_000, whileBusy: "steer", isAvailable: () => false });
  t.after(() => batcher.cancel());
  batcher.setForegroundRunning(true);
  let receipts = 0;
  const item = event("in_flight", { onDelivered: () => { receipts++; } });
  batcher.enqueue(item);
  const flush = batcher.flush();
  batcher.setWhileBusy("hold");
  assert.equal(batcher.enqueue(item), false);
  batcher.enqueue(event("later"));
  finish();
  assert.equal(await flush, true);
  assert.equal(receipts, 1);
  assert.equal(await batcher.flush(), false);
  assert.equal(messages.length, 1);
  assert.equal(batcher.pendingCount(), 1);
});

test("atomic default saves replace valid preferences and failed rename cleans temp files without changing live settings", async (t) => {
  const f = preferencesFixture(t);
  saveCallbackDefault("steer", f.seams);
  saveCallbackDefault("hold", f.seams);
  assert.deepEqual(getCallbackSettings({}, f.seams), { mode: "hold", source: "default" });
  const before = readFileSync(f.path, "utf8");
  assert.throws(() => saveCallbackDefault("bad" as never, f.seams), /Invalid callback delivery mode/);
  assert.equal(readFileSync(f.path, "utf8"), before);
  const batcher = getCallbackBatcher(f.host, { windowMs: 10_000 });
  t.after(() => batcher.cancel());
  changeCallbackSetting(f.host, f.ctx, "steer");
  batcher.setForegroundRunning(true);
  batcher.enqueue(event("unchanged"));
  rmSync(f.path);
  mkdirSync(f.path);
  const sentinel = join(f.path, "do-not-remove");
  writeFileSync(sentinel, "existing target");
  assert.throws(() => saveCallbackDefault("hold", f.seams), /Cannot save callback default/);
  assert.equal(readFileSync(sentinel, "utf8"), "existing target");
  assert.deepEqual(readdirSync(join(f.seams.agentDir(), "extensions")), ["pi-better-callback-preferences.json"]);
  assert.deepEqual(getCallbackSettings(f.ctx, f.seams), { mode: "steer", source: "session" });
  assert.equal(await batcher.flush(), true);
  assert.deepEqual(f.messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
});

test("removed busy-mode environment values cannot enable steering; idle delivery is unchanged", async () => {
  const env = "PI_BETTER_CALLBACK_WHILE_BUSY";
  const previous = process.env[env];
  try {
    for (const value of [undefined, "", "invalid", "STEER", " steer ", "steer"]) {
      if (value === undefined) delete process.env[env];
      else process.env[env] = value;
      let idle = false;
      const { host, messages } = recordingHost();
      const batcher = createCallbackBatcher(host, { windowMs: 10_000, isAvailable: () => idle });
      batcher.setForegroundRunning(true);
      try {
        batcher.toolStarted("foreground");
        batcher.enqueue(event("busy"));
        assert.equal(await batcher.flush(), false, `active tool must hold callbacks (${value})`);
        await batcher.toolEnded("foreground");
        assert.equal(messages.length, 0, `environment must not enable busy handoff (${value})`);
        idle = true;
        batcher.setAvailability(() => idle);
        await batcher.flush();
        assert.equal(messages.length, 1, "idle must not repeat a busy handoff");
        batcher.enqueue(event("idle"));
        // Reset the idle awaitingRun guard after the preceding idle follow-up.
        idle = false;
        batcher.setAvailability(() => idle);
        idle = true;
        batcher.setAvailability(() => idle);
        await batcher.flush();
        assert.equal(messages.length, 2);
        assert.deepEqual(messages[1]!.options, { deliverAs: "followUp", triggerTurn: true });
      } finally { batcher.cancel(); }
    }
  } finally {
    if (previous === undefined) delete process.env[env];
    else process.env[env] = previous;
  }
});

test("#425 time-separated mixed completions form one steer at the last parallel/nested tool end", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = false;
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50, whileBusy: "steer", isAvailable: () => idle });
  batcher.setForegroundRunning(true);
  try {
    for (const id of ["parent", "parallel", "parent/1"]) {
      batcher.toolStarted(id);
      batcher.toolStarted(id);
    }
    for (const id of ["sa_first", "bg_second", "sa_third"]) {
      const item = event(id, {
        ...(id.startsWith("bg") ? { source: "background-task", detailTool: "bg_task_status" } as const : {}),
        onDelivered: () => delivered.push(id),
      });
      assert.equal(batcher.enqueue(item), true);
      assert.equal(batcher.enqueue(item), false);
      t.mock.timers.tick(200);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages.length, 0, "debounce/retry windows must not split an active tool batch");
    }
    assert.equal(batcher.enqueue(event("quiet", { callback: false })), false);
    await batcher.toolEnded("unknown");
    await batcher.toolEnded("parallel");
    await batcher.toolEnded("parallel");
    await batcher.toolEnded("parent/1");
    assert.equal(messages.length, 0, "nested and parallel ends cannot release an active parent");
    assert.deepEqual(delivered, []);
    await batcher.toolEnded("parent");
    await batcher.toolEnded("parent");
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
    assert.equal(messages[0]!.message.customType, "background-completion-batch");
    assert.match(messages[0]!.message.content, /^3 background completions are ready:/);
    assert.match(messages[0]!.message.content, /bg_task_status id=bg_second/);
    assert.match(messages[0]!.message.content, /subagent_result id="sa_first"/);
    assert.doesNotMatch(messages[0]!.message.content, /quiet/);
    assert.ok(utf8ByteLength(messages[0]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
    assert.deepEqual(delivered, ["sa_first", "bg_second", "sa_third"]);
    idle = true;
    batcher.setAvailability(() => idle);
    await batcher.flush();
    assert.equal(messages.length, 1);
  } finally { batcher.cancel(); }
});

test("#425 compaction and branch summary unavailability hold callbacks until an agent run or idle", async () => {
  let idle = false;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, whileBusy: "steer", isAvailable: () => idle });
  try {
    batcher.enqueue(event("during_compaction"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 0, "non-idle without an active agent must not request a run");
    batcher.setForegroundRunning(true);
    assert.equal(await batcher.flush(), true);
    assert.deepEqual(messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
    batcher.setForegroundRunning(false);
    batcher.enqueue(event("during_branch_summary"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1, "agent_end must close the busy steering opportunity");
    idle = true;
    assert.equal(await batcher.flush(), true);
    assert.deepEqual(messages[1]!.options, { deliverAs: "followUp", triggerTurn: true });
  } finally { batcher.cancel(); }
});

test("#425 a busy agent with no active tool uses the accumulation window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 25, whileBusy: "steer", isAvailable: () => false });
  batcher.setForegroundRunning(true);
  try {
    batcher.enqueue(event("between_tools"));
    t.mock.timers.tick(24);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 0);
    t.mock.timers.tick(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
  } finally { batcher.cancel(); }
});

test("#425 final tool end awaits handoff and receipts even after an in-flight deferred flush", async () => {
  let finishHandoff!: () => void;
  let receipted = false;
  const batcher = createCallbackBatcher({ sendMessage() {
    return new Promise<void>((resolve) => { finishHandoff = resolve; });
  } }, { windowMs: 10_000, whileBusy: "steer", isAvailable: () => false });
  batcher.setForegroundRunning(true);
  try {
    batcher.toolStarted("tool");
    batcher.enqueue(event("awaited", { onDelivered: () => { receipted = true; } }));
    const deferred = batcher.flush();
    let ended = false;
    const boundary = batcher.toolEnded("tool").then(() => { ended = true; });
    assert.equal(await deferred, false);
    assert.equal(typeof finishHandoff, "function", "final end must send without waiting for a timer");
    assert.equal(ended, false);
    assert.equal(receipted, false);
    finishHandoff();
    await boundary;
    assert.equal(ended, true);
    assert.equal(receipted, true);
    assert.equal(batcher.pendingCount(), 0);
  } finally { batcher.cancel(); }
});

test("#425 default-mode tool notifications do not wait on an in-flight idle handoff", async () => {
  let finishHandoff!: () => void;
  const batcher = createCallbackBatcher({ sendMessage() {
    return new Promise<void>((resolve) => { finishHandoff = resolve; });
  } }, { windowMs: 10_000, whileBusy: "hold" });
  batcher.enqueue(event("idle_handoff"));
  const flush = batcher.flush();
  try {
    batcher.toolStarted("new_run_tool");
    let ended = false;
    void batcher.toolEnded("new_run_tool").then(() => { ended = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(ended, true, "default-mode tools cannot wait on the handoff that started their run");
  } finally {
    finishHandoff();
    await flush;
    batcher.cancel();
  }
});

test("#425 busy steering retains send retry, receipt retry, and late suppression", async () => {
  const { host, messages } = recordingHost();
  let failSend = true;
  let failReceipt = true;
  let suppressed = false;
  const delivered: string[] = [];
  const suppressions: string[] = [];
  const batcher = createCallbackBatcher({ sendMessage(message, options) {
    if (failSend) throw new Error("handoff unavailable");
    return host.sendMessage(message, options);
  } }, { windowMs: 10_000, whileBusy: "steer", isAvailable: () => false });
  batcher.setForegroundRunning(true);
  try {
    batcher.toolStarted("tool");
    batcher.enqueue(event("retry", { onDelivered: () => {
      if (failReceipt) throw new Error("receipt unavailable");
      delivered.push("retry");
    } }));
    batcher.enqueue(event("cancelled", {
      getSuppressionReason: () => suppressed ? "owner changed while busy" : undefined,
      onSuppressed: (reason) => suppressions.push(reason),
    }));
    suppressed = true;
    assert.equal(await batcher.toolEnded("tool"), false);
    assert.equal(messages.length, 0);
    assert.deepEqual(delivered, []);
    assert.deepEqual(suppressions, ["owner changed while busy"]);
    assert.equal(batcher.pendingCount(), 1);
    failSend = false;
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
    assert.doesNotMatch(messages[0]!.message.content, /cancelled/);
    failReceipt = false;
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 1, "receipt retry must not send another steer");
    assert.deepEqual(delivered, ["retry"]);
  } finally { batcher.cancel(); }
});

test("#425 opt-in cannot bypass unreadable availability or the idle awaitingRun guard", async () => {
  let unreadable = true;
  let idle = true;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, whileBusy: "steer", isAvailable: () => {
    if (unreadable) throw new Error("availability unavailable");
    return idle;
  } });
  batcher.setForegroundRunning(true);
  try {
    batcher.enqueue(event("first"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 0);
    unreadable = false;
    assert.equal(await batcher.flush(), true);
    batcher.enqueue(event("next"));
    batcher.setAvailability(() => idle);
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1, "a deferred idle run is not a busy steering opportunity");
    idle = false;
    batcher.setAvailability(() => idle);
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1]!.options, { deliverAs: "steer", triggerTurn: true });
  } finally { batcher.cancel(); }
});

test("#425 bounded busy overflow is unreceipted and waits through the next active tool", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, maxBytes: 700, whileBusy: "steer", isAvailable: () => false });
  batcher.setForegroundRunning(true);
  try {
    batcher.toolStarted("first_tool");
    for (const id of ["first", "overflow", "last"]) {
      batcher.enqueue(event(id, { label: "x".repeat(160), onDelivered: () => delivered.push(id) }));
    }
    await batcher.toolEnded("first_tool");
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message.content, /not receipted; still queued/);
    assert.equal(batcher.pendingCount(), 3 - delivered.length);
    assert.ok(batcher.pendingCount() > 0);
    batcher.toolStarted("next_tool");
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1);
    await batcher.toolEnded("next_tool");
    while (batcher.pendingCount()) await batcher.flush();
    assert.deepEqual(delivered, ["first", "overflow", "last"]);
    for (const { message, options } of messages) {
      assert.ok(utf8ByteLength(message.content) <= 700);
      assert.deepEqual(options, { deliverAs: "steer", triggerTurn: true });
    }
  } finally { batcher.cancel(); }
});

test("#425 both vendored copies share tool IDs across distinct wrappers and host refresh", async () => {
  const subagents = await import("../pi-better-subagents/shared-callback-batcher.ts");
  const background = await import("../pi-better-background-tasks/src/shared-callback-batcher.ts");
  const { host, messages } = recordingHost();
  const sessionManager = { getBranch: () => [{ type: "custom", customType: CALLBACK_SETTINGS_ENTRY, data: { version: 1, mode: "steer" } }] };
  const ctx = { isIdle: () => false, sessionManager };
  const first = getCallbackBatcher(host, { windowMs: 10_000, whileBusy: "steer" });
  first.setForegroundRunning(true);
  setCallbackBatchContext(host, ctx);
  const subagentHost = { ...host, events: {} };
  const backgroundHost = { ...host, events: {} };
  subagents.setCallbackBatchContext(subagentHost, ctx);
  background.setCallbackBatchContext(backgroundHost, ctx);
  const second = subagents.getCallbackBatcher(subagentHost);
  const third = background.getCallbackBatcher(backgroundHost);
  assert.equal(second, first);
  assert.equal(third, first);
  try {
    second.toolStarted("shared_tool");
    third.toolStarted("shared_tool");
    first.enqueue(event("shared_completion"));
    const refreshed = { ...host, events: {} };
    background.setCallbackBatchContext(refreshed, ctx);
    assert.equal(await first.flush(), false, "context refresh retains the active Set");
    await background.getCallbackBatcher(refreshed).toolEnded("shared_tool");
    await second.toolEnded("shared_tool");
    assert.equal(messages.length, 1, "duplicate ends from both consumers release one batch");
    assert.deepEqual(messages[0]!.options, { deliverAs: "steer", triggerTurn: true });
  } finally { first.cancel(); }
});

test("#425 shutdown cancels busy steering and clears tools but preserves handoff receipts on resume", async () => {
  const { host, messages } = recordingHost();
  let writable = false;
  let receipts = 0;
  const item = event("delivered", { onDelivered: () => {
    if (!writable) throw new Error("receipt unavailable");
    receipts++;
  } });
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, whileBusy: "steer", isAvailable: () => false });
  batcher.setForegroundRunning(true);
  try {
    batcher.enqueue(item);
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1);
    batcher.toolStarted("abandoned_tool");
    batcher.enqueue(event("abandoned"));
    batcher.cancel();
    batcher.enqueue(event("late_old_context"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1, "a shutdown cannot turn unavailability into busy steering");
    batcher.cancel();
    batcher.setAvailability(() => false);
    batcher.setForegroundRunning(true);
    writable = true;
    batcher.enqueue(item);
    batcher.enqueue(event("resumed"));
    assert.equal(await batcher.flush(), true, "abandoned tool IDs cannot strand resumed work");
    assert.equal(receipts, 1);
    assert.equal(messages.length, 2);
    assert.match(messages[1]!.message.content, /id=resumed/);
    assert.doesNotMatch(messages[1]!.message.content, /id=delivered|abandoned|late_old_context/);
  } finally { batcher.cancel(); }
});

test("#425 opt-in leaves urgent health delivery on its immediate follow-up path", async () => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, whileBusy: "steer", isAvailable: () => false });
  batcher.setForegroundRunning(true);
  try {
    batcher.toolStarted("tool");
    batcher.enqueue(event("ordinary"));
    assert.equal(await batcher.deliverUrgent({ source: "subagent", id: "health", label: "worker",
      status: "orphaned", customType: "subagent-health", content: "Needs attention" }), true);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0]!.options, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(batcher.pendingCount(), 1);
    await batcher.toolEnded("tool");
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[1]!.options, { deliverAs: "steer", triggerTurn: true });
  } finally { batcher.cancel(); }
});

test("successful handoffs retry failed receipt hooks without sending again", async () => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10000 });
  let writable = false;
  let receipts = 0;
  const onDelivered = () => { if (!writable) throw new Error("receipt write failed"); receipts++; };
  batcher.enqueue(event("ordinary", { onDelivered }));
  assert.equal(await batcher.flush(), false);
  assert.equal(await batcher.flush(), false);
  assert.equal(messages.length, 1);
  writable = true;
  assert.equal(await batcher.flush(), true);
  assert.equal(receipts, 1);
  assert.equal(messages.length, 1);
  writable = false;
  const urgent = { source: "subagent" as const, id: "urgent", label: "urgent", status: "failure", customType: "failure", content: "failure", onDelivered };
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.equal(messages.length, 2);
  writable = true;
  assert.equal(await batcher.deliverUrgent(urgent), true);
  assert.equal(receipts, 2, "the urgent receipt is persisted after storage recovers");
  assert.equal(messages.length, 2);
  batcher.cancel();
});

test("coalesces callback-enabled completions in stable enqueue order", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_2", { onDelivered: () => delivered.push("sa_2") }));
  batcher.enqueue(event("bg_1", {
    source: "background-task",
    label: "build",
    status: "failed",
    detailTool: "bg_task_status",
    onDelivered: () => delivered.push("bg_1"),
  }));
  batcher.enqueue(event("sa_3", { status: "failed", onDelivered: () => delivered.push("sa_3") }));

  assert.equal(await batcher.flush(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message.content, /^3 background completions are ready:/);
  for (const id of ["sa_2", "bg_1", "sa_3"]) assert.match(messages[0]!.message.content, new RegExp(`id=${id} \\|`));
  assert.ok(messages[0]!.message.content.indexOf("sa_2") < messages[0]!.message.content.indexOf("bg_1"));
  assert.ok(messages[0]!.message.content.indexOf("bg_1") < messages[0]!.message.content.indexOf("sa_3"));
  assert.deepEqual(delivered, ["sa_2", "bg_1", "sa_3"]);
  assert.deepEqual(messages[0]!.options, { deliverAs: "followUp", triggerTurn: true });
});

test("debounces a single completion and flushes it after the bounded window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_single", { onDelivered: () => delivered.push("sa_single") }));
  t.mock.timers.tick(24);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 0);

  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message.content, /^1 background completion is ready:/);
  assert.deepEqual(delivered, ["sa_single"]);
});

test("busy completions wait for availability and aggregate across debounce windows (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = false;
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, isAvailable: () => idle });
  try {
    for (const id of ["sa_first", "sa_second", "sa_third"]) {
      batcher.enqueue(event(id, { onDelivered: () => delivered.push(id) }));
      t.mock.timers.tick(100);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(await batcher.flush(), false, "explicit flush cannot bypass foreground availability");
    assert.equal(messages.length, 0);
    assert.deepEqual(delivered, []);
    assert.equal(batcher.pendingCount(), 3);

    idle = true;
    batcher.setAvailability(() => idle);
    assert.equal(messages.length, 0, "availability notification must not start a reentrant model run");
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message.content, /^3 background completions are ready:/);
    assert.deepEqual(delivered, ["sa_first", "sa_second", "sa_third"]);
    assert.equal(batcher.pendingCount(), 0);
  } finally { batcher.cancel(); }
});

test("arrivals and overflow during a completion-driven run wait for the next availability (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = false;
  const messages: string[] = [];
  const delivered: string[] = [];
  const batcher = createCallbackBatcher({ sendMessage(message) {
    messages.push(message.content);
    idle = false;
  } }, { windowMs: 25, maxBytes: 700, isAvailable: () => idle });
  try {
    for (const id of ["sa_a", "sa_b", "sa_c", "sa_d"]) {
      batcher.enqueue(event(id, { label: "x".repeat(160), onDelivered: () => delivered.push(id) }));
    }
    idle = true;
    batcher.setAvailability(() => idle);
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.ok(batcher.pendingCount() > 0, "bounded overflow stays queued");
    batcher.enqueue(event("sa_during_run"));
    t.mock.timers.tick(1000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1, "neither overflow nor concurrent arrivals preload future turns");
    while (batcher.pendingCount() > 0) {
      const before: number = messages.length;
      idle = true;
      batcher.setAvailability(() => idle);
      t.mock.timers.tick(25);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages.length, before + 1);
    }
    assert.equal(new Set(delivered).size, 4);
    assert.equal(delivered.length, 4);
    assert.equal(messages.filter((message) => message.includes("id=sa_during_run |")).length, 1);
  } finally { batcher.cancel(); }
});

test("availability errors defer sends and suppression is rechecked after the busy run (#409)", async () => {
  const { host, messages } = recordingHost();
  let unreadable = true;
  let cancelled = false;
  const suppressed: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, isAvailable: () => {
    if (unreadable) throw new Error("session availability unavailable");
    return true;
  } });
  try {
    batcher.enqueue(event("sa_cancelled", {
      getSuppressionReason: () => cancelled ? "cancelled while foreground was busy" : undefined,
      onSuppressed: (reason) => suppressed.push(reason),
    }));
    batcher.enqueue(event("sa_remaining"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 0);
    cancelled = true;
    unreadable = false;
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0]!.message.content, /sa_cancelled/);
    assert.deepEqual(suppressed, ["cancelled while foreground was busy"]);
  } finally { batcher.cancel(); }
});

test("a foreground run starting inside the debounce window prevents the scheduled handoff (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = true;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 25, isAvailable: () => idle });
  try {
    batcher.enqueue(event("sa_before_foreground"));
    idle = false;
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 0);
    assert.equal(batcher.pendingCount(), 1);
    idle = true;
    batcher.setAvailability(() => idle);
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.equal(batcher.pendingCount(), 0);
  } finally { batcher.cancel(); }
});

test("a deferred model run permits only one handoff even while Pi still reports idle (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = true;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 0, retryMs: 10, maxBytes: 700, isAvailable: () => idle });
  try {
    for (const id of ["sa_first", "sa_overflow", "sa_last"]) {
      batcher.enqueue(event(id, { label: "x".repeat(160) }));
    }
    await batcher.flush();
    assert.equal(messages.length, 1);
    assert.ok(batcher.pendingCount() > 0);
    batcher.enqueue(event("sa_concurrent"));
    // Another extension's settled handler can refresh the idle predicate while
    // Pi is still deferring the first model run.
    batcher.setAvailability(() => idle);
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1, "overflow and arrivals cannot create additional deferred runs");
    idle = false;
    batcher.setAvailability(() => idle);
    idle = true;
    batcher.setAvailability(() => idle);
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 2, "a genuine busy-to-idle transition permits the next handoff");
  } finally { batcher.cancel(); }
});

test("pending completions recover when availability returns without a lifecycle event (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = false;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 100, isAvailable: () => idle });
  try {
    batcher.enqueue(event("sa_during_compaction"));
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 0);
    idle = true;
    // Manual compaction can restore idle without emitting agent_settled.
    t.mock.timers.tick(100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.equal(batcher.pendingCount(), 0);
  } finally { batcher.cancel(); }
});

test("bounds event text and excludes caller-supplied result and log payloads", () => {
  const resultSentinel = "FULL_RESULT_SENTINEL";
  const logSentinel = "RAW_LOG_SENTINEL";
  const content = formatCallbackBatch([
    {
      ...event("sa_bounded", { label: `label-${"x".repeat(10_000)}` }),
      result: resultSentinel,
      log: logSentinel,
    } as CallbackBatchEvent,
  ]);

  assert.ok(content.length < 700, `single-event callback must stay bounded; got ${content.length}`);
  assert.match(content, /source=subagent/);
  assert.match(content, /id=sa_bounded/);
  assert.match(content, /status=completed/);
  assert.match(content, /subagent_result id="sa_bounded"/);
  assert.doesNotMatch(content, new RegExp(`${resultSentinel}|${logSentinel}`));
  assert.match(content, /Full results and logs are intentionally omitted/);
  assert.match(content, /cursor\/limit/);
  assert.doesNotMatch(content, /tools used:| · tools: |read,bash,write/);
});

test("keeps failed snapshots retryable and merges concurrent arrivals exactly once", async () => {
  let rejectFirst!: (reason: Error) => void;
  let attempt = 0;
  const contents: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    sendMessage(message) {
      contents.push(message.content);
      attempt += 1;
      if (attempt === 1) return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    },
  };
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_a", { onDelivered: () => delivered.push("sa_a") }));
  batcher.enqueue(event("sa_b", { onDelivered: () => delivered.push("sa_b") }));
  const failedFlush = batcher.flush();
  batcher.enqueue(event("sa_c", { onDelivered: () => delivered.push("sa_c") }));
  batcher.enqueue(event("sa_a", { onDelivered: () => delivered.push("duplicate") }));
  rejectFirst(new Error("simulated handoff failure"));

  assert.equal(await failedFlush, false);
  assert.deepEqual(delivered, [], "failed handoff must not mark any event delivered");
  assert.equal(batcher.pendingCount(), 3);

  assert.equal(await batcher.flush(), true);
  assert.equal(contents.length, 2);
  assert.ok(contents[1]!.indexOf("sa_a") < contents[1]!.indexOf("sa_b"));
  assert.ok(contents[1]!.indexOf("sa_b") < contents[1]!.indexOf("sa_c"));
  assert.equal((contents[1]!.match(/id=sa_a/g) ?? []).length, 1);
  assert.deepEqual(delivered, ["sa_a", "sa_b", "sa_c"]);
});

test("filters callback:false and ownership-suppressed events out of a mixed batch", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const suppressed: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_active", { onDelivered: () => delivered.push("sa_active") }));
  batcher.enqueue(event("sa_quiet", {
    callback: false,
    onDelivered: () => delivered.push("sa_quiet"),
  }));
  batcher.enqueue(event("bg_foreign", {
    source: "background-task",
    detailTool: "bg_task_status",
    getSuppressionReason: () => "origin session-a does not match active session-b",
    onSuppressed: (reason) => suppressed.push(reason),
  }));

  assert.equal(await batcher.flush(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message.content, /sa_active/);
  assert.doesNotMatch(messages[0]!.message.content, /sa_quiet|bg_foreign/);
  assert.deepEqual(delivered, ["sa_active"]);
  assert.deepEqual(suppressed, ["origin session-a does not match active session-b"]);
});

test("delivery-state read errors defer a batch instead of permanently suppressing it", async () => {
  let unreadable = true;
  let sent = 0;
  let suppressed = 0;
  const batcher = createCallbackBatcher({ sendMessage() { sent++; } }, { windowMs: 10_000, retryMs: 10_000 });
  try {
    batcher.enqueue({ ...event("sa_read_error"),
      isDelivered: () => { if (unreadable) throw new Error("temporary metadata read error"); return false; },
      onSuppressed: () => { suppressed++; },
    });
    assert.equal(await batcher.flush(), false);
    assert.equal(batcher.pendingCount(), 1);
    assert.equal(suppressed, 0);
    assert.equal(sent, 0);
    unreadable = false;
    assert.equal(await batcher.flush(), true);
    assert.equal(sent, 1);
  } finally { batcher.cancel(); }
});

test("one unreadable receipt does not block unrelated deliverable completions", async () => {
  const messages: string[] = [];
  const batcher = createCallbackBatcher({ sendMessage(message) { messages.push(message.content); } }, { windowMs: 10_000, retryMs: 10_000 });
  try {
    batcher.enqueue({ ...event("sa_unreadable"), isDelivered: () => { throw new Error("unreadable receipt"); } });
    batcher.enqueue(event("sa_ready"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /sa_ready/);
    assert.doesNotMatch(messages[0]!, /sa_unreadable/);
    assert.equal(batcher.pendingCount(), 1);
  } finally { batcher.cancel(); }
});

test("urgent ownership read errors remain retryable and do not acknowledge suppression", async () => {
  let unreadable = true;
  let sent = 0;
  let suppressed = 0;
  const batcher = createCallbackBatcher({ sendMessage() { sent++; } });
  const urgent = { ...event("sa_unverified"), customType: "failure-attention", content: "Failure needs attention",
    getSuppressionReason: () => { if (unreadable) throw new Error("temporary ownership read error"); return undefined; },
    onSuppressed: () => { suppressed++; },
  };
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.equal(suppressed, 0);
  assert.equal(sent, 0);
  unreadable = false;
  assert.equal(await batcher.deliverUrgent(urgent), true);
  assert.equal(sent, 1);
});

test("urgent health signals bypass an ordinary batch and retry without early markers", async () => {
  let failUrgent = true;
  const sends: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    sendMessage(message) {
      sends.push(message.content);
      if (message.customType === "subagent-health" && failUrgent) {
        failUrgent = false;
        throw new Error("simulated urgent handoff failure");
      }
    },
  };
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });
  batcher.enqueue(event("sa_ordinary"));

  const urgent = {
    source: "subagent" as const,
    id: "sa_orphaned",
    label: "reviewer",
    status: "orphaned",
    customType: "subagent-health",
    content: "ATTENTION: subagent sa_orphaned is orphaned; inspect subagent_result.",
    onDelivered: () => delivered.push("sa_orphaned"),
  };
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.deepEqual(delivered, []);
  assert.equal(batcher.pendingCount(), 1, "ordinary completion remains queued");

  assert.equal(await batcher.deliverUrgent(urgent), true);
  assert.deepEqual(delivered, ["sa_orphaned"]);
  assert.equal(sends.length, 2, "urgent retries immediately and never waits for the ordinary flush");
  assert.match(sends[1]!, /orphaned/);

  assert.equal(await batcher.flush(), true);
  assert.equal(sends.length, 3);
  assert.match(sends[2]!, /sa_ordinary/);
});


test("callback batch default budget is 2 KiB and explicit pages clamp to 8 KiB", () => {
  assert.equal(CALLBACK_BATCH_BUDGET_BYTES, 2 * 1024);
  assert.equal(CALLBACK_BATCH_MAX_BYTES, 8 * 1024);
  assert.equal(callbackBatchBudget(), 2 * 1024);
  assert.equal(callbackBatchBudget(512), 512);
  assert.equal(callbackBatchBudget(99_999), 8 * 1024);
  assert.equal(callbackBatchBudget(0), 2 * 1024);
  assert.equal(callbackBatchBudget(Number.NaN), 2 * 1024);
});

test("large batches stay within 2 KiB, count omitted rows, and receipt only represented events", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  try {
    for (let i = 0; i < 80; i++) {
      const failed = i % 7 === 0;
      batcher.enqueue(event(`sa_${String(i).padStart(3, "0")}`, {
        status: failed ? "failed; unresolved failure observations" : "completed",
        outcome: failed ? "failed" : "completed",
        failure: failed ? `Unresolved failure · incident ${i} · poll exploded` : undefined,
        omittedIncidents: failed ? 3 : undefined,
        incidentCount: failed ? 4 : undefined,
        onDelivered: () => delivered.push(`sa_${String(i).padStart(3, "0")}`),
      }));
    }
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 1);
    const content = messages[0]!.message.content;
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `batch was ${utf8ByteLength(content)} bytes`);
    assert.match(content, /omitted from this batch \(not receipted; still queued\)/);
    assert.match(content, /cursor\/limit/);
    assert.match(content, /failure:/);
    assert.match(content, /omittedIncidents=3/);
    assert.doesNotMatch(content, /tools used:/);
    assert.ok(delivered.length >= 1);
    assert.ok(delivered.length < 80);
    assert.equal(batcher.pendingCount(), 80 - delivered.length);
    assert.match(content, /status=failed/);
    const first = [...delivered];
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 2);
    assert.ok(utf8ByteLength(messages[1]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
    assert.ok(delivered.length > first.length);
    for (const id of first) {
      assert.equal(delivered.filter((item) => item === id).length, 1, `${id} was receipted twice`);
      assert.doesNotMatch(messages[1]!.message.content, new RegExp(`id=${id} \\|`));
    }
  } finally {
    batcher.cancel();
  }
});

test("Unicode long labels stay inside the UTF-8 budget without splitting a code point", async () => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10_000 });
  try {
    const label = "日本語🔥".repeat(400);
    batcher.enqueue(event("sa_unicode", { label, status: "completed" }));
    assert.equal(await batcher.flush(), true);
    const content = messages[0]!.message.content;
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `unicode batch was ${utf8ByteLength(content)} bytes`);
    assert.doesNotMatch(content, /\uFFFD/);
    assert.match(content, /日本語|🔥/);
    assert.match(content, /id=sa_unicode/);
  } finally {
    batcher.cancel();
  }
});

test("many failures keep decisive facts and omitted incident counts before routine completions", () => {
  const events = [
    event("sa_ok", { status: "completed", outcome: "completed" }),
    event("sa_fail", {
      status: "failed; unresolved failure observations",
      outcome: "failed",
      failure: "Unresolved failure · poll exploded · evidence: ref=e42",
      decision: "Condition matched: $.terminalFailure = true",
      incidentCount: 12,
      omittedIncidents: 7,
    }),
    event("bg_gap", {
      source: "background-task",
      detailTool: "bg_task_status",
      status: "failed",
      outcome: "failed",
      decision: "Permission denied while terminating process tree. The task may still be executing.",
    }),
  ];
  const packed = packCallbackBatch(events);
  assert.ok(utf8ByteLength(packed.text) <= CALLBACK_BATCH_BUDGET_BYTES);
  assert.match(packed.text, /failure: Unresolved failure/);
  assert.match(packed.text, /omittedIncidents=7 retrieve: subagent_result id="sa_fail"/);
  assert.match(packed.text, /Condition matched: \$\.terminalFailure = true/);
  assert.match(packed.text, /Permission denied while terminating process tree/);
  assert.match(packed.text, /subagent_result id="sa_fail"/);
  assert.match(packed.text, /bg_task_status id=bg_gap/);
  assert.doesNotMatch(packed.text, /tools used:|FULL_LOG|environment/);
  assert.equal(packed.omitted, 0);
});

test("a failed sendMessage receipts nobody and retries the same represented plus overflow rows", async () => {
  let failNext = true;
  const contents: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    sendMessage(message) {
      if (failNext) {
        failNext = false;
        throw new Error("simulated handoff failure");
      }
      contents.push(message.content);
    },
  };
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  try {
    for (let i = 0; i < 40; i++) {
      batcher.enqueue(event(`row_${i}`, {
        label: `long-label-${"🔥".repeat(20)}-${i}`,
        status: i === 39 ? "failed" : "completed",
        failure: i === 39 ? "Unresolved failure · last row" : undefined,
        onDelivered: () => delivered.push(`row_${i}`),
      }));
    }
    assert.equal(await batcher.flush(), false);
    assert.deepEqual(delivered, []);
    assert.equal(batcher.pendingCount(), 40);
    assert.equal(await batcher.flush(), true);
    assert.equal(contents.length, 1);
    assert.ok(utf8ByteLength(contents[0]!) <= CALLBACK_BATCH_BUDGET_BYTES);
    assert.ok(delivered.length >= 1);
    assert.ok(delivered.length < 40);
    assert.match(contents[0]!, /failure:/);
    assert.equal(batcher.pendingCount(), 40 - delivered.length);
  } finally {
    batcher.cancel();
  }
});

test("origin isolation, callback:false, and pending overflow do not receipt omitted rows", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const suppressed: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  try {
    batcher.enqueue(event("sa_quiet", {
      callback: false,
      onDelivered: () => delivered.push("sa_quiet"),
    }));
    batcher.enqueue(event("sa_foreign", {
      getSuppressionReason: () => "origin session-a does not match active session-b",
      onSuppressed: (reason) => suppressed.push(reason),
      onDelivered: () => delivered.push("sa_foreign"),
    }));
    for (let i = 0; i < 30; i++) {
      batcher.enqueue(event(`sa_keep_${i}`, {
        label: `worker ${"x".repeat(80)} ${i}`,
        onDelivered: () => delivered.push(`sa_keep_${i}`),
      }));
    }
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0]!.message.content, /sa_quiet|sa_foreign/);
    assert.deepEqual(suppressed, ["origin session-a does not match active session-b"]);
    assert.ok(!delivered.includes("sa_quiet"));
    assert.ok(!delivered.includes("sa_foreign"));
    assert.ok(utf8ByteLength(messages[0]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
    if (batcher.pendingCount() > 0) {
      assert.match(messages[0]!.message.content, /not receipted; still queued/);
    }
  } finally {
    batcher.cancel();
  }
});

test("urgent callback content is bounded to 2 KiB with receipts, counts, and retrieval", async () => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host);
  try {
    const huge = `URGENT_BODY ${"你".repeat(3_000)} ${"x".repeat(4_000)}`;
    assert.ok(utf8ByteLength(huge) > CALLBACK_BATCH_BUDGET_BYTES);
    let receipts = 0;
    assert.equal(await batcher.deliverUrgent({
      source: "subagent",
      id: "sa_urgent_bound",
      label: "reviewer",
      status: "failure",
      customType: "subagent-failure",
      content: huge,
      detailTool: "subagent_result",
      incidentCount: 12,
      omittedIncidents: 7,
      onDelivered: () => { receipts += 1; },
    }), true);
    assert.equal(messages.length, 1);
    const content = messages[0]!.message.content;
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `urgent was ${utf8ByteLength(content)} bytes`);
    assert.doesNotMatch(content, /\uFFFD/);
    assert.match(content, /sa_urgent_bound/);
    assert.match(content, /incidents=12 omittedIncidents=7 retrieve: subagent_result id="sa_urgent_bound"/);
    assert.match(content, /Inspect: subagent_result id="sa_urgent_bound"/);
    assert.match(content, /omittedBytes=\d+/);
    assert.equal(receipts, 1);
    assert.equal(content.includes(huge), false);
  } finally {
    batcher.cancel();
  }
});

test("callback overflow stays queued across a recreated batcher and is receipted once", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const first = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  const events = Array.from({ length: 40 }, (_, i) => event(`sa_overflow_${String(i).padStart(2, "0")}`, {
    label: `overflow-${"文".repeat(30)}-${i}`,
    onDelivered: () => delivered.push(`sa_overflow_${String(i).padStart(2, "0")}`),
  }));
  try {
    for (const item of events) first.enqueue(item);
    assert.equal(await first.flush(), true);
    assert.equal(messages.length, 1);
    assert.ok(utf8ByteLength(messages[0]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
    const firstDelivered = [...delivered];
    assert.ok(firstDelivered.length >= 1);
    assert.ok(firstDelivered.length < 40);
    assert.equal(first.pendingCount(), 40 - firstDelivered.length);
    first.cancel();

    const second = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
    try {
      for (const item of events) {
        second.enqueue({
          ...item,
          isDelivered: () => delivered.includes(item.id),
        });
      }
      assert.equal(await second.flush(), true);
      assert.equal(messages.length, 2);
      assert.ok(utf8ByteLength(messages[1]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
      for (const id of firstDelivered) {
        assert.equal(delivered.filter((item) => item === id).length, 1, `${id} receipted twice after reload`);
        assert.doesNotMatch(messages[1]!.message.content, new RegExp(`id=${id} \\|`));
      }
      assert.ok(delivered.length > firstDelivered.length);
      assert.equal(await second.flush(), true);
      const unique = new Set(delivered);
      assert.equal(unique.size, delivered.length, "no event was receipted twice while draining overflow");
    } finally {
      second.cancel();
    }
  } finally {
    first.cancel();
  }
});

function incidentRows(count: number, filler: string): string[] {
  return Array.from({ length: count }, (_, i) => `Unresolved failure · observed 2026-09-27T00:00:0${i % 10}Z · incident-${i} ${filler}`);
}

test("batch rows count exactly which incident rows they show and never claim clipped ones", () => {
  const rows = incidentRows(12, "界".repeat(150));
  const packed = packCallbackBatch([
    event("bg_many", { source: "background-task", detailTool: "bg_task_status", status: "failed", failureRows: rows }),
  ]);
  assert.ok(utf8ByteLength(packed.text) <= CALLBACK_BATCH_BUDGET_BYTES);
  const shown = rows.filter((row) => packed.text.includes(row)).length;
  assert.match(packed.text, new RegExp(`incidents=12 shown=${shown} omittedIncidents=${12 - shown} retrieve: bg_task_status id=bg_many`));
  assert.doesNotMatch(packed.text, /\uFFFD/);
});

test("a single oversized row shrinks its detail but keeps its incident counts and retrieval", () => {
  const rows = incidentRows(30, "x".repeat(380));
  const packed = packCallbackBatch([
    event("sa_huge", { label: "L".repeat(500), status: "failed", failureRows: rows, decision: "D".repeat(2_000) }),
    event("sa_next"),
  ], { maxBytes: 1_024 });
  assert.ok(utf8ByteLength(packed.text) <= 1_024, `${utf8ByteLength(packed.text)} bytes`);
  assert.deepEqual(packed.represented.map((item) => item.id), ["sa_huge"]);
  assert.match(packed.text, /incidents=30 shown=0 omittedIncidents=30 retrieve: subagent_result id="sa_huge"/);
  assert.match(packed.text, /1 more completion omitted from this batch \(not receipted; still queued\)/);
});

test("urgent callbacks keep the explanation, whole incident rows, exact counts, and one real inspect target", () => {
  for (const filler of ["x".repeat(4_000), "界".repeat(3_000)]) {
    const rows = incidentRows(12, filler.slice(0, 120));
    const content = formatUrgentCallback({
      source: "background-task",
      id: "failure:bg_task_1:deadbeef",
      inspectId: "bg_task_1",
      label: "deploy",
      status: "failure",
      customType: "background-task-failure",
      content: `Background task bg_task_1 needs attention. ${filler}`,
      detailTool: "bg_task_status",
      failureRows: rows,
    });
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `${utf8ByteLength(content)} bytes`);
    assert.doesNotMatch(content, /failure:bg_task_1:deadbeef/);
    assert.match(content, /^background-task id=bg_task_1 /);
    assert.match(content, /Background task bg_task_1 needs attention/);
    assert.match(content, /omittedBytes=\d+ retrieve: bg_task_status id=bg_task_1/);
    const shown = rows.filter((row) => content.includes(row)).length;
    assert.ok(shown >= 1, "at least one whole incident row fits beside the explanation");
    assert.match(content, new RegExp(`incidents=12 shown=${shown} omittedIncidents=${12 - shown} retrieve: bg_task_status id=bg_task_1`));
    assert.equal(content.match(/Inspect: bg_task_status id=bg_task_1/g)?.length, 1);
  }
});

test("urgent callbacks under a tiny budget still keep the counts ahead of any body", () => {
  const content = formatUrgentCallback({
    source: "subagent", id: "sa_tiny", label: "w", status: "lost", customType: "subagent-health",
    content: "ATTENTION ".repeat(200), failureRows: incidentRows(4, "y".repeat(100)),
  }, { maxBytes: 400 });
  assert.ok(utf8ByteLength(content) <= 400);
  assert.match(content, /incidents=4 shown=0 omittedIncidents=4/);
});

test("long completion statuses keep whole notes and name omissions instead of an ellipsis (#323)", () => {
  const notes = ["failed", "action required", "observation incomplete", ...Array.from({ length: 8 }, (_, i) => `note-${i}-${"q".repeat(20)}`)];
  const status = notes.join("; ");
  assert.ok(utf8ByteLength(status) > 160);
  const content = formatCallbackBatch([event("bg_long_status", { source: "background-task", status, detailTool: "bg_task_status", incidentCount: 3 })]);
  const field = content.match(/status=(.*?) \| inspect:/)?.[1];
  assert.ok(field, content);
  assert.ok(utf8ByteLength(field) <= 160, field);
  assert.doesNotMatch(field, /\.\.\.|…/);
  assert.match(field, /^failed; action required; observation incomplete; /);
  const kept = field.replace(/ \(\+\d+ more status notes?; see inspect\)$/, "").split("; ");
  for (const note of kept) assert.ok(notes.includes(note), `kept note ${note} must be whole`);
  const omitted = Number(field.match(/\(\+(\d+) more status notes?; see inspect\)$/)?.[1]);
  assert.equal(kept.length + omitted, notes.length);
  assert.match(content, /incidents=3 shown=0/);

  const short = formatCallbackBatch([event("bg_short_status", { status: "failed; 2 incidents need attention" })]);
  assert.match(short, /status=failed; 2 incidents need attention \| inspect:/);

  const urgent = formatUrgentCallback({
    source: "subagent", id: "sa_status", label: "w", status, customType: "subagent-health", content: "lost",
  });
  const header = urgent.split("\n")[0]!;
  assert.doesNotMatch(header, /\.\.\.|…/);
  assert.match(header, /status=failed; action required; .* \(\+\d+ more status notes?; see inspect\)$/);

  const single = formatCallbackBatch([event("sa_single_note", { status: `failed:${"z".repeat(400)}` })]);
  assert.match(single, /status=failed:z+ \(clipped; see inspect\) \| inspect:/);
});
