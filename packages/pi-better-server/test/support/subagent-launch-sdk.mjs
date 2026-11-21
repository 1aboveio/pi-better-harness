import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } from "@earendil-works/pi-coding-agent";
import backgroundExtension from "../../../pi-better-background-tasks/src/index.ts";
import extension, { isHealthTickerActive } from "../../../pi-better-subagents/index.ts";
import { workObservation } from "../../../pi-better-subagents/work-observation.ts";
import { observeLaunchPhases } from "./launch-phase-probe.mjs";
const cwd = process.env.LAUNCH_WORKSPACE, agentDir = process.env.PI_CODING_AGENT_DIR;
const fixture = process.env.CONTINUATION_CONTEXT ? JSON.parse(process.env.CONTINUATION_CONTEXT) : undefined;
let policy = fixture?.policy ?? (process.env.LAUNCH_POLICY ? JSON.parse(process.env.LAUNCH_POLICY) : undefined);
const deliveries = [];
const notes = [];
let uiFailures = 0;
const settingsManager = SettingsManager.inMemory(fixture ? { defaultProvider: "test", defaultModel: "model" } : {});
if (fixture?.ui) initTheme(settingsManager.getTheme(), false);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: !fixture?.loadUserExtensions, noSkills: true,
    noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [...(process.env.LAUNCH_BACKGROUND === "1" ? [backgroundExtension] : []), pi => extension({ ...pi,
        sendMessage(message, options) { pi.sendMessage(message, options); deliveries.push({ message, options }); },
    }), pi => {
        pi.events.on("pi-better-sandbox:policy-request", () => { if (policy) pi.events.emit("pi-better-sandbox:policy", policy); });
    }] });
await resourceLoader.reload();
const sessionManager = fixture?.sessionFile ? SessionManager.open(fixture.sessionFile)
    : fixture ? SessionManager.create(cwd, fixture.sessionDir, { id: fixture.sessionId }) : SessionManager.inMemory(cwd);
if (fixture?.ui && !fixture.sessionFile) sessionManager.appendCustomEntry("health-ui-recipient", {});
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager, ...(process.env.LAUNCH_BACKGROUND === "1" || fixture?.loadUserExtensions ? {} : { noTools: "all" }) });
await session.bindExtensions(fixture?.ui ? { mode: "tui", uiContext: { ...session.extensionRunner.getUIContext(),
    notify(msg, level = "info") {
        if (fixture?.failHealthNotify && / is lost |\(orphaned\)/.test(msg)) { uiFailures++; throw new Error("UI adapter unavailable"); }
        notes.push({ msg, level });
    },
} } : { mode: "print" });
if (fixture?.ui && !fixture.sessionFile) await session.prompt("Prepare the health notification recipient");
const state = () => ({ entries: sessionManager.getBranch(), sessionId: sessionManager.getSessionId(), sessionFile: sessionManager.getSessionFile(), deliveries, notes });
if (fixture) session.subscribe(() => queueMicrotask(() => { if (process.connected) process.send({ state: state() }); }));
process.send({ ready: true, ...state(), tools: ["subagent_spawn", "subagent_spawn_batch", "subagent_list", "subagent_result", "subagent_stop", "subagent_settings", "subagent_resume", "subagent_release"].filter(name => session.extensionRunner.getToolDefinition(name)) });
process.on("message", async request => {
    let stopTrace;
    try {
        if (request.inspect) { const observed = workObservation(); process.send({ id: request.id, state: state(), result: { pid: process.pid, healthActive: isHealthTickerActive(), uiFailures, observation: observed && { status: observed.status, reason: observed.reason, rows: observed.rows.map(row => ({ id: row.meta.id, status: row.meta.status })) } } }); return; }
        if (request.stop) {
            await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose(); process.disconnect(); return;
        }
        if (request.policy !== undefined) policy = request.policy;
        if (request.goalComplete) sessionManager.appendCustomEntry("pi-better-goal", { kind: "set", goal: { goalId: "completed-parent-goal", status: "completed" } });
        const tool = session.extensionRunner.getToolDefinition(request.tool ?? "subagent_spawn");
        if (request.traceLaunch) stopTrace = observeLaunchPhases(message => {
            if (process.connected) process.send(message, () => {});
        });
        const context = session.extensionRunner.createContext();
        // Independent oracle: read the actual SDK foreground before tool preparation yields.
        if (fixture) process.send({ invocation: request.id, entry: {
            cwd: context.cwd, sessionId: context.sessionManager.getSessionId(),
            branchId: context.sessionManager.getLeafId(),
        } });
        const result = await tool.execute(request.key, request.params, undefined, undefined, context);
        stopTrace?.(); stopTrace = undefined;
        process.send({ id: request.id, result, ...(fixture ? { state: state() } : {}) });
    } catch (error) { stopTrace?.("failed"); process.send({ id: request.id, error: String(error), stack: error.stack, ...(fixture ? { state: state() } : {}) }); }
});
