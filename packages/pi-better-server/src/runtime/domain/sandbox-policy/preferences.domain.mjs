// Generated fixed launch domain from packages/pi-better-sandbox/preferences.ts. Do not edit directly.
/** Persisted foreground-sandbox activation preference. */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "./shared-harness-settings.domain.mjs";
export const SANDBOX_PREFERENCES_FILE_NAME = "pi-better-sandbox-preferences.json";
export const SANDBOX_PREFERENCES_FORMAT_VERSION = 1;
export class SandboxPreferenceError extends Error {
    constructor(message) {
        super(message);
        this.name = "SandboxPreferenceError";
    }
}
export function sandboxPreferencesPath(seams = {}) {
    return harnessSettingsPath(seams);
}
/** Read the persisted default. No file means the product default: off. */
export function readSandboxDefault(seams = {}) {
    const path = sandboxPreferencesPath(seams);
    try {
        const stored = readHarnessSetting("sandbox", seams, {
            path: join((seams.agentDir ?? getAgentDir)(), "extensions", SANDBOX_PREFERENCES_FILE_NAME),
            parse: (value) => parseSandboxPreferences(value, path),
        });
        return stored === undefined ? "off" : parseSandboxPreferences(stored, path).default;
    }
    catch (error) {
        if (error instanceof SandboxPreferenceError)
            throw error;
        throw new SandboxPreferenceError(`The sandbox preference at ${path} could not be read: ${messageOf(error)}`);
    }
}
function parseSandboxPreferences(parsed, path) {
    const value = parsed;
    if (value?.version !== SANDBOX_PREFERENCES_FORMAT_VERSION ||
        (value.default !== "off" && value.default !== "on")) {
        throw new SandboxPreferenceError(`The sandbox preference at ${path} must contain version ${SANDBOX_PREFERENCES_FORMAT_VERSION} and default "off" or "on".`);
    }
    return { version: SANDBOX_PREFERENCES_FORMAT_VERSION, default: value.default };
}
/** Atomically persist the default used by future sessions. */
export function writeSandboxDefault(mode, seams = {}) {
    const path = sandboxPreferencesPath(seams);
    try {
        const value = parseSandboxPreferences({ version: SANDBOX_PREFERENCES_FORMAT_VERSION, default: mode }, path);
        updateHarnessSetting("sandbox", () => value, seams);
    }
    catch (error) {
        throw new SandboxPreferenceError(`The sandbox preference at ${path} could not be written: ${messageOf(error)}`);
    }
    return path;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
