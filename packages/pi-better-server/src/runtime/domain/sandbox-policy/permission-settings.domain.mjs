// Generated fixed launch domain from packages/pi-better-sandbox/permission-settings.ts. Do not edit directly.
/** Versioned storage for the permission table; does not activate enforcement. */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultSandboxPermissions, parseSandboxPermissions } from "./permissions.domain.mjs";
import { readSandboxDefault } from "./preferences.domain.mjs";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "./shared-harness-settings.domain.mjs";
export function permissionSettingsPath(seams = {}) {
    return harnessSettingsPath(seams);
}
export function readPermissionSettings(seams = {}) {
    const stored = readHarnessSetting("sandboxPermissions", seams, {
        path: join((seams.agentDir ?? getAgentDir)(), "extensions", "pi-better-sandbox-permissions.json"),
        parse: parsePermissionSettings,
    });
    if (stored === undefined) {
        const settings = defaultSandboxPermissions();
        settings.main.enabled = readSandboxDefault(seams) === "on";
        settings.background = { ...settings.main };
        return settings;
    }
    return parsePermissionSettings(stored).permissions;
}
function parsePermissionSettings(parsed) {
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
        throw new Error("Unsupported sandbox permissions file version.");
    }
    return { version: 1, permissions: parseSandboxPermissions(parsed.permissions) };
}
export function writePermissionSettings(settings, seams = {}) {
    const permissions = parseSandboxPermissions(settings);
    updateHarnessSetting("sandboxPermissions", () => ({ version: 1, permissions }), seams);
}
