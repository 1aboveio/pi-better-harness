/**
 * Runtime smoke for issue #69 navigator health display.
 *
 * Exercises pure navigator/health-surface helpers against the real modules the
 * extension loads. Does not spawn OS processes or open a TUI.
 *
 *   node --experimental-strip-types tests/smoke_navigator_health.mjs \
 *     [--json docs/tests/_generated/runtime-smoke-results-69.json]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    formatNavigatorHealthFacts,
    statusThemeColor,
    visibleWidth,
    isActionableHealth,
} from "../health-surface.mjs";
import {
    buildNavigatorRows,
    buildNavigatorLines,
    formatNavigatorRowText,
    buildDetailLines,
    createNavigatorState,
    navigatorSectionLabel,
} from "../navigator.ts";
import { observeRunHealth } from "../health-observation.ts";
import { fmtElapsed, shortModel } from "../widget.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const outPath = jsonIdx >= 0
    ? args[jsonIdx + 1]
    : join(ROOT, "..", "docs/tests/_generated/runtime-smoke-results-69.json");

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
const thresh = { quietMs: 30_000, staleMs: 120_000, longToolMs: 60_000, longCompactionMs: 60_000 };

const healthy = observeRunHealth({
    status: "running",
    now: NOW,
    facts: { ...emptyFacts, lastMeaningfulAt: NOW - 5_000 },
    startedAt: BASE,
    thresholds: thresh,
});
const stale = observeRunHealth({
    status: "running",
    now: NOW,
    facts: { ...emptyFacts, lastMeaningfulAt: NOW - 200_000 },
    startedAt: BASE,
    thresholds: thresh,
});
const compacting = observeRunHealth({
    status: "running",
    now: NOW,
    facts: {
        ...emptyFacts,
        lastMeaningfulAt: NOW - 10_000,
        compacting: true,
        compactionStartedAt: NOW - 20_000,
    },
    startedAt: BASE,
    thresholds: thresh,
});

must("healthy not actionable", isActionableHealth(healthy) === false);
must("healthy facts empty", formatNavigatorHealthFacts(healthy).length === 0);
must("stale actionable", isActionableHealth(stale) === true);
must("stale fact", formatNavigatorHealthFacts(stale).some((f) => /stale/.test(f)));
must("compacting fact", formatNavigatorHealthFacts(compacting).some((f) => /compacting/.test(f)));
must("fact cap ≤2", formatNavigatorHealthFacts({
    ...stale,
    compactFacts: ["a", "b", "c"],
    activity: "stale",
    tool: { state: "long_running", active: { toolName: "bash" } },
}).length <= 2);

must("status colors", statusThemeColor("completed") === "success"
    && statusThemeColor("failed") === "danger"
    && statusThemeColor("lost") === "danger"
    && statusThemeColor("orphaned") === "warning"
    && statusThemeColor("killed") === "warning"
    && statusThemeColor("running") === "accent");

const rows = buildNavigatorRows([{
    id: "sa_smoke",
    name: "reviewer",
    status: "running",
    model: "xai/grok-4.5",
    startedAt: BASE,
    effort: "high",
}], {
    effectiveStatus: (m) => m.status,
    shortModel,
    fmtElapsed,
    now: NOW,
    spendFor: () => "1k tok · $0.01",
    toolFor: () => "bash",
    effortFor: (m) => m.effort,
    healthFor: () => stale,
});
const rowText = formatNavigatorRowText(rows[0]);
must("name first", rowText.startsWith("reviewer"));
must("model before status", rowText.indexOf("grok-4.5") < rowText.lastIndexOf("running"));
must("effort adjacent", /grok-4\.5 high/.test(rowText));
must("status near end before facts", /running · stale/.test(rowText) || rowText.endsWith("running · stale"));

const fg = (c, s) => `\u001b[31m${s}\u001b[0m`; // any ANSI
const lines = buildNavigatorLines(createNavigatorState(rows), {
    width: 40,
    colorizeStatus: true,
    fg,
});
must("width-safe colored rows", lines.every((l) => visibleWidth(l) <= 40));

const detailLines = buildDetailLines({
    id: "sa_smoke",
    name: "reviewer",
    status: "orphaned",
    model: "grok-4.5",
    effort: "high",
    elapsed: "1m",
    tools: "bash",
    currentTool: "bash",
    spend: "$0.01",
    output: "partial",
    pid: 1,
    pgid: 1,
    orphanedAt: NOW - 10_000,
    orphanedCallbackSentAt: NOW - 9_000,
    health: compacting,
    now: NOW,
}, { width: 60, colorizeStatus: true, fg: (c, s) => s });
const detailText = detailLines.join("\n");
const sectionAt = (label) => detailLines.findIndex((l) => navigatorSectionLabel(l) === label);
must("detail has process section", sectionAt("process") >= 0);
must("detail has compaction section", sectionAt("compaction") >= 0);
must("detail has active tool section", sectionAt("active tool") >= 0);
must("detail has model section", sectionAt("model") >= 0);
must("detail separates compaction before tool",
    sectionAt("compaction") < sectionAt("active tool")
    && sectionAt("active tool") < sectionAt("model"));
must("detail callbacks", sectionAt("callbacks") >= 0 && /orphaned notified/.test(detailText));
must("detail width-safe", detailLines.every((l) => visibleWidth(l) <= 60));

const failed = steps.filter((s) => s.status === "fail").length;
const passed = steps.filter((s) => s.status === "pass").length;
const summary = {
    issue: 69,
    generatedAt: new Date().toISOString(),
    passed,
    failed,
    total: steps.length,
    ok: failed === 0,
    steps,
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n");
console.log(failed === 0 ? `SMOKE PASS ${passed}/${steps.length}` : `SMOKE FAIL ${failed}/${steps.length}`);
console.log(`wrote ${outPath}`);
process.exit(failed === 0 ? 0 : 1);
