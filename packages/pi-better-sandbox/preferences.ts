/** Persisted foreground-sandbox activation preference. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const SANDBOX_PREFERENCES_FILE_NAME = "pi-better-sandbox-preferences.json";
export const SANDBOX_PREFERENCES_FORMAT_VERSION = 1;

export type SandboxDefaultMode = "off" | "on";

export type SandboxPreferenceSeams = {
    agentDir?: () => string;
};

type SandboxPreferencesFile = {
    version: number;
    default: SandboxDefaultMode;
};

export class SandboxPreferenceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SandboxPreferenceError";
    }
}

export function sandboxPreferencesPath(seams: SandboxPreferenceSeams = {}): string {
    return join((seams.agentDir ?? getAgentDir)(), "extensions", SANDBOX_PREFERENCES_FILE_NAME);
}

/** Read the persisted default. No file means the product default: off. */
export function readSandboxDefault(seams: SandboxPreferenceSeams = {}): SandboxDefaultMode {
    const path = sandboxPreferencesPath(seams);
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "off";
        throw new SandboxPreferenceError(
            `The sandbox preference at ${path} could not be read: ${messageOf(error)}`,
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new SandboxPreferenceError(
            `The sandbox preference at ${path} is not valid JSON: ${messageOf(error)}`,
        );
    }

    const value = parsed as Partial<SandboxPreferencesFile> | null;
    if (
        value?.version !== SANDBOX_PREFERENCES_FORMAT_VERSION ||
        (value.default !== "off" && value.default !== "on")
    ) {
        throw new SandboxPreferenceError(
            `The sandbox preference at ${path} must contain version ${SANDBOX_PREFERENCES_FORMAT_VERSION} and default "off" or "on".`,
        );
    }
    return value.default;
}

/** Atomically persist the default used by future sessions. */
export function writeSandboxDefault(
    mode: SandboxDefaultMode,
    seams: SandboxPreferenceSeams = {},
): string {
    const path = sandboxPreferencesPath(seams);
    mkdirSync(dirname(path), { recursive: true });
    const contents = `${JSON.stringify(
        { version: SANDBOX_PREFERENCES_FORMAT_VERSION, default: mode } satisfies SandboxPreferencesFile,
        undefined,
        2,
    )}\n`;
    const pending = `${path}.${process.pid}.tmp`;
    try {
        writeFileSync(pending, contents, "utf8");
        renameSync(pending, path);
    } catch (error) {
        throw new SandboxPreferenceError(
            `The sandbox preference at ${path} could not be written: ${messageOf(error)}`,
        );
    }
    return path;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}