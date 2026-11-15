// Generated fixed launch domain from packages/pi-better-subagents/managed-launch-journal.mjs. Do not edit directly.
import { createHash } from "node:crypto";
import { openStore } from "./shared-operation-coordinator/index.domain.mjs";
const ordered = value => value === null || typeof value !== "object" ? value
    : Array.isArray(value) ? value.map(ordered)
        : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
export const launchDigest = value => createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
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
