import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { acquireMutationStore } from "../src/runtime/mutation-store.ts";

const domain = "../../pi-better-subagents/";
const { startWorkRuntimeFixture } = await import(domain + "tests/work-runtime-fixture.mjs");
const { writeMeta, runDir, logPathFor } = await import(domain + "registry.ts");
const { readRunFailures, pendingFailureAttention, failurePath } = await import(domain + "failures.ts");
const { default: extension } = await import(domain + "index.ts");
const until = async (check: () => boolean, message: string) => {
  const deadline = Date.now() + 10000;
  while (!check()) { assert.ok(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 25)); }
};

test("manager folds a changed old terminal log without a foreground and reconnect delivers only its new failure", { timeout: 30000 }, async () => {
  const agentDir = process.env.PI_CODING_AGENT_DIR!, cwd = process.cwd();
  mkdirSync(agentDir, { recursive: true });
  const lease = acquireMutationStore(agentDir);
  lease.store.subagentLaunchJournal().epoch("prior-manager"); lease.release();
  const daemon = await startWorkRuntimeFixture();
  const observer = new WorkClient(daemon.socketPath, agentDir);
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "failure-fixture", defaultModel: "model" });
  let turns = 0;
  const provider = (pi: any) => pi.registerProvider("failure-fixture", {
    baseUrl: "https://example.invalid", apiKey: "offline", api: "openai-completions",
    models: [{ id: "model", name: "Offline recipient", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model: any) {
      turns++; const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: any = { role: "assistant", content: [{ type: "text", text: "Failure received" }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end();
      }); return stream;
    },
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension, provider] });
  let session: any;
  let releasingWitness: unknown, owedWitness: unknown;
  try {
    await loader.reload();
    let manager = SessionManager.create(cwd, agentDir + "/sessions");
    const open = async () => {
      ({ session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: manager, noTools: "all" }));
      await session.setModel(session.extensionRunner.createContext().modelRegistry.find("failure-fixture", "model"));
      await session.bindExtensions({ mode: "print" });
    };
    await open();
    manager.appendCustomEntry("saved-recipient", {});
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved recipient" }], api: "openai-completions", provider: "failure-fixture", model: "model", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const id = "sa_managed_old_failure";
    mkdirSync(runDir(id), { recursive: true }); writeFileSync(logPathFor(id), "{}\n");
    writeMeta({ id, sessionId: id, status: "lost", pid: 0, spawnPid: process.pid, cwd,
      startedAt: Date.now() - 120000, endedAt: Date.now() - 60000, lostAt: Date.now() - 60000,
      lostCallbackSentAt: Date.now() - 60000, callback: true, promptPreview: "fixture", logPath: logPathFor(id),
      callbackOrigin: { sessionId: manager.getSessionId(), cwd },
      management: { root: agentDir, instance: "prior-manager", epoch: 1 } });
    // Start the shared observer and commit the initial clean-log signature.
    const initialBy = Date.now() + 10000;
    while (!(await observer.request("runtime_get_snapshot", { scope: { id } })).rows.length) {
      assert.ok(Date.now() < initialBy); await new Promise(resolve => setTimeout(resolve, 25));
    }
    const foreign = "sa_foreign_old_failure";
    mkdirSync(runDir(foreign), { recursive: true }); writeFileSync(logPathFor(foreign), "{malformed event\n");
    writeMeta({ id: foreign, sessionId: foreign, status: "failed", pid: 0, spawnPid: 0, cwd,
      startedAt: Date.now() - 120000, endedAt: Date.now() - 60000, callback: false, promptPreview: "foreign fixture", logPath: logPathFor(foreign),
      management: { root: agentDir + "/foreign", instance: "foreign", epoch: 1 } });
    const file = manager.getSessionFile()!;
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); session = undefined;
    observer.close();
    appendFileSync(logPathFor(id), "{malformed event\n");
    // This read only observes the ledger; no foreground calls collectRunFailures.
    await until(() => {
      const state = readRunFailures(id), at = Date.now();
      const pending = pendingFailureAttention(state, at, { terminal: true });
      if (pending) releasingWitness = { at, pending, state };
      return Boolean(pending);
    }, "manager did not durably fold the changed raw log");
    assert.equal(turns, 0, "no recipient is live to produce the failure ledger");
    assert.equal(existsSync(failurePath(foreign)), false, "foreign-root records do not authorize canonical writes");
    const owedState = readRunFailures(id), owedAt = Date.now();
    const owed = pendingFailureAttention(owedState, owedAt, { terminal: true });
    owedWitness = { at: owedAt, pending: owed ?? null, state: owedState };
    assert.ok(owed.incidents.length);
    manager = SessionManager.open(file); await loader.reload(); await open();
    await until(() => turns === 1, "reconnected original recipient did not receive new failure attention");
    await session.waitForIdle();
    await until(() => !pendingFailureAttention(readRunFailures(id), Date.now(), { terminal: true }), "native handoff did not record the exact failure receipt");
    assert.equal(turns, 1, "handled old health callback is not delivered again");
  } catch (error) {
    const { workObservation } = await import(domain + "work-observation.ts");
    console.error("failure-fold diagnostics", turns, workObservation(), readRunFailures("sa_managed_old_failure"), daemon.diagnostics());
    console.error("failure-fold wait witness", JSON.stringify({ releasingWitness, owedWitness }).slice(0, 8192));
    throw error;
  } finally {
    if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    observer.close(); await daemon();
  }
});
