import { type CatalogDefinition, type PortablePreferences, type ThinkingLevel } from "./catalog-schema.mjs";
import { type CatalogSnapshot, type LoadCatalogInput, type SaveResult } from "./catalog-store.mjs";
export declare const AGENT_SESSION_SETTINGS_ENTRY = "pi-better-subagents-agent-settings";
export type AgentSettingKey = "model" | "effort";
export type AgentSessionOverrides = Readonly<Record<string, Readonly<{
    model?: string | null;
    effort?: ThinkingLevel | null;
}>>>;
export interface AgentSessionContext {
    sessionManager?: {
        getBranch?(): readonly unknown[];
    };
}
export interface AgentSessionSettings {
    restore(ctx: AgentSessionContext): void;
    snapshot(): AgentSessionOverrides;
    change(id: string, key: AgentSettingKey, value: string | null): void;
    reset(id: string): void;
    clear(): void;
}
/** The host must restore from the current context before constructing catalog hosts. */
export declare function createAgentSessionSettings(pi: {
    appendEntry(customType: string, data: unknown): void;
}): AgentSessionSettings;
/** Copy only preferences; never repair or bypass a catalog validation failure. */
export declare function sessionPreferences(definition: CatalogDefinition, settings?: AgentSessionOverrides, saved?: AgentSessionOverrides): PortablePreferences;
/** A launch batch retains this immutable overlay, even if the UI changes later. */
export declare function withAgentSessionSettings(snapshot: CatalogSnapshot, settings?: AgentSessionOverrides): CatalogSnapshot;
/** Save selected preference edits without copying or rewriting Markdown definitions. */
export declare function saveAgentSessionDefaults(snapshot: CatalogSnapshot, id: string, settings: AgentSessionOverrides, location: LoadCatalogInput): SaveResult;
