/** Branch-local catalog preferences. Null removes a definition's own value. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { EFFORT_LEVELS, type CatalogDefinition, type PortablePreferences, type ThinkingLevel } from "./catalog-schema.ts";
import { contentDigest, projectCatalogPaths, userCatalogPaths, type CatalogSnapshot, type LoadCatalogInput, type SaveResult } from "./catalog-store.ts";
import { writeCatalogPreferences } from "./catalog-preferences.ts";

export const AGENT_SESSION_SETTINGS_ENTRY = "pi-better-subagents-agent-settings";
export type AgentSettingKey = "model" | "effort";
export type AgentSessionOverrides = Readonly<Record<string, Readonly<{ model?: string | null; effort?: ThinkingLevel | null }>>>;
export interface AgentSessionContext {
    sessionManager?: { getBranch?(): readonly unknown[] };
}
export interface AgentSessionSettings {
    restore(ctx: AgentSessionContext): void;
    snapshot(): AgentSessionOverrides;
    change(id: string, key: AgentSettingKey, value: string | null): void;
    reset(id: string): void;
    clear(): void;
}

function validId(id: unknown): id is string {
    return typeof id === "string" && /^(role|agent)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id);
}

function valid(id: unknown, key: unknown, value: unknown): boolean {
    return validId(id) &&
        (key === "model" || key === "effort") && (value === null || typeof value === "string" &&
            (key === "model" ? /^[a-z0-9][a-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)
                : (EFFORT_LEVELS as readonly string[]).includes(value)));
}

/** The host must restore from the current context before constructing catalog hosts. */
export function createAgentSessionSettings(pi: { appendEntry(customType: string, data: unknown): void }): AgentSessionSettings {
    let overrides: AgentSessionOverrides = Object.freeze({});
    const apply = (id: string, key: AgentSettingKey, value: string | null) => {
        overrides = Object.freeze({ ...overrides, [id]: Object.freeze({ ...overrides[id], [key]: value }) });
    };
    const reset = (id: string) => {
        const next = { ...overrides };
        delete next[id];
        overrides = Object.freeze(next);
    };
    return {
        snapshot: () => overrides,
        clear() { overrides = Object.freeze({}); },
        restore(ctx) {
            overrides = Object.freeze({});
            const branch = ctx.sessionManager?.getBranch?.();
            if (!Array.isArray(branch)) return;
            for (const entry of branch) {
                if (!entry || entry.type !== "custom" || entry.customType !== AGENT_SESSION_SETTINGS_ENTRY) continue;
                const data = entry.data;
                if (data?.version !== 1) continue;
                if (data.kind === "reset") {
                    if (validId(data.id)) reset(data.id);
                } else if (valid(data.id, data.key, data.value)) {
                    apply(data.id, data.key, data.value);
                }
            }
        },
        change(id, key, value) {
            if (!valid(id, key, value)) throw new Error("Choose a catalog id and a valid model or effort. Nothing changed.");
            // Append first: a persistence failure must not become an ephemeral edit.
            pi.appendEntry(AGENT_SESSION_SETTINGS_ENTRY, { version: 1, id, key, value });
            apply(id, key, value);
        },
        reset(id) {
            if (!validId(id)) throw new Error("Choose a valid catalog id. Nothing changed.");
            // Append first, just like changes: failed persistence leaves the session intact.
            pi.appendEntry(AGENT_SESSION_SETTINGS_ENTRY, { version: 1, kind: "reset", id });
            reset(id);
        },
    };
}

/** Copy only preferences; never repair or bypass a catalog validation failure. */
export function sessionPreferences(definition: CatalogDefinition, settings: AgentSessionOverrides = {}, saved: AgentSessionOverrides = {}): PortablePreferences {
    const own = { ...(definition.kind === "role" ? definition.defaults : definition.overrides) };
    const patch = { ...saved[definition.id], ...settings[definition.id] };
    for (const key of ["model", "effort"] as const) {
        if (!patch || !Object.hasOwn(patch, key)) continue;
        if (patch[key] === null) delete own[key];
        else if (patch[key] !== undefined) Object.assign(own, { [key]: patch[key] });
    }
    return own;
}

/** A launch batch retains this immutable overlay, even if the UI changes later. */
export function withAgentSessionSettings(snapshot: CatalogSnapshot, settings?: AgentSessionOverrides): CatalogSnapshot {
    if (!settings || Object.keys(settings).length === 0) return snapshot;
    const ordered = Object.fromEntries(Object.keys(settings).sort().map((id) => [id, Object.freeze({
        ...(Object.hasOwn(settings[id]!, "model") ? { model: settings[id]!.model } : {}),
        ...(Object.hasOwn(settings[id]!, "effort") ? { effort: settings[id]!.effort } : {}),
    })]));
    const digest = contentDigest(JSON.stringify([snapshot.digest, ordered]));
    return Object.freeze({ ...snapshot, digest, revision: digest, sessionSettings: Object.freeze(ordered) });
}

/** Save selected preference edits without copying or rewriting Markdown definitions. */
export function saveAgentSessionDefaults(snapshot: CatalogSnapshot, id: string, settings: AgentSessionOverrides, location: LoadCatalogInput): SaveResult {
    const entry = snapshot.roles.get(id) ?? snapshot.agents.get(id);
    if (!entry?.definition || !entry.structurallyValid || entry.duplicate) {
        return { ok: false, diagnostics: [{ severity: "error", code: "agents-save", message: `Cannot save ${id}: repair the catalog definition first. Session edits are unchanged.`, blocking: true, structural: false }] };
    }
    const scope = entry.scope === "project" || Object.values(snapshot.preferenceSources?.[id] ?? {}).some(source => source.scope === "project") ? "project" : "user";
    if (scope === "project" && !location.projectTrusted) {
        return { ok: false, diagnostics: [{ severity: "error", code: "agents-save", message: "Project catalog preferences require a trusted project. Nothing changed.", blocking: true, structural: false }] };
    }
    const root = scope === "project" ? projectCatalogPaths(location.cwd, location.projectConfigDirName).root : userCatalogPaths(location.userRoot).root;
    try {
        mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
        const saved = writeCatalogPreferences(root, id, current => ({ ...current, ...settings[id] }));
        return { ok: true, path: saved.path, scope, diagnostics: [] };
    } catch (error) {
        return { ok: false, diagnostics: [{ severity: "error", code: "agents-save", message: error instanceof Error ? error.message : String(error), blocking: true, structural: false }] };
    }
}
