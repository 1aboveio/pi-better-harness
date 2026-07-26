// @covers subagent-spawn-batch.planning
// @level unit
// @covers subagent-spawn-batch.option-merge
// @level unit
// @covers subagent-spawn-batch.validation
// @level unit
// @covers subagent-spawn-batch.response-format
// @level unit
// @covers subagent-spawn-batch.names
// @level unit
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
    BATCH_JOB_NAME_DEFAULT,
    assignBatchJobNames,
    formatBatchLaunchResponse,
    mergeJobOptions,
    planBatchLaunches,
    validateBatchPlan,
} from "../batch.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexSource = readFileSync(resolve(__dirname, "..", "index.ts"), "utf8");

const CFG = {
    toolExtensions: { web_fetch: "npm:@juicesharp/rpiv-web-tools" },
    providerExtensions: { xai: "npm:pi-xai-oauth" },
};

describe("mergeJobOptions", () => {
    it("per-job options override shared options", () => {
        const shared = {
            model: "shared/model",
            tools: "read,bash",
            clean: false,
            sandbox: true,
            callback: true,
            cwd: "/shared",
            git_clone_workspace: true,
            approve: false,
            allow_nested: false,
            exclude_tools: "web_fetch",
            sandbox_dir: "/shared-sbx",
        };
        const job = {
            prompt: "do it",
            name: "job-a",
            model: "job/model",
            tools: "read,edit",
            clean: true,
            sandbox: false,
            callback: false,
            cwd: "/job",
            git_clone_workspace: false,
            approve: true,
            allow_nested: true,
            exclude_tools: "bash",
            sandbox_dir: "/job-sbx",
        };

        const merged = mergeJobOptions(shared, job);

        assert.equal(merged.prompt, "do it");
        assert.equal(merged.name, "job-a");
        assert.equal(merged.model, "job/model");
        assert.equal(merged.tools, "read,edit");
        assert.equal(merged.clean, true);
        assert.equal(merged.sandbox, false);
        assert.equal(merged.callback, false);
        assert.equal(merged.cwd, "/job");
        assert.equal(merged.git_clone_workspace, false, "per-job git_clone_workspace must override shared");
        assert.equal(merged.approve, true);
        assert.equal(merged.allow_nested, true);
        assert.equal(merged.exclude_tools, "bash");
        assert.equal(merged.sandbox_dir, "/job-sbx");
    });

    it("shared options fill in missing per-job values, preserving false booleans", () => {
        const shared = { sandbox: true, callback: false, clean: false, git_clone_workspace: true };
        const job = { prompt: "x" };

        const merged = mergeJobOptions(shared, job);

        assert.equal(merged.sandbox, true);
        assert.equal(merged.callback, false);
        assert.equal(merged.clean, false);
        assert.equal(merged.git_clone_workspace, true, "shared git_clone_workspace must forward when job omits it");
        assert.equal(merged.model, undefined);
    });

    it("a fully empty shared object leaves job values untouched", () => {
        const job = { prompt: "x", name: "n", sandbox: false, git_clone_workspace: true };
        const merged = mergeJobOptions({}, job);

        assert.equal(merged.prompt, "x");
        assert.equal(merged.name, "n");
        assert.equal(merged.sandbox, false);
        assert.equal(merged.git_clone_workspace, true, "per-job git_clone_workspace must survive empty shared");
        assert.equal(merged.model, undefined);
    });

    // @fails-without-fix subagent-spawn-batch.option-merge
    // @covers subagent-spawn-batch.option-merge
    // @level unit
    // Class: batch-clone-option-forwarding — shared + per-job must reach spawnSubagentRun.
    it("forwards git_clone_workspace from shared and per-job inputs (same-semantics contract)", () => {
        // Shared-only: job omits the field → shared true must appear on the merge result
        // that index.ts spreads into spawnSubagentRun.
        const fromShared = mergeJobOptions({ git_clone_workspace: true, sandbox: true }, { prompt: "shared-only" });
        assert.equal(fromShared.git_clone_workspace, true);
        assert.notEqual(
            fromShared.git_clone_workspace,
            undefined,
            "shared git_clone_workspace must not be dropped by mergeJobOptions",
        );

        // Per-job-only: empty shared → job true must appear.
        const fromJob = mergeJobOptions({}, { prompt: "job-only", git_clone_workspace: true });
        assert.equal(fromJob.git_clone_workspace, true);

        // Per-job false must override shared true (preserve false booleans).
        const overrideFalse = mergeJobOptions(
            { git_clone_workspace: true },
            { prompt: "override", git_clone_workspace: false },
        );
        assert.equal(overrideFalse.git_clone_workspace, false);

        // Neither set → undefined (spawn path treats as not requested).
        const neither = mergeJobOptions({ sandbox: true }, { prompt: "neither" });
        assert.equal(neither.git_clone_workspace, undefined);

        // Production merge must literally name the field (guards against a future
        // rewrite that spreads a whitelist without this key).
        const batchSource = readFileSync(resolve(__dirname, "..", "batch.mjs"), "utf8");
        assert.match(
            batchSource,
            /git_clone_workspace:\s*job\.git_clone_workspace\s*\?\?\s*shared\?\.git_clone_workspace/,
            "mergeJobOptions must forward git_clone_workspace from job ?? shared",
        );
    });
});

describe("validateBatchPlan", () => {
    it("accepts a valid one-job batch", () => {
        assert.doesNotThrow(() =>
            validateBatchPlan({ shared: {}, jobs: [{ prompt: "hello" }], config: CFG }),
        );
    });

    it("rejects an empty jobs array", () => {
        assert.throws(
            () => validateBatchPlan({ shared: {}, jobs: [], config: CFG }),
            /jobs must contain at least one job/,
        );
    });

    it("rejects non-array jobs", () => {
        assert.throws(
            () => validateBatchPlan({ shared: {}, jobs: "nope", config: CFG }),
            /jobs must be an array/,
        );
    });

    it("rejects a job with missing or empty prompt", () => {
        assert.throws(
            () => validateBatchPlan({ shared: {}, jobs: [{ prompt: "" }], config: CFG }),
            /job 1 is missing a non-empty prompt/,
        );
        assert.throws(
            () => validateBatchPlan({ shared: {}, jobs: [{}], config: CFG }),
            /job 1 is missing a non-empty prompt/,
        );
    });

    it("rejects an invalid onCapacity value", () => {
        assert.throws(
            () =>
                validateBatchPlan({
                    shared: {},
                    jobs: [{ prompt: "x" }],
                    onCapacity: "launch-all",
                    config: CFG,
                }),
            /onCapacity must be "reject" or "launch-available"/,
        );
    });

    it("accepts the two valid onCapacity values", () => {
        for (const mode of ["reject", "launch-available"]) {
            assert.doesNotThrow(() =>
                validateBatchPlan({
                    shared: {},
                    jobs: [{ prompt: "x" }],
                    onCapacity: mode,
                    config: CFG,
                }),
            );
        }
    });

    it("rejects clean:true with an extension-provided tool", () => {
        assert.throws(
            () =>
                validateBatchPlan({
                    shared: {},
                    jobs: [{ prompt: "x", clean: true, tools: "read,web_fetch" }],
                    config: CFG,
                }),
            /clean:true with extension-provided tool "web_fetch"/,
        );
    });

    it("rejects clean:true inherited from shared with a per-job extension tool", () => {
        assert.throws(
            () =>
                validateBatchPlan({
                    shared: { clean: true },
                    jobs: [{ prompt: "x", tools: "web_fetch" }],
                    config: CFG,
                }),
            /clean:true with extension-provided tool "web_fetch"/,
        );
    });

    it("allows clean:true with only built-in tools", () => {
        assert.doesNotThrow(() =>
            validateBatchPlan({
                shared: {},
                jobs: [{ prompt: "x", clean: true, tools: "read,bash" }],
                config: CFG,
            }),
        );
    });

    it("accepts clean:true with allow_nested:true to match single-spawn parity", () => {
        // Single-spawn does not reject this combination; batch must match.
        assert.doesNotThrow(() =>
            validateBatchPlan({
                shared: {},
                jobs: [{ prompt: "x", clean: true, allow_nested: true, tools: "read,bash" }],
                config: CFG,
            }),
        );
    });

    it("rejects clean:true when config.defaultTools contains an extension tool", () => {
        assert.throws(
            () =>
                validateBatchPlan({
                    shared: {},
                    jobs: [{ prompt: "x", clean: true }],
                    config: { ...CFG, defaultTools: "read,web_fetch" },
                }),
            /clean:true with extension-provided tool "web_fetch"/,
        );
    });

    it("accepts clean:true when config.defaultTools contains only built-ins", () => {
        assert.doesNotThrow(() =>
            validateBatchPlan({
                shared: {},
                jobs: [{ prompt: "x", clean: true }],
                config: { ...CFG, defaultTools: "read,bash" },
            }),
        );
    });
});

describe("assignBatchJobNames", () => {
    it("uses provided names unchanged when unique", () => {
        const jobs = [{ prompt: "a", name: "alpha" }, { prompt: "b", name: "beta" }];
        assert.deepEqual(assignBatchJobNames(jobs), ["alpha", "beta"]);
    });

    it("assigns default names to unnamed jobs", () => {
        const jobs = [{ prompt: "a" }, { prompt: "b" }];
        assert.deepEqual(assignBatchJobNames(jobs), [
            `${BATCH_JOB_NAME_DEFAULT}-1`,
            `${BATCH_JOB_NAME_DEFAULT}-2`,
        ]);
    });

    it("suffixes duplicate names predictably", () => {
        const jobs = [
            { prompt: "a", name: "reviewer" },
            { prompt: "b", name: "reviewer" },
            { prompt: "c", name: "reviewer" },
        ];
        assert.deepEqual(assignBatchJobNames(jobs), ["reviewer", "reviewer-2", "reviewer-3"]);
    });

    it("handles a mix of named and unnamed jobs", () => {
        const jobs = [{ prompt: "a" }, { prompt: "b", name: "reviewer" }, { prompt: "c" }];
        assert.deepEqual(assignBatchJobNames(jobs), [
            `${BATCH_JOB_NAME_DEFAULT}-1`,
            "reviewer",
            `${BATCH_JOB_NAME_DEFAULT}-3`,
        ]);
    });

    it("keeps generated suffixes globally unique even when raw names collide with suffixes", () => {
        const jobs = [
            { prompt: "a", name: "reviewer" },
            { prompt: "b", name: "reviewer" },
            { prompt: "c", name: "reviewer-2" },
        ];
        const names = assignBatchJobNames(jobs);
        assert.deepEqual(names, ["reviewer", "reviewer-2", "reviewer-2-2"]);
        const unique = new Set(names);
        assert.equal(unique.size, names.length);
    });
});

describe("planBatchLaunches", () => {
    it("launches all jobs when capacity is sufficient (default reject)", () => {
        const result = planBatchLaunches({
            jobs: [{ name: "a" }, { name: "b" }],
            runningCount: 1,
            maxConcurrent: 4,
            onCapacity: "reject",
        });

        assert.deepEqual(result.toLaunch, [{ name: "a" }, { name: "b" }]);
        assert.deepEqual(result.skipped, []);
    });

    it("rejects before launching when the batch exceeds capacity", () => {
        assert.throws(
            () =>
                planBatchLaunches({
                    jobs: [{ name: "a" }, { name: "b" }, { name: "c" }],
                    runningCount: 2,
                    maxConcurrent: 4,
                    onCapacity: "reject",
                }),
            /Batch of 3 jobs exceeds available capacity \(2\/4 subagent slots free\)/,
        );
    });

    it("launch-available launches up to the free slots", () => {
        const result = planBatchLaunches({
            jobs: [{ name: "a" }, { name: "b" }, { name: "c" }],
            runningCount: 2,
            maxConcurrent: 4,
            onCapacity: "launch-available",
        });

        assert.deepEqual(result.toLaunch, [{ name: "a" }, { name: "b" }]);
        assert.deepEqual(result.skipped, [{ name: "c" }]);
    });

    it("launch-available skips everything when capacity is full", () => {
        const result = planBatchLaunches({
            jobs: [{ name: "a" }],
            runningCount: 4,
            maxConcurrent: 4,
            onCapacity: "launch-available",
        });

        assert.deepEqual(result.toLaunch, []);
        assert.deepEqual(result.skipped, [{ name: "a" }]);
    });

    it("treats unspecified onCapacity as reject", () => {
        assert.throws(
            () =>
                planBatchLaunches({
                    jobs: [{ name: "a" }, { name: "b" }],
                    runningCount: 3,
                    maxConcurrent: 4,
                }),
            /Batch of 2 jobs exceeds available capacity \(1\/4 subagent slots free\)/,
        );
    });

    it("subtracts pending reservations from available capacity", () => {
        assert.throws(
            () =>
                planBatchLaunches({
                    jobs: [{ name: "a" }, { name: "b" }],
                    runningCount: 0,
                    pendingCount: 1,
                    maxConcurrent: 2,
                    onCapacity: "reject",
                }),
            /Batch of 2 jobs exceeds available capacity \(1\/2 subagent slots free\)/,
        );

        const partial = planBatchLaunches({
            jobs: [{ name: "a" }, { name: "b" }, { name: "c" }],
            runningCount: 0,
            pendingCount: 1,
            maxConcurrent: 3,
            onCapacity: "launch-available",
        });
        assert.deepEqual(partial.toLaunch, [{ name: "a" }, { name: "b" }]);
        assert.deepEqual(partial.skipped, [{ name: "c" }]);
    });
});

describe("formatBatchLaunchResponse", () => {
    it("formats a fully launched batch with batchName", () => {
        const text = formatBatchLaunchResponse({
            batchId: "batch_abc123",
            batchName: "reviewers",
            launched: [
                { name: "alice", id: "sa_1" },
                { name: "bob", id: "sa_2" },
            ],
            skipped: [],
        });

        assert.match(text, /Batch reviewers \(batch_abc123\) launched 2 subagent\(s\):/);
        assert.match(text, /• alice → sa_1/);
        assert.match(text, /• bob → sa_2/);
        assert.ok(!text.includes("Skipped"));
    });

    it("formats a partial launch with skipped jobs", () => {
        const text = formatBatchLaunchResponse({
            batchId: "batch_xyz",
            launched: [{ name: "alice", id: "sa_1" }],
            skipped: [{ name: "bob" }, { name: "carol" }],
        });

        assert.match(text, /Batch batch_xyz launched 1 subagent\(s\):/);
        assert.match(text, /• alice → sa_1/);
        assert.match(text, /Skipped \(capacity\): bob, carol/);
    });

    it("formats the zero-launched case clearly", () => {
        const text = formatBatchLaunchResponse({
            batchId: "batch_empty",
            launched: [],
            skipped: [{ name: "only" }],
        });

        assert.equal(text, "Batch batch_empty: no jobs launched — capacity full.\nSkipped (capacity): only");
    });

    it("formats a launch with failed jobs", () => {
        const text = formatBatchLaunchResponse({
            batchId: "batch_fail",
            launched: [{ name: "alice", id: "sa_1" }],
            skipped: [{ name: "carol" }],
            failed: [{ name: "bob", reason: "spawn exited with status 1" }],
        });

        assert.match(text, /Batch batch_fail launched 1 subagent\(s\):/);
        assert.match(text, /• alice → sa_1/);
        assert.match(text, /Failed \(1\): bob: spawn exited with status 1/);
        assert.match(text, /Skipped \(capacity\): carol/);
    });
});

describe("index.ts batch wiring", () => {
    // @covers subagent-spawn-batch.tool-registration
    // @level unit
    it("registers the subagent_spawn_batch tool", () => {
        assert.ok(
            indexSource.includes('name: "subagent_spawn_batch"'),
            "index.ts must register subagent_spawn_batch",
        );
    });

    // @covers subagent-spawn-batch.shared-helper
    // @level unit
    it("uses a shared internal spawnSubagentRun helper for both tools", () => {
        assert.ok(
            indexSource.includes("async function spawnSubagentRun"),
            "index.ts must define a shared spawnSubagentRun helper",
        );
        assert.ok(
            indexSource.includes("await spawnSubagentRun(ctx, p)"),
            "subagent_spawn must call the shared helper",
        );
        assert.ok(
            indexSource.includes("await spawnSubagentRun(ctx, { ...merged, name }"),
            "subagent_spawn_batch must call the shared helper per job",
        );
    });

    // @covers subagent-spawn-batch.planning
    // @level unit
    it("imports and uses batch planning helpers", () => {
        assert.ok(indexSource.includes("validateBatchPlan"), "index.ts must validate the batch plan");
        assert.ok(indexSource.includes("planBatchLaunches"), "index.ts must plan launches against capacity");
        assert.ok(indexSource.includes("assignBatchJobNames"), "index.ts must assign job names");
        assert.ok(indexSource.includes("mergeJobOptions"), "index.ts must merge shared/per-job options");
        assert.ok(indexSource.includes("formatBatchLaunchResponse"), "index.ts must format the batch response");
    });

    // @covers subagent-spawn-batch.metadata
    // @level unit
    it("passes batchId and batchName into spawnSubagentRun so metadata is recorded", () => {
        assert.ok(
            indexSource.includes("{ batchId, batchName: p.batchName }"),
            "batch info must be passed to each spawn",
        );
    });

    // @covers subagent-spawn-batch.nesting-control
    // @level unit
    it("includes subagent_spawn_batch in the child nesting denylist", () => {
        // Parse the SUBAGENT_TOOLS array specifically so removing the batch tool
        // from that set fails even if the tool name still appears elsewhere.
        const match = indexSource.match(/const SUBAGENT_TOOLS\s*=\s*\[([\s\S]*?)\];/);
        assert.ok(match, "index.ts must declare SUBAGENT_TOOLS");
        const members = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
        assert.ok(
            members.includes("subagent_spawn_batch"),
            "SUBAGENT_TOOLS must include the batch tool so child recursion boundaries stay coherent",
        );
        assert.ok(
            members.includes("subagent_spawn"),
            "SUBAGENT_TOOLS must still include subagent_spawn",
        );
    });

    // @covers subagent-spawn-batch.capacity-admission
    // @level unit
    it("reject mode reserves whole-batch capacity on the shared gate", () => {
        // Class invariant: reject mode holds all slots before any job launches so
        // an interleaved single-spawn cannot oversubscribe after job 1 yields.
        const executeMatch = indexSource.match(
            /name:\s*"subagent_spawn_batch"[\s\S]*?async execute[\s\S]*?(?=\/\/ ---- (?:subagent_list|model-facing))/
        );
        assert.ok(executeMatch, "must locate subagent_spawn_batch.execute");
        const body = executeMatch[0];
        assert.ok(
            body.includes("getSharedCapacityGate"),
            "batch path must use the shared capacity gate",
        );
        assert.match(
            body,
            /tryReserve\(\s*p\.jobs\.length\s*,\s*maxConcurrent\s*\)/,
            "reject mode must reserve the whole batch atomically",
        );
        assert.match(
            body,
            /launchAvailable[\s\S]*tryReserve\(\s*1\s*,\s*maxConcurrent\s*\)/,
            "launch-available must reserve one slot per job",
        );
        assert.match(
            body,
            /not launched due to earlier job failure in reject mode/,
            "reject-mode launch failure must account for later jobs explicitly",
        );
    });

    // @covers subagent-spawn-batch.capacity-admission
    // @level unit
    it("single-spawn path reserves on the same shared capacity gate", () => {
        const spawnMatch = indexSource.match(
            /name:\s*"subagent_spawn"[\s\S]*?async execute[\s\S]*?(?=\/\/ ---- subagent_spawn_batch)/,
        );
        assert.ok(spawnMatch, "must locate subagent_spawn.execute");
        const body = spawnMatch[0];
        assert.ok(
            body.includes("getSharedCapacityGate"),
            "single-spawn must share the capacity gate with batch",
        );
        assert.match(
            body,
            /tryReserve\(\s*1\s*,\s*maxConcurrent\s*\)/,
            "single-spawn must reserve one slot before launch",
        );
        assert.match(body, /gate\.commit\(\s*1\s*\)/, "single-spawn must commit after launch");
        assert.match(body, /gate\.release\(\s*1\s*\)/, "single-spawn must release on failure");
    });
});
