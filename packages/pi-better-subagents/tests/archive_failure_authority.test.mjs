import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArchivedAttempts, readArchivedAttempt, recordArchiveStatusTombstone } from "../session-store.ts";
import { removeMetaArtifacts, runDir } from "../registry.ts";

test("failed archive observations never authorize dropping a later attempt without its tombstone", () => {
    const previous = process.env.PI_SUBAGENT_DURABLE_DIR;
    const root = fs.mkdtempSync(join(tmpdir(), "archive-authority-"));
    process.env.PI_SUBAGENT_DURABLE_DIR = root;
    const read = fs.readFileSync;
    const readdir = fs.readdirSync;
    try {
        fs.mkdirSync(join(root, "attempts"));
        const record = (id) => ({ version: 1, meta: { id, sessionId: id, status: "completed", startedAt: 1,
            cwd: root, recipe: { version: 1, sessionId: id, sessionDir: join(root, "sessions"), cwd: root } } });
        const path = join(root, "attempts", "sa_a.json");
        fs.writeFileSync(path, JSON.stringify(record("sa_a")));
        let refusedPath = path;
        const archiveReads = new Map();
        fs.readFileSync = function(p, ...args) {
            archiveReads.set(String(p), (archiveReads.get(String(p)) ?? 0) + 1);
            if (String(p) === refusedPath) throw Object.assign(new Error("transient read refusal"), { code: "EACCES" });
            return read.call(this, p, ...args);
        };
        syncBuiltinESMExports();
        // Retain R1's trigger: stat works, the first archive read fails, access
        // recovers, then unrelated B is atomically published. Refusal is allowed;
        // a partial listing must never become lasting absence authority.
        try { listArchivedAttempts(); } catch (error) { assert.match(error.message, /transient read refusal/); }
        assert.equal(readArchivedAttempt("sa_a"), undefined, "an unreadable direct lookup must refuse continuation");
        assert.throws(() => recordArchiveStatusTombstone({ id: "sa_later", sessionId: "sa_a", status: "failed", startedAt: 2 }), /transient read refusal/);
        refusedPath = undefined;
        assert.equal(readArchivedAttempt("sa_a").id, "sa_a");
        fs.writeFileSync(join(root, "attempts", "sa_b.tmp"), JSON.stringify(record("sa_b")));
        fs.renameSync(join(root, "attempts", "sa_b.tmp"), join(root, "attempts", "sa_b.json"));
        assert.deepEqual(listArchivedAttempts().map((m) => m.id).sort(), ["sa_a", "sa_b"], "recovered A must be rediscovered after B publication");
        assert.equal(recordArchiveStatusTombstone({ id: "sa_later", sessionId: "sa_a", status: "failed", startedAt: 2 }), true);
        assert.equal(readArchivedAttempt("sa_a"), undefined, "the old completion must not be offered after the later failure");

        const later = { id: "sa_latest", sessionId: "sa_a", status: "killed", startedAt: 3, spawnPid: process.pid, cwd: root };
        fs.mkdirSync(runDir(later.id), { recursive: true });
        fs.writeFileSync(join(runDir(later.id), "meta.json"), JSON.stringify(later));
        // Even a warmed marker must not turn a transient read error into absent
        // evidence or overwrite a newer marker with an older one.
        const marker = join(root, "session-state", "sa_a.json");
        fs.writeFileSync(marker + ".tmp", JSON.stringify({ version: 1, sessionId: "sa_a", attemptId: "sa_newer", status: "lost", startedAt: 4 }));
        fs.renameSync(marker + ".tmp", marker);
        refusedPath = marker;
        assert.throws(() => readArchivedAttempt("sa_a"), /transient read refusal/);
        assert.equal(removeMetaArtifacts(later), false, "cleanup must retain volatile evidence when marker authority is unreadable");
        assert.equal(fs.existsSync(join(runDir(later.id), "meta.json")), true);
        refusedPath = undefined;
        assert.equal(removeMetaArtifacts(later), true);
        assert.equal(JSON.parse(read(marker, "utf8")).attemptId, "sa_newer", "stronger lost tombstone must survive recovered cleanup");
        assert.equal(readArchivedAttempt("sa_a"), undefined);

        // Force a list invalidation and refuse enumeration while directory stat
        // still succeeds. Recovery without another publication must retry.
        fs.writeFileSync(join(root, "attempts", "sa_c.json"), JSON.stringify(record("sa_c")));
        fs.readdirSync = function(p, ...args) {
            if (String(p) === join(root, "attempts")) throw Object.assign(new Error("transient enumeration refusal"), { code: "EACCES" });
            return readdir.call(this, p, ...args);
        };
        syncBuiltinESMExports();
        assert.throws(() => recordArchiveStatusTombstone({ id: "sa_c_later", sessionId: "sa_c", status: "lost", startedAt: 2 }), /transient enumeration refusal/);
        fs.readdirSync = readdir;
        syncBuiltinESMExports();
        assert.equal(recordArchiveStatusTombstone({ id: "sa_c_later", sessionId: "sa_c", status: "lost", startedAt: 2 }), true);
        assert.equal(readArchivedAttempt("sa_c"), undefined);

        // A retry without a new directory mutation must revalidate the failed
        // file while reusing successful observations from the interrupted scan.
        for (const id of ["sa_d", "sa_e"]) fs.writeFileSync(join(root, "attempts", `${id}.json`), JSON.stringify(record(id)));
        archiveReads.clear();
        refusedPath = join(root, "attempts", "sa_e.json");
        assert.throws(() => listArchivedAttempts(), /transient read refusal/);
        refusedPath = undefined;
        assert.deepEqual(listArchivedAttempts().map((m) => m.id).sort(), ["sa_b", "sa_d", "sa_e"]);
        assert.equal(archiveReads.get(join(root, "attempts", "sa_d.json")), 1, "retry must reuse successfully read D");
        assert.equal(archiveReads.get(join(root, "attempts", "sa_e.json")), 2, "retry must reread refused E without another publication");
        assert.equal(archiveReads.get(path), undefined, "retry must not reread unchanged A");
    } finally {
        fs.readFileSync = read;
        fs.readdirSync = readdir;
        syncBuiltinESMExports();
        if (previous === undefined) delete process.env.PI_SUBAGENT_DURABLE_DIR;
        else process.env.PI_SUBAGENT_DURABLE_DIR = previous;
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(runDir("sa_latest"), { recursive: true, force: true });
    }
});
