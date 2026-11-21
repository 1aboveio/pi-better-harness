// Generated fixed launch domain from packages/pi-better-sandbox/permissions.ts. Do not edit directly.
/** Permission values are intent; launch backends must validate support before enforcement. */
import { defaultSubagentTools, parseSubagentTools } from "./shared-task-tools.domain.mjs";
/**
 * Return fresh profiles so changing one column never changes another.
 * All sandbox switches default to Off. Subagents retain Outside project = Write
 * and credentials = Write & delete when enabled. Main keeps Read for both rows.
 * Explicit saved profiles retain their values.
 */
export function defaultSandboxPermissions() {
    const profile = () => ({
        enabled: false,
        projectFiles: "read-write",
        outsideProject: "read",
        storedCredentials: "read",
        commands: true,
        shell: true,
        commandTimeoutSeconds: null,
        network: true,
        processAccess: "read",
    });
    return { main: profile(), background: profile(), subagents: { ...profile(), outsideProject: "write", storedCredentials: "read-write" }, subagentTools: defaultSubagentTools() };
}
function isProfile(value) {
    if (!value || typeof value !== "object")
        return false;
    const p = value;
    const credential = (v) => v === "off" || v === "read" || v === "read-write";
    const access = (v) => credential(v) || v === "write";
    const shell = p.shell === undefined || typeof p.shell === "boolean";
    // Missing and null both mean no cap. A cap must fit a supported seconds value.
    const timeout = p.commandTimeoutSeconds === undefined || p.commandTimeoutSeconds === null ||
        (typeof p.commandTimeoutSeconds === "number" && Number.isFinite(p.commandTimeoutSeconds) &&
            p.commandTimeoutSeconds > 0 && p.commandTimeoutSeconds <= 2147483);
    return typeof p.enabled === "boolean" && typeof p.commands === "boolean" && shell && timeout &&
        typeof p.network === "boolean" && access(p.projectFiles) &&
        access(p.outsideProject) && credential(p.storedCredentials) &&
        (p.processAccess === undefined || p.processAccess === "off" || p.processAccess === "read");
}
const FILE_RANK = { off: 0, read: 1, write: 2, "read-write": 3 };
/**
 * Human-readable descriptions of every way `next` grants more than `previous`
 * (a higher file level, a capability switched on, or a sandbox switched off).
 * Saving such a change needs interactive confirmation.
 */
export function describeLoosening(previous, next) {
    const changes = [];
    for (const column of ["main", "subagents", "background"]) {
        const label = column === "main" ? "Main" : column === "background" ? "Background tasks" : "Subagents";
        const a = previous[column];
        const b = next[column];
        if (a.enabled && !b.enabled)
            changes.push(`${label}: sandbox off`);
        for (const key of ["projectFiles", "outsideProject", "storedCredentials"]) {
            if (FILE_RANK[b[key]] > FILE_RANK[a[key]])
                changes.push(`${label}: ${key} ${a[key]} → ${b[key]}`);
        }
        if (b.commands && !a.commands)
            changes.push(`${label}: commands on`);
        // Missing shell means the old behavior (On); missing/null timeout means no cap.
        if (a.shell === false && b.shell !== false)
            changes.push(`${label}: shell scripts on`);
        const previousTimeout = a.commandTimeoutSeconds ?? null;
        const nextTimeout = b.commandTimeoutSeconds ?? null;
        if (previousTimeout !== null && (nextTimeout === null || nextTimeout > previousTimeout)) {
            changes.push(`${label}: command time limit ${previousTimeout}s → ${nextTimeout === null ? "no limit" : `${nextTimeout}s`}`);
        }
        if (b.network && !a.network)
            changes.push(`${label}: network on`);
        if (a.processAccess !== "read" && b.processAccess === "read")
            changes.push(`${label}: processAccess off → read`);
    }
    // A trusted tool runs outside the file rules: ticking one loosens the profile.
    return changes;
}
/** Strict decoding: malformed policy must not silently broaden permissions. */
export function parseSandboxPermissions(value) {
    if (!value || typeof value !== "object")
        throw new Error("Invalid sandbox permission settings.");
    const settings = value;
    if (!isProfile(settings.main) || !isProfile(settings.subagents)) {
        throw new Error("Sandbox settings require Main and Subagents profiles with explicit permission values.");
    }
    if (settings.background !== undefined && !isProfile(settings.background)) {
        throw new Error("Background tasks profile requires explicit permission values.");
    }
    const copy = (p) => ({
        enabled: p.enabled, projectFiles: p.projectFiles, outsideProject: p.outsideProject,
        storedCredentials: p.storedCredentials, commands: p.commands,
        // Legacy profiles predate Shell scripts and the command time limit.
        shell: p.shell ?? true, commandTimeoutSeconds: p.commandTimeoutSeconds ?? null,
        network: p.network, processAccess: p.processAccess ?? "off",
    });
    // Missing Background tasks inherits Main once, without linking the profiles.
    // Files written before the Tools section existed get the default tool set.
    return { main: copy(settings.main), background: copy(settings.background ?? settings.main),
        subagents: copy(settings.subagents), subagentTools: parseSubagentTools(settings.subagentTools) };
}
