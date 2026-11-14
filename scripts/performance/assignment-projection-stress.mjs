import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildNavigatorRows } from "../../packages/pi-better-subagents/navigator.mjs";
import { collectSubagentActivity } from "../../packages/pi-better-goal/src/subagents.ts";
import { openStore } from "../../packages/operation-coordinator/index.ts";

const root = fs.mkdtempSync(join(tmpdir(), "pi-projection-stress-"));
const savedEnv = new Map(["TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_DURABLE_DIR"].map((key) => [key, process.env[key]]));
const originalRead = fs.readFileSync;
const reportPath = process.env.PI_PERF_REPORT;
const report = { version: 1, node: process.version, platform: process.platform, results: [] };
let measuredRuns;
let metadataReads = 0;
const repeats = 3;
try {
    for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = root;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_SUBAGENT_DURABLE_DIR = join(root, "durable");
    fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
    const store = openStore({ path: join(process.env.PI_CODING_AGENT_DIR, "operation-coordinator.sqlite") });
    store.close();
    fs.readFileSync = function(path, ...args) {
        if (measuredRuns && String(path).startsWith(measuredRuns + "/") && String(path).endsWith("/meta.json")) metadataReads++;
        return originalRead.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    for (const records of [200, 1000, 2000]) {
        const base = join(root, `registry-${records}`, "pi-better-subagents");
        const runs = join(base, "runs");
        fs.mkdirSync(runs, { recursive: true });
        const metas = Array.from({ length: records }, (_, i) => ({
            id: `sa_stress_${i}`, sessionId: `conversation-${i}`, status: "completed", startedAt: i,
            endedAt: i + 1, exitCode: 0, pid: process.pid, spawnPid: process.pid, cwd: root,
            operations: { conversationId: `conversation-${i}`, workspace: root },
        }));
        for (const meta of metas) {
            fs.mkdirSync(join(runs, meta.id));
            fs.writeFileSync(join(runs, meta.id, "meta.json"), JSON.stringify(meta));
        }
        for (const rows of [1, 20, 50]) {
            const visible = metas.slice(0, rows);
            const parentPid = 4194304 + rows;
            const parent = join(base, "by-parent", String(parentPid));
            fs.mkdirSync(parent, { recursive: true });
            fs.writeFileSync(join(parent, ".initialized"), "1");
            for (const meta of visible) {
                meta.spawnPid = parentPid;
                fs.writeFileSync(join(runs, meta.id, "meta.json"), JSON.stringify(meta));
                fs.writeFileSync(join(parent, meta.id), "");
            }
            // Navigator uses os.tmpdir(); each registry gets its own temporary root.
            process.env.TMPDIR = dirname(base);
            process.env.TMP = dirname(base);
            process.env.TEMP = dirname(base);
            const consumers = [
                { name: "navigator", run: () => buildNavigatorRows(visible, {
                    effectiveStatus: (meta) => meta.status, shortModel: () => "model",
                    fmtElapsed: () => "1s", spendFor: () => "",
                }) },
                { name: "goal", run: () => collectSubagentActivity({ baseDir: base, parentPid, processExists: () => false }).items },
            ];
            for (const consumer of consumers) {
                measuredRuns = runs;
                metadataReads = 0;
                const cpu = process.cpuUsage();
                const start = performance.now();
                for (let i = 0; i < repeats; i++) assert.equal(consumer.run().length, rows);
                const wallMs = performance.now() - start;
                const usage = process.cpuUsage(cpu);
                const perRefresh = consumer.name === "goal" ? rows * 2 : rows;
                const metadataReadBudget = rows === 1 ? records + perRefresh * (repeats - 1)
                    + (consumer.name === "goal" ? rows : 0) : perRefresh * repeats;
                const result = { consumer: consumer.name, records, rows, refreshes: repeats,
                    metadataReads, metadataReadBudget,
                    cpuMs: (usage.user + usage.system) / 1000, wallMs };
                report.results.push(result);
                console.log(JSON.stringify(result));
                assert.ok(metadataReads <= result.metadataReadBudget,
                    `${consumer.name}: repeated full-registry scans (${metadataReads} reads > ${result.metadataReadBudget})`);
                if (rows === 1) assert.ok(metadataReads >= records, "the probe must observe the initial lineage scan");
            }
        }
    }
} catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    throw error;
} finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
}
