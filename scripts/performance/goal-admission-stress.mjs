import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const gatePath = resolve(option("--gate") ?? fileURLToPath(new URL("../../packages/pi-better-goal/src/workflow-gates.ts", import.meta.url)));
const script = resolve(option("--scheduler") ?? fileURLToPath(new URL("../../packages/pi-better-goal/test/fixtures/resolve-issues/scripts/next-actions.mjs", import.meta.url)));
const { operationResumeSchedulerGate } = await import(pathToFileURL(gatePath).href);
const root = fs.mkdtempSync(join(tmpdir(), "pi-goal-admission-stress-"));
const runDir = join(root, "run");
const workspace = join(root, "workspace");
const metricsPath = join(root, "metrics.jsonl");
const preload = join(root, "metrics.mjs");
const savedOptions = process.env.NODE_OPTIONS;
const originals = new Map();
let timer;

try {
    fs.mkdirSync(runDir);
    fs.mkdirSync(workspace);
    for (let dir = 0; dir < 20; dir++) {
        const path = join(workspace, String(dir));
        fs.mkdirSync(path);
        for (let file = 0; file < 250; file++) fs.writeFileSync(join(path, `${file}.txt`), "fixture\n");
    }
    const planPath = join(runDir, "task-plan.json");
    fs.writeFileSync(planPath, JSON.stringify({ skill: "rush-issues", spec: "local CPU regression fixture", units:
        Array.from({ length: 4 }, (_, index) => ({ id: String(index + 1), status: "in-flight", stage: "implement",
            worker: `fixture-${index}`, workerKind: "implement", workerSince: new Date().toISOString(), workspace })) }));
    // Instrument real scheduler children, including their synchronous workspace traversal.
    fs.writeFileSync(preload, `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const start = performance.now(), cpu = process.cpuUsage(), calls = {};
const append = fs.appendFileSync;
append(${JSON.stringify(metricsPath)}, JSON.stringify({event:"start",pid:process.pid,at:Date.now()}) + "\\n");
for (const name of ["statSync", "readdirSync", "readFileSync"]) {
  const original = fs[name]; calls[name] = 0;
  fs[name] = function(...args) { calls[name]++; return Reflect.apply(original, this, args); };
}
syncBuiltinESMExports();
process.on("exit", () => {
  const used = process.cpuUsage(cpu);
  append(${JSON.stringify(metricsPath)}, JSON.stringify({event:"exit",pid:process.pid,at:Date.now(),calls,
    cpuMs:(used.user+used.system)/1000,wallMs:performance.now()-start}) + "\\n");
});
`);
    process.env.NODE_OPTIONS = `${savedOptions ?? ""} --import=${pathToFileURL(preload).href}`;
    const callerCalls = {};
    for (const name of ["statSync", "readdirSync", "readFileSync"]) {
        const original = fs[name];
        originals.set(name, original);
        callerCalls[name] = 0;
        fs[name] = function(...args) { callerCalls[name]++; return Reflect.apply(original, this, args); };
    }
    syncBuiltinESMExports();
    const owner = { name: "rush-issues", path: join(dirname(dirname(script)), "SKILL.md"), role: "coordinator", planOwner: "workflow" };
    const entries = [{ type: "custom", customType: "pi-better-workflow-plan", data: { version: 1, kind: "set", owner: owner.name, path: planPath } }];
    let lastTick = performance.now(), maxEventLoopLagMs = 0;
    timer = setInterval(() => {
        const now = performance.now();
        maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - lastTick - 10);
        lastTick = now;
    }, 10);
    const start = performance.now(), cpu = process.cpuUsage();
    const gates = await Promise.all(Array.from({ length: 16 }, () => operationResumeSchedulerGate(entries, owner)));
    const used = process.cpuUsage(cpu);
    const callerCpuMs = (used.user + used.system) / 1000;
    const wallMs = performance.now() - start;
    clearInterval(timer);
    for (const [name, original] of originals) fs[name] = original;
    syncBuiltinESMExports();
    const records = fs.readFileSync(metricsPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const children = records.filter(record => record.event === "exit");
    let active = 0, peakChildren = 0;
    for (const record of records) {
        active += record.event === "start" ? 1 : -1;
        peakChildren = Math.max(peakChildren, active);
    }
    const childCalls = Object.fromEntries(Object.keys(callerCalls).map(name => [name, children.reduce((sum, child) => sum + child.calls[name], 0)]));
    const childCpuMs = children.reduce((sum, child) => sum + child.cpuMs, 0);
    const report = { gatePath, script, requests: gates.length, schedulerProcesses: children.length, peakChildren,
        callerCalls, childCalls, callerCpuMs, childCpuMs, combinedCpuMs: callerCpuMs + childCpuMs, wallMs, maxEventLoopLagMs };
    console.log(JSON.stringify(report, null, 2));
    if (process.env.PI_PERF_REPORT) fs.writeFileSync(process.env.PI_PERF_REPORT, `${JSON.stringify(report, null, 2)}\n`);
    assert.ok(gates.every(gate => gate.ok), "all admissions must receive usable evidence");
    assert.equal(active, 0, "all instrumented children must exit");
    if (!args.includes("--baseline")) assert.equal(children.length, 1, "16 equivalent requests must share one scheduler traversal");
} finally {
    clearInterval(timer);
    for (const [name, original] of originals) fs[name] = original;
    syncBuiltinESMExports();
    if (savedOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedOptions;
    fs.rmSync(root, { recursive: true, force: true });
}
