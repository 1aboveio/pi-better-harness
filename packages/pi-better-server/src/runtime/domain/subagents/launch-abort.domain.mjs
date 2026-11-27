// Generated fixed launch domain from packages/pi-better-subagents/launch-abort.ts. Do not edit directly.
import { discardFailedLaunch } from "./registry.domain.mjs";
import { killProcessTree } from "./spawn.domain.mjs";
/** A signal request is not writer-exit proof. Retain ownership until close. */
export async function abortUncommittedLaunch(id, options) {
    if (options.child) {
        killProcessTree(options.child.pid, "SIGKILL");
        // If exit cannot be established, neither the lease nor its evidence is removed.
        await options.child.exit;
    }
    options.lease?.release();
    discardFailedLaunch(id, options.artifacts);
}
