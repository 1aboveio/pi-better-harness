/** Versioned storage for the permission table; does not activate enforcement. */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultSandboxPermissions, parseSandboxPermissions, type SandboxPermissionSettings } from "./permissions.ts";
import { readSandboxDefault, type SandboxPreferenceSeams } from "./preferences.ts";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "./shared-harness-settings.ts";

export function permissionSettingsPath(seams: SandboxPreferenceSeams = {}): string {
    return harnessSettingsPath(seams);
}

export function readPermissionSettings(seams: SandboxPreferenceSeams = {}): SandboxPermissionSettings {
    const stored = readHarnessSetting<unknown>("sandboxPermissions", seams, {
        path: join((seams.agentDir ?? getAgentDir)(), "extensions", "pi-better-sandbox-permissions.json"),
        parse: parsePermissionSettings,
    });
    if (stored === undefined) {
        const settings = defaultSandboxPermissions();
        settings.main.enabled = readSandboxDefault(seams) === "on";
        return settings;
    }
    return parsePermissionSettings(stored).permissions;
}

function parsePermissionSettings(parsed: unknown): { version: number; permissions: SandboxPermissionSettings } {
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
        throw new Error("Unsupported sandbox permissions file version.");
    }
    return { version: 1, permissions: parseSandboxPermissions((parsed as { permissions?: unknown }).permissions) };
}

export function writePermissionSettings(
    settings: SandboxPermissionSettings,
    seams: SandboxPreferenceSeams = {},
): void {
    const permissions = parseSandboxPermissions(settings);
    updateHarnessSetting("sandboxPermissions", () => ({ version: 1, permissions }), seams);
}
