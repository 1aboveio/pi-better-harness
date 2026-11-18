import assert from "node:assert/strict";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";

/** Failure-only metadata, never journal/prompt contents or a quiescence claim. */
export function captureRunRemovalEvidence(directory) {
    const entries = [];
    let truncated = false;
    const record = value => { if (entries.length < 24) entries.push(value); else truncated = true; };
    const visit = (relative, depth) => {
        let cursor;
        try {
            const path = join(directory, relative);
            const root = lstatSync(path);
            if (!root.isDirectory() || root.isSymbolicLink()) {
                record({ relative: relative.slice(0, 256) || ".", kind: root.isSymbolicLink() ? "symlink" : "file" });
                return;
            }
            cursor = opendirSync(path);
            for (;;) {
                if (entries.length === 24) { truncated = true; break; }
                const child = cursor.readSync();
                if (!child) break;
                const name = relative ? `${relative}/${child.name}` : child.name;
                try {
                    const stat = lstatSync(join(directory, name), { bigint: true });
                    record({ relative: name.slice(0, 256), nameTruncated: name.length > 256,
                        kind: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
                        dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
                        mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
                    if (stat.isDirectory() && !stat.isSymbolicLink()) {
                        if (depth < 2) visit(name, depth + 1);
                        else truncated = true;
                    }
                } catch (error) { record({ relative: name.slice(0, 256), error: error.code ?? "metadata-unavailable" }); }
            }
        } catch (error) { record({ relative: relative.slice(0, 256) || ".", error: error.code ?? "directory-unavailable" }); }
        finally { try { cursor?.closeSync(); } catch (error) { record({ relative: relative.slice(0, 256) || ".", error: error.code ?? "close-unavailable" }); } }
    };
    visit("", 0);
    return { entries, truncated, maxEntries: 24, maxDepth: 2 };
}

/** Register cleanup only with the fixture that holds the actual exit observer. */
export function registerFixtureRun(run, ownedExits, liveRuns, teardownOwner) {
    if (teardownOwner === "continuation-fixture") {
        assert.equal(ownedExits.has(run.id), false, "a run cannot have two fixture teardown owners");
        return;
    }
    const owned = ownedExits.get(run.id);
    assert.ok(owned?.completion && owned.pid === run.pid, "local cleanup requires the exact owned exit acknowledgement");
    liveRuns.push(run);
}

/** Called only after successful acknowledged removal, never after a timeout. */
export function retireFixtureRun(run, receipt, ownedExits, liveRuns) {
    assert.equal(ownedExits.get(run.id), receipt, "retirement must match the exact exit owner receipt");
    assert.equal(receipt.pid, run.pid, "retirement must match the original child");
    for (let index = liveRuns.length - 1; index >= 0; index--) {
        if (liveRuns[index].id === run.id && liveRuns[index].pid === run.pid) liveRuns.splice(index, 1);
    }
    ownedExits.delete(run.id);
}

/** Original two-second teardown budget covers finalization and callback writes. */
export async function settleFixtureRun(receipt, batcher, assertQuiescent) {
    batcher.cancel();
    let timeout;
    try {
        await Promise.race([(async () => {
            await receipt.completion;
            batcher.cancel(); await batcher.settled(); batcher.cancel();
            assertQuiescent();
        })(), new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Owned timing finalizer did not settle")), 2000);
        })]);
    } finally { clearTimeout(timeout); }
}
