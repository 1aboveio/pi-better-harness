// @covers subagents.settings-runtime
// @level integration
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Type } from "typebox";

const sdkUrl = process.env.PI_CODEMODE_TEST_SDK_DIR
  ? pathToFileURL(join(process.env.PI_CODEMODE_TEST_SDK_DIR, "dist/index.js")).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(sdkUrl);
const ai = await import(process.env.PI_CODEMODE_TEST_SDK_DIR
  ? new URL("../../pi-ai/dist/index.js", sdkUrl).href
  : import.meta.resolve("@earendil-works/pi-ai"));
const settingsType = "pi-better-subagents-settings";

function textContent(message) {
  return typeof message.content === "string" ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

function snapshotFromResult(result, expected) {
  assert.notEqual(result.isError, true, "the real inspection tool must succeed");
  const snapshot = result.structuredContent ?? result.details;
  assert.ok(snapshot && typeof snapshot === "object", "inspection returns a structured snapshot");
  assert.equal(typeof snapshot.revision, "string");
  assert.ok(snapshot.revision.length > 0, "revision is a nonempty content fingerprint");
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(snapshot[key], value, key);
  assert.equal(snapshot.occupiedSlots, snapshot.runningCount + snapshot.pendingCount);
  assert.equal(snapshot.availableSlots, Math.max(0, snapshot.maxConcurrent - snapshot.occupiedSlots));
  return snapshot;
}

test("real Pi refreshes live parent occupancy and source revisions during one foreground run", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-settings-runtime-"));
  const agentDir = join(root, "agent");
  const configPath = join(agentDir, "settings.json");
  const previousEnv = Object.fromEntries(["PI_CODING_AGENT_DIR", "TMPDIR", "TMP", "TEMP"]
    .map((key) => [key, process.env[key]]));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // Registry reconciliation and shutdown must never see the user's real children.
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = root;
  mkdirSync(agentDir, { recursive: true });
  const savedConfig = `${JSON.stringify({ piBetterHarness: { subagents: { delegationMode: "adaptive", maxConcurrent: 3 } } })}\n`;
  writeFileSync(configPath, savedConfig);
  const keepAlive = setInterval(() => {}, 10_000);
  const toolEntered = Promise.withResolvers();
  const releaseTool = Promise.withResolvers();
  const requests = [];
  const started = Array.from({ length: 8 }, () => Promise.withResolvers());
  const children = [];
  const contexts = [];
  const inspectionResults = [];
  const errors = [];
  const pages = [];
  let session;
  let contribution;
  let foreground;
  let agentStarts = 0;
  let settlements = 0;
  let closedPages = 0;
  let uiKeys = [];
  let resetConfig;
  let cleaningUp = false;
  t.after(async () => {
    cleaningUp = true;
    releaseTool.resolve();
    for (const request of requests) request.finish();
    try {
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      await Promise.all(children.map(({ exited }) => exited));
      if (session) {
        await session.abort();
        await foreground;
        await session._extensionRunner.emit({ type: "session_shutdown" });
        session.dispose();
      }
    } finally {
      clearInterval(keepAlive);
      resetConfig?.();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
  const { default: subagentsExtension } = await import("../packages/pi-better-subagents/index.ts");
  const { setConfigPathForTests } = await import("../packages/pi-better-subagents/config.ts");
  const { delegationPrompt } = await import("../packages/pi-better-subagents/delegation.ts");
  const registry = await import("../packages/pi-better-subagents/registry.ts");
  setConfigPathForTests(configPath);
  resetConfig = () => setConfigPathForTests(undefined);
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const provider = {
    baseUrl: "https://example.invalid", apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "offline", name: "Offline fixture", input: ["text"], reasoning: false,
      contextWindow: 128_000, maxTokens: 1024, cost }],
    streamSimple(model, context) {
      const index = requests.length;
      const stream = ai.createAssistantMessageEventStream();
      const toolName = index === 0 ? "held_work" : index < 7 ? "subagent_settings" : undefined;
      const response = { role: "assistant", content: toolName
        ? [{ type: "toolCall", id: `settings-call-${index}`, name: toolName, arguments: {} }]
        : [{ type: "text", text: "Finished." }],
        api: model.api, provider: model.provider, model: model.id,
        stopReason: toolName ? "toolUse" : "stop", timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } };
      let finished = false;
      const request = { context: { ...context, messages: structuredClone(context.messages) }, finish() {
        if (finished) return;
        finished = true;
        stream.push({ type: "done", reason: response.stopReason, message: response });
        stream.end(response);
      } };
      requests.push(request);
      started[index]?.resolve(request);
      if (cleaningUp || index >= started.length) request.finish();
      return stream;
    },
  };
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: { enabled: false },
  });
  const modelRuntime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(),
    refreshOnCreate: false, modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json") });
  modelRuntime.registerProvider("subagent-settings-test", provider);
  const loader = new sdk.DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [{ name: "subagents-under-test", factory(pi) {
      pi.events.on("harness-settings:register", (registered) => {
        if (registered.id === "subagents") contribution = registered;
      });
      pi.registerProvider("subagent-settings-test", provider);
      subagentsExtension(pi);
      // A public command supplies the SDK's real command context to the hub opener.
      pi.registerCommand("runtime-subagent-settings", {
        description: "Open the captured settings contribution",
        handler: (_args, ctx) => contribution.open(ctx),
      });
      pi.registerTool({ name: "held_work", label: "Held work", description: "Offline held tool",
        parameters: Type.Object({}), async execute() {
          toolEntered.resolve();
          await releaseTool.promise;
          return { content: [{ type: "text", text: "Tool finished." }], details: undefined };
        } });
      // This observer runs after the real context hook, before Pi drops customType.
      pi.on("context", (event) => { contexts.push(structuredClone(event.messages)); });
      pi.on("tool_result", (event) => {
        if (event.toolName === "subagent_settings") inspectionResults.push(structuredClone(event));
      });
      pi.on("agent_start", () => { agentStarts += 1; });
      pi.on("agent_settled", () => { settlements += 1; });
    } }],
  });
  await loader.reload();
  ({ session } = await sdk.createAgentSession({ cwd: root, agentDir, settingsManager, modelRuntime,
    resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(root),
    model: modelRuntime.getModel("subagent-settings-test", "offline"), noTools: "builtin" }));
  const theme = { fg: (_color, text) => text, bg: (_color, text) => text,
    bold: (text) => text, inverse: (text) => text };
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error), uiContext: {
    notify() {}, setWidget() {}, setStatus() {}, setEditorComponent() {}, confirm: async () => true,
    async custom(factory) {
      let closed = false;
      const page = factory({ requestRender() {} }, theme, {}, () => { closed = true; closedPages += 1; });
      page.focused = true;
      const before = page.render(100).join("\n");
      for (const key of uiKeys) page.handleInput(key);
      const after = page.render(100).join("\n");
      page.handleInput("\x1b");
      assert.equal(closed, true, "Escape closes the actual settings component");
      pages.push({ before, after });
    },
  } });
  assert.equal(typeof contribution?.open, "function", "capture registration before loading the real extension");
  const stateEntries = () => session.sessionManager.getEntries().filter((entry) => entry.type === "custom");
  function assertEphemeral() {
    assert.equal(session.messages.some((message) => message.customType === settingsType), false,
      "request-local settings must not enter agent state");
    assert.equal(session.sessionManager.getEntries().some((entry) =>
      entry.customType === settingsType || entry.message?.customType === settingsType), false,
    "request-local settings must not enter the stored transcript");
  }
  function settingsBlock(index, mode, cap, snapshot) {
    const blocks = contexts[index].filter((message) => message.role === "custom" && message.customType === settingsType);
    assert.equal(blocks.length, 1, `request ${index + 1} has exactly one settings custom block`);
    const text = textContent(blocks[0]);
    assert.match(text, new RegExp(`(?:maxConcurrent|Concurrent subagents|Concurrency limit)[\\s\"':=\\x60*-]+${cap}\\b`, "i"));
    assert.ok(text.includes(delegationPrompt(mode)), "each request contains the complete current delegation prompt");
    if (snapshot) {
      assert.deepEqual(blocks[0].details, snapshot, "context and inspection agree on every structured field");
      assert.ok(text.includes(snapshot.revision), "the readable context exposes the inspection revision");
      for (const [label, value] of [["Running", snapshot.runningCount], ["reserved", snapshot.pendingCount],
        ["Occupied slots", snapshot.occupiedSlots], ["Available slots", snapshot.availableSlots]]) {
        assert.match(text, new RegExp(`${label}:\\s*${value}\\b`), "provider-visible occupancy agrees with inspection");
      }
    }
    const delivered = requests[index].context.messages.filter((message) => message.role === "user" && textContent(message) === text);
    assert.equal(delivered.length, 1, "the recording provider receives the full custom block exactly once");
    assertEphemeral();
    return text;
  }
  // These are real processes with IPC readiness, not Pi/LLM launches. Keep the
  // metadata alive after exit to distinguish process liveness from stored status.
  async function heldChild(foreign = false) {
    const child = spawn(process.execPath, ["-e", 'process.on("message", () => process.exit(0)); process.send("ready");'], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const exited = once(child, "exit");
    children.push({ child, exited });
    const [ready] = await once(child, "message");
    assert.equal(ready, "ready");
    const id = registry.nextRunId();
    const meta = { id, status: "running", pid: child.pid, spawnPid: foreign ? child.pid : process.pid,
      cwd: root, promptPreview: "Offline held child", startedAt: Date.now(),
      logPath: registry.logPathFor(id), sessionId: `fixture-${id}`, callback: false };
    registry.writeMeta(meta);
    return { child, exited, meta: registry.readMeta(id) };
  }
  const owned = await heldChild();
  const foreign = await heldChild(true);
  const inspectionTool = session.getToolDefinition("subagent_settings");
  assert.ok(inspectionTool, "the read-only inspection tool is registered in the actual SDK");
  assert.deepEqual(inspectionTool.parameters.properties ?? {}, {}, "inspection accepts no setting arguments");
  const initialEntries = structuredClone(stateEntries());
  const initialSnapshot = snapshotFromResult(await inspectionTool.execute("initial-settings", {}), {
    delegationMode: "adaptive", maxConcurrent: 3,
    sources: { delegationMode: "config", maxConcurrent: "config" },
    runningCount: 1, pendingCount: 0, occupiedSlots: 1, availableSlots: 2,
  });
  assert.deepEqual(stateEntries(), initialEntries, "live occupancy inspection is read-only");
  assert.deepEqual(registry.readMeta(owned.meta.id), owned.meta);
  assert.deepEqual(registry.readMeta(foreign.meta.id), foreign.meta);
  foreground = session.prompt("Run held_work, inspect subagent settings, and continue foreground work", { source: "extension" });
  const waitForBoundary = (promise, label) => Promise.race([
    promise,
    foreground.then(() => assert.fail(`Foreground settled before ${label}: ${JSON.stringify(session.messages.at(-1))}`)),
  ]);
  const nextRequest = (index) => waitForBoundary(started[index].promise, `provider request ${index + 1}`);
  const first = await nextRequest(0);
  first.finish();
  await waitForBoundary(toolEntered.promise, "held_work execution");
  assert.equal(session.isIdle, false);
  uiKeys = ["\x1b[B", "\r", "\x15", "7", "\r"];
  await session.prompt("/runtime-subagent-settings");
  assert.match(pages[0].before, /Concurrent subagents\s+3/);
  assert.match(pages[0].after, /Concurrent subagents\s+7/);
  assert.equal(requests.length, 1, "opening and applying settings while busy does not start a model request");
  const oldText = settingsBlock(0, "adaptive", 3, initialSnapshot);
  releaseTool.resolve();
  const second = await nextRequest(1);
  assert.equal(agentStarts, 1);
  assert.equal(settlements, 0, "the new settings reach the same foreground run before settlement");
  const entriesBeforeInspection = structuredClone(stateEntries());
  second.finish();
  const third = await nextRequest(2);
  const expected = { delegationMode: "adaptive", maxConcurrent: 7,
    sources: { delegationMode: "config", maxConcurrent: "session" },
    runningCount: 1, pendingCount: 0, occupiedSlots: 1, availableSlots: 6 };
  const capSnapshot = snapshotFromResult(inspectionResults[0], expected);
  assert.equal(oldText.includes(capSnapshot.revision), false, "a cap edit changes the content fingerprint");
  settingsBlock(1, "adaptive", 7, capSnapshot);
  settingsBlock(2, "adaptive", 7, capSnapshot);
  assert.deepEqual(stateEntries(), entriesBeforeInspection, "inspection does not mutate session settings");
  assert.deepEqual(registry.readMeta(owned.meta.id), owned.meta, "inspection does not rewrite live metadata");
  assert.deepEqual(registry.readMeta(foreign.meta.id), foreign.meta);
  assert.equal(owned.child.kill("SIGTERM"), true);
  assert.deepEqual(await owned.exited, [null, "SIGTERM"], "wait for actual child termination before inspecting again");
  assert.equal(foreign.child.exitCode, null);
  assert.equal(foreign.child.signalCode, null, "the foreign parent's child remains alive");
  const emptyExpected = { ...expected, runningCount: 0, occupiedSlots: 0, availableSlots: 7 };
  const afterExit = snapshotFromResult(await inspectionTool.execute("after-child-exit", {}), emptyExpected);
  assert.equal(afterExit.revision, capSnapshot.revision, "process exit changes occupancy, not settings provenance");
  assert.deepEqual(registry.readMeta(owned.meta.id), owned.meta,
    "dead child metadata stays running, so the decrement must come from actual liveness");
  assert.deepEqual(registry.readMeta(foreign.meta.id), foreign.meta);
  assert.deepEqual(stateEntries(), entriesBeforeInspection, "post-exit inspection remains read-only");

  // Change mode through the real standalone command while request three is held.
  uiKeys = ["\r"];
  await session.prompt("/subagents settings");
  assert.match(pages[1].after, /Delegation mode\s+coordinator/);
  assert.equal(requests.length, 3, "a mode edit does not restart the model or queue another run");
  const entriesAfterModeEdit = structuredClone(stateEntries());
  third.finish();
  const fourth = await nextRequest(3);
  const modeSnapshot = snapshotFromResult(inspectionResults[1], { ...emptyExpected, delegationMode: "coordinator",
    sources: { delegationMode: "session", maxConcurrent: "session" } });
  assert.notEqual(modeSnapshot.revision, capSnapshot.revision, "mode changes update the fingerprint");
  settingsBlock(3, "coordinator", 7, modeSnapshot);
  fourth.finish();
  const fifth = await nextRequest(4);
  const repeated = snapshotFromResult(inspectionResults[2], { ...emptyExpected, delegationMode: "coordinator",
    sources: { delegationMode: "session", maxConcurrent: "session" } });
  assert.equal(repeated.revision, modeSnapshot.revision, "unchanged settings retain their content fingerprint");
  settingsBlock(4, "coordinator", 7, repeated);
  assert.deepEqual(stateEntries(), entriesAfterModeEdit, "repeated inspection remains read-only");
  assert.equal(readFileSync(configPath, "utf8"), savedConfig, "session UI edits do not save global defaults");

  await session.prompt("/subagents reset");
  fifth.finish();
  const sixth = await nextRequest(5);
  const configExpected = { ...initialSnapshot, runningCount: 0, occupiedSlots: 0, availableSlots: 3 };
  const configured = snapshotFromResult(inspectionResults[3], configExpected);
  settingsBlock(5, "adaptive", 3, configured);
  await session.prompt("/subagents cap 3");
  const entriesAfterSameValue = structuredClone(stateEntries());
  sixth.finish();
  const seventh = await nextRequest(6);
  const { revision: configuredRevision, ...configuredValues } = configured;
  const sameValue = snapshotFromResult(inspectionResults[4], { ...configuredValues,
    sources: { delegationMode: "config", maxConcurrent: "session" } });
  assert.notEqual(sameValue.revision, configuredRevision, "source-only config-to-session changes revise the fingerprint");
  settingsBlock(6, "adaptive", 3, sameValue);
  assert.deepEqual(stateEntries(), entriesAfterSameValue, "same-value inspection does not append settings entries");
  await session.prompt("/subagents save");
  const entriesAfterSave = structuredClone(stateEntries());
  seventh.finish();
  const eighth = await nextRequest(7);
  const saved = snapshotFromResult(inspectionResults[5], configExpected);
  assert.equal(saved.revision, configured.revision, "saving unchanged values restores the config-sourced revision");
  settingsBlock(7, "adaptive", 3, saved);
  assert.deepEqual(stateEntries(), entriesAfterSave, "inspection after saving remains read-only");
  assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), JSON.parse(savedConfig),
    "saving the same values only changes their source, not the numeric default");
  eighth.finish();
  await foreground;
  await session.waitForIdle();
  assert.equal(requests.length, 8, "one foreground run makes only the eight scripted requests");
  assert.equal(agentStarts, 1);
  assert.equal(settlements, 1);
  assert.equal(closedPages, 2);
  assert.deepEqual(stateEntries(), entriesAfterSave, "foreground completion does not persist request snapshots");
  assertEphemeral();
  assert.deepEqual(errors, []);
  foreign.child.send("release");
  assert.deepEqual(await foreign.exited, [0, null], "release the foreign fixture after proving it stayed alive throughout");
});
