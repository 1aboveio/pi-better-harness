import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import background from "../packages/pi-better-background-tasks/src/index.ts";
import goal from "../packages/pi-better-goal/src/index.ts";
import subagents from "../packages/pi-better-subagents/index.ts";

for (const resumed of [false, true]) {
  test(`ordinary Pi input with a stalled runtime handshake in a ${resumed ? "restored" : "fresh"} session`, { timeout: 15000 }, async t => {
    const root = realpathSync(mkdtempSync("/tmp/pi-startup-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const sockets = new Set();
    const requests = [];
    const subscriptions = [];
    const handshake = Promise.withResolvers();
    const snapshot = { status: "ready", instanceId: "fixture", scopeRevision: "1", seq: 1, rows: [], totalMatching: 0 };
    const server = createServer(socket => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      createInterface({ input: socket }).on("line", async line => {
        const request = JSON.parse(line);
        requests.push(request.type);
        if (request.type === "hello") await handshake.promise;
        if (request.type === "runtime_subscribe") subscriptions.push(request.scope);
        const data = request.type === "hello" ? { instanceId: "fixture", capabilities: request.requiredCapabilities } :
          request.type === "runtime_background_tool" ? { tasks: [], legacyRows: [], deliveries: [] } : snapshot;
        if (!socket.destroyed) socket.write(JSON.stringify({ id: request.id, success: true, data }) + "\n");
      });
    });
    let session;
    t.after(async () => {
      handshake.resolve();
      if (session) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    });
    server.listen(join(root, "pi-server.sock"));
    await once(server, "listening");
    writeFileSync(join(root, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: root, serverDir: root }));
    const sessions = join(root, "sessions");
    mkdirSync(sessions);
    let manager = SessionManager.create(root, sessions);
    if (resumed) {
      const file = manager.getSessionFile();
      writeFileSync(file, JSON.stringify(manager.getHeader()) + "\n");
      manager = SessionManager.open(file, sessions);
    }
    const settingsManager = SettingsManager.inMemory();
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
      modelsPath: join(root, "models.json"), modelsStorePath: join(root, "models-store.json") });
    const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const provider = {
      baseUrl: "https://example.invalid", apiKey: "test", api: "openai-completions",
      models: [{ id: "offline", name: "Offline", input: ["text"], reasoning: false, contextWindow: 16000, maxTokens: 100, cost }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message = { role: "assistant", content: [{ type: "text", text: "fixture reply" }], api: model.api,
          provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
          usage: { ...cost, totalTokens: 0, cost: { ...cost, total: 0 } } };
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
        return stream;
      },
    };
    modelRuntime.registerProvider("startup-test", provider);
    const resourceLoader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true,
      noContextFiles: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [subagents, background, goal, pi => pi.registerProvider("startup-test", provider)],
    });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd: root, agentDir: root, sessionManager: manager, settingsManager, resourceLoader,
      modelRuntime, model: modelRuntime.getModel("startup-test", "offline") }));
    await session.bindExtensions({ mode: "rpc" });
    await session.prompt("ordinary input");
    assert.equal(session.messages.at(-1)?.content[0]?.text, "fixture reply");
    for (const name of ["subagent_list", "bg_task_list"]) {
      assert.ok(session.getActiveToolNames().includes(name));
      assert.ok(session.getToolDefinition(name).parameters.properties.limit);
    }
    if (resumed) {
      await t.waitFor(() => assert.ok(requests.includes("hello")));
      handshake.resolve();
      await t.waitFor(() => assert.ok(subscriptions.some(scope => scope.background) && subscriptions.some(scope => !scope.background)));
      assert.ok(subscriptions.every(scope => scope.sessionId === manager.getSessionId()));
    } else {
      await delay(50);
      assert.deepEqual(requests, []);
      const ctx = session.extensionRunner.createContext();
      const list = session.getToolDefinition("subagent_list");
      const results = Promise.all(["a", "b"].map(key => list.execute(key, { limit: 1 }, undefined, undefined, ctx)));
      await t.waitFor(() => assert.ok(requests.includes("hello")));
      handshake.resolve();
      for (const result of await results) assert.ok(!result.isError);
      assert.deepEqual(requests.filter(type => type === "hello"), ["hello"]);
      assert.equal(subscriptions.length, 1);
      assert.equal(subscriptions[0].sessionId, manager.getSessionId());
      const inspect = session.getToolDefinition("get_background_activity");
      const activity = await inspect.execute("inspect-work", {}, undefined, undefined, ctx);
      assert.equal(activity.details.coverage, "verified");
      assert.ok(subscriptions.some(scope => scope.background));
    }
  });
}
