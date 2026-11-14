import fs from "node:fs";
import { register, syncBuiltinESMExports } from "node:module";
import { join, sep } from "node:path";
register(new URL("./pi_host_stub_hooks.mjs", import.meta.url));
const intervals = [];
globalThis.setInterval = (fn, ms) => { if (ms === 15000) intervals.push(fn); return { unref() {} }; };
globalThis.clearInterval = () => {};
const { default: extension } = await import("../index.ts");
const { listMetas } = await import("../registry.ts");
const tools = new Map();
const handlers = new Map();
extension({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), sendMessage() {} });
const ctx = { cwd: process.env.TMPDIR, hasUI: false, isIdle: () => true,
    ui: { notify() {}, setWidget() {} }, sessionManager: { getSessionId: () => "archive-budget" } };
// A real owned running record keeps the actual health interval scheduled.
const runningDir = join(process.env.TMPDIR, "pi-better-subagents", "runs", `sa_reader_${process.pid}`);
fs.mkdirSync(runningDir, { recursive: true });
fs.writeFileSync(join(runningDir, "meta.json"), JSON.stringify({ id: `sa_reader_${process.pid}`, status: "running",
    pid: process.pid, spawnPid: process.pid, sessionId: "archive-budget", startedAt: 6000,
    cwd: process.env.TMPDIR, logPath: join(runningDir, "output.log"), callback: false }));
await handlers.get("session_start")?.({}, ctx);
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
            for (const interval of intervals) await interval();
            await tools.get("subagent_list").execute("budget", { status: ["running"] }, undefined, undefined, ctx);
        }
        metas = listMetas();
    }
    process.send({ count: metas.filter((m) => m.id.startsWith("sa_archive_")).length, name: metas.find((m) => m.id === "sa_archive_4415")?.name,
        archiveReads, markerStats, healthIntervals: intervals.length, cpu: process.cpuUsage(start) });
});
