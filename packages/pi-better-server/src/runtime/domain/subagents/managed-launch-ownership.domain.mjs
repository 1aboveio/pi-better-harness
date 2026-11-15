// Generated fixed launch domain from packages/pi-better-subagents/managed-launch-ownership.ts. Do not edit directly.
import { realProcessProbe } from "./health.domain.mjs";
/** Management transfer never treats timeout or absent identity as proof of death. */
export function assertSubagentHandoff(metas, root, probe = realProcessProbe) {
    const evidence = (pid, start) => {
        if (!pid || !probe.pidExists(pid))
            return "gone";
        const observed = probe.startToken(pid);
        if (!start || !observed)
            return "unknown";
        return observed === start ? "live" : "gone";
    };
    for (const meta of metas) {
        if (meta.status !== "running" && meta.status !== "orphaned")
            continue;
        if (!meta.management) {
            if (evidence(meta.spawnPid, meta.spawnPidStartTime) !== "gone")
                throw new Error(`legacy-manager-live-or-unknown: ${meta.id}`);
            if (evidence(meta.pid, meta.pidStartTime) !== "gone")
                throw new Error(`legacy-writer-live-or-unknown: ${meta.id}`);
        }
        else {
            if (meta.management.root !== root)
                continue;
            if (evidence(meta.pid, meta.pidStartTime) === "unknown")
                throw new Error(`writer-identity-unknown: ${meta.id}`);
        }
    }
}
