import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { continuationModels, startContinuationModel } from "./support/subagent-offline-model.ts";

test("continuation offline transport produces the original four native messages through the actual SDK", async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "model-transport-")), agentDir = join(root, "agent"); mkdirSync(agentDir);
  const model = await startContinuationModel(root);
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(continuationModels(model.baseUrl)));
    const settingsManager = SettingsManager.inMemory({ defaultProvider: "test", defaultModel: "model" });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
      noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true });
    await resourceLoader.reload();
    const manager = SessionManager.create(root, join(root, "sessions"));
    ({ session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader, sessionManager: manager, noTools: "all" }));
    await session.prompt("INITIAL TASK");
    assert.equal(session.getLastAssistantText(), "INITIAL ANSWER");
    const saved = manager.getSessionFile()!;
    await session.prompt("FIX IT");
    assert.equal(manager.getSessionFile(), saved);
    const messages = readFileSync(saved, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(entry => entry.type === "message")
      .map(entry => ({ role: entry.message.role, text: typeof entry.message.content === "string" ? entry.message.content : entry.message.content.map((part: any) => part.text ?? "").join("") }));
    assert.deepEqual(messages, [
      { role: "user", text: "INITIAL TASK" }, { role: "assistant", text: "INITIAL ANSWER" },
      { role: "user", text: "FIX IT" }, { role: "assistant", text: "FOLLOWUP:FIX IT" },
    ]);
  } finally { session?.dispose(); await model.close(); }
});
