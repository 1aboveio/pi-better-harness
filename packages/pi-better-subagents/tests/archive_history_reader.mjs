import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { join, sep } from "node:path";
const { default: extension, isHealthTickerActive } = await import("../index.ts");
const { listMetas } = await import("../registry.ts");
const cwd = process.env.TMPDIR, agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
    noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [extension] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), noTools: "all" });
await session.bindExtensions({ mode: "print" });
const ctx = session.extensionRunner.createContext();
let archiveReads = 0;
let markerStats = 0;
const read = fs.readFileSync;
const stat = fs.statSync;
fs.readFileSync = function(path, ...args) {
    if (String(path).startsWith(join(process.env.TMPDIR, "attempts") + sep) && String(path).endsWith(".json")) archiveReads++;
    return read.call(this, path, ...args);
};
fs.statSync = function(path, ...args) {
    if (String(path).startsWith(join(process.env.TMPDIR, "session-state") + sep)) markerStats++;
    return stat.call(this, path, ...args);
};
syncBuiltinESMExports();
process.on("message", async (command) => {
    if (command === "stop") {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose(); process.disconnect(); return;
    }
    if (command === "unreadable") {
        const normalStat = fs.statSync;
        fs.statSync = (path, ...args) => {
            if (String(path) === join(process.env.TMPDIR, "session-state")) {
                throw Object.assign(new Error("injected marker directory refusal"), { code: "EACCES" });
            }
            return normalStat(path, ...args);
        };
        syncBuiltinESMExports();
        let error;
        try { listMetas(); } catch (failure) { error = failure.message; }
        finally { fs.statSync = normalStat; syncBuiltinESMExports(); }
        process.send({ error });
        return;
    }
    archiveReads = markerStats = 0;
    const start = process.cpuUsage();
    let metas;
    for (let i = 0; i < (command === "budget" ? 10 : 1); i++) {
        if (command === "consumers") {
            await session.extensionRunner.getToolDefinition("subagent_list").execute("budget", { status: ["running"] }, undefined, undefined, ctx);
        }
        metas = listMetas();
    }
    process.send({ count: metas.filter((m) => m.id.startsWith("sa_archive_")).length, name: metas.find((m) => m.id === "sa_archive_4415")?.name,
        archiveReads, markerStats, frontendHealthActive: isHealthTickerActive(), cpu: process.cpuUsage(start) });
});
process.send({ ready: true });
