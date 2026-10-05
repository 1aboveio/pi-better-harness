/** Permission values are intent; launch backends must validate support before enforcement. */
import { defaultSubagentTools, packageLabel, parseSubagentTools, type SubagentToolSettings } from "./shared-task-tools.ts";
export type { SubagentToolSettings } from "./shared-task-tools.ts";
/**
 * Project files / Outside project levels: Off, Read, Write (read, create and
 * overwrite in place; nothing removed or renamed away outside temp, hidden home
 * entries and worktree folders), and Write & delete (`read-write`, the level
 * formerly shown as "Read / write").
 */
export type FileAccess = "off" | "read" | "write" | "read-write";
/** Stored credentials keeps its three levels. */
export type CredentialAccess = Exclude<FileAccess, "write">;
export interface SandboxPermissionProfile {
    enabled: boolean;
    projectFiles: FileAccess;
    outsideProject: FileAccess;
    storedCredentials: CredentialAccess;
    commands: boolean;
    network: boolean;
    processAccess: "off" | "read";
}
export interface SandboxPermissionSettings {
    main: SandboxPermissionProfile;
    subagents: SandboxPermissionProfile;
    /** Extension tools a confined subagent may use (ADR 0009). */
    subagentTools: SubagentToolSettings;
}

/**
 * Return fresh profiles so changing one column never changes the other.
 * Subagents default to Outside project = Write and credentials = Write & delete.
 * Main keeps Read for both rows. Explicit saved profiles retain their values.
 */
export function defaultSandboxPermissions(): SandboxPermissionSettings {
    const profile = (): SandboxPermissionProfile => ({
        enabled: false,
        projectFiles: "read-write",
        outsideProject: "read",
        storedCredentials: "read",
        commands: true,
        network: true,
        processAccess: "read",
    });
    return { main: profile(), subagents: { ...profile(), enabled: true, outsideProject: "write", storedCredentials: "read-write" }, subagentTools: defaultSubagentTools() };
}

function isProfile(value: unknown): value is SandboxPermissionProfile {
    if (!value || typeof value !== "object") return false;
    const p = value as Record<string, unknown>;
    const credential = (v: unknown): boolean => v === "off" || v === "read" || v === "read-write";
    const access = (v: unknown): boolean => credential(v) || v === "write";
    return typeof p.enabled === "boolean" && typeof p.commands === "boolean" &&
        typeof p.network === "boolean" && access(p.projectFiles) &&
        access(p.outsideProject) && credential(p.storedCredentials) &&
        (p.processAccess === undefined || p.processAccess === "off" || p.processAccess === "read");
}

const FILE_RANK: Record<FileAccess, number> = { off: 0, read: 1, write: 2, "read-write": 3 };

/**
 * Human-readable descriptions of every way `next` grants more than `previous`
 * (a higher file level, a capability switched on, or a sandbox switched off).
 * Saving such a change needs interactive confirmation.
 */
export function describeLoosening(previous: SandboxPermissionSettings, next: SandboxPermissionSettings): string[] {
    const changes: string[] = [];
    for (const column of ["main", "subagents"] as const) {
        const label = column === "main" ? "Main" : "Subagents";
        const a = previous[column];
        const b = next[column];
        if (a.enabled && !b.enabled) changes.push(`${label}: sandbox off`);
        for (const key of ["projectFiles", "outsideProject", "storedCredentials"] as const) {
            if (FILE_RANK[b[key]] > FILE_RANK[a[key]]) changes.push(`${label}: ${key} ${a[key]} → ${b[key]}`);
        }
        for (const key of ["commands", "network"] as const) {
            if (b[key] && !a[key]) changes.push(`${label}: ${key} on`);
        }
        if (a.processAccess !== "read" && b.processAccess === "read") changes.push(`${label}: processAccess off → read`);
    }
    // A trusted tool runs outside the file rules: ticking one loosens the profile.
    for (const tool of next.subagentTools.trusted) {
        if (!previous.subagentTools.trusted.some((t) => t.name === tool.name && t.package === tool.package)) {
            changes.push(`Subagents: trusted tool ${tool.name} (${packageLabel(tool.package)}) runs outside the file rules`);
        }
    }
    return changes;
}

/** Strict decoding: malformed policy must not silently broaden permissions. */
export function parseSandboxPermissions(value: unknown): SandboxPermissionSettings {
    if (!value || typeof value !== "object") throw new Error("Invalid sandbox permission settings.");
    const settings = value as Record<string, unknown>;
    if (!isProfile(settings.main) || !isProfile(settings.subagents)) {
        throw new Error("Sandbox settings require Main and Subagents profiles with explicit permission values.");
    }
    const copy = (p: SandboxPermissionProfile): SandboxPermissionProfile => ({
        enabled: p.enabled, projectFiles: p.projectFiles, outsideProject: p.outsideProject,
        storedCredentials: p.storedCredentials, commands: p.commands, network: p.network,
        processAccess: p.processAccess ?? "off",
    });
    // Files written before the Tools section existed get the default tool set.
    return { main: copy(settings.main), subagents: copy(settings.subagents), subagentTools: parseSubagentTools(settings.subagentTools) };
}
