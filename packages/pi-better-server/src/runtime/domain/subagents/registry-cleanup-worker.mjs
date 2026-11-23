// Generated fixed launch domain from packages/pi-better-subagents/registry-cleanup-worker.mjs. Do not edit directly.
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { bindRuntimeOutcomeStore } from "./assignment-outcomes.domain.mjs";
import { enforceRegistrySizeCapOnce, runDailyCleanupOnce } from "./cleanup.domain.mjs";
import { onMetaChanged } from "./registry.domain.mjs";
import { openStore } from "./shared-operation-coordinator/index.domain.mjs";
const { root, config } = workerData;
process.env.PI_CODING_AGENT_DIR = root;
// Reuse one coordinator connection for all assignment and retention checks in this sweep.
const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
const unbind = bindRuntimeOutcomeStore(root, store);
// Cleanup emits a metadata change after each committed removal, including during the daily sweep.
const off = onMetaChanged(meta => { if (meta)
    parentPort.postMessage(meta.id); });
try {
    runDailyCleanupOnce({ config });
    enforceRegistrySizeCapOnce({ config });
}
finally {
    off();
    unbind();
    store.close();
}
