// @covers subagent-list.filters
// @level unit
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    SUBAGENT_LIST_DEFAULT_LIMIT,
    SUBAGENT_LIST_MAX_LIMIT,
    buildSubagentList,
} from "../list.mjs";

const PARENT = 41001;
const OTHER_PARENT = 41002;
const BASE = 1_700_000_000_000;

function meta(id, overrides = {}) {
    return {
        id,
        status: "completed",
        pid: 9000,
        spawnPid: PARENT,
        model: "xai/grok-4.5",
        cwd: "/repo",
        promptPreview: `prompt for ${id}`,
        startedAt: BASE,
        endedAt: BASE + 45_000,
        logPath: `/tmp/${id}.log`,
        sessionId: id,
        ...overrides,
    };
}

function build(metas, params = {}, extra = {}) {
    return buildSubagentList({
        metas,
        params,
        parentPid: PARENT,
        now: BASE + 60_000,
        usageById: () => ({ input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 }),
        ...extra,
    });
}

function rowLines(output) {
    return output.split("\n").filter((line) => line.startsWith("• "));
}

function rowIds(output) {
    return rowLines(output).map((line) => line.match(/(sa_[a-z0-9_]+)/)?.[1]);
}

describe("subagent_list helper", () => {
    it("defaults to current-parent runs, newest first, capped at 20 rows", () => {
        const metas = [];
        for (let i = 0; i < 25; i++) {
            metas.push(meta(`sa_owned_${String(i).padStart(2, "0")}`, { startedAt: BASE + i }));
        }
        metas.push(meta("sa_foreign_newest", { spawnPid: OTHER_PARENT, startedAt: BASE + 1000 }));

        const output = build(metas);
        const ids = rowIds(output);

        assert.equal(rowLines(output).length, SUBAGENT_LIST_DEFAULT_LIMIT);
        assert.equal(ids[0], "sa_owned_24");
        assert.equal(ids.at(-1), "sa_owned_05");
        assert.ok(!ids.includes("sa_owned_04"));
        assert.ok(!ids.includes("sa_foreign_newest"));
    });

    it("honors an explicit limit", () => {
        const metas = Array.from({ length: 5 }, (_, i) => meta(`sa_limit_${i}`, { startedAt: BASE + i }));
        const output = build(metas, { limit: 3 });

        assert.deepEqual(rowIds(output), ["sa_limit_4", "sa_limit_3", "sa_limit_2"]);
        assert.equal(rowLines(output).length, 3);
    });

    it("clamps overlarge limits to the documented maximum", () => {
        const metas = Array.from({ length: SUBAGENT_LIST_MAX_LIMIT + 5 }, (_, i) => meta(`sa_max_${i}`, { startedAt: BASE + i }));
        const output = build(metas, { limit: 250 });

        assert.equal(rowLines(output).length, SUBAGENT_LIST_MAX_LIMIT);
        assert.ok(output.includes(`Requested limit 250 exceeds maximum ${SUBAGENT_LIST_MAX_LIMIT}; using ${SUBAGENT_LIST_MAX_LIMIT}.`));
        assert.ok(output.includes(`Showing ${SUBAGENT_LIST_MAX_LIMIT} of ${SUBAGENT_LIST_MAX_LIMIT + 5} matching subagent runs`));
    });

    it("keeps all:true machine-global scope while still respecting limit", () => {
        const metas = [
            meta("sa_owned_old", { startedAt: BASE + 1 }),
            meta("sa_foreign_new", { spawnPid: OTHER_PARENT, startedAt: BASE + 4 }),
            meta("sa_owned_new", { startedAt: BASE + 3 }),
            meta("sa_foreign_mid", { spawnPid: OTHER_PARENT, startedAt: BASE + 2 }),
        ];

        assert.deepEqual(rowIds(build(metas, { limit: 3 })), ["sa_owned_new", "sa_owned_old"]);
        assert.deepEqual(rowIds(build(metas, { all: true, limit: 3 })), ["sa_foreign_new", "sa_owned_new", "sa_foreign_mid"]);
    });

    it("filters by effective status, including transient exited", () => {
        const metas = [
            meta("sa_running", { status: "running", startedAt: BASE + 1 }),
            meta("sa_completed", { status: "completed", startedAt: BASE + 2 }),
            meta("sa_failed", { status: "failed", startedAt: BASE + 3 }),
            meta("sa_killed", { status: "killed", startedAt: BASE + 4 }),
            meta("sa_dead", { status: "running", startedAt: BASE + 5 }),
        ];
        const statusOf = (m) => m.id === "sa_dead" ? "exited" : m.status;

        const output = build(metas, { status: ["running", "completed", "failed", "killed", "exited"] }, { statusOf });

        assert.deepEqual(rowIds(output), ["sa_dead", "sa_killed", "sa_failed", "sa_completed", "sa_running"]);
        for (const status of ["[exited]", "[killed]", "[failed]", "[completed]", "[running]"]) {
            assert.ok(output.includes(status), `expected ${status} in output:\n${output}`);
        }
    });

    it("can narrow status filters to selected effective statuses", () => {
        const metas = [
            meta("sa_running", { status: "running", startedAt: BASE + 1 }),
            meta("sa_completed", { status: "completed", startedAt: BASE + 2 }),
            meta("sa_failed", { status: "failed", startedAt: BASE + 3 }),
            meta("sa_dead", { status: "running", startedAt: BASE + 4 }),
        ];
        const statusOf = (m) => m.id === "sa_dead" ? "exited" : m.status;

        const output = build(metas, { status: ["failed", "exited"] }, { statusOf });

        assert.deepEqual(rowIds(output), ["sa_dead", "sa_failed"]);
        assert.ok(!output.includes("sa_running"));
        assert.ok(!output.includes("sa_completed"));
    });

    it("includes a truncation summary when matching runs exceed the displayed limit", () => {
        const metas = Array.from({ length: 5 }, (_, i) => meta(`sa_trunc_${i}`, { startedAt: BASE + i }));
        const output = build(metas, { limit: 2 });

        assert.equal(rowLines(output).length, 2);
        assert.ok(output.includes("Showing 2 of 5 matching subagent runs (limit 2)."));
    });

    it("returns a clear message for empty filtered results", () => {
        const output = build([meta("sa_done", { status: "completed" })], { status: ["failed"] });

        assert.equal(output, "No subagent runs match filters.");
    });

    it("preserves the existing run row format", () => {
        const run = meta("sa_format", {
            name: "reviewer",
            model: "xai/grok-4.5",
            promptPreview: "hello   world\nfrom prompt",
            status: "completed",
            startedAt: BASE,
            endedAt: BASE + 45_000,
        });
        const output = build([run], {}, {
            usageById: () => ({ input: 400, output: 800, cacheRead: 0, costUSD: 0.0034, total: 1200 }),
        });

        assert.equal(
            output,
            "• reviewer sa_format  [completed]  xai/grok-4.5  45s · 1.2k tok (↑400 ↓800) · $0.0034\n    hello world from prompt",
        );
    });

    it("includes batch name and id for batch-launched runs only", () => {
        const batchRun = meta("sa_batch", {
            name: "job-1",
            batchId: "batch_abc123",
            batchName: "reviewers",
            status: "running",
            startedAt: BASE,
        });
        const plainRun = meta("sa_plain", {
            name: "solo",
            status: "running",
            startedAt: BASE + 1,
        });

        const output = build([batchRun, plainRun], {}, {
            usageById: () => ({ input: 0, output: 0, cacheRead: 0, costUSD: 0, total: 0 }),
            statusOf: (m) => m.status,
        });

        assert.ok(output.includes("[batch: reviewers batch_abc123]"), output);
        assert.equal(
            (output.match(/\[batch:/g) ?? []).length,
            1,
            "only batch-launched rows should carry batch info",
        );
    });
});
