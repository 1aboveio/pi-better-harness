import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("large archive history stays bounded across independent readers and publications", { timeout: 120_000 }, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "archive-budget-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, "attempts"));
    mkdirSync(join(root, "pi-better-subagents", "runs"), { recursive: true });
    for (let i = 0; i < 4416; i++) {
        const meta = { id: `sa_archive_${i}`, sessionId: `conversation-${i}`, status: "completed",
            startedAt: i, endedAt: i + 1, cwd: root,
            recipe: { version: 1, sessionId: `conversation-${i}`, sessionDir: join(root, "sessions"), cwd: root } };
        writeFileSync(join(root, "attempts", `${meta.id}.json`), JSON.stringify({ version: 1, meta }));
    }
    const readers = [0, 1].map(() => {
        const child = fork(fileURLToPath(new URL("./archive_history_reader.mjs", import.meta.url)), [], {
            env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, PI_SUBAGENT_DURABLE_DIR: root },
            execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        t.after(() => new Promise((resolve) => { child.once("exit", resolve); child.kill(); }));
        return (command) => new Promise((resolve, reject) => {
            const onError = (error) => reject(error);
            child.once("message", (result) => { child.removeListener("error", onError); resolve(result); });
            child.once("error", onError);
            child.send(command);
        });
    });
    const writer = (action, value = "") => execFileSync(process.execPath, ["--input-type=module", "-e", `
        import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
        import { join } from 'node:path';
        const root = ${JSON.stringify(root)};
        const path = join(root, 'attempts', 'sa_archive_4415.json');
        ${action === "replace" ? `const record = JSON.parse(readFileSync(path)); record.meta.name = ${JSON.stringify(value)}; writeFileSync(path + '.tmp', JSON.stringify(record)); renameSync(path + '.tmp', path);` : ""}
        ${action === "delete" ? "unlinkSync(path);" : ""}
        ${action === "add" ? "const record = JSON.parse(readFileSync(join(root, 'attempts', 'sa_archive_4414.json'))); record.meta.id = 'sa_archive_4415'; record.meta.sessionId = record.meta.recipe.sessionId = 'conversation-4415'; writeFileSync(path + '.tmp', JSON.stringify(record)); renameSync(path + '.tmp', path);" : ""}
        ${action === "marker" ? `mkdirSync(join(root, 'session-state'), {recursive:true}); const path2 = join(root, 'session-state', 'conversation-4415.json'); writeFileSync(path2 + '.tmp', JSON.stringify({version:1, sessionId:'conversation-4415', attemptId:'sa_later', status:${JSON.stringify(value)}, startedAt:5000})); renameSync(path2 + '.tmp', path2);` : ""}
        ${action === "clear" ? "unlinkSync(join(root, 'session-state', 'conversation-4415.json'));" : ""}
    `]);
    for (const reader of readers) assert.equal((await reader("warm")).healthIntervals, 1);
    const failures = [];
    let mutationReads = 0;
    let maxMutationReads = 0;
    for (const reader of readers) {
        const result = await reader("budget");
        t.diagnostic(JSON.stringify(result));
        assert.equal(result.count, 4416);
        if (result.markerStats > 10) failures.push(`unchanged history still checks ${result.markerStats} per-record markers`);
        const consumers = await reader("consumers");
        t.diagnostic(JSON.stringify({ consumers }));
        if (consumers.markerStats > 1 || consumers.archiveReads > 0) failures.push(`health/tool consumers inspect completed history: ${JSON.stringify(consumers)}`);
    }
    for (let i = 0; i < 10; i++) {
        writer("replace", `replacement-${i}`);
        for (const reader of readers) {
            const result = await reader("once");
            assert.equal(result.name, `replacement-${i}`);
            mutationReads += result.archiveReads;
            maxMutationReads = Math.max(maxMutationReads, result.archiveReads);
            if (result.archiveReads > 1) failures.push(`single publication rereads ${result.archiveReads} archives`);
        }
    }
    t.diagnostic(JSON.stringify({ mutationReads, maxMutationReads, publications: 10, readers: readers.length }));
    for (const status of ["failed", "killed", "lost"]) {
        writer("marker", status);
        for (const reader of readers) assert.equal((await reader("once")).count, 4415);
        writer("clear");
        for (const reader of readers) assert.equal((await reader("once")).count, 4416);
    }
    writer("delete");
    for (const reader of readers) assert.equal((await reader("once")).count, 4415);
    writer("add");
    for (const reader of readers) assert.equal((await reader("once")).count, 4416);
    for (const reader of readers) assert.match((await reader("unreadable")).error, /injected marker directory refusal/);
    for (const reader of readers) assert.equal((await reader("once")).count, 4416, "storage recovery must not reuse an absent-history result");
    assert.deepEqual(failures, []);
});
