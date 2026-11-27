// Drive a real Pi session in its own process so the parent can kill it during compaction.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import nativeCompaction, { nativeCompactionSetting as toggle } from "../../extensions/native-compaction/index.ts";

const [root, modelId, sessionFile, automatic] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, cacheWarming: { enabled: false },
  compaction: { enabled: automatic === "true", reserveTokens: 1024,
    ...(process.env.PI_NATIVE_COMPACTION_LIVE_WINDOW === "1" ? {} : { keepRecentTokens: 64 }) } });
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), refreshOnCreate: false,
  modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "models-store.json") });
let request;
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [{ name: "native-compaction", factory(pi) {
    nativeCompaction(pi);
    pi.on("before_provider_request", ({ payload }) => {
      const { input, ...settings } = payload;
      request = { prefix: input.map(digest), settings: digest(settings) };
    });
  } }] });
await resourceLoader.reload();
const sessionManager = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(root, join(root, "sessions"));
const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime, sessionManager,
  model: modelRuntime.getModel("test-responses", modelId), noTools: "all" });
const errors = [];
await session.bindExtensions({ onError: error => errors.push(error.message) });
process.send({ file: sessionManager.getSessionFile(), toggle: toggle.get() });
process.on("message", async command => {
  try {
    if ("toggle" in command) toggle.change(command.toggle);
    if (command.prompt) {
      await session.prompt(command.prompt);
      const answer = session.state.messages.findLast(message => message.role === "assistant");
      if (!answer || answer.stopReason === "error") throw new Error(answer?.errorMessage ?? "Missing assistant reply");
      const { input, cacheRead, cacheWrite } = answer.usage;
      process.send({ text: answer.content.filter(x => x.type === "text").map(x => x.text).join(""),
        request, cached: cacheRead, written: cacheWrite, total: input + cacheRead + cacheWrite, errors });
    } else if (command.compact) {
      const result = await session.compact(command.focus);
      process.send({ native: result.details?.format === "openai-responses-v1", errors });
    } else if (command.close) {
      session.dispose(); process.disconnect();
    } else process.send({ toggle: toggle.get() });
  } catch (error) { process.send({ error: error.message }); }
});
