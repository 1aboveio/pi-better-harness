// Generated fixed launch domain from packages/pi-better-subagents/managed-failure-worker.mjs. Do not edit directly.
/** Root-owned mechanical file folding. No SQLite connection or native transcript. */
import { parentPort, workerData } from "node:worker_threads";
import { collectRunFailures } from "./failures.domain.mjs";
import { readMeta } from "./registry.domain.mjs";
const revoked = new Int32Array(workerData.revocation);
const assertCurrent = () => {
    if (!Number.isSafeInteger(workerData.epoch) || Atomics.load(revoked, 0))
        throw new Error("failure-fold-owner-revoked");
};
parentPort.on("message", ({ ids }) => {
    try {
        assertCurrent();
        if (!Array.isArray(ids) || ids.length > 128)
            throw new Error("failure-fold-batch-overflow");
        for (const id of new Set(ids)) {
            assertCurrent();
            if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id))
                continue;
            const meta = readMeta(id);
            if (!meta || meta.management?.root !== workerData.root || meta.status === "running")
                continue;
            const assertRunCurrent = () => {
                assertCurrent();
                const latest = readMeta(id);
                if (!latest || latest.management?.root !== workerData.root || latest.status === "running")
                    throw new Error("failure-fold-run-authority-changed");
            };
            collectRunFailures(id, meta.cwd, meta.status !== "orphaned", assertRunCurrent);
        }
        parentPort.postMessage({ complete: true });
    }
    catch (error) {
        parentPort.postMessage({ error: String(error) });
    }
});
