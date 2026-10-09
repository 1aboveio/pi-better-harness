// @covers goal.retry-runtime-compatibility
// @level integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Reuse the pinned SDK selected by the native-codemode compatibility lane.
const sdkUrl = process.env.PI_CODEMODE_TEST_SDK_DIR
  ? pathToFileURL(join(process.env.PI_CODEMODE_TEST_SDK_DIR, "dist/index.js")).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(sdkUrl);
const aiUrl = process.env.PI_CODEMODE_TEST_SDK_DIR
  ? new URL("../../pi-ai/dist/index.js", sdkUrl).href
  : import.meta.resolve("@earendil-works/pi-ai");
const ai = await import(aiUrl);
const previousEnv = Object.fromEntries([
  "PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS", "PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES",
  "PI_BETTER_GOAL_DISABLE_WAKE", "PI_BETTER_EXTENSION_DISABLE_WAKE",
].map((key) => [key, process.env[key]]));
process.env.PI_BETTER_GOAL_IDLE_CONTINUATION_DELAY_MS = "60000";
process.env.PI_BETTER_GOAL_MAX_NO_PROGRESS_RETRIES = "1";
delete process.env.PI_BETTER_GOAL_DISABLE_WAKE;
delete process.env.PI_BETTER_EXTENSION_DISABLE_WAKE;
const { default: goalExtension } = await import("../packages/pi-better-goal/src/index.ts");
const { createGoalSnapshot, goalSetEntry, createContinuationState, continuationStateEntry, currentGoalSnapshot, currentContinuationState } =
  await import("../packages/pi-better-goal/src/goal-state.ts");
const { continuationEvidence } = await import("../packages/pi-better-goal/src/continuation.ts");

test("Pi retries settle before Goal updates, and only explicit resume reopens exhausted holds", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-goal-retry-runtime-"));
  const agentDir = join(root, "agent");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let session;
  t.after(async () => {
    if (session) {
      await session._extensionRunner.emit({ type: "session_shutdown" });
      session.dispose();
    }
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(root, { recursive: true, force: true });
  });
  // Shorten only the clock scale. Pi's default retry count remains unchanged.
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { baseDelayMs: 1, maxAgentDelayMs: 4 },
    compaction: { enabled: false },
    cacheWarming: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore(), refreshOnCreate: false,
    modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json"),
  });
  let attempts = 0;
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const provider = {
    baseUrl: "https://example.invalid", apiKey: "synthetic-test-key", api: "openai-completions",
    models: [{ id: "offline", name: "Offline fixture", input: ["text"], reasoning: false,
      contextWindow: 128_000, maxTokens: 1024, cost }],
    streamSimple(model) {
      attempts += 1;
      const stream = ai.createAssistantMessageEventStream();
      const error = { role: "assistant", content: [], api: model.api, provider: model.provider,
        model: model.id, stopReason: "error", errorMessage: "fetch failed", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { ...cost, total: 0 } } };
      stream.push({ type: "error", reason: "error", error });
      stream.end(error);
      return stream;
    },
  };
  modelRuntime.registerProvider("goal-retry-test", provider);
  let activityChanged;
  let subscribeActivity;
  let backgroundActive = false;
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "goal-under-test", factory(pi) {
      pi.registerProvider("goal-retry-test", provider);
      goalExtension(pi);
      subscribeActivity = (listener) => pi.events.on("pi-better-goal:activity", listener);
      pi.events.emit("pi-better-goal:register-provider", {
        id: "runtime-fixture",
        getActivity: () => ({ providerId: "runtime-fixture", items: backgroundActive
          ? [{ id: "work", status: "running", active: true }] : [] }),
        onActivityChanged(notify) {
          activityChanged = notify;
          return () => { activityChanged = undefined; };
        },
      });
    } }],
  });
  await loader.reload();
  const goal = createGoalSnapshot("wait for network recovery");
  const manager = sdk.SessionManager.inMemory(root);
  manager.appendCustomEntry("pi-better-goal", goalSetEntry(goal, "command"));
  manager.appendCustomEntry("pi-better-goal", continuationStateEntry({
    ...createContinuationState(goal.goalId), lastEvidenceSignature: continuationEvidence([]).signature,
  }));
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, modelRuntime,
    resourceLoader: loader, sessionManager: manager, model: modelRuntime.getModel("goal-retry-test", "offline"),
    noTools: "builtin" }));
  const errors = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });
  const trace = [];
  session.subscribe((event) => {
    if (event.type === "auto_retry_start") trace.push({ type: event.type, attempt: event.attempt, delayMs: event.delayMs });
    if (event.type === "agent_settled") trace.push({ type: event.type });
  });
  await session.prompt("retry the pending request", { source: "extension" });
  const ctx = { sessionManager: manager };
  const ledger = currentContinuationState(ctx, goal.goalId);
  assert.equal(attempts, 4, "initial request plus Pi's three default retries");
  assert.deepEqual(trace, [
    { type: "auto_retry_start", attempt: 1, delayMs: 1 },
    { type: "auto_retry_start", attempt: 2, delayMs: 2 },
    { type: "auto_retry_start", attempt: 3, delayMs: 4 },
    { type: "agent_settled" },
  ]);
  assert.equal(ledger.noProgressRetries, 1, "Goal counts the settled turn, not inner network attempts");
  assert.equal(ledger.blocked, true);
  assert.equal(settingsManager.getRetrySettings().maxRetries, 3, "Goal leaves Pi's retry budget alone");

  await session.reload();
  assert.equal(currentContinuationState(ctx, goal.goalId).blocked, true, "reload preserves the held ledger");
  const sent = [];
  const sendCustomMessage = session.sendCustomMessage.bind(session);
  session.sendCustomMessage = async (message, options) => {
    sent.push({ message, options });
    return sendCustomMessage(message, options);
  };
  const resumedTurnSettled = new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "agent_settled") return;
      unsubscribe();
      resolve();
    });
  });
  await session.prompt("/goal resume");
  await resumedTurnSettled;
  assert.equal(currentGoalSnapshot(ctx).goalId, goal.goalId);
  assert.equal(currentGoalSnapshot(ctx).status, "active");
  assert.equal(currentContinuationState(ctx, goal.goalId).blocked, false);
  assert.equal(currentContinuationState(ctx, goal.goalId).noProgressRetries, 0);
  assert.equal(sent.length, 1, "the real command path hands off exactly one continuation");
  assert.equal(sent[0].options.triggerTurn, true);
  assert.equal(attempts, 8, "the resumed continuation really runs through Pi's retry loop");

  await session.prompt("repeat the failed request", { source: "extension" });
  assert.equal(currentContinuationState(ctx, goal.goalId).blocked, true);
  const held = currentContinuationState(ctx, goal.goalId);
  await session.prompt("what is blocked?", { source: "interactive" });
  assert.deepEqual(currentContinuationState(ctx, goal.goalId), held, "a real interactive question preserves the exhausted ledger");
  const observeActivity = async (active) => {
    const observed = new Promise((resolve) => {
      const unsubscribe = subscribeActivity((snapshot) => {
        if (snapshot.backgroundRunning !== active) return;
        unsubscribe();
        resolve();
      });
    });
    backgroundActive = active;
    assert.equal(typeof activityChanged, "function");
    activityChanged();
    await observed;
  };
  await observeActivity(true);
  await observeActivity(false);
  assert.deepEqual(currentContinuationState(ctx, goal.goalId), held, "background drains do not reopen an exhausted hold");
  const sentBeforeCallback = sent.length;
  await session.prompt("background completion callback", { source: "extension" });
  assert.deepEqual(currentContinuationState(ctx, goal.goalId), held, "callback-origin turns leave the exhausted hold intact");
  assert.equal(sent.length, sentBeforeCallback, "the held goal sends no drain continuation");
  assert.equal(attempts, 20);
  assert.deepEqual(errors, []);
});
