import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignmentFor, createAssignmentProjector } from "../assignment-projection.mjs";
import { buildNavigatorRows } from "../navigator.mjs";
import { collectSubagentActivity } from "../../pi-better-goal/src/subagents.ts";

test("UI refreshes share lineage reads and a later refresh sees external changes", () => {
    const root = fs.mkdtempSync(join(tmpdir(), "projection-io-"));
    const previousTmp = process.env.TMPDIR;
    process.env.TMPDIR = root;
    const base = join(root, "pi-better-subagents");
    const runs = join(base, "runs");
    fs.mkdirSync(runs, { recursive: true });
    const save = (meta) => {
        fs.mkdirSync(join(runs, meta.id), { recursive: true });
        fs.writeFileSync(join(runs, meta.id, "meta.json"), JSON.stringify(meta));
    };
    const metas = Array.from({ length: 40 }, (_, i) => ({ id: `sa_io_${i}`, sessionId: `session-${i}`,
        status: "completed", startedAt: i, cwd: root, spawnPid: process.pid, pid: process.pid, exitCode: 0,
        operations: { conversationId: `session-${i}`, workspace: root } }));
    metas.forEach(save);
    fs.writeFileSync(join(runs, "partial.json"), "not a run directory");
    fs.mkdirSync(join(runs, "null-record"));
    fs.writeFileSync(join(runs, "null-record", "meta.json"), "null");
    const read = fs.readFileSync;
    const readdir = fs.readdirSync;
    let reads = 0;
    let listings = 0;
    fs.readFileSync = function(path, ...args) {
        if (String(path).startsWith(runs) && String(path).endsWith("/meta.json")) reads++;
        return read.call(this, path, ...args);
    };
    fs.readdirSync = function(path, ...args) {
        if (String(path) === runs) listings++;
        return readdir.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const options = { baseDir: base, observation: { verified: true, waits: [] } };
    try {
        const expected = metas.map((meta) => assignmentFor(meta, meta.status, options));
        reads = 0;
        const project = createAssignmentProjector(options);
        assert.deepEqual(metas.map((meta) => project(meta)), expected);
        assert.equal(reads, metas.length + 2);
        reads = 0;
        listings = 0;
        assert.deepEqual(createAssignmentProjector(options)(metas[0]), expected[0]);
        assert.ok(reads <= 2, `a later refresh reread ${reads} unrelated run records`);
        assert.equal(listings, 0, "a stable refresh must reuse the run identity catalog");
        options.observation.waits.push({ waitId: "live-wait", generation: 1, phase: "waiting" });
        assert.equal(project(metas[0]).state, "waiting", "the snapshot must not cache authoritative observations");
        options.observation.waits.pop();

        reads = 0;
        buildNavigatorRows(metas, { effectiveStatus: (m) => m.status, shortModel: () => "model",
            fmtElapsed: () => "1s", spendFor: () => "" });
        assert.equal(reads, metas.length, "navigator should reread only visible conversations");

        // Prime Goal's parent index; the steady-state collection reads each owned
        // record once and takes one shared lineage snapshot.
        collectSubagentActivity({ baseDir: base });
        reads = 0;
        collectSubagentActivity({ baseDir: base });
        assert.equal(reads, metas.length * 2);

        const continuation = { ...metas[0], id: "sa_io_resume", resumedFrom: metas[0].id,
            startedAt: 100, status: "running", operations: { ...metas[0].operations, resumeLaunchToken: "token" } };
        save(continuation);
        assert.equal(project(metas[0]).attemptId, metas[0].id, "a refresh retains its snapshot");
        assert.equal(createAssignmentProjector(options)(metas[0]).attemptId, continuation.id);
        continuation.status = "failed";
        save(continuation);
        assert.equal(createAssignmentProjector(options)(metas[0]).state, "failed", "an existing file's update is visible on the next refresh");

        const ordinary = { ...metas[0], operations: undefined };
        reads = 0;
        assert.equal(createAssignmentProjector(options)(ordinary).state, "completed");
        assert.equal(reads, 0, "ordinary runs do not need lineage discovery");
    } finally {
        fs.readFileSync = read;
        fs.readdirSync = readdir;
        syncBuiltinESMExports();
        if (previousTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = previousTmp;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a projection batch keeps workspace, assignment and manual continuation boundaries", () => {
    const base = fs.mkdtempSync(join(tmpdir(), "projection-isolation-"));
    const root = { id: "root", sessionId: "shared-session", cwd: "/first-workspace", status: "completed",
        startedAt: 1, exitCode: 0, assignment: { assignmentId: "first-assignment" },
        operations: { conversationId: "shared-session", workspace: "/first-workspace" } };
    const automatic = { ...root, id: "automatic", resumedFrom: root.id, startedAt: 2,
        operations: { ...root.operations, resumeLaunchToken: "automatic-token" } };
    const foreignWorkspace = { ...automatic, id: "foreign-workspace", cwd: "/other-workspace", startedAt: 30 };
    const foreignAssignment = { ...automatic, id: "foreign-assignment", assignment: { assignmentId: "other-assignment" }, startedAt: 40 };
    const manual = { ...automatic, id: "manual", startedAt: 50, operations: root.operations };
    const manualChild = { ...automatic, id: "manual-child", resumedFrom: manual.id, startedAt: 60 };
    const metas = [root, automatic, foreignWorkspace, foreignAssignment, manual, manualChild];
    const options = { baseDir: base, observation: { verified: true, waits: [] } };
    try {
        for (const meta of metas) {
            fs.mkdirSync(join(base, "runs", meta.id), { recursive: true });
            fs.writeFileSync(join(base, "runs", meta.id, "meta.json"), JSON.stringify(meta));
        }
        const project = createAssignmentProjector(options);
        for (const meta of metas) assert.deepEqual(project(meta), assignmentFor(meta, meta.status, options));
        assert.equal(project(root).attemptId, automatic.id);
        assert.equal(project(manual).attemptId, manualChild.id);
        fs.rmSync(join(base, "runs", automatic.id), { recursive: true });
        assert.equal(project(root).attemptId, automatic.id);
        assert.equal(createAssignmentProjector(options)(root).attemptId, root.id, "the next refresh observes removals");
    } finally {
        fs.rmSync(base, { recursive: true, force: true });
    }
});

test("a run directory committed after discovery becomes visible without a global rescan", () => {
    const base = fs.mkdtempSync(join(tmpdir(), "projection-late-meta-"));
    const runs = join(base, "runs");
    const root = { id: "root", sessionId: "conversation", cwd: base, status: "completed",
        startedAt: 1, exitCode: 0, operations: { conversationId: "conversation", workspace: base } };
    const continuation = { ...root, id: "continuation", status: "failed", startedAt: 2,
        resumedFrom: root.id, operations: { ...root.operations, resumeLaunchToken: "resume" } };
    const originalNow = Date.now;
    let now = originalNow();
    Date.now = () => now;
    try {
        fs.mkdirSync(join(runs, root.id), { recursive: true });
        fs.writeFileSync(join(runs, root.id, "meta.json"), JSON.stringify(root));
        fs.mkdirSync(join(runs, continuation.id));
        const options = { baseDir: base, observation: { verified: true, waits: [] } };
        assert.equal(createAssignmentProjector(options)(root).attemptId, root.id);
        fs.writeFileSync(join(runs, continuation.id, "meta.json"), JSON.stringify(continuation));
        now += 1_001;
        assert.equal(createAssignmentProjector(options)(root).attemptId, continuation.id);
    } finally {
        Date.now = originalNow;
        fs.rmSync(base, { recursive: true, force: true });
    }
});
