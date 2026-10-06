// @covers background-callback.batch
// @level integration
// @fails-without-fix background-callback.batch
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Type } from "typebox";
import backgroundTasksExtension from "../packages/pi-better-background-tasks/src/index.ts";
import subagentsExtension from "../packages/pi-better-subagents/index.ts";
import { changeCallbackSetting, getCallbackBatcher } from "../packages/pi-better-background-tasks/src/shared-callback-batcher.ts";
import { getCallbackBatcher as getSubagentCallbackBatcher } from "../packages/pi-better-subagents/shared-callback-batcher.ts";

const sdkUrl = process.env.PI_CODEMODE_TEST_SDK_DIR
  ? pathToFileURL(join(process.env.PI_CODEMODE_TEST_SDK_DIR, "dist/index.js")).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(sdkUrl);
const ai = await import(process.env.PI_CODEMODE_TEST_SDK_DIR
  ? new URL("../../pi-ai/dist/index.js", sdkUrl).href
  : import.meta.resolve("@earendil-works/pi-ai"));

test("#425 real Pi sees one mixed completion steer after a held tool without settling", { timeout: 10_000 }, async (t) => {
  const keepAlive = setInterval(() => {}, 10_000);
  t.after(() => clearInterval(keepAlive));
  const root = mkdtempSync(join(tmpdir(), "pi-callback-steer-"));
  const agentDir = join(root, "agent");
  let session;
  let host;
  let subagentHost;
  let settlements = 0;
  const toolEntered = Promise.withResolvers();
  const releaseTool = Promise.withResolvers();
  const compactionEntered = Promise.withResolvers();
  const releaseCompaction = Promise.withResolvers();
  const started = Array.from({ length: 4 }, () => Promise.withResolvers());
  const requests = [];
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const provider = {
    baseUrl: "https://example.invalid", apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "offline", name: "Offline fixture", input: ["text"], reasoning: false,
      contextWindow: 128_000, maxTokens: 1024, cost }],
    streamSimple(model, context) {
      const stream = ai.createAssistantMessageEventStream();
      const first = requests.length === 0;
      const response = { role: "assistant", content: first
        ? [{ type: "toolCall", id: "held-call", name: "held_work", arguments: {} }]
        : [{ type: "text", text: "Finished." }],
        api: model.api, provider: model.provider, model: model.id,
        stopReason: first ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      const request = { context, finish() {
        stream.push({ type: "done", reason: response.stopReason, message: response });
        stream.end(response);
      } };
      requests.push(request);
      started[requests.length - 1]?.resolve(request);
      if (requests.length > started.length) request.finish();
      return stream;
    },
  };
  t.after(async () => {
    releaseCompaction.resolve();
    releaseTool.resolve();
    for (const request of requests) request.finish();
    if (session) {
      await session.abort();
      await session._extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 1 }, cacheWarming: { enabled: false },
    steeringMode: "one-at-a-time", followUpMode: "one-at-a-time",
  });
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
    refreshOnCreate: false, modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json") });
  modelRuntime.registerProvider("callback-steer-test", provider);
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "background-tasks-under-test", factory(pi) {
      host = pi;
      pi.registerProvider("callback-steer-test", provider);
      backgroundTasksExtension(pi);
      pi.registerTool({ name: "held_work", label: "Held work", description: "Offline held tool",
        parameters: Type.Object({}), async execute() {
          toolEntered.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "Tool finished." }], details: undefined };
        } });
      pi.on("agent_settled", () => { settlements += 1; });
      pi.on("session_before_compact", async () => {
        compactionEntered.resolve();
        await releaseCompaction.promise;
        return { cancel: true };
      });
    } }, { name: "subagents-under-test", factory(pi) {
      subagentHost = pi;
      subagentsExtension(pi);
    } }],
  });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, modelRuntime,
    resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(root),
    model: modelRuntime.getModel("callback-steer-test", "offline"), noTools: "builtin" }));
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  changeCallbackSetting(host, { sessionManager: session.sessionManager, isIdle: () => session.isIdle }, "steer");
  const sent = [];
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (message, options) => {
    sent.push({ message, options, idleAtSend: session.isIdle });
    return sendCustomMessage(message, options);
  };
  const batcher = getCallbackBatcher(host);
  const subagentBatcher = getSubagentCallbackBatcher(subagentHost);
  assert.equal(batcher, subagentBatcher);
  const receipts = [];
  const completion = (source, id) => ({ source, id, label: id,
    status: "completed", detailTool: source === "subagent" ? "subagent_result" : "bg_task_status",
    onDelivered: () => receipts.push(id) });
  const foreground = session.prompt("Run held_work, then continue foreground work", { source: "extension" });
  (await started[0].promise).finish();
  await toolEntered.promise;
  const firstCompletion = completion("background-task", "bg_held");
  batcher.enqueue(firstCompletion);
  assert.equal(await batcher.flush(), false, "hold completions until the active tool boundary");
  subagentBatcher.enqueue(completion("subagent", "sa_held"));
  assert.equal(subagentBatcher.enqueue({ ...completion("subagent", "sa_silent"), callback: false }), false);
  assert.equal(await subagentBatcher.flush(), false);
  assert.equal(sent.length, 0);
  releaseTool.resolve();
  const continued = await started[1].promise;
  assert.equal(settlements, 0, "the completion must be visible before the foreground run settles");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idleAtSend, false);
  assert.equal(sent[0].options.deliverAs, "steer");
  assert.match(sent[0].message.content, /^2 background completions are ready:/);
  const modelContext = JSON.stringify(continued.context.messages);
  assert.match(modelContext, /bg_held/);
  assert.match(modelContext, /sa_held/);
  assert.doesNotMatch(modelContext, /sa_silent/);
  assert.deepEqual(receipts, ["bg_held", "sa_held"]);
  continued.finish();
  await foreground;
  await session.waitForIdle();
  assert.equal(requests.length, 2, "steer must not leave a duplicate follow-up turn");

  batcher.enqueue(firstCompletion);
  await batcher.flush();
  assert.equal(sent.length, 1, "idle replay of a steer handoff must not send it again");
  batcher.enqueue(completion("background-task", "bg_idle"));
  const idleRun = await started[2].promise;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].idleAtSend, true);
  assert.deepEqual(sent[1].options, { deliverAs: "followUp", triggerTurn: true });
  assert.match(JSON.stringify(idleRun.context.messages), /bg_idle/);
  idleRun.finish();
  await session.waitForIdle();

  const modelOnlyRun = session.prompt("Continue without tools", { source: "extension" });
  const modelOnlyRequest = await started[3].promise;
  batcher.enqueue(completion("background-task", "bg_model_stream"));
  await batcher.flush();
  assert.equal(sent.length, 3);
  assert.equal(sent[2].idleAtSend, false);
  assert.equal(sent[2].options.deliverAs, "steer");
  modelOnlyRequest.finish();
  await modelOnlyRun;
  await session.waitForIdle();
  assert.equal(requests.length, 5, "a busy completion must steer a model-only turn even when it stops");
  assert.match(JSON.stringify(requests[4].context.messages), /bg_model_stream/);

  const compacting = assert.rejects(session.compact(), /Compaction cancelled/);
  await compactionEntered.promise;
  await t.test("manual compaction holds callbacks instead of dispatching a run", {
    skip: session.isIdle ? "This older Pi SDK reports idle during manual compaction" : false,
  }, async () => {
    assert.equal(session.isStreaming, false);
    batcher.enqueue(completion("background-task", "bg_during_compaction"));
    assert.equal(await batcher.flush(), false);
    assert.equal(sent.length, 3, "compaction cannot dispatch a completion-driven agent run");
    assert.equal(requests.length, 5);
    releaseCompaction.resolve();
    await compacting;
    await batcher.flush();
    await session.waitForIdle();
    assert.equal(sent.length, 4);
    assert.deepEqual(sent[3].options, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(requests.length, 6, "the held completion becomes one idle run after compaction");
    assert.match(JSON.stringify(requests[5].context.messages), /bg_during_compaction/);
  });
  releaseCompaction.resolve();
  await compacting;
  assert.deepEqual(errors, []);
});

test("#409 real Pi runs one aggregate after settlement and holds arrivals during that run", { timeout: 10_000 }, async (t) => {
  // Production wake timers are unref'd; the offline provider's unresolved
  // promises do not keep Node alive while this test waits for a wake.
  const keepAlive = setInterval(() => {}, 10_000);
  t.after(() => clearInterval(keepAlive));
  const root = mkdtempSync(join(tmpdir(), "pi-callback-availability-"));
  const agentDir = join(root, "agent");
  let session;
  let host;
  let subagentHost;
  const requests = [];
  const settledEntered = Promise.withResolvers();
  const releaseSettled = Promise.withResolvers();
  const firstHandoff = Promise.withResolvers();
  let heldSettlement = false;
  const started = Array.from({ length: 4 }, () => Promise.withResolvers());
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const provider = {
    baseUrl: "https://example.invalid", apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "offline", name: "Offline fixture", input: ["text"], reasoning: false,
      contextWindow: 128_000, maxTokens: 1024, cost }],
    streamSimple(model, context) {
      const stream = ai.createAssistantMessageEventStream();
      const response = { role: "assistant", content: [{ type: "text", text: "Finished." }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      const request = { context, finish() {
        stream.push({ type: "done", reason: "stop", message: response });
        stream.end(response);
      } };
      requests.push(request);
      started[requests.length - 1]?.resolve(request);
      return stream;
    },
  };
  t.after(async () => {
    releaseSettled.resolve();
    for (const request of requests) request.finish();
    if (session) {
      await session.abort();
      await session._extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false },
    followUpMode: "one-at-a-time",
  });
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
    refreshOnCreate: false, modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json") });
  modelRuntime.registerProvider("callback-availability-test", provider);
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "background-tasks-under-test", factory(pi) {
      host = pi;
      pi.registerProvider("callback-availability-test", provider);
      backgroundTasksExtension(pi);
    } }, { name: "subagents-under-test", factory(pi) {
      subagentHost = pi;
      subagentsExtension(pi);
      pi.on("agent_settled", async () => {
        if (heldSettlement) return;
        heldSettlement = true;
        settledEntered.resolve();
        await releaseSettled.promise;
      });
    } }],
  });
  await loader.reload();
  const manager = sdk.SessionManager.inMemory(root);
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, modelRuntime,
    resourceLoader: loader, sessionManager: manager,
    model: modelRuntime.getModel("callback-availability-test", "offline"), noTools: "builtin" }));
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  changeCallbackSetting(host, { sessionManager: manager, isIdle: () => session.isIdle }, "hold");
  const sent = [];
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = (message, options) => {
    sent.push({ message, idleAtSend: session.isIdle });
    if (sent.length === 1) firstHandoff.resolve();
    return sendCustomMessage(message, options);
  };
  const batcher = getCallbackBatcher(host);
  const subagentBatcher = getSubagentCallbackBatcher(subagentHost);
  assert.notEqual(host, subagentHost);
  assert.equal(batcher, subagentBatcher, "real extension API wrappers must share one session batcher");
  const enqueue = (id) => batcher.enqueue({ source: "background-task", id, label: id,
    status: "succeeded", detailTool: "bg_task_status" });
  const foreground = session.prompt("Continue foreground work", { source: "extension" });
  const first = await started[0].promise;
  enqueue("bg_first");
  assert.equal(await batcher.flush(), false);
  subagentBatcher.enqueue({ source: "subagent", id: "sa_second", label: "reviewer",
    status: "completed", detailTool: "subagent_result" });
  assert.equal(await batcher.flush(), false);
  assert.equal(sent.length, 0, "busy completions never enter Pi's follow-up queue");
  first.finish();
  await settledEntered.promise;
  await firstHandoff.promise;
  enqueue("bg_during_callback");
  await batcher.flush();
  await new Promise((resolve) => setImmediate(resolve));
  await batcher.flush();
  assert.equal(sent.length, 1, "a held settled handler cannot cause multiple deferred runs");
  releaseSettled.resolve();

  const aggregate = await started[1].promise;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].idleAtSend, true, "callback starts only after Pi becomes idle");
  assert.match(sent[0].message.content, /^2 background completions are ready:/);
  assert.match(sent[0].message.content, /bg_first/);
  assert.match(sent[0].message.content, /sa_second/);
  aggregate.finish();

  const next = await started[2].promise;
  assert.equal(sent.length, 2);
  assert.equal(sent[1].idleAtSend, true);
  assert.match(sent[1].message.content, /^1 background completion is ready:/);
  assert.match(sent[1].message.content, /bg_during_callback/);
  assert.doesNotMatch(sent[1].message.content, /bg_first|sa_second/);
  next.finish();
  await foreground;
  await session.waitForIdle();
  assert.equal(requests.length, 3, "one foreground run plus one aggregate and one later arrival run");
  assert.equal(batcher.pendingCount(), 0);

  const previousHost = host;
  await session.reload();
  assert.notEqual(host, previousHost, "reload replaces the extension runtime's API wrappers");
  const reloaded = getCallbackBatcher(host);
  assert.equal(reloaded, batcher, "session event bus preserves shared handoff state across reload");
  enqueue("bg_after_reload");
  const afterReload = await started[3].promise;
  assert.equal(sent.length, 3);
  assert.match(sent[2].message.content, /bg_after_reload/);
  assert.equal(sent[2].idleAtSend, true);
  afterReload.finish();
  await session.waitForIdle();
  assert.equal(requests.length, 4);
  assert.deepEqual(errors, []);
});