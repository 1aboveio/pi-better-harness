import type { ConversationLease } from "./continuation.ts";
import { discardFailedLaunch } from "./registry.ts";
import { killProcessTree, type SpawnResult } from "./spawn.ts";

/** A signal request is not writer-exit proof. Retain ownership until close. */
export async function abortUncommittedLaunch(
    id: string,
    options: {
        child?: SpawnResult;
        lease?: ConversationLease;
        artifacts: Parameters<typeof discardFailedLaunch>[1];
    },
): Promise<void> {
    if (options.child) {
        killProcessTree(options.child.pid, "SIGKILL");
        // If exit cannot be established, neither the lease nor its evidence is removed.
        await options.child.exit;
    }
    options.lease?.release();
    discardFailedLaunch(id, options.artifacts);
}
