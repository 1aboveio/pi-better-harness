#!/usr/bin/env node
/**
 * Issue #312 AC13 — deterministic model-facing payload baseline.
 *
 * Usage:
 *   node --import tsx scripts/issue-312-payload-baseline.mjs
 *   node --import tsx scripts/issue-312-payload-baseline.mjs --phase after \
 *     --json-out docs/issue-312-payload-baseline-after.json \
 *     --md-out docs/issue-312-payload-baseline-after.md
 *
 * Isolates TMPDIR, freezes Date.now, seeds synthetic runs/tasks, then
 * measures registered-tool `content` and callback sendMessage payloads as
 * UTF-8 bytes. Does not call a model.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isolateHarnessEnv } from "./issue-312-payload-baseline/isolate.mjs";

function arg(flag, fallback) {
    const index = process.argv.indexOf(flag);
    if (index === -1) return fallback;
    return process.argv[index + 1] ?? fallback;
}

function gitInfo() {
    const run = (command) => execSync(command, { encoding: "utf8" }).trim();
    return {
        branch: run("git rev-parse --abbrev-ref HEAD"),
        sha: run("git rev-parse HEAD"),
        dirty: run("git status --porcelain") !== "",
    };
}

function modelInfo() {
    return {
        id: `${process.env.PI_PROVIDER ?? "unknown"}/${process.env.PI_MODEL ?? "unknown"}`,
        effort: process.env.PI_REASONING_LEVEL ?? "unknown",
        expected: "xai/grok-4.6 high",
    };
}

const phase = arg("--phase", "before");
const jsonOut = arg("--json-out");
const mdOut = arg("--md-out");
const env = isolateHarnessEnv({ stable: true });

try {
    const { collectBaseline, serializeReport, renderMarkdown } = await import("./issue-312-payload-baseline/run.mjs");
    const report = await collectBaseline({ phase });
    const serializable = serializeReport(report, {
        git: gitInfo(),
        measuredAt: new Date(env.wallClockMs()).toISOString(),
        model: modelInfo(),
    });

    const summary = serializable.cases
        .map((item) => `${String(item.utf8Bytes).padStart(8)} B  ${item.id}`)
        .join("\n");
    process.stdout.write(
        `issue-312 payload baseline (${phase})  cases=${serializable.cases.length}\n${summary}\n`,
    );

    if (jsonOut) {
        const path = resolve(jsonOut);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${JSON.stringify(serializable, null, 2)}\n`);
        process.stdout.write(`wrote ${path}\n`);
    }
    if (mdOut) {
        const path = resolve(mdOut);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, `${renderMarkdown(serializable)}\n`);
        process.stdout.write(`wrote ${path}\n`);
    }
} finally {
    env.restore();
}
