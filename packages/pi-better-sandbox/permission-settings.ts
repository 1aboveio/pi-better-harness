/** Versioned storage for the permission table; does not activate enforcement. */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { defaultSandboxPermissions, parseSandboxPermissions, type SandboxPermissionSettings } from "./permissions.ts";
import { readSandboxDefault, type SandboxPreferenceSeams } from "./preferences.ts";

export function permissionSettingsPath(seams: SandboxPreferenceSeams = {}): string {
    return join((seams.agentDir ?? getAgentDir)(), "extensions", "pi-better-sandbox-permissions.json");
}

export function readPermissionSettings(seams: SandboxPreferenceSeams = {}): SandboxPermissionSettings {
    let raw: string;
    try {
        raw = readFileSync(permissionSettingsPath(seams), "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const settings = defaultSandboxPermissions();
        settings.main.enabled = readSandboxDefault(seams) === "on";
        return settings;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) {
        throw new Error("Unsupported sandbox permissions file version.");
    }
    return parseSandboxPermissions((parsed as { permissions?: unknown }).permissions);
}

export function writePermissionSettings(
    settings: SandboxPermissionSettings,
    seams: SandboxPreferenceSeams = {},
): void {
    const permissions = parseSandboxPermissions(settings);
    const path = permissionSettingsPath(seams);
    mkdirSync(dirname(path), { recursive: true });
    const pending = `${path}.${randomUUID()}.tmp`;
    try {
        writeFileSync(pending, JSON.stringify({ version: 1, permissions }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
        renameSync(pending, path);
    } finally {
        rmSync(pending, { force: true });
    }
}
