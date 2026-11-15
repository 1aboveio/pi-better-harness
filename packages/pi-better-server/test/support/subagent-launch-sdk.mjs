import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension, { isHealthTickerActive } from "../../../pi-better-subagents/index.ts";
import { workObservation } from "../../../pi-better-subagents/work-observation.ts";
const cwd = process.env.LAUNCH_WORKSPACE, agentDir = process.env.PI_CODING_AGENT_DIR;
const fixture = process.env.CONTINUATION_CONTEXT ? JSON.parse(process.env.CONTINUATION_CONTEXT) : undefined;
let policy = fixture?.policy;
const deliveries = [];
const settingsManager = SettingsManager.inMemory(fixture ? { defaultProvider: "test", defaultModel: "model" } : {});
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [pi => extension({ ...pi,
        sendMessage(message, options) { pi.sendMessage(message, options); deliveries.push({ message, options }); },
    }), pi => {
        pi.events.on("pi-better-sandbox:policy-request", () => { if (policy) pi.events.emit("pi-better-sandbox:policy", policy); });
    }] });
await resourceLoader.reload();
const sessionManager = fixture?.sessionFile ? SessionManager.open(fixture.sessionFile)
    : fixture ? SessionManager.create(cwd, fixture.sessionDir, { id: fixture.sessionId }) : SessionManager.inMemory(cwd);
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager, noTools: "all" });
await session.bindExtensions({ mode: "print" });
const state = () => ({ entries: sessionManager.getBranch(), sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), deliveries });
if (fixture) session.subscribe(() => queueMicrotask(() => { if (process.connected) process.send({ state: state() }); }));
process.send({ ready: true, ...state(), tools: ["subagent_spawn", "subagent_spawn_batch", "subagent_result", "subagent_stop", "subagent_settings", "subagent_resume", "subagent_release"].filter(name => session.extensionRunner.getToolDefinition(name)) });
process.on("message", async request => {
    try {
        if (request.inspect) { const observed = workObservation(); process.send({ id: request.id, result: { pid: process.pid, healthActive: isHealthTickerActive(), observation: observed && { status: observed.status, reason: observed.reason, rows: observed.rows.map(row => ({ id: row.meta.id, status: row.meta.status })) } } }); return; }
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
