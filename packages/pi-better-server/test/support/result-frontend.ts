import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const root = process.env.PI_CODING_AGENT_DIR!;
// The SDK loads the production extension; no model request is needed to exercise its registered tools.
const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
  additionalExtensionPaths: [new URL("../../../pi-better-background-tasks/src/index.ts", import.meta.url).pathname],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await resourceLoader.reload();
if (resourceLoader.getExtensions().errors.length) throw new Error(JSON.stringify(resourceLoader.getExtensions().errors));
const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager, resourceLoader,
  sessionManager: SessionManager.inMemory(root) });
await session.bindExtensions({ onError: error => { throw new Error(String(error)); }, shutdownHandler: () => {} });
const tool = (name: string) => {
  const found = session.agent.state.tools.find(tool => tool.name === name);
  if (!found) throw new Error(`Production SDK tool missing: ${name}`);
  return found;
};
const launched = await tool("bg_task_spawn").execute("spawn-760", { shell: false, callback: true,
  argv: [process.execPath, "-e", `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(root, "executions"))},'start\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, "finish"))})){clearInterval(t);console.log('independent terminal evidence');}},20);`] });
const taskId = launched.content.map((part: any) => part.text ?? "").join("\n").match(/bgs_[0-9a-f]{20}/)?.[0];
if (!taskId) throw new Error(JSON.stringify(launched));
const waited = await tool("wait_for_operations").execute("wait-760", { task_ids: [taskId], continuation_note: "Interpret the independent result" });
if (!(waited.details as any)?.waitId) throw new Error(JSON.stringify(waited));
process.send?.({ taskId, wait: waited.details, sessionId: session.sessionId });
process.on("message", () => { session.dispose(); process.exit(0); });
