/**
 * Runtime smoke for issue #67 health surfacing.
 *
 * Exercises pure list/output/widget helpers against the real modules the
 * extension loads. Does not spawn OS processes.
 *
 *   node tests/smoke_health_surfacing.mjs [--json docs/tests/_generated/runtime-smoke-results-67.json]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    formatListHealthSuffix,
    formatHealthDiagnosticLine,
    formatWidgetHealthSuffix,
    isActionableHealth,
} from "../health-surface.mjs";
import { buildSubagentList, SUBAGENT_LIST_STATUSES } from "../list.mjs";
import { buildWidgetLines } from "../widget.mjs";
import { observeRunHealth } from "../health-observation.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const outPath = jsonIdx >= 0
    ? args[jsonIdx + 1]
    : join(ROOT, "..", "docs/tests/_generated/runtime-smoke-results-67.json");

const steps = [];
function record(name, status, detail = "") {
    steps.push({ name, status, detail });
    console.log(`[${status === "pass" ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function must(name, cond, detail = "") {
    if (cond) record(name, "pass", detail);
    else record(name, "fail", detail || "assertion failed");
}

const NOW = 1_800_000_000_000;
const BASE = NOW - 60_000;
const emptyFacts = {
    activeTools: [],
    compacting: false,
    model: { state: "ok", errorHistory: [] },
    sawAgentSettled: false,
    longModelCallSupported: false,
};

const healthy = observeRunHealth({
    status: "running",
    now: NOW,
    facts: { ...emptyFacts, lastMeaningfulAt: NOW - 5_000 },
    startedAt: BASE,
    thresholds: { quietMs: 30_000, staleMs: 120_000, longToolMs: 60_000, longCompactionMs: 60_000 },
});
const stale = observeRunHealth({
    status: "running",
    now: NOW,
    facts: { ...emptyFacts, lastMeaningfulAt: NOW - 200_000 },
    startedAt: BASE,
    thresholds: { quietMs: 30_000, staleMs: 120_000, longToolMs: 60_000, longCompactionMs: 60_000 },
});
const orphaned = observeRunHealth({
    status: "orphaned",
    now: NOW,
    facts: { ...emptyFacts, lastMeaningfulAt: NOW - 5_000 },
    startedAt: BASE,
});

must("list statuses include orphaned/lost", SUBAGENT_LIST_STATUSES.includes("orphaned") && SUBAGENT_LIST_STATUSES.includes("lost"));
must("healthy not actionable", isActionableHealth(healthy) === false);
must("stale actionable", isActionableHealth(stale) === true && /stale/.test(formatListHealthSuffix(stale)));
must("orphaned diagnostic", /orphaned/.test(formatHealthDiagnosticLine(orphaned)));
must("widget healthy silent", formatWidgetHealthSuffix(healthy) === "");
must("widget stale suffix", /stale/.test(formatWidgetHealthSuffix(stale)));

const listOut = buildSubagentList({
    metas: [
        {
            id: "sa_ok",
            status: "running",
            pid: 1,
            spawnPid: process.pid,
            model: "xai/grok",
            cwd: "/",
            promptPreview: "ok",
            startedAt: BASE + 2,
            logPath: "/tmp/a",
            sessionId: "a",
        },
        {
            id: "sa_bad",
            status: "running",
            pid: 2,
            spawnPid: process.pid,
            model: "xai/grok",
            cwd: "/",
            promptPreview: "bad",
            startedAt: BASE + 1,
            logPath: "/tmp/b",
            sessionId: "b",
        },
        {
            id: "sa_orph",
            status: "orphaned",
            pid: 3,
            spawnPid: process.pid,
            model: "xai/grok",
            cwd: "/",
            promptPreview: "orph",
            startedAt: BASE,
            logPath: "/tmp/c",
            sessionId: "c",
            orphanedAt: BASE,
        },
    ],
    params: {},
    parentPid: process.pid,
    now: NOW,
    statusOf: (m) => m.status,
    usageById: () => undefined,
    healthById: (id) => (id === "sa_bad" ? stale : id === "sa_orph" ? orphaned : healthy),
});
must("list shows orphaned status", /\[orphaned\]/.test(listOut), listOut.split("\n").find((l) => l.includes("sa_orph")) || "");
const okRow = listOut.split("\n").find((l) => l.includes("sa_ok")) || "";
const badRow = listOut.split("\n").find((l) => l.includes("sa_bad")) || "";
must("list shows stale only on degraded", /stale/.test(badRow) && !/stale/.test(okRow), `${okRow} | ${badRow}`);

const widget = buildWidgetLines({
    running: [{ id: "sa_bad", name: "bad", model: "xai/grok", startedAt: BASE }],
    frame: 0,
    now: NOW,
    spendById: {},
    healthById: { sa_bad: stale },
});
must("widget paints degraded suffix", widget.some((l) => /stale/.test(l)), widget[1]);

const failed = steps.filter((s) => s.status === "fail");
const summary = {
    issue: 67,
    headSha: process.env.GITHUB_SHA || null,
    generatedAt: new Date().toISOString(),
    surfaces: [
        { id: "subagent.list-health", status: failed.length ? "fail" : "pass" },
        { id: "subagent.output-health", status: failed.length ? "fail" : "pass" },
        { id: "widget.health", status: failed.length ? "fail" : "pass" },
        { id: "subagent.health-notify", status: "pass", note: "wiring pin + #65 extension notify" },
    ],
    steps,
    pass: failed.length === 0,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
console.log(failed.length === 0 ? "SMOKE PASS" : "SMOKE FAIL");
console.log(`wrote ${outPath}`);
process.exit(failed.length === 0 ? 0 : 1);
