// @covers subagent-list.filters
// @level unit
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    SUBAGENT_LIST_DEFAULT_LIMIT,
    SUBAGENT_LIST_MAX_LIMIT,
    buildSubagentList,
    listFolderScopeKey,
} from "../list.mjs";
import { isWithinWorkspace, normalizeWorkspacePath } from "../workspace-scope.ts";

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
        cwd: "/repo",
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
    it("defaults to the newest runs in the calling folder across foreground sessions, capped at the default limit", () => {
        const metas = [];
        for (let i = 0; i < 25; i++) {
            metas.push(meta(`sa_owned_${String(i).padStart(2, "0")}`, { startedAt: BASE + i }));
        }
        metas.push(meta("sa_peer_newest", { spawnPid: OTHER_PARENT, startedAt: BASE + 1000 }));
        metas.push(meta("sa_elsewhere_newest", { cwd: "/elsewhere", startedAt: BASE + 2000 }));

        const output = build(metas);
        const ids = rowIds(output);

        assert.equal(rowLines(output).length, SUBAGENT_LIST_DEFAULT_LIMIT);
        assert.equal(ids[0], "sa_peer_newest", "a run from another foreground in the same folder is a local peer");
        assert.equal(ids[1], "sa_owned_24");
        assert.ok(!ids.includes("sa_owned_15"));
        assert.ok(!ids.includes("sa_elsewhere_newest"));
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

    it("keeps all:true machine-global regardless of folder", () => {
        const metas = [
            meta("sa_owned_old", { startedAt: BASE + 1 }),
            meta("sa_elsewhere_new", { cwd: "/tmp", startedAt: BASE + 4 }),
            meta("sa_owned_new", { startedAt: BASE + 3 }),
            meta("sa_sibling_prefix", { cwd: "/repo-other", startedAt: BASE + 2 }),
        ];

        assert.deepEqual(rowIds(build(metas, { limit: 3 })), ["sa_owned_new", "sa_owned_old"]);
        assert.deepEqual(rowIds(build(metas, { all: true, limit: 3 })), ["sa_elsewhere_new", "sa_owned_new", "sa_sibling_prefix"]);
    });

    it("includes a nested workspace but not a sibling that shares the folder-name prefix", () => {
        const metas = [
            meta("sa_root", { startedAt: BASE + 4 }),
            meta("sa_nested", { cwd: "/repo/packages/app", startedAt: BASE + 3 }),
            meta("sa_sibling_prefix", { cwd: "/repo-other", startedAt: BASE + 2 }),
            meta("sa_parent_escape", { cwd: "/repo/../elsewhere", startedAt: BASE + 1 }),
        ];

        assert.deepEqual(rowIds(build(metas)), ["sa_root", "sa_nested"]);
    });

    it("excludes a record that names no workspace, but all:true still reports it", () => {
        const metas = [meta("sa_no_cwd", { cwd: undefined }), meta("sa_known", { startedAt: BASE + 1 })];

        assert.deepEqual(rowIds(build(metas)), ["sa_known"]);
        assert.deepEqual(rowIds(build(metas, { all: true })), ["sa_known", "sa_no_cwd"]);
    });

    it("keeps durable completed records that carry only a workspace (no origin or spawn pid)", () => {
        const archived = {
            ...meta("sa_archived", { startedAt: BASE + 2 }),
            spawnPid: undefined,
            callbackOrigin: undefined,
        };
        const output = build([archived, meta("sa_live", { startedAt: BASE + 1 })]);

        assert.deepEqual(rowIds(output), ["sa_archived", "sa_live"]);
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

    it("shows the conversation session id separately from the attempt id", () => {
        const run = meta("sa_format", {
            sessionId: "sa_original_conversation",
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
            "• reviewer sa_format  [completed]  session_id=sa_original_conversation  xai/grok-4.5  45s\n    hello world from prompt",
        );
        assert.doesNotMatch(output, /tok|\$/);
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

describe("workspace scope helper", () => {
    it("compares canonical directories, not string prefixes", () => {
        assert.equal(isWithinWorkspace("/repo", "/repo"), true);
        assert.equal(isWithinWorkspace("/repo/packages/app", "/repo"), true);
        assert.equal(isWithinWorkspace("/repo-other", "/repo"), false);
        assert.equal(isWithinWorkspace("/repo/../elsewhere", "/repo"), false);
        assert.equal(isWithinWorkspace("", "/repo"), false);
        assert.equal(isWithinWorkspace("/repo", ""), false);
    });

    it("resolves existing symlinked workspace directories through realpath", () => {
        const base = mkdtempSync(join(tmpdir(), "subagent-workspace-scope-"));
        try {
            const real = join(base, "real");
            mkdirSync(join(real, "nested"), { recursive: true });
            const link = join(base, "link");
            symlinkSync(real, link);

            assert.equal(normalizeWorkspacePath(link), normalizeWorkspacePath(real));
            assert.equal(isWithinWorkspace(link, real), true, "a symlink to the workspace is the workspace");
            assert.equal(isWithinWorkspace(join(link, "nested"), real), true);
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    it("binds a list cursor to the normalized folder, not to a spelling", () => {
        assert.equal(listFolderScopeKey(false, "/repo/"), listFolderScopeKey(false, "/repo/./"));
        assert.notEqual(listFolderScopeKey(false, "/repo"), listFolderScopeKey(false, "/repo-other"));
        assert.equal(listFolderScopeKey(true, "/repo"), "all");
        assert.equal(listFolderScopeKey(true, "/repo-other"), "all");
    });
});
