/**
 * Issue #67 — surface health observations on list / output / widget / notify paths.
 *
 * Healthy/quiet stays low-noise. Degraded, orphaned, and lost add diagnostics
 * without inventing a parallel health model (uses #66 observeRunHealth facts).
 *
 * // @covers subagent.list-health
 * // @level unit
 * // @covers subagent.output-health
 * // @level unit
 * // @covers widget.health
 * // @level unit
 * // @covers subagent.health-notify
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
    isActionableHealth,
    healthSurfaceFacts,
    formatListHealthSuffix,
    formatHealthDiagnosticLine,
    formatWidgetHealthSuffix,
    appendHealthDiagnostic,
} from "../health-surface.mjs";
import {
    SUBAGENT_LIST_STATUSES,
    buildSubagentList,
    formatSubagentListRow,
} from "../list.mjs";
import {
    buildWidgetLines,
    isHealthLogCacheFresh,
    resolveHealthLogExtraction,
} from "../widget.mjs";
import { observeRunHealth, extractChildEventFacts } from "../health-observation.ts";
import { formatSubagentOutputBody } from "../parse.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOW = 1_800_000_000_000;
const BASE = NOW - 60_000;

const THRESH = {
    quietMs: 30_000,
    staleMs: 120_000,
    longToolMs: 60_000,
    longCompactionMs: 60_000,
};

function emptyFacts(overrides = {}) {
    return {
        activeTools: [],
        compacting: false,
        model: { state: "ok", errorHistory: [] },
        sawAgentSettled: false,
        longModelCallSupported: false,
        ...overrides,
    };
}

function obsFor(status, facts, extra = {}) {
    return observeRunHealth({
        status,
        now: NOW,
        facts,
        thresholds: THRESH,
        startedAt: BASE,
        ...extra,
    });
}

function meta(id, overrides = {}) {
    return {
        id,
        status: "running",
        pid: 9000,
        spawnPid: 41001,
        model: "xai/grok-4.5",
        cwd: "/repo",
        promptPreview: `prompt for ${id}`,
        startedAt: BASE,
        logPath: `/tmp/${id}.log`,
        sessionId: id,
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Pure surface helpers
// ---------------------------------------------------------------------------
describe("health surface helpers", () => {
    // @covers subagent.list-health
    // @level unit
    it("healthy/quiet observations are not actionable", () => {
        const healthy = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const quiet = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 45_000 }));
        assert.equal(healthy.activity, "healthy");
        assert.equal(quiet.activity, "quiet");
        assert.equal(isActionableHealth(healthy), false);
        assert.equal(isActionableHealth(quiet), false);
        assert.equal(formatListHealthSuffix(healthy), "");
        assert.equal(formatListHealthSuffix(quiet), "");
        assert.equal(formatHealthDiagnosticLine(healthy), "");
        assert.equal(formatWidgetHealthSuffix(healthy), "");
        assert.equal(formatWidgetHealthSuffix(quiet), "");
    });

    // @covers subagent.list-health
    // @level unit
    it("healthy short-running tool is not actionable (no list/output/widget noise)", () => {
        // #66 emits compactFacts like "bash 10s" while tool.state is still
        // ordinary "running". #67 surfaces must stay silent until long_running
        // or another degraded dimension appears.
        const shortTool = obsFor(
            "running",
            emptyFacts({
                lastMeaningfulAt: NOW - 10_000,
                activeTools: [{ toolName: "bash", startedAt: NOW - 10_000 }],
                lastToolAt: NOW - 10_000,
            }),
        );
        assert.equal(shortTool.tool.state, "running");
        assert.ok(shortTool.compactFacts.some((f) => /bash/.test(f)), shortTool.compactFacts.join(","));
        assert.equal(isActionableHealth(shortTool), false);
        assert.equal(formatListHealthSuffix(shortTool), "");
        assert.equal(formatHealthDiagnosticLine(shortTool), "");
        assert.equal(formatWidgetHealthSuffix(shortTool), "");

        const listRow = formatSubagentListRow(meta("sa_bash", { name: "worker" }), {
            status: "running",
            now: NOW,
            health: shortTool,
        });
        assert.doesNotMatch(listRow, / · bash|health:|long bash/);

        const outBody = formatSubagentOutputBody("[sa_bash · running · 10s]", "", "hi", "raw", []);
        assert.equal(
            appendHealthDiagnostic(outBody, formatHealthDiagnosticLine(shortTool)),
            outBody,
        );

        const spendById = {
            sa_bash: {
                usage: { total: 0, input: 0, output: 0, costUSD: 0 },
                tool: "bash",
            },
        };
        const running = [{ id: "sa_bash", name: "worker", model: "xai/grok-4.5", startedAt: BASE }];
        const baseline = buildWidgetLines({ running, frame: 0, now: NOW, spendById });
        const withHealth = buildWidgetLines({
            running,
            frame: 0,
            now: NOW,
            spendById,
            healthById: { sa_bash: shortTool },
        });
        // Widget already shows the tool via its normal label; health must not
        // append a second degraded " · bash 10s" suffix on top of it.
        assert.deepEqual(withHealth, baseline);
        assert.match(baseline[1], / · bash$/); // normal tool label only
        assert.doesNotMatch(baseline[1], /bash \d|long bash|health:/);
    });

    // @covers subagent.list-health
    // @level unit
    it("preserves degraded facts that share a running tool-name prefix", () => {
        // Tool names are runtime strings from tool_execution_start. A short-running
        // tool named `model` must not strip `model error` / `model retrying` via a
        // naive `${name} ` prefix filter — those remain actionable diagnostics.
        const colliding = {
            status: "running",
            activity: "healthy",
            compactFacts: ["model 10s", "model error"],
            tool: { state: "running", active: { toolName: "model" }, ageMs: 10_000 },
        };
        assert.equal(isActionableHealth(colliding), true);
        assert.deepEqual(healthSurfaceFacts(colliding), ["model error"]);
        assert.match(formatListHealthSuffix(colliding), /model error/);
        assert.doesNotMatch(formatListHealthSuffix(colliding), /model 10s/);
        assert.match(formatHealthDiagnosticLine(colliding), /\[health: model error\]/);
        assert.match(formatWidgetHealthSuffix(colliding), /model error/);

        const retrying = {
            ...colliding,
            compactFacts: ["model", "model retrying"],
        };
        assert.deepEqual(healthSurfaceFacts(retrying), ["model retrying"]);
        assert.equal(isActionableHealth(retrying), true);

        // Control: ordinary duration-only fact with a non-colliding name stays quiet.
        const ordinary = {
            status: "running",
            activity: "healthy",
            compactFacts: ["bash 10s"],
            tool: { state: "running", active: { toolName: "bash" }, ageMs: 10_000 },
        };
        assert.equal(isActionableHealth(ordinary), false);
        assert.deepEqual(healthSurfaceFacts(ordinary), []);
    });

    // @covers subagent.list-health
    // @level unit
    it("stale / long-tool / compacting / model-error are actionable", () => {
        const stale = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 200_000 }));
        assert.equal(stale.activity, "stale");
        assert.equal(isActionableHealth(stale), true);
        assert.match(formatListHealthSuffix(stale), /stale/);
        assert.match(formatHealthDiagnosticLine(stale), /\[health:.*stale/);

        const longTool = obsFor(
            "running",
            emptyFacts({
                lastMeaningfulAt: NOW - 10_000,
                activeTools: [{ toolName: "bash", startedAt: NOW - 90_000 }],
                lastToolAt: NOW - 90_000,
            }),
        );
        assert.equal(longTool.tool.state, "long_running");
        assert.match(formatListHealthSuffix(longTool), /long bash|bash/);

        const compacting = obsFor(
            "running",
            emptyFacts({
                lastMeaningfulAt: NOW - 10_000,
                compacting: true,
                compactionStartedAt: NOW - 10_000,
            }),
        );
        assert.match(formatListHealthSuffix(compacting), /compact/);

        const modelErr = obsFor(
            "running",
            emptyFacts({
                lastMeaningfulAt: NOW - 10_000,
                model: {
                    state: "error",
                    lastError: { message: "rate limit", at: NOW - 5_000 },
                    errorHistory: [{ message: "rate limit", at: NOW - 5_000 }],
                },
            }),
        );
        assert.match(formatListHealthSuffix(modelErr), /model error/);
    });

    // @covers subagent.list-health
    // @level unit
    it("orphaned and lost are always actionable status facts", () => {
        const orphaned = obsFor("orphaned", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const lost = obsFor("lost", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        assert.equal(isActionableHealth(orphaned), true);
        assert.equal(isActionableHealth(lost), true);
        assert.ok(healthSurfaceFacts(orphaned).includes("orphaned"));
        assert.ok(healthSurfaceFacts(lost).includes("lost"));
        assert.match(formatHealthDiagnosticLine(orphaned), /orphaned/);
        assert.match(formatHealthDiagnosticLine(lost), /lost/);
    });
});

// ---------------------------------------------------------------------------
// subagent_list
// ---------------------------------------------------------------------------
describe("subagent_list health surfacing", () => {
    // @covers subagent.list-health
    // @level unit
    it("accepts durable orphaned and lost statuses in filters", () => {
        assert.ok(SUBAGENT_LIST_STATUSES.includes("orphaned"));
        assert.ok(SUBAGENT_LIST_STATUSES.includes("lost"));

        const metas = [
            meta("sa_run", { status: "running", startedAt: BASE + 3 }),
            meta("sa_orph", { status: "orphaned", startedAt: BASE + 2, orphanedAt: BASE + 1 }),
            meta("sa_lost", { status: "lost", startedAt: BASE + 1, lostAt: BASE, endedAt: BASE }),
            meta("sa_done", { status: "completed", startedAt: BASE, endedAt: BASE + 1 }),
        ];
        const out = buildSubagentList({
            metas,
            params: { status: ["orphaned", "lost"] },
            parentPid: 41001,
            now: NOW,
            statusOf: (m) => m.status,
            usageById: () => undefined,
        });
        assert.ok(out.includes("[orphaned]"), out);
        assert.ok(out.includes("[lost]"), out);
        assert.ok(!out.includes("sa_run"), out);
        assert.ok(!out.includes("sa_done"), out);
    });

    // @covers subagent.list-health
    // @level unit
    it("healthy/quiet rows stay on the compact format (no health suffix)", () => {
        const run = meta("sa_quiet", { name: "worker", status: "running" });
        const healthyObs = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const row = formatSubagentListRow(run, {
            status: "running",
            now: NOW,
            usage: undefined,
            health: healthyObs,
        });
        assert.equal(
            row,
            `• worker sa_quiet  [running]  xai/grok-4.5  1m 00s\n    prompt for sa_quiet`,
        );
        assert.doesNotMatch(row, /health:| · stale| · model/);
    });

    // @covers subagent.list-health
    // @level unit
    it("degraded running rows append compact health facts", () => {
        const run = meta("sa_stale", { name: "laggy", status: "running" });
        const stale = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 200_000 }));
        const row = formatSubagentListRow(run, {
            status: "running",
            now: NOW,
            usage: undefined,
            health: stale,
        });
        assert.match(row, /\[running\].* · stale/);
        assert.ok(row.startsWith("• laggy sa_stale  [running]"), row);
    });

    // @covers subagent.list-health
    // @level unit
    it("orphaned/lost rows show durable status brackets", () => {
        const orphaned = formatSubagentListRow(meta("sa_o", { status: "orphaned", name: "left" }), {
            status: "orphaned",
            now: NOW,
            health: obsFor("orphaned", emptyFacts({ lastMeaningfulAt: NOW - 5_000 })),
        });
        const lost = formatSubagentListRow(meta("sa_l", { status: "lost", name: "gone" }), {
            status: "lost",
            now: NOW,
            health: obsFor("lost", emptyFacts({ lastMeaningfulAt: NOW - 5_000 })),
        });
        assert.match(orphaned, /\[orphaned\]/);
        assert.match(lost, /\[lost\]/);
    });

    // @covers subagent.list-health
    // @level unit
    it("buildSubagentList wires optional healthById for degraded rows only", () => {
        const metas = [
            meta("sa_ok", { name: "ok", status: "running", startedAt: BASE + 2 }),
            meta("sa_bad", { name: "bad", status: "running", startedAt: BASE + 1 }),
        ];
        const healthById = {
            sa_ok: obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 5_000 })),
            sa_bad: obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 200_000 })),
        };
        const out = buildSubagentList({
            metas,
            params: {},
            parentPid: 41001,
            now: NOW,
            statusOf: (m) => m.status,
            usageById: () => undefined,
            healthById: (id) => healthById[id],
        });
        const lines = out.split("\n").filter((l) => l.startsWith("• "));
        assert.equal(lines.length, 2);
        assert.doesNotMatch(lines[0], / · stale/);
        assert.match(lines[1], / · stale/);
    });
});

// ---------------------------------------------------------------------------
// subagent_output
// ---------------------------------------------------------------------------
describe("subagent_output health diagnostics", () => {
    // @covers subagent.output-health
    // @level unit
    it("healthy running output has no health diagnostic line", () => {
        const healthy = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const head = "[sa_1 · running · 1m 00s]";
        const body = formatSubagentOutputBody(head, "", "hello", "raw", []);
        const withHealth = appendHealthDiagnostic(body, formatHealthDiagnosticLine(healthy));
        assert.equal(withHealth, body);
        assert.doesNotMatch(withHealth, /\[health:/);
    });

    // @covers subagent.output-health
    // @level unit
    it("orphaned / lost / degraded running include a health diagnostic", () => {
        const head = "[sa_1 · orphaned · 1m 00s]";
        const body = formatSubagentOutputBody(head, "", "partial", "RAW", []);
        const line = formatHealthDiagnosticLine(
            obsFor("orphaned", emptyFacts({ lastMeaningfulAt: NOW - 5_000 })),
        );
        const out = appendHealthDiagnostic(body, line);
        assert.match(out, /\[health: orphaned\]/);
        assert.ok(out.indexOf("[health:") < out.indexOf("partial"), out);

        const degraded = formatHealthDiagnosticLine(
            obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 200_000 })),
        );
        assert.match(appendHealthDiagnostic(body, degraded), /\[health:.*stale/);
    });
});

// ---------------------------------------------------------------------------
// passive widget
// ---------------------------------------------------------------------------
describe("passive widget health surfacing", () => {
    // @covers widget.health
    // @level unit
    it("healthy/quiet runs keep today's widget line shape (non-regression)", () => {
        const healthy = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const baseline = buildWidgetLines({
            running: [{ id: "a1", name: "watch", model: "xai/grok-4.5", startedAt: BASE }],
            frame: 0,
            now: NOW,
            spendById: {},
        });
        const withHealth = buildWidgetLines({
            running: [{ id: "a1", name: "watch", model: "xai/grok-4.5", startedAt: BASE }],
            frame: 0,
            now: NOW,
            spendById: {},
            healthById: { a1: healthy },
        });
        assert.deepEqual(withHealth, baseline);
        assert.equal(baseline[0], "Subagents · 1 running");
        assert.doesNotMatch(baseline[1], /stale|orphaned|health:/);
    });

    // @covers widget.health
    // @level unit
    it("degraded health can appear on the widget line without focus APIs", () => {
        const stale = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 200_000 }));
        const lines = buildWidgetLines({
            running: [{ id: "a1", name: "laggy", model: "xai/grok-4.5", startedAt: BASE }],
            frame: 0,
            now: NOW,
            spendById: {},
            healthById: { a1: stale },
        });
        assert.match(lines[1], / · stale/);
        // Still a plain string[] widget — no focus/interactive contract.
        assert.equal(typeof lines[1], "string");

        const widgetSource = readFileSync(join(ROOT, "widget.mjs"), "utf8");
        const indexSource = readFileSync(join(ROOT, "index.ts"), "utf8");
        // Passive string[] only — no focus APIs on the widget helper surface.
        assert.doesNotMatch(widgetSource, /setFocus|tabIndex|onFocus|\.focus\(/);
        assert.match(indexSource, /setWidget\("subagents"/);
        // Health is painted via setWidget/buildWidgetLines, not navigator custom().
        assert.match(indexSource, /buildWidgetLines\(\{[\s\S]{0,240}healthById[\s\S]{0,240}\}\)/);
        assert.doesNotMatch(indexSource, /healthById[\s\S]{0,120}custom\(/);
    });

    // @covers widget.health
    // @level unit
    it("orphaned runs can surface on the passive widget when included", () => {
        const orphaned = obsFor("orphaned", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const lines = buildWidgetLines({
            running: [{ id: "o1", name: "left", model: "xai/grok-4.5", startedAt: BASE, status: "orphaned" }],
            frame: 0,
            now: NOW,
            spendById: {},
            healthById: { o1: orphaned },
        });
        assert.match(lines[1], /orphaned/);
    });

    // @covers widget.health
    // @level unit
    it("widget health log parse is cached by size/mtime across frames", () => {
        // Unchanged logs must not re-invoke extract on every 1 Hz frame.
        const factsA = emptyFacts({ lastMeaningfulAt: NOW - 5_000 });
        const rawA = { mtimeMs: 100, sizeBytes: 4096 };
        let extracts = 0;
        const extract = () => {
            extracts += 1;
            return { facts: factsA, rawLog: rawA };
        };

        const first = resolveHealthLogExtraction(null, { logSize: 4096, mtimeMs: 100 }, extract);
        assert.equal(first.hit, false);
        assert.equal(extracts, 1);

        const cached = {
            facts: first.facts,
            rawLog: first.rawLog,
            logSize: 4096,
            mtimeMs: 100,
        };
        assert.equal(isHealthLogCacheFresh(cached, 4096, 100), true);

        const second = resolveHealthLogExtraction(cached, { logSize: 4096, mtimeMs: 100 }, extract);
        const third = resolveHealthLogExtraction(cached, { logSize: 4096, mtimeMs: 100 }, extract);
        assert.equal(second.hit, true);
        assert.equal(third.hit, true);
        assert.equal(extracts, 1, "unchanged log must not reparse every widget frame");
        assert.equal(second.facts, first.facts);

        // Size growth forces a fresh parse.
        const grownFacts = emptyFacts({ lastMeaningfulAt: NOW - 1_000 });
        const afterGrow = resolveHealthLogExtraction(
            cached,
            { logSize: 8192, mtimeMs: 100 },
            () => {
                extracts += 1;
                return { facts: grownFacts, rawLog: { mtimeMs: 100, sizeBytes: 8192 } };
            },
        );
        assert.equal(afterGrow.hit, false);
        assert.equal(extracts, 2);
        assert.equal(afterGrow.facts, grownFacts);

        // mtime change alone also invalidates (rewrite without size change).
        const rewritten = resolveHealthLogExtraction(
            { facts: grownFacts, rawLog: afterGrow.rawLog, logSize: 8192, mtimeMs: 100 },
            { logSize: 8192, mtimeMs: 200 },
            () => {
                extracts += 1;
                return { facts: grownFacts, rawLog: { mtimeMs: 200, sizeBytes: 8192 } };
            },
        );
        assert.equal(rewritten.hit, false);
        assert.equal(extracts, 3);

        // index.ts must gate the widget health path on the size/mtime helper.
        const indexSource = readFileSync(join(ROOT, "index.ts"), "utf8");
        assert.match(indexSource, /resolveHealthLogExtraction/);
        assert.match(indexSource, /healthLogCache/);
        const widgetSection = indexSource.match(
            /\/\/ ---- live status widget[\s\S]*?\/\/ ----(?! live)/,
        )?.[0] ?? "";
        assert.match(widgetSection, /resolveHealthLogExtraction/);
        // Direct extract still exists for the miss path, but must be behind the cache.
        assert.match(widgetSection, /extractChildEventFactsFromLog/);
    });
});

// ---------------------------------------------------------------------------
// notify / callback independence (wiring pins + helper facts)
// ---------------------------------------------------------------------------
describe("human notify vs callback independence", () => {
    // @covers subagent.health-notify
    // @level unit
    it("index health tick notifies on transition without requiring callback:true", () => {
        const indexSource = readFileSync(join(ROOT, "index.ts"), "utf8");
        // Transition notify is unconditional on callback flag.
        assert.match(indexSource, /ui\.notify\(note, "warning"\)/);
        // callback:false only gates model delivery.
        assert.match(indexSource, /buildHealthCallbackDelivery/);
        assert.match(indexSource, /callback:false/);
        // Marker path for suppressed model still exists.
        assert.match(indexSource, /orphanedCallbackSentAt/);
        assert.match(indexSource, /lostCallbackSentAt/);
    });

    // @covers subagent.health-notify
    // @level unit
    it("tools/output path does not gate TUI visibility on callback", () => {
        const toolsSource = readFileSync(join(ROOT, "tools.ts"), "utf8");
        // Health observation wiring must not early-return on meta.callback === false.
        assert.doesNotMatch(
            toolsSource,
            /callback\s*===\s*false[\s\S]{0,80}health|health[\s\S]{0,80}callback\s*===\s*false/,
        );
    });
});

// ---------------------------------------------------------------------------
// result diagnostics remain from #65 + optional health line
// ---------------------------------------------------------------------------
describe("subagent_result health/loss/orphan diagnostics", () => {
    // @covers subagent.output-health
    // @level unit
    it("tools path still uses formatOrphanedResult / lost diagnostic wiring", () => {
        const toolsSource = readFileSync(join(ROOT, "tools.ts"), "utf8");
        const lifecycleSource = readFileSync(join(ROOT, "lifecycle.ts"), "utf8");
        assert.match(toolsSource, /formatOrphanedResult/);
        assert.match(lifecycleSource, /formatLostResult/);
        // #67 may append health diagnostics but must keep #65 formatters.
        assert.match(toolsSource, /formatHealthDiagnosticLine|healthSurface|observeRunHealth|appendHealthDiagnostic/);
    });
});

// Keep extractChildEventFacts import live for future fixture expansion without lint noise.
void extractChildEventFacts;
