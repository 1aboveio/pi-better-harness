/** Permission values are intent; launch backends must validate support before enforcement. */
export type FileAccess = "off" | "read" | "read-write";
export interface SandboxPermissionProfile {
    enabled: boolean;
    projectFiles: FileAccess;
    outsideProject: FileAccess;
    storedCredentials: FileAccess;
    commands: boolean;
    network: boolean;
}
export interface SandboxPermissionSettings {
    main: SandboxPermissionProfile;
    subagents: SandboxPermissionProfile;
}

/** Return fresh profiles so changing one column never changes the other. */
export function defaultSandboxPermissions(): SandboxPermissionSettings {
    const profile = (): SandboxPermissionProfile => ({
        enabled: false,
        projectFiles: "read-write",
        outsideProject: "read",
        storedCredentials: "read",
        commands: true,
        network: true,
    });
    return { main: profile(), subagents: { ...profile(), enabled: true } };
}

function isProfile(value: unknown): value is SandboxPermissionProfile {
    if (!value || typeof value !== "object") return false;
    const p = value as Record<string, unknown>;
    const access = (v: unknown): boolean => v === "off" || v === "read" || v === "read-write";
    return typeof p.enabled === "boolean" && typeof p.commands === "boolean" &&
        typeof p.network === "boolean" && access(p.projectFiles) &&
        access(p.outsideProject) && access(p.storedCredentials);
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
    });
    return { main: copy(settings.main), subagents: copy(settings.subagents) };
}
