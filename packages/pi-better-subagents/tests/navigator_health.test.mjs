/**
 * Issue #69 — health state in the TUI navigator list and detail view.
 *
 * Pins:
 * - Navigator row scan order: name/id · model [· effort] · elapsed [· tool]
 *   [· spend] · status [· ≤2 health facts]
 * - Healthy/quiet rows stay low-noise (no health facts)
 * - Degraded rows append compact facts (compacting, long tool, model error,
 *   stale, …) capped at two after status
 * - Durable statuses colorize semantically (width-safe / visible-width aware)
 * - Detail view sections: status, model/effort, process, liveness, activity,
 *   compaction, active tool, model, log, thresholds, callbacks, output —
 *   with compaction separated from tool and model-call state
 *
 * // @covers navigator.health
 * // @level unit
 * // @covers navigator.detail-health
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    formatNavigatorHealthFacts,
    statusThemeColor,
    visibleWidth,
    truncateToVisibleWidth,
    isActionableHealth,
} from "../health-surface.mjs";
import {
    buildNavigatorRows,
    buildNavigatorLines,
    formatNavigatorRowText,
    buildNavigatorDetail,
    buildDetailLines,
    createNavigatorState,
    createNavigatorOverlayComponent,
    navigatorSectionLabel,
} from "../navigator.ts";
import { observeRunHealth } from "../health-observation.ts";
import { fmtElapsed, shortModel, fmtSpend } from "../widget.ts";

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

function meta(overrides = {}) {
    return {
        id: "sa_t69_1",
        name: "reviewer",
        status: "running",
        pid: 4242,
        pgid: 4242,
        pidStartTime: "token-1",
        spawnPid: process.pid,
        model: "xai/grok-4.5",
        cwd: "/tmp",
        promptPreview: "p",
        startedAt: BASE,
        logPath: "/tmp/x.log",
        sessionId: "s",
        ...overrides,
    };
}

// Theme stub markers: <accent>…</>  (closing tag is bare </>)
const strip = (s) => String(s).replace(/<\/?[a-zA-Z][\w-]*>/g, "").replace(/<\/>/g, "");
const themeFg = (c, s) => `<${c}>${s}</>`;

// ---------------------------------------------------------------------------
// Row order + health facts
// ---------------------------------------------------------------------------
describe("navigator health row order", () => {
    // @covers navigator.health
    // @level unit
    it("keeps name/id first, model next, effort adjacent, then elapsed/tool/spend, status last", () => {
        const healthy = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const rows = buildNavigatorRows([
            meta({ effort: "high" }),
        ], {
            effectiveStatus: (m) => m.status,
            shortModel,
            fmtElapsed,
            now: NOW,
            spendFor: () => "1.2k tok · $0.01",
            toolFor: () => "bash",
            effortFor: (m) => m.effort,
            healthFor: () => healthy,
        });
        assert.equal(rows.length, 1);
        const r = rows[0];
        assert.equal(r.name, "reviewer");
        assert.equal(r.model, "grok-4.5");
        assert.equal(r.effort, "high");
        assert.equal(r.tool, "bash");
        assert.ok(r.spend.includes("tok"));
        assert.equal(r.status, "running");
        assert.deepEqual(r.healthFacts, [], "healthy is silent");

        const text = formatNavigatorRowText(r);
        // Explicit order: name, model+effort, elapsed, tool, spend, status.
        const nameIdx = text.indexOf("reviewer");
        const modelIdx = text.indexOf("grok-4.5");
        const effortIdx = text.indexOf("high");
        const toolIdx = text.indexOf("bash");
        const spendIdx = text.indexOf("1.2k");
        const statusIdx = text.lastIndexOf("running");
        assert.ok(nameIdx === 0 || nameIdx < modelIdx, text);
        assert.ok(modelIdx < effortIdx, `model before effort: ${text}`);
        assert.ok(effortIdx < toolIdx, `effort before tool: ${text}`);
        assert.ok(toolIdx < spendIdx, `tool before spend: ${text}`);
        assert.ok(spendIdx < statusIdx, `spend before status: ${text}`);
        assert.match(text, /^reviewer · grok-4\.5 high · .+ · bash · 1\.2k tok · \$0\.01 · running$/);
    });

    // @covers navigator.health
    // @level unit
    it("appends at most two compact health facts after status", () => {
        // Compacting + long tool + model error would be 3 in compactFacts, but
        // #66 already caps compactFacts at 2; still assert navigator cap.
        const degraded = obsFor(
            "running",
            emptyFacts({
                lastMeaningfulAt: NOW - 10_000,
                compacting: true,
                compactionStartedAt: NOW - 90_000,
                activeTools: [{ toolName: "bash", startedAt: NOW - 90_000 }],
                model: {
                    state: "error",
                    lastError: { message: "rate limit", at: NOW - 5_000 },
                    errorHistory: [{ message: "rate limit", at: NOW - 5_000 }],
                },
            }),
        );
        // Force extra facts through the navigator helper with a synthetic obs.
        const synthetic = {
            ...degraded,
            compactFacts: ["long compacting 1m", "long bash 1m", "model error", "extra"],
            tool: { state: "long_running", active: { toolName: "bash" } },
        };
        const facts = formatNavigatorHealthFacts(synthetic);
        assert.ok(facts.length <= 2, `cap 2, got ${facts.length}: ${facts.join(",")}`);
        assert.ok(!facts.includes("extra"));

        const rows = buildNavigatorRows([meta()], {
            effectiveStatus: () => "running",
            shortModel,
            fmtElapsed,
            now: NOW,
            spendFor: () => "",
            healthFor: () => synthetic,
        });
        const text = formatNavigatorRowText(rows[0]);
        const afterStatus = text.split(" · running · ")[1] ?? "";
        const trailing = afterStatus ? afterStatus.split(" · ") : [];
        assert.ok(trailing.length <= 2, `trailing facts ${trailing.length}: ${text}`);
        assert.ok(text.includes(" · running"), text);
        // Status precedes facts.
        const statusAt = text.indexOf(" · running");
        const factAt = text.indexOf(facts[0]);
        assert.ok(statusAt >= 0 && factAt > statusAt, text);
    });

    // @covers navigator.health
    // @level unit
    it("healthy/quiet rows avoid noisy health facts", () => {
        const healthy = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 5_000 }));
        const quiet = obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 45_000 }));
        // Short ordinary tool is not actionable (#67).
        const shortTool = obsFor(
            "running",
            emptyFacts({
                lastMeaningfulAt: NOW - 10_000,
                activeTools: [{ toolName: "bash", startedAt: NOW - 10_000 }],
            }),
        );
        assert.equal(isActionableHealth(healthy), false);
        assert.equal(isActionableHealth(quiet), false);
        assert.equal(isActionableHealth(shortTool), false);
        assert.deepEqual(formatNavigatorHealthFacts(healthy), []);
        assert.deepEqual(formatNavigatorHealthFacts(quiet), []);
        assert.deepEqual(formatNavigatorHealthFacts(shortTool), []);

        const lines = buildNavigatorLines(createNavigatorState(
            buildNavigatorRows([meta()], {
                effectiveStatus: () => "running",
                shortModel,
                fmtElapsed,
                now: NOW,
                spendFor: () => "",
                healthFor: () => healthy,
            }),
        ), { width: 120 });
        const row = strip(lines[3]);
        assert.ok(row.includes("running"));
        assert.ok(!/stale|compact|error|long /.test(row), row);
    });

    // @covers navigator.health
    // @level unit
    it("degraded rows show compact facts (compacting, long tool, model error, stale)", () => {
        const cases = [
            {
                label: "compacting",
                obs: obsFor("running", emptyFacts({
                    lastMeaningfulAt: NOW - 10_000,
                    compacting: true,
                    compactionStartedAt: NOW - 20_000,
                })),
                expect: /compacting/,
            },
            {
                label: "long tool",
                obs: obsFor("running", emptyFacts({
                    lastMeaningfulAt: NOW - 10_000,
                    activeTools: [{ toolName: "bash", startedAt: NOW - 90_000 }],
                })),
                expect: /long bash|bash/,
            },
            {
                label: "model error",
                obs: obsFor("running", emptyFacts({
                    lastMeaningfulAt: NOW - 10_000,
                    model: {
                        state: "error",
                        lastError: { message: "timeout", at: NOW - 2_000 },
                        errorHistory: [{ message: "timeout", at: NOW - 2_000 }],
                    },
                })),
                expect: /model error/,
            },
            {
                label: "stale",
                obs: obsFor("running", emptyFacts({ lastMeaningfulAt: NOW - 200_000 })),
                expect: /stale/,
            },
        ];
        for (const c of cases) {
            const facts = formatNavigatorHealthFacts(c.obs);
            assert.ok(facts.length > 0, `${c.label}: expected facts`);
            assert.ok(facts.length <= 2, `${c.label}: cap 2`);
            assert.ok(facts.some((f) => c.expect.test(f)), `${c.label}: ${facts.join(",")}`);
            const text = formatNavigatorRowText({
                id: "sa_x",
                name: "n",
                model: "m",
                elapsed: "1s",
                status: "running",
                healthFacts: facts,
            });
            assert.ok(text.endsWith(facts.join(" · ")) || text.includes(`running · ${facts[0]}`), text);
        }
    });
});

// ---------------------------------------------------------------------------
// Semantic status color + ANSI width safety
// ---------------------------------------------------------------------------
describe("navigator status colorization", () => {
    // @covers navigator.health
    // @level unit
    it("maps running/completed/failed/killed/orphaned/lost to semantic theme colors", () => {
        assert.equal(statusThemeColor("running"), "accent");
        assert.equal(statusThemeColor("completed"), "success");
        assert.equal(statusThemeColor("failed"), "danger");
        assert.equal(statusThemeColor("lost"), "danger");
        assert.equal(statusThemeColor("killed"), "warning");
        assert.equal(statusThemeColor("orphaned"), "warning");
        assert.equal(statusThemeColor("exited"), "dim");
    });

    // @covers navigator.health
    // @level unit
    it("colorizes status in overlay lines and stays visible-width safe", () => {
        const rows = [
            { id: "a", name: "alpha", status: "running", model: "m", elapsed: "1s", spend: "", healthFacts: [] },
            { id: "b", name: "beta", status: "failed", model: "m", elapsed: "2s", spend: "", healthFacts: ["stale"] },
            { id: "c", name: "gamma", status: "orphaned", model: "m", elapsed: "3s", spend: "", healthFacts: [] },
            { id: "d", name: "delta", status: "lost", model: "m", elapsed: "4s", spend: "", healthFacts: [] },
            { id: "e", name: "eps", status: "completed", model: "m", elapsed: "5s", spend: "", healthFacts: [] },
            { id: "f", name: "zeta", status: "killed", model: "m", elapsed: "6s", spend: "", healthFacts: [] },
        ];
        const state = createNavigatorState(rows);
        const lines = buildNavigatorLines(state, {
            width: 80,
            colorizeStatus: true,
            fg: themeFg,
        });
        // title + actions + spacer + 6 rows + spacer + bottom rail
        assert.equal(lines.length, 11);
        const plain = lines.map(strip);
        assert.ok(plain[3].includes("alpha · m · 1s · running"));
        assert.ok(plain[4].includes("beta · m · 2s · failed · stale"));
        // Color markers present on status tokens only.
        assert.ok(lines[3].includes("<accent>running</>"), lines[3]);
        assert.ok(lines[4].includes("<danger>failed</>"), lines[4]);
        assert.ok(lines[5].includes("<warning>orphaned</>"), lines[5]);
        assert.ok(lines[6].includes("<danger>lost</>"), lines[6]);
        assert.ok(lines[7].includes("<success>completed</>"), lines[7]);
        assert.ok(lines[8].includes("<warning>killed</>"), lines[8]);

        for (const w of [20, 37, 80]) {
            const narrow = buildNavigatorLines(state, {
                width: w,
                colorizeStatus: true,
                fg: themeFg,
            });
            for (const line of narrow) {
                assert.ok(visibleWidth(line) <= w, `vis ${visibleWidth(line)} > ${w}: ${line}`);
            }
        }
    });

    // @covers navigator.health
    // @level unit
    it("truncateToVisibleWidth preserves ANSI while limiting visible cells", () => {
        const colored = `hello · <danger>failed</> · stale`;
        assert.equal(visibleWidth(colored), visibleWidth(strip(colored)));
        const cut = truncateToVisibleWidth(colored, 12);
        assert.ok(visibleWidth(cut) <= 12, `${visibleWidth(cut)} ${cut}`);
        // Opening tag should still be present when truncation lands inside text after it.
        const mid = truncateToVisibleWidth(`pre · <warning>orphaned</> tail`, 20);
        assert.ok(visibleWidth(mid) <= 20);
    });

    // @covers navigator.health
    // @level unit
    it("overlay render keeps semantic status color on the selected row", () => {
        const tui = { requestRender() {} };
        const theme = { fg: themeFg };
        const done = () => {};
        // Signature: (rows, deps, tui, theme, done)
        const component = createNavigatorOverlayComponent(
            [{ id: "a", name: "alpha", status: "failed", model: "m", elapsed: "1s", spend: "", healthFacts: [] }],
            {
                matchKey: () => false,
                truncate: (s, w) => truncateToVisibleWidth(s, w),
            },
            tui,
            theme,
            done,
        );
        const lines = component.render(80);
        const row = lines[3];
        assert.ok(row.includes("<danger>failed</>"), row);
        // Selected marker is accent, but status keeps danger.
        assert.ok(row.includes("›") && row.includes("<danger>failed</>"), row);
        assert.ok(visibleWidth(row) <= 80);
        // List-mode render does not arm timers, but dispose is still the
        // required teardown contract for any overlay component instance.
        component.dispose();
    });
});

// ---------------------------------------------------------------------------
// Detail sections
// ---------------------------------------------------------------------------
describe("navigator detail health sections", () => {
    // @covers navigator.detail-health
    // @level unit
    it("detail shows status, model/effort, process, liveness, activity, compaction, tool, model, log, thresholds, callbacks", () => {
        const obs = obsFor(
            "orphaned",
            emptyFacts({
                lastMeaningfulAt: NOW - 15_000,
                compacting: true,
                compactionStartedAt: NOW - 40_000,
                activeTools: [{ toolName: "bash", startedAt: NOW - 90_000 }],
                model: {
                    state: "error",
                    lastError: { message: "net down", at: NOW - 3_000 },
                    errorHistory: [
                        { message: "net down", at: NOW - 3_000 },
                        { message: "earlier", at: NOW - 30_000 },
                    ],
                },
            }),
            {
                rawLog: { mtimeMs: NOW - 12_000, sizeBytes: 4096 },
                process: { supervised: false },
            },
        );
        const d = buildNavigatorDetail("sa_t69_1", {
            readMeta: () => meta({
                status: "orphaned",
                effort: "max",
                orphanedAt: NOW - 20_000,
                orphanedCallbackSentAt: NOW - 19_000,
            }),
            effectiveStatus: (m) => m.status,
            parseRun: () => ({
                finalText: "",
                lastActivity: "working…",
                toolCalls: ["read", "bash"],
                usage: { input: 10, output: 5, total: 15, costUSD: 0.01 },
            }),
            shortModel,
            fmtElapsed,
            fmtSpend,
            now: NOW,
            effortFor: (m) => m.effort,
            healthFor: () => obs,
        });
        assert.equal(d.status, "orphaned");
        assert.equal(d.effort, "max");
        assert.equal(d.pid, 4242);
        assert.equal(d.pgid, 4242);
        assert.ok(d.health);

        const lines = buildDetailLines(d, {
            width: 100,
            colorizeStatus: true,
            fg: themeFg,
        }).map(strip);
        const text = lines.join("\n");

        assert.ok(lines.some((l) => l.trimStart().startsWith("status") && l.includes("orphaned")), text);
        assert.ok(text.includes("model   grok-4.5 · effort max"), text);
        assert.ok(text.includes("process"), text);
        assert.ok(/pid 4242/.test(text) && /pgid 4242/.test(text), text);
        assert.ok(/liveness orphaned/.test(text), text);
        assert.ok(text.includes("activity"), text);
        assert.ok(text.includes("compaction"), text);
        assert.ok(/compacting/.test(text), text);
        assert.ok(text.includes("active tool"), text);
        // Compaction section is separate from active tool and model.
        const sectionIdx = (label) => lines.findIndex((l) => navigatorSectionLabel(l) === label);
        const compactIdx = sectionIdx("compaction");
        const toolIdx = sectionIdx("active tool");
        const modelIdx = sectionIdx("model");
        assert.ok(compactIdx > 0 && toolIdx > compactIdx && modelIdx > toolIdx, text);
        assert.ok(/long_running|bash/.test(text), text);
        assert.ok(/state error|model error|net down/.test(text), text);
        assert.ok(text.includes("log"), text);
        assert.ok(/last write/.test(text), text);
        assert.ok(text.includes("thresholds"), text);
        assert.ok(/quiet|stale|long-tool/.test(text), text);
        assert.ok(text.includes("callbacks"), text);
        assert.ok(/orphaned notified/.test(text), text);
        assert.ok(text.includes("output"), text);
        // Status color present before strip in raw lines.
        const raw = buildDetailLines(d, { width: 100, colorizeStatus: true, fg: themeFg });
        assert.ok(raw.some((l) => l.includes("<warning>orphaned</>")), raw.join("\n"));
    });

    // @covers navigator.detail-health
    // @level unit
    it("clearly separates compaction from active tool and model-call state", () => {
        const obs = obsFor(
            "running",
            emptyFacts({
                lastMeaningfulAt: NOW - 5_000,
                compacting: true,
                compactionStartedAt: NOW - 10_000,
                activeTools: [{ toolName: "read", startedAt: NOW - 5_000 }],
                model: { state: "retrying", errorHistory: [], retry: { attempt: 2, maxAttempts: 5 } },
            }),
        );
        const lines = buildDetailLines({
            id: "sa_x",
            name: "n",
            status: "running",
            model: "m",
            elapsed: "1s",
            tools: "read",
            currentTool: "read",
            spend: "",
            output: "hi",
            health: obs,
            now: NOW,
        }, { width: 80 }).map(strip);

        const idx = (label) => lines.findIndex((l) => navigatorSectionLabel(l) === label);
        assert.ok(idx("compaction") >= 0);
        assert.ok(idx("active tool") > idx("compaction"));
        assert.ok(idx("model") > idx("active tool"));
        // Compaction block does not mention tool/model state labels.
        const compactBlock = lines.slice(idx("compaction"), idx("active tool")).join("\n");
        assert.ok(/compacting/.test(compactBlock), compactBlock);
        assert.ok(!/retrying|read/.test(compactBlock), compactBlock);
        const toolBlock = lines.slice(idx("active tool"), idx("model")).join("\n");
        assert.ok(/read/.test(toolBlock), toolBlock);
        const modelBlock = lines.slice(idx("model"), idx("log")).join("\n");
        assert.ok(/retrying|retry/.test(modelBlock), modelBlock);
    });

    // @covers navigator.detail-health
    // @level unit
    it("legacy dead-running metadata does not pair status exited with liveness supervised", () => {
        // Production detail shows effectiveStatus(meta). Health observation must
        // use that same display status (#69): durable meta.status "running" with a
        // dead pid surfaces as "exited", which is terminal — never supervised.
        const eff = "exited";
        const obsFromEffective = obsFor(
            eff,
            emptyFacts({ lastMeaningfulAt: NOW - 5_000 }),
        );
        assert.equal(obsFromEffective.process.liveness, "terminal");
        assert.notEqual(obsFromEffective.process.liveness, "supervised");

        const d = buildNavigatorDetail("sa_t69_dead", {
            readMeta: () => meta({
                id: "sa_t69_dead",
                status: "running", // durable legacy
                pid: 999_999_999, // gone
            }),
            effectiveStatus: () => eff,
            parseRun: () => ({
                finalText: "done",
                lastActivity: "",
                toolCalls: [],
                usage: { input: 0, output: 0, total: 0, costUSD: 0 },
            }),
            shortModel,
            fmtElapsed,
            fmtSpend,
            now: NOW,
            // Same contract as index observeNavigatorHealth: observe with effective status.
            healthFor: () => obsFromEffective,
        });
        assert.equal(d.status, "exited");

        const text = buildDetailLines(d, { width: 100 }).map(strip).join("\n");
        assert.match(text, /status\s+exited/);
        assert.match(text, /liveness terminal/);
        assert.doesNotMatch(text, /liveness supervised/);

        // Defensive: even if a stale running observation leaks in, detail must not
        // render the incoherent pair the reviewer reproduced.
        const leakedRunningObs = obsFor(
            "running",
            emptyFacts({ lastMeaningfulAt: NOW - 5_000 }),
        );
        assert.equal(leakedRunningObs.process.liveness, "supervised");
        const leakedText = buildDetailLines({
            ...d,
            status: "exited",
            health: leakedRunningObs,
            now: NOW,
        }, { width: 100 }).map(strip).join("\n");
        assert.match(leakedText, /status\s+exited/);
        assert.doesNotMatch(leakedText, /liveness supervised/);
        assert.match(leakedText, /liveness terminal/);
    });

    // @covers navigator.detail-health
    // @level unit
    it("detail lines stay within width when status is colorized", () => {
        const d = {
            id: "sa_x",
            name: "n".repeat(40),
            status: "failed",
            model: "m".repeat(30),
            elapsed: "12s",
            tools: "t".repeat(40),
            spend: "s".repeat(40),
            output: "o".repeat(100),
            pid: 1,
            pgid: 1,
            health: obsFor("failed", emptyFacts({ lastMeaningfulAt: NOW - 5_000 })),
            now: NOW,
            orphanedCallbackSentAt: undefined,
            lostCallbackSentAt: NOW - 1_000,
        };
        for (const w of [20, 37, 80]) {
            for (const line of buildDetailLines(d, { width: w, colorizeStatus: true, fg: themeFg })) {
                assert.ok(visibleWidth(line) <= w, `w=${w} vis=${visibleWidth(line)} ${line}`);
            }
        }
    });
});
