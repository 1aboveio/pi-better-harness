/**
 * Pure helpers for subagent_spawn_batch.
 *
 * Planning, option merging, validation, and response formatting live here so
 * they are unit-testable without mocking the spawn seam. The batch tool in
 * index.ts calls these helpers and then reuses the same internal spawn path
 * as subagent_spawn so behavior cannot drift.
 */

import { BUILTIN_TOOLS } from "./extensions.mjs";
import { SAFE_CLEAN_TOOLS } from "./config.ts";

const VALID_CAPACITY_MODES = new Set(["reject", "launch-available"]);

/**
 * Overlay per-job options on top of shared options. Only defined keys are
 * inherited; booleans keep their false values.
 */
export function mergeJobOptions(shared, job) {
    return {
        prompt: job.prompt,
        name: job.name ?? shared?.name,
        model: job.model ?? shared?.model,
        tools: job.tools ?? shared?.tools,
        exclude_tools: job.exclude_tools ?? shared?.exclude_tools,
        clean: job.clean ?? shared?.clean,
        sandbox: job.sandbox ?? shared?.sandbox,
        sandbox_dir: job.sandbox_dir ?? shared?.sandbox_dir,
        callback: job.callback ?? shared?.callback,
        cwd: job.cwd ?? shared?.cwd,
        // Same semantics as subagent_spawn: shared and per-job values must reach
        // spawnSubagentRun so batch jobs can request disposable clone workspaces.
        git_clone_workspace: job.git_clone_workspace ?? shared?.git_clone_workspace,
        approve: job.approve ?? shared?.approve,
        allow_nested: job.allow_nested ?? shared?.allow_nested,
    };
}

/**
 * Validate a batch plan before any job is launched. Throws a clear error for
 * malformed input or invalid option combinations.
 */
export function validateBatchPlan({ shared, jobs, onCapacity, config }) {
    if (!Array.isArray(jobs)) {
        throw new Error("jobs must be an array.");
    }
    if (jobs.length === 0) {
        throw new Error("jobs must contain at least one job.");
    }

    if (onCapacity !== undefined && !VALID_CAPACITY_MODES.has(onCapacity)) {
        throw new Error(
            `onCapacity must be "reject" or "launch-available"; got ${JSON.stringify(onCapacity)}.`,
        );
    }

    const seenPrompts = new Set();
    for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        if (!job || typeof job !== "object") {
            throw new Error(`job ${i + 1} must be an object.`);
        }
        if (typeof job.prompt !== "string" || job.prompt.trim() === "") {
            throw new Error(`job ${i + 1} is missing a non-empty prompt.`);
        }
        if (seenPrompts.has(job.prompt)) {
            // Duplicate prompts are allowed, but a batch with every prompt
            // identical is a common mistake; warn via the error path only when
            // ALL prompts are the same (still launchable if intentional).
            if (i === jobs.length - 1 && seenPrompts.size === 1) {
                // Not a hard error; callers may choose to warn.
            }
        }
        seenPrompts.add(job.prompt);

        const merged = mergeJobOptions(shared, job);
        if (merged.clean === true) {
            // Validate the effective tool allowlist, which resolves in this order:
            // per-job tools → shared tools → config.defaultTools → clean-safe built-ins.
            // Note: we intentionally do NOT reject clean:true + allow_nested:true here;
            // single-spawn accepts that combination, so batch validation must match it exactly.
            const rawTools = merged.tools ?? config?.defaultTools ?? SAFE_CLEAN_TOOLS;
            const toolList = rawTools
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean);
            for (const tool of toolList) {
                if (!BUILTIN_TOOLS.includes(tool)) {
                    throw new Error(
                        `job ${i + 1} (${merged.name ?? i + 1}): clean:true with ` +
                            `extension-provided tool "${tool}" is invalid — the tool will not exist in a clean child.`,
                    );
                }
            }
        }
    }
}

/**
 * Assign a globally-unique display name to every job.
 *   - missing name -> job-{index}
 *   - duplicate name -> name-2, name-3, ... (skipping any already-used suffix)
 *
 * Suffixes are checked against the full set of assigned names so a raw name
 * like "reviewer-2" cannot collide with the suffix generated for "reviewer".
 */
export function assignBatchJobNames(jobs) {
    const used = new Set();
    const names = [];

    for (let i = 0; i < jobs.length; i++) {
        let raw = jobs[i]?.name ?? `${BATCH_JOB_NAME_DEFAULT}-${i + 1}`;
        let name = raw;
        if (used.has(name)) {
            let suffix = 2;
            name = `${raw}-${suffix}`;
            while (used.has(name)) {
                suffix += 1;
                name = `${raw}-${suffix}`;
            }
        }
        used.add(name);
        names.push(name);
    }

    return names;
}

export const BATCH_JOB_NAME_DEFAULT = "job";

let batchSeq = 0;
/** Generate a collision-free batch ID distinct from run IDs. */
export function nextBatchId() {
    batchSeq += 1;
    return `batch_${Date.now().toString(36)}_${batchSeq}`;
}

/**
 * Decide which jobs launch and which are skipped based on available capacity.
 *
 * Capacity = maxConcurrent - runningCount - pendingCount. pendingCount covers
 * in-process reservations held by concurrent single/batch spawns so a stale
 * snapshot cannot oversubscribe after an async yield.
 *
 *   onCapacity === "reject" (default): throw if the whole batch does not fit.
 *   onCapacity === "launch-available": launch up to the available slots.
 */
export function planBatchLaunches({
    jobs,
    runningCount,
    pendingCount = 0,
    maxConcurrent,
    onCapacity,
}) {
    const available = Math.max(0, maxConcurrent - runningCount - pendingCount);

    if (onCapacity === "launch-available") {
        const toLaunch = jobs.slice(0, available);
        const skipped = jobs.slice(available);
        return { toLaunch, skipped };
    }

    if (jobs.length > available) {
        throw new Error(
            `Batch of ${jobs.length} jobs exceeds available capacity ` +
                `(${available}/${maxConcurrent} subagent slots free). ` +
                "Stop some runs or set onCapacity to \"launch-available\".",
        );
    }

    return { toLaunch: jobs, skipped: [] };
}

/**
 * Format the launch response for subagent_spawn_batch.
 */
export function formatBatchLaunchResponse({ batchId, batchName, launched, skipped, failed }) {
    const lines = [];
    const label = batchName ? `${batchName} (${batchId})` : batchId;

    if (launched.length === 0) {
        const reason = skipped.length ? " — capacity full" : "";
        lines.push(`Batch ${label}: no jobs launched${reason}.`);
    } else {
        lines.push(
            `Batch ${label} launched ${launched.length} subagent(s):`,
        );
        for (const { name, id } of launched) {
            lines.push(`• ${name} → ${id}`);
        }
    }

    if (failed?.length) {
        lines.push(
            `Failed (${failed.length}): ${failed
                .map((f) => `${f.name}: ${f.reason}`)
                .join("; ")}`,
        );
    }

    if (skipped.length) {
        lines.push(
            `Skipped (capacity): ${skipped.map((j) => j.name).join(", ")}`,
        );
    }

    return lines.join("\n");
}
