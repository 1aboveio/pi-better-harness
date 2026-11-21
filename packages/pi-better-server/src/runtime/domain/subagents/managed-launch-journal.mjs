// Generated fixed launch domain from packages/pi-better-subagents/managed-launch-journal.mjs. Do not edit directly.
import { openStore } from "./shared-operation-coordinator/index.domain.mjs";
export { launchDigest } from "./launch-digest.mjs";
/** Standalone callers own a store; server callers pass their shared mutation lease. */
export function openLaunchJournal(path, sharedStore) {
    const store = sharedStore ?? openStore({ path });
    try {
        const journal = store.subagentLaunchJournal();
        return { journal, close: () => { if (!sharedStore)
                store.close(); } };
    }
    catch (error) {
        if (!sharedStore)
            store.close();
        throw error;
    }
}
