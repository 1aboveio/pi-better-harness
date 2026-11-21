// Generated fixed launch domain from packages/pi-better-subagents/retained-result.ts. Do not edit directly.
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import { dirname, join } from "node:path";
import { snapshotTree, verifyTree } from "./workspace-files.domain.mjs";
import { resultDir } from "./session-store.domain.mjs";
// Published only while retiring a quiescent attempt. A result record can answer reads,
// but cannot authorize admission, revive a writer or make a failed attempt resumable.
export function retainResult(meta, logPath, scratch) {
    const dir = resultDir(meta.id);
    if (!dir)
        throw new Error("Invalid result identity");
    if (existsSync(dir)) {
        if (readRetainedResult(meta.id)?.sessionId !== meta.sessionId)
            throw new Error("Retained result identity changed");
        return;
    }
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    const temp = mkdtempSync(dir + "-");
    try {
        for (const name of ["output.log", "failures.jsonl"]) {
            const source = join(dirname(logPath), name);
            if (existsSync(source))
                copyFileSync(source, join(temp, name));
        }
        let savedScratch;
        if (scratch && existsSync(scratch)) {
            const files = snapshotTree(scratch);
            if (files.some((entry) => entry.name !== ".sandbox-anchor")) {
                cpSync(scratch, join(temp, "scratch"), { recursive: true, verbatimSymlinks: true });
                verifyTree(join(temp, "scratch"), files);
                verifyTree(scratch, files);
                savedScratch = join(dir, "scratch");
            }
        }
        writeFileSync(join(temp, "result.json"), JSON.stringify({ ...meta, taskScratch: savedScratch, logPath: join(dir, "output.log") }), { mode: 0o600 });
        renameSync(temp, dir);
    }
    finally {
        rmSync(temp, { recursive: true, force: true });
    }
}
export function readRetainedResult(id) {
    const dir = resultDir(id);
    if (!dir)
        return;
    try {
        const meta = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
        if (meta.id === id && ["completed", "killed", "failed", "lost"].includes(meta.status))
            return meta;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    return undefined;
}
