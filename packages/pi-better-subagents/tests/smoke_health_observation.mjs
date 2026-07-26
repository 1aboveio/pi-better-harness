/**
 * Runtime smoke for issue #66 health observation seam.
 * Exercises real filesystem log + pure observation against #64 fixture content.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    extractChildEventFactsFromLog,
    observeRunHealth,
    DEFAULT_HEALTH_THRESHOLDS,
} from "../health-observation.ts";
import { logPathFor, runDir } from "../registry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "docs/evidence/issue-64/fixtures/tool-start-end.ndjson");
const id = `sa_smoke66_${process.pid}_${Date.now()}`;
const now = Date.now();

const results = { surface: "health.observation", status: "fail", detail: "" };

try {
    mkdirSync(runDir(id), { recursive: true });
    const body = readFileSync(FIX, "utf-8");
    writeFileSync(logPathFor(id), "Warning: noise banner\n" + body, "utf-8");
    const sec = Math.floor(now / 1000);
    utimesSync(logPathFor(id), sec, sec);

    const { facts, rawLog } = extractChildEventFactsFromLog(id, { now });
    assert.ok(facts.lastMeaningfulAt !== undefined, "parsed meaningful activity");
    assert.ok((rawLog.sizeBytes ?? 0) > 0, "raw log size diagnostic");

    const obs = observeRunHealth({
        status: "running",
        now,
        facts,
        rawLog,
        thresholds: DEFAULT_HEALTH_THRESHOLDS,
        process: { supervised: true },
        startedAt: now - 60_000,
    });
    assert.equal(obs.status, "running");
    assert.ok(["healthy", "quiet", "stale"].includes(obs.activity));
    assert.equal(obs.model.longModelCall, undefined);
    assert.ok(obs.rawLog.sizeBytes > 0);

    // Open-tool residual: append an unmatched start and ensure not stale.
    writeFileSync(
        logPathFor(id),
        body + "\n" + JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "call_smoke",
            toolName: "bash",
            at: now - 5_000,
        }) + "\n",
        "utf-8",
    );
    const open = extractChildEventFactsFromLog(id, { now });
    const openObs = observeRunHealth({
        status: "orphaned",
        now,
        facts: open.facts,
        rawLog: open.rawLog,
        thresholds: { quietMs: 1_000, staleMs: 2_000, longToolMs: 60_000, longCompactionMs: 60_000 },
        process: { supervised: false },
    });
    assert.equal(openObs.process.liveness, "orphaned");
    assert.equal(openObs.tool.state, "running");
    assert.notEqual(openObs.activity, "stale");

    results.status = "pass";
    results.detail = `meaningfulAt=${facts.lastMeaningfulAt}; activity=${obs.activity}; openTool=${openObs.tool.active?.toolName}; orphanedLiveness=${openObs.process.liveness}`;
    console.log("SMOKE PASS", results.detail);
} catch (err) {
    results.status = "fail";
    results.detail = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error("SMOKE FAIL", results.detail);
    process.exitCode = 1;
} finally {
    try { rmSync(runDir(id), { recursive: true, force: true }); } catch { /* */ }
    const out = {
        generatedAt: new Date().toISOString(),
        // checklist parser accepts top-level array or `{ results: [...] }`
        results: [
            {
                surface: "health.observation",
                status: results.status,
                command: "node --experimental-strip-types tests/smoke_health_observation.mjs",
                detail: results.detail,
            },
            {
                surface: "health.event-facts",
                status: results.status,
                command: "node --experimental-strip-types tests/smoke_health_observation.mjs",
                detail: results.detail,
            },
        ],
    };
    const dest = join(ROOT, "docs/tests/_generated/runtime-smoke-results-66.json");
    writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
    console.log("wrote", dest);
}
