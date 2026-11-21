import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extensionFactory from "../../index.ts";
import { openSharedCatalog } from "../../shared-catalog.ts";
import { closeCatalogHost } from "../../catalog-host-admission.ts";

const cwd = process.env.CATALOG_WORKSPACE, agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
settingsManager.setProjectTrusted(true);
const sessionManager = SessionManager.inMemory(cwd);
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extensionFactory] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader, settingsManager, sessionManager, noTools: "all" });
await session.bindExtensions({ mode: "print" });
const ctx = session.extensionRunner.createContext();
const command = session.extensionRunner.getRegisteredCommands().find(command => command.name === "agents");
const base = sessionManager.appendCustomEntry("catalog-fixture-base", {});
let frozen;
process.send({ ready: true });
process.on("message", async request => {
    try {
        if (request.action === "stop") {
            closeCatalogHost(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); session.dispose(); process.disconnect(); return;
        }
        if (request.action === "branch") {
            sessionManager.branch(base);
            sessionManager.appendCustomEntry("pi-better-subagents-agent-settings", { version: 1, id: "role.ephemeral", key: "effort", value: request.effort });
            await session.extensionRunner.emit({ type: "session_tree" });
        }
        if (request.action === "revoke") settingsManager.setProjectTrusted(false);
        await command.handler("list", ctx);
        const remote = await openSharedCatalog(cwd, agentDir);
        try {
            const snapshot = await remote.get();
            if (request.action === "save") await remote.edit({ action: "preferences", catalogId: "role.ephemeral", preferences: { effort: request.effort }, expectedRevision: snapshot.revision });
            if (request.action === "freeze") frozen = snapshot;
            const tool = session.extensionRunner.getToolDefinition("agents_catalog");
            const inspected = await tool.execute("fixture", { action: "inspect", id: "role.ephemeral" }, undefined, undefined, ctx);
            process.send({ id: request.id, result: { view: inspected.details.view, saved: (await remote.get()).savedSettings,
                frozen: frozen?.savedSettings, sessionId: sessionManager.getSessionId(), branchId: sessionManager.getLeafId() } });
        } finally { remote.close(); }
    } catch (error) { process.send({ id: request.id, error: String(error) }); }
});
