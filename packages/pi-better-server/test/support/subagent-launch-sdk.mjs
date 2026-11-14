import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../../../pi-better-subagents/index.ts";
const cwd = process.env.LAUNCH_WORKSPACE, agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [extension] });
await resourceLoader.reload();
const sessionManager = SessionManager.inMemory(cwd);
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager, noTools: "all" });
await session.bindExtensions({ mode: "print" });
process.send({ ready: true, sessionId: sessionManager.getSessionId() });
process.on("message", async request => {
    try {
        if (request.stop) {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose(); process.disconnect(); return;
        }
        if (request.goalComplete) sessionManager.appendCustomEntry("pi-better-goal", { kind: "set", goal: { goalId: "completed-parent-goal", status: "completed" } });
        const tool = session.extensionRunner.getToolDefinition("subagent_spawn");
        const result = await tool.execute(request.key, request.params, undefined, undefined, session.extensionRunner.createContext());
        process.send({ result });
    } catch (error) { process.send({ error: String(error), stack: error.stack }); }
});
