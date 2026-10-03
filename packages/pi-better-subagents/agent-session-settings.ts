/** Branch-local catalog preferences. Null removes a definition's own value. */
import { EFFORT_LEVELS, type CatalogDefinition, type PortablePreferences, type ThinkingLevel } from "./catalog-schema.ts";
import { contentDigest, saveDefinition, type CatalogSnapshot, type LoadCatalogInput, type SaveResult } from "./catalog-store.ts";

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
    clear(): void;
}

function valid(id: unknown, key: unknown, value: unknown): boolean {
    return typeof id === "string" && /^(role|agent)\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) &&
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
                if (data?.version !== 1 || !valid(data.id, data.key, data.value)) continue;
                apply(data.id, data.key, data.value);
            }
        },
        change(id, key, value) {
            if (!valid(id, key, value)) throw new Error("Choose a catalog id and a valid model or effort. Nothing changed.");
            // Append first: a persistence failure must not become an ephemeral edit.
            pi.appendEntry(AGENT_SESSION_SETTINGS_ENTRY, { version: 1, id, key, value });
            apply(id, key, value);
        },
    };
}

/** Copy only preferences; never repair or bypass a catalog validation failure. */
export function sessionPreferences(definition: CatalogDefinition, settings: AgentSessionOverrides = {}): PortablePreferences {
    const own = { ...(definition.kind === "role" ? definition.defaults : definition.overrides) };
    const patch = settings[definition.id];
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

/** Save selected own preferences only. Never flatten inherited role settings. */
export function saveAgentSessionDefaults(snapshot: CatalogSnapshot, id: string, settings: AgentSessionOverrides, location: LoadCatalogInput): SaveResult {
    const entry = snapshot.roles.get(id) ?? snapshot.agents.get(id);
    if (!entry?.definition || !entry.structurallyValid || entry.duplicate) {
        return { ok: false, diagnostics: [{ severity: "error", code: "agents-save", message: `Cannot save ${id}: repair the catalog definition first. Session edits are unchanged.`, blocking: true, structural: false }] };
    }
    const definition = structuredClone(entry.definition);
    const preferences = sessionPreferences(definition, settings);
    if (definition.kind === "role") definition.defaults = preferences;
    else definition.overrides = preferences;
    // The store validates and writes atomically, including trust and symlink checks.
    return saveDefinition({ ...location, definition, scope: entry.scope === "project" ? "project" : "user", replace: entry.scope !== "bundled" });
}
