/**
 * Runtime smoke for orphaned/lost callbacks + diagnostic results (issue #65).
 *
 * Exercises pure delivery/result formatters against the real modules the
 * extension loads, plus a durable meta.json round-trip of the callback markers
 * that survive reloads. Does not spawn OS processes (the #63 smoke already
 * proves real-process orphaned/lost transitions).
 *
 *   node tests/smoke_health_callback.mjs [--json docs/tests/_generated/runtime-smoke-results-65.json]
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    formatHealthCallbackTrigger,
    buildHealthCallbackDelivery,
} from "../completion.mjs";
import { formatOrphanedResult, formatLostResult } from "../lifecycle.ts";
import { writeMeta, readMeta, nextRunId, runDir, baseDir } from "../registry.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const jsonIdx = args.indexOf("--json");
const outPath = jsonIdx >= 0
    ? args[jsonIdx + 1]
    : join(ROOT, "..", "docs/tests/_generated/runtime-smoke-results-65.json");

const steps = [];
function record(name, status, detail = "") {
    steps.push({ name, status, detail });
    const mark = status === "pass" ? "PASS" : "FAIL";
    console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function must(name, cond, detail = "") {
    if (cond) record(name, "pass", detail);
    else record(name, "fail", detail || "assertion failed");
}

const sampleRun = {
    finalText: "smoke partial progress",
    lastActivity: "smoke partial progress",
    toolCalls: ["bash"],
    unmatchedToolCalls: [],
    sawEnd: false,
    usage: { input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 },
};

try {
    // 1. Orphaned attention wording + tools.
    const orphanedTrig = formatHealthCallbackTrigger({
        id: "sa_smoke_o", label: "smoke (sa_smoke_o)", status: "orphaned",
    });
    must(
        "orphaned callback wording",
        /ATTENTION/i.test(orphanedTrig)
            && /supervision/i.test(orphanedTrig)
            && /may still be alive/i.test(orphanedTrig)
            && orphanedTrig.includes('subagent_result id="sa_smoke_o"')
            && orphanedTrig.includes('subagent_output id="sa_smoke_o"')
            && orphanedTrig.includes('subagent_stop id="sa_smoke_o"')
            && /wait/i.test(orphanedTrig) && /retry/i.test(orphanedTrig),
        orphanedTrig.slice(0, 120),
    );

    // 2. Lost attention wording.
    const lostTrig = formatHealthCallbackTrigger({
        id: "sa_smoke_l", label: "smoke (sa_smoke_l)", status: "lost",
    });
    must(
        "lost callback wording",
        /ATTENTION/i.test(lostTrig)
            && /no related process remains/i.test(lostTrig)
            && /no coherent terminal/i.test(lostTrig)
            && !/may still be alive/i.test(lostTrig),
        lostTrig.slice(0, 120),
    );

    // 3. Delivery options + callback:false suppression.
    const dTrue = buildHealthCallbackDelivery({
        id: "sa_smoke_d", label: "d", status: "orphaned", callback: true,
    });
    must(
        "callback:true non-interrupting delivery",
        dTrue
            && dTrue.options.deliverAs === "followUp"
            && dTrue.options.triggerTurn === true,
        JSON.stringify(dTrue?.options),
    );
    const dFalse = buildHealthCallbackDelivery({
        id: "sa_smoke_d", label: "d", status: "lost", callback: false,
    });
    must("callback:false suppresses model delivery", dFalse === null);

    // 4. Result diagnostics.
    const orphanedBody = formatOrphanedResult(sampleRun, "RAW_ORPHAN");
    must(
        "orphaned result diagnostic + best-current artifacts",
        /orphaned/i.test(orphanedBody)
            && /best-current parsed output/i.test(orphanedBody)
            && orphanedBody.includes("smoke partial progress")
            && orphanedBody.includes("RAW_ORPHAN"),
    );
    const lostBody = formatLostResult(sampleRun, "RAW_LOST");
    must(
        "lost result diagnostic + best-available artifacts",
        /lost/i.test(lostBody)
            && /best-available/i.test(lostBody)
            && lostBody.includes("smoke partial progress")
            && lostBody.includes("RAW_LOST"),
    );

    // 5. Durable callback markers round-trip through meta.json.
    const id = nextRunId();
    const metaPath = runDir(id);
    try {
        writeMeta({
            id,
            status: "orphaned",
            pid: 1,
            spawnPid: process.pid,
            cwd: process.cwd(),
            promptPreview: "smoke",
            startedAt: Date.now(),
            logPath: join(metaPath, "output.log"),
            sessionId: id,
            orphanedAt: Date.now(),
            orphanedCallbackSentAt: 1_700_000_000_000,
        });
        const back = readMeta(id);
        must(
            "orphanedCallbackSentAt survives meta.json reload",
            back?.orphanedCallbackSentAt === 1_700_000_000_000,
            `got ${back?.orphanedCallbackSentAt}`,
        );
        writeMeta({
            ...back,
            status: "lost",
            lostAt: Date.now(),
            endedAt: Date.now(),
            lostCallbackSentAt: 1_700_000_000_001,
        });
        const lostBack = readMeta(id);
        must(
            "lostCallbackSentAt survives meta.json reload",
            lostBack?.lostCallbackSentAt === 1_700_000_000_001
                && lostBack?.orphanedCallbackSentAt === 1_700_000_000_000,
            `got lost=${lostBack?.lostCallbackSentAt} orphaned=${lostBack?.orphanedCallbackSentAt}`,
        );
    } finally {
        rmSync(metaPath, { recursive: true, force: true });
    }
} catch (err) {
    record("smoke threw", "fail", err instanceof Error ? err.message : String(err));
}

const failed = steps.filter((s) => s.status === "fail").length;
const status = failed === 0 ? "pass" : "fail";
const ranAt = new Date().toISOString();
const command = "node --experimental-strip-types tests/smoke_health_callback.mjs";
// Array shape expected by coverage-checklist.mjs --smoke (smoke.results || array).
const payload = {
    results: [
        {
            surface: "subagent.health-callback",
            command,
            ranAt,
            status,
            steps: steps.filter((s) => /callback|delivery|marker|Callback/i.test(s.name)),
        },
        {
            surface: "subagent.result",
            command,
            ranAt,
            status,
            steps: steps.filter((s) => /result diagnostic|artifacts/i.test(s.name)),
        },
    ],
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
console.log(failed === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failed})`);
console.log(`wrote ${outPath}`);
// Keep baseDir reference so the import is used if tree-shaken readers care.
void baseDir;
process.exit(failed === 0 ? 0 : 1);
