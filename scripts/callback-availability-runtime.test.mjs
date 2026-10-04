// @covers background-callback.batch
// @level integration
// @fails-without-fix background-callback.batch
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import backgroundTasksExtension from "../packages/pi-better-background-tasks/src/index.ts";
import subagentsExtension from "../packages/pi-better-subagents/index.ts";
import { getCallbackBatcher } from "../packages/pi-better-background-tasks/src/shared-callback-batcher.ts";
import { getCallbackBatcher as getSubagentCallbackBatcher } from "../packages/pi-better-subagents/shared-callback-batcher.ts";

const sdkUrl = process.env.PI_CODEMODE_TEST_SDK_DIR
  ? pathToFileURL(join(process.env.PI_CODEMODE_TEST_SDK_DIR, "dist/index.js")).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(sdkUrl);
const ai = await import(process.env.PI_CODEMODE_TEST_SDK_DIR
  ? new URL("../../pi-ai/dist/index.js", sdkUrl).href
  : import.meta.resolve("@earendil-works/pi-ai"));

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