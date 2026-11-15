import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../../../pi-better-subagents/index.ts";
const cwd = process.env.LAUNCH_WORKSPACE, agentDir = process.env.PI_CODING_AGENT_DIR;
const fixture = process.env.CONTINUATION_CONTEXT ? JSON.parse(process.env.CONTINUATION_CONTEXT) : undefined;
let policy = fixture?.policy;
const settingsManager = SettingsManager.inMemory(fixture ? { defaultProvider: "test", defaultModel: "model" } : {});
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [extension, pi => {
        pi.events.on("pi-better-sandbox:policy-request", () => { if (policy) pi.events.emit("pi-better-sandbox:policy", policy); });
    }] });
await resourceLoader.reload();
const sessionManager = fixture ? SessionManager.create(cwd, fixture.sessionDir, { id: fixture.sessionId }) : SessionManager.inMemory(cwd);
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager, noTools: "all" });
await session.bindExtensions({ mode: "print" });
const state = () => ({ entries: sessionManager.getBranch(), sessionId: sessionManager.getSessionId() });
if (fixture) session.subscribe(() => queueMicrotask(() => { if (process.connected) process.send({ state: state() }); }));
process.send({ ready: true, ...state(), tools: ["subagent_spawn", "subagent_spawn_batch", "subagent_result", "subagent_stop", "subagent_settings", "subagent_resume", "subagent_release"].filter(name => session.extensionRunner.getToolDefinition(name)) });
process.on("message", async request => {
    try {
        if (request.stop) {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose(); process.disconnect(); return;
        }
        if (request.policy !== undefined) policy = request.policy;
        if (request.goalComplete) sessionManager.appendCustomEntry("pi-better-goal", { kind: "set", goal: { goalId: "completed-parent-goal", status: "completed" } });
        const tool = session.extensionRunner.getToolDefinition(request.tool ?? "subagent_spawn");
        const result = await tool.execute(request.key, request.params, undefined, undefined, session.extensionRunner.createContext());
        process.send({ id: request.id, result, ...(fixture ? { state: state() } : {}) });
    } catch (error) { process.send({ id: request.id, error: String(error), stack: error.stack, ...(fixture ? { state: state() } : {}) }); }
});
