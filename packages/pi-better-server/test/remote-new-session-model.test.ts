import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { startDaemon, type DaemonOptions } from "../src/server.ts";
import { Client, llmCalls, makeEnv, waitFor, type Env } from "./helpers.ts";

async function setup(t: TestContext, configure?: (env: Env) => Promise<DaemonOptions["sessionOptions"]> | DaemonOptions["sessionOptions"]) {
  const previous = { ...process.env };
  const env = makeEnv();
  Object.assign(process.env, env.vars);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  // A second real extension provider makes unintended fallback observable.
  const fake = readFileSync(join(env.agentDir, "extensions", "fake.ts"), "utf8");
  const providerOnly = `${fake.slice(0, fake.indexOf("export default function"))}export default function (pi: ExtensionAPI) {\n${fake.slice(fake.indexOf('  pi.registerProvider("fake"'), fake.indexOf("\n  pi.registerTool"))}\n}`;
  writeFileSync(join(env.agentDir, "extensions", "fake2.ts"), providerOnly
    .replace('registerProvider("fake"', 'registerProvider("fake2"')
    .replaceAll('"fake-1"', '"fake-2"').replaceAll('"fake-api"', '"fake2-api"'));
  const sessionOptions = await configure?.(env);
  const logs: string[] = [];
  const daemon = await startDaemon({ serverDir: env.serverDir, sessionOptions, log: message => logs.push(message) });
  t.after(() => daemon.stop());
  const client = await Client.connect(daemon.socketPath);
  t.after(() => client.close());
  return { env, daemon, client, logs };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function create(f: Fixture, model?: { provider: string; modelId: string }) {
  // Native browser `n` sends this command without a model.
  const response = await f.client.request({ type: "create_session", cwd: f.env.cwd, ...(model ? { model } : {}) });
  assert.equal(response.success, true, JSON.stringify(response));
  const sessionId = response.sessionId as string;
  const state = await f.client.request({ type: "get_state", sessionId });
  assert.equal(state.success, true);
  return { sessionId, state: state.data, hosted: f.daemon.registry.get(sessionId)! };
}

async function prompt(f: Fixture, sessionId: string, message: string, provider: string, model: string) {
  const response = await f.client.request({ type: "prompt", sessionId, message });
  assert.equal(response.success, true, JSON.stringify(response));
  const assistant = await waitFor("completed first reply", async () => {
    const result = await f.client.request({ type: "get_messages", sessionId });
    return result.data.messages.find((m: any) => m.role === "assistant" && m.content.some((c: any) => c.text === `echo:${message}`));
  });
  assert.equal(assistant.provider, provider);
  assert.equal(assistant.model, model);
  assert.equal(assistant.stopReason, "stop");
  await waitFor("session idle", () => !f.daemon.registry.get(sessionId)!.executionActive);
}

test("browser-style create uses the extension default and persists only after its first prompt", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const { sessionId, state, hosted } = await create(f);
  assert.equal(state.model.provider, "fake");
  assert.equal(state.model.id, "fake-1");
  assert.equal(existsSync(hosted.session.sessionFile!), false, "empty sessions have no transcript file");
  assert.deepEqual(hosted.session.messages, []);
  await prompt(f, sessionId, "new-session-first-prompt", "fake", "fake-1");
  assert.equal(existsSync(hosted.session.sessionFile!), true);
  assert.deepEqual(hosted.session.sessionManager.buildSessionContext().model, { provider: "fake", modelId: "fake-1" });
  assert.equal(llmCalls(f.env).length, 1);
});

test("workspace defaults override agent defaults after extension registration", { timeout: 30_000 }, async t => {
  const f = await setup(t, env => {
    mkdirSync(join(env.cwd, ".pi"));
    writeFileSync(join(env.cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "fake2", defaultModel: "fake-2" }));
  });
  const { sessionId, state } = await create(f);
  assert.equal(state.model.provider, "fake2");
  await prompt(f, sessionId, "workspace-default", "fake2", "fake-2");
});

test("implicit initialization preserves global model and thinking preferences", { timeout: 30_000 }, async t => {
  let settings: SettingsManager;
  const f = await setup(t, env => {
    const providerFile = join(env.agentDir, "extensions", "fake2.ts");
    writeFileSync(providerFile, readFileSync(providerFile, "utf8").replace("reasoning: false", "reasoning: true"));
    writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1", defaultThinkingLevel: "minimal", theme: "unchanged" }));
    mkdirSync(join(env.cwd, ".pi"));
    writeFileSync(join(env.cwd, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "fake2", defaultModel: "fake-2" }));
    settings = SettingsManager.create(env.cwd, env.agentDir);
    return { settingsManager: settings, thinkingLevel: "xhigh" };
  });
  const globalFile = join(f.env.agentDir, "settings.json");
  const projectFile = join(f.env.cwd, ".pi", "settings.json");
  const beforeGlobal = readFileSync(globalFile, "utf8");
  const beforeProject = readFileSync(projectFile, "utf8");
  const { sessionId, state, hosted } = await create(f);
  assert.equal(state.model.provider, "fake2");
  assert.equal(state.thinkingLevel, "high");
  assert.equal(hosted.session.settingsManager, settings!);
  assert.equal(readFileSync(globalFile, "utf8"), beforeGlobal);
  assert.equal(readFileSync(projectFile, "utf8"), beforeProject);
  await prompt(f, sessionId, "implicit-model-does-not-change-preferences", "fake2", "fake-2");
  assert.equal(readFileSync(globalFile, "utf8"), beforeGlobal);
  assert.equal(readFileSync(projectFile, "utf8"), beforeProject);
});

test("caller settings and a preloaded resource loader select the default without reloading the loader", { timeout: 30_000 }, async t => {
  let loader: DefaultResourceLoader;
  let reload: DefaultResourceLoader["reload"];
  const f = await setup(t, async env => {
    const settingsManager = SettingsManager.inMemory({ defaultProvider: "fake2", defaultModel: "fake-2" });
    loader = new DefaultResourceLoader({ cwd: env.cwd, agentDir: env.agentDir, settingsManager });
    await loader.reload();
    reload = loader.reload;
    return { settingsManager, resourceLoader: loader };
  });
  const { sessionId, hosted } = await create(f);
  assert.equal(hosted.session.resourceLoader, loader!);
  assert.equal(loader!.reload, reload!);
  // A caller-owned loader intentionally makes background activity unobservable.
  const response = await f.client.request({ type: "prompt", sessionId, message: "caller-default" });
  assert.equal(response.success, true, JSON.stringify(response));
  await waitFor("caller default reply", () => hosted.session.getLastAssistantText() === "echo:caller-default");
  assert.equal(hosted.session.model?.provider, "fake2");
});

for (const defaultProvider of ["fake", "unavailable-provider"]) {
  test(`explicit request wins over ${defaultProvider} settings`, { timeout: 30_000 }, async t => {
    const f = await setup(t, env => {
      writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ defaultProvider, defaultModel: "fake-1" }));
    });
    const { sessionId, state } = await create(f, { provider: "fake2", modelId: "fake-2" });
    assert.equal(state.model.provider, "fake2");
    await prompt(f, sessionId, "explicit-model", "fake2", "fake-2");
  });
}

test("an explicit SDK model overrides unavailable configured defaults", { timeout: 30_000 }, async t => {
  const f = await setup(t, () => ({
    settingsManager: SettingsManager.inMemory({ defaultProvider: "missing-provider", defaultModel: "missing-model" }),
    model: {
      provider: "fake2", id: "fake-2", name: "Fake 2", api: "fake2-api" as never,
      baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096,
    },
  }));
  const { sessionId, state } = await create(f);
  assert.equal(state.model.provider, "fake2");
  await prompt(f, sessionId, "sdk-explicit-model", "fake2", "fake-2");
});

test("reopening empty and populated sessions keeps their selected model and existing history", { timeout: 30_000 }, async t => {
  const f = await setup(t);
  const { sessionId, hosted } = await create(f, { provider: "fake2", modelId: "fake-2" });
  const emptyPath = hosted.session.sessionFile!;
  await f.client.request({ type: "close_session", sessionId });
  writeFileSync(join(f.env.agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1" }));
  assert.equal((await f.client.request({ type: "open_session", sessionId })).success, true);
  assert.equal(existsSync(emptyPath), false);
  assert.equal(f.daemon.registry.get(sessionId)!.session.model?.provider, "fake2");
  await prompt(f, sessionId, "before-reopen", "fake2", "fake-2");
  const path = f.daemon.registry.get(sessionId)!.session.sessionFile!;
  await f.client.request({ type: "close_session", sessionId });
  const before = readFileSync(path);
  assert.equal((await f.client.request({ type: "open_session", sessionId })).success, true);
  assert.deepEqual(readFileSync(path), before, "reopening must not append model changes to existing history");
  await prompt(f, sessionId, "after-reopen", "fake2", "fake-2");
});

test("credential helper failures do not expose their output to clients or logs", { timeout: 30_000 }, async t => {
  const secret = "credential-helper-private-output";
  const f = await setup(t, async env => {
    const modelRuntime = await ModelRuntime.create({ authPath: join(env.agentDir, "auth.json"), modelsPath: null });
    const checkAuth = modelRuntime.checkAuth.bind(modelRuntime);
    // Only the external credential lookup fails; the daemon, SDK, and provider remain real.
    t.mock.method(modelRuntime, "checkAuth", async (provider: string) => {
      if (provider === "fake") throw new Error(secret);
      return checkAuth(provider);
    });
    return { modelRuntime };
  });
  const response = await f.client.request({ type: "create_session", cwd: f.env.cwd });
  assert.equal(response.success, false);
  assert.match(response.error, /credentials/);
  assert.equal(JSON.stringify(response).includes(secret), false);
  assert.equal(f.logs.join("\n").includes(secret), false);
  assert.equal(llmCalls(f.env).length, 0);
  assert.deepEqual(f.daemon.registry.list(), []);
});

for (const unavailable of ["provider", "model", "auth"] as const) {
  test(`unavailable configured ${unavailable} fails with guidance and never calls another provider`, { timeout: 30_000 }, async t => {
    const secret = "private-auth-sentinel";
    const f = await setup(t, env => {
      const defaultProvider = unavailable === "provider" ? "missing-provider" : "fake";
      const defaultModel = unavailable === "model" ? "missing-model" : "fake-1";
      writeFileSync(join(env.agentDir, "settings.json"), JSON.stringify({ defaultProvider, defaultModel, apiKey: secret }));
      if (unavailable === "auth") {
        const file = join(env.agentDir, "extensions", "fake.ts");
        writeFileSync(file, readFileSync(file, "utf8").replace('apiKey: "fake-key",', ""));
      }
    });
    const response = await f.client.request({ type: "create_session", cwd: f.env.cwd });
    assert.equal(response.success, false, "a configured default must not silently use fake2");
    assert.match(response.error, /configured model/i);
    assert.match(response.error, /settings|credentials|log in/i);
    assert.equal(JSON.stringify(response).includes(secret), false);
    assert.equal(llmCalls(f.env).length, 0);
    assert.deepEqual(f.daemon.registry.list(), []);
    const index = join(f.env.serverDir, "sessions.json");
    if (existsSync(index)) assert.deepEqual(JSON.parse(readFileSync(index, "utf8")).sessions, []);
    // Failed initialization must leave the daemon usable with an explicit valid model.
    const { sessionId } = await create(f, { provider: "fake2", modelId: "fake-2" });
    await prompt(f, sessionId, "recover-with-explicit-model", "fake2", "fake-2");
  });
}
