import assert from "node:assert/strict";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertLocalSessionTransferSafe, markLocalSessionDeparted, registerDetach, registerLocalOwnershipGuard } from "../src/detach/extension.ts";
import { localStateDir, writeLocalRecord, type LocalRecord } from "../src/detach/local-state.ts";
import { llmCalls, makeEnv } from "./helpers.ts";

async function setup(t: TestContext, detachFirst = false) {
  const env = makeEnv();
  const vars = { ...env.vars, PI_REMOTE_STATE_DIR: join(env.root, "state") };
  const saved = new Map(Object.keys(vars).map(key => [key, process.env[key]]));
  Object.assign(process.env, vars);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const createRuntime = async (manager: SessionManager, register = registerLocalOwnershipGuard, additionalExtensionPaths: string[] = []) => {
    let api!: ExtensionAPI;
    const loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, additionalExtensionPaths, extensionFactories: [pi => {
      api = pi;
      if (detachFirst) registerDetach(pi);
      register(pi);
      register(pi);
    }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: env.cwd, agentDir: env.agentDir, sessionManager: manager, resourceLoader: loader });
    const startAbortSignals: boolean[] = [];
    session.subscribe(event => {
      if (event.type === "agent_start") startAbortSignals.push(session.agent.signal?.aborted === true);
    });
    t.after(() => session.dispose());
    await session.bindExtensions({});
    await session.setModel(session.modelRuntime.getModel("fake", "fake-1")!);
    return { api, loader, session, startAbortSignals };
  };
  const manager = SessionManager.create(env.cwd, join(env.agentDir, "sessions"));
  const runtime = await createRuntime(manager);
  await runtime.session.prompt("seed ownership test");
  const sessionFile = manager.getSessionFile()!;
  const record = (state: LocalRecord["state"]) => writeLocalRecord(localStateDir(), {
    sessionId: manager.getSessionId(), state, epoch: 0, moveId: "guard-transfer", cwd: env.cwd, host: "testhost",
  });
  const transcript = () => readFileSync(sessionFile, "utf8");
  const append = (content: string) => manager.appendMessage({ role: "user", content, timestamp: 0 });
  const writeGate = manager as unknown as { _rewriteFile(): void };
  return { env, ...runtime, createRuntime, manager, writeGate, record, transcript, append };
}

for (const loading of ["inline", "file"] as const) {
 test(`a departed manager stays blocked across ${loading}-loaded replacement runtimes while a returned manager can execute and persist`, async t => {
  const f = await setup(t);
  const sessionId = f.manager.getSessionId();
  const before = f.transcript();
  const calls = llmCalls(f.env).length;
  const persist = f.manager._persist;
  const rewrite = f.writeGate._rewriteFile;
  f.record("moved");
  markLocalSessionDeparted(f.api, sessionId, f.manager);
  f.record("owned");
  const oldContext = f.session.extensionRunner!.createContext();
  f.session.dispose();
  assert.throws(() => oldContext.sessionManager, /disposed|no longer active|stale/i);

  const replacement = loading === "inline"
    ? await f.createRuntime(f.manager)
    : await f.createRuntime(f.manager, () => {}, [fileURLToPath(new URL("../src/detach/extension.ts", import.meta.url))]);
  assert.notEqual(replacement.api, f.api);
  assert.equal(f.transcript(), before, "constructor and binding cannot write through the retained manager");
  const runner = replacement.session.extensionRunner!;
  assert.deepEqual(await runner.emitInput("stale input", undefined, "interactive"), { action: "handled" });
  const tool = await runner.emitToolCall({ type: "tool_call", toolCallId: "stale-tool", toolName: "bash", input: { command: "touch should-not-run" } });
  assert.equal(tool?.block, true);
  await replacement.session.prompt("stale prompt");
  assert.equal(llmCalls(f.env).length, calls, "no model work may run with silently discarded persistence");
  await replacement.session.sendCustomMessage({ customType: "background-task", content: "stale callback", display: true }, { triggerTurn: true });
  assert.deepEqual(replacement.startAbortSignals, [true], "extension turns start with an aborted signal");
  f.append("stale direct append");
  f.writeGate._rewriteFile();
  assert.equal(f.transcript(), before);
  assert.equal(f.manager._persist, persist, "replacement APIs reuse the manager's persist gate");
  assert.equal(f.writeGate._rewriteFile, rewrite, "replacement APIs reuse the manager's rewrite gate");

  const returnedFile = join(f.env.root, "returned.jsonl");
  copyFileSync(f.manager.getSessionFile()!, returnedFile);
  const returnedManager = SessionManager.open(returnedFile);
  assert.equal(returnedManager.getSessionId(), sessionId);
  returnedManager.appendMessage({ role: "user", content: "new history from remote", timestamp: 0 });
  const returned = await f.createRuntime(returnedManager);
  assert.deepEqual(await returned.session.extensionRunner!.emitInput("returned input", undefined, "interactive"), { action: "continue" });
  assert.equal(await returned.session.extensionRunner!.emitToolCall({ type: "tool_call", toolCallId: "returned-tool", toolName: "bash", input: { command: "true" } }), undefined);
  const returnedCalls = llmCalls(f.env).length;
  await returned.session.prompt("continue returned history");
  assert.equal(llmCalls(f.env).length, returnedCalls + 1);
  assert.equal(returned.session.getLastAssistantText(), "echo:continue returned history");
  assert.equal(SessionManager.open(returnedManager.getSessionFile()!).getLeafId(), returnedManager.getLeafId(), "allowed model work is persisted, not silently lost");
  assert.match(readFileSync(returnedFile, "utf8"), /echo:continue returned history/);
  const lastCall = llmCalls(f.env).at(-1)!;
  for (const text of ["seed ownership test", "new history from remote", "continue returned history"]) {
    assert.ok(lastCall.messages.some(message => message.role === "user" && message.text === text), `${text} is in the returned model context`);
  }
  assert.equal(f.transcript(), before, "the stale manager's original file remains untouched");
 });
}

for (const detachFirst of [false, true]) {
  test(`ownership guard registration is idempotent with detach loaded ${detachFirst ? "first" : "later"}`, async t => {
    const f = await setup(t, detachFirst);
    const runner = f.session.extensionRunner!;
    const persist = f.manager._persist;
    const rewrite = f.writeGate._rewriteFile;
    if (!detachFirst) {
      assert.equal(runner.getCommand("detach"), undefined, "the standalone guard registers no detach command");
      registerDetach(f.api);
    }
    registerLocalOwnershipGuard(f.api);
    await runner.emit({ type: "session_start", reason: "resume" });
    assert.deepEqual(await runner.emitInput("allowed input", undefined, "interactive"), { action: "continue" });
    assert.equal(f.manager._persist, persist, "the manager's persist gate is not wrapped twice");
    assert.equal(f.writeGate._rewriteFile, rewrite, "the manager's rewrite gate is not wrapped twice");
    const extension = f.loader.getExtensions().extensions.find(ext => ext.handlers.has("tool_call"))!;
    for (const event of ["session_start", "input", "agent_start", "tool_call"]) {
      assert.equal(extension.handlers.get(event)?.length, 1, `${event} has one ownership handler`);
    }
    const entryId = f.append("written once after repeated registration");
    const entries = f.transcript().trim().split("\n").map(line => JSON.parse(line));
    assert.equal(entries.filter(entry => entry.id === entryId).length, 1);
    assert.equal(SessionManager.open(f.manager.getSessionFile()!).getLeafId(), entryId);
  });
}

for (const state of ["fenced", "moved"] as const) {
  test(`the standalone guard blocks ${state} input, tools and writes, and aborts extension turns`, async t => {
    const f = await setup(t);
    const runner = f.session.extensionRunner!;
    const before = f.transcript();
    const calls = llmCalls(f.env).length;
    f.record(state);
    assert.deepEqual(await runner.emitInput("blocked input", undefined, "interactive"), { action: "handled" });
    if (state === "moved") f.record("owned"); // Return before any persist call can latch departure.
    await f.session.prompt("blocked prompt");
    assert.equal(llmCalls(f.env).length, calls, "blocked input never reaches the model");
    const starts = f.startAbortSignals.length;
    await f.session.sendCustomMessage({ customType: "background-task", content: "blocked callback", display: true }, { triggerTurn: true });
    assert.deepEqual(f.startAbortSignals.slice(starts), [true], "the extension-triggered turn starts with its real signal aborted");
    const result = await runner.emitToolCall({ type: "tool_call", toolCallId: "guard-tool", toolName: "bash", input: { command: "touch should-not-run" } });
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", state === "fenced" ? /detach.*in flight/ : /moved away.*new process/);
    f.append("blocked append");
    f.writeGate._rewriteFile();
    assert.equal(f.transcript(), before, "both append and full rewrite leave the transcript untouched");
  });
}

test("an owned source remains writable after a copy that does not mark departure", async t => {
  const f = await setup(t);
  f.record("owned");
  const calls = llmCalls(f.env).length;
  await f.session.prompt("continue after copy");
  assert.equal(llmCalls(f.env).length, calls + 1);
  assert.equal(f.session.getLastAssistantText(), "echo:continue after copy");
  const entryId = f.append("copy source still owns the transcript");
  assert.equal(SessionManager.open(f.manager.getSessionFile()!).getLeafId(), entryId);
});

test("write gates retain the real manager after native-style context invalidation and latch moved records", async t => {
  const f = await setup(t);
  const ctx = f.session.extensionRunner!.createContext();
  assert.equal(ctx.sessionManager, f.manager);
  f.session.dispose();
  assert.throws(() => ctx.sessionManager, /disposed|no longer active|stale/i);
  const entryId = f.append("write through the captured manager after context invalidation");
  assert.equal(SessionManager.open(f.manager.getSessionFile()!).getLeafId(), entryId);
  const before = f.transcript();
  f.record("fenced");
  f.append("fenced after context invalidation");
  f.writeGate._rewriteFile();
  assert.equal(f.transcript(), before);
  f.record("moved");
  f.append("latch departure on persist without input");
  f.record("owned");
  f.append("return cannot reopen the invalidated manager");
  f.writeGate._rewriteFile();
  assert.equal(f.transcript(), before);
});

test("acknowledged handoff marks departure before a return replaces the record without an intervening guard check", async t => {
  const f = await setup(t);
  const before = f.transcript();
  const calls = llmCalls(f.env).length;
  f.record("moved");
  markLocalSessionDeparted(f.api, f.manager.getSessionId(), f.manager);
  f.record("owned");
  await f.session.prompt("old process must not reactivate");
  assert.equal(llmCalls(f.env).length, calls, "the returned record cannot admit old input");
  const starts = f.startAbortSignals.length;
  await f.session.sendCustomMessage({ customType: "background-task", content: "old callback after return", display: true }, { triggerTurn: true });
  assert.deepEqual(f.startAbortSignals.slice(starts), [true]);
  f.append("old writer after immediate return");
  f.writeGate._rewriteFile();
  assert.equal(f.transcript(), before);
});

test("a manager may start a different logical session after departure without reactivating the old id", async t => {
  const f = await setup(t);
  const oldId = f.manager.getSessionId();
  const before = f.transcript();
  markLocalSessionDeparted(f.api, oldId, f.manager);
  f.manager.newSession();
  assert.notEqual(f.manager.getSessionId(), oldId);
  f.manager.appendMessage({ role: "user", content: "new logical id remains writable", timestamp: 0 });
  f.manager.appendMessage(f.session.messages.find(message => message.role === "assistant")!);
  assert.match(readFileSync(f.manager.getSessionFile()!, "utf8"), /new logical id remains writable/);
  assert.equal(f.transcript(), before);
});

test("late departure notification targets the captured manager, and retained snapshots stay read-only after return", async t => {
  const f = await setup(t);
  const sessionId = f.manager.getSessionId();
  const before = f.transcript();
  const returnedFile = join(f.env.root, "canonical-returned.jsonl");
  copyFileSync(f.manager.getSessionFile()!, returnedFile);
  writeLocalRecord(localStateDir(), { sessionId, state: "owned", epoch: 2, sessionFile: returnedFile, cwd: f.env.cwd });
  const returned = await f.createRuntime(SessionManager.open(returnedFile));
  markLocalSessionDeparted(returned.api, sessionId, f.manager);
  await returned.session.prompt("canonical returned writer");
  assert.equal(returned.session.getLastAssistantText(), "echo:canonical returned writer");
  const retained = await f.createRuntime(SessionManager.open(f.manager.getSessionFile()!));
  const calls = llmCalls(f.env).length;
  await retained.session.prompt("must not revive retained snapshot");
  assert.equal(llmCalls(f.env).length, calls);
  assert.equal(f.transcript(), before);
});

for (const missing of ["_persist", "_rewriteFile"] as const) {
  test(`transfer safety accepts a supported manager and rejects Pi without ${missing}`, t => {
    const env = makeEnv();
    const manager = SessionManager.create(env.cwd, join(env.agentDir, "sessions"));
    assertLocalSessionTransferSafe(manager);
    Object.defineProperty(manager, missing, { value: undefined, configurable: true });
    t.after(() => { delete (manager as unknown as Record<string, unknown>)[missing]; });
    assert.throws(() => assertLocalSessionTransferSafe(manager), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`Refusing to detach:.*${missing}`));
      assert.match(error.message, /This session is unchanged\./);
      return true;
    });
  });
}
