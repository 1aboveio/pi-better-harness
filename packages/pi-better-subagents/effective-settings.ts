import { createHash } from "node:crypto";
import { delegationPrompt, type DelegationMode } from "./delegation.ts";

export const SUBAGENT_SETTINGS_CONTEXT = "pi-better-subagents-settings";

export interface EffectiveSubagentSettings {
    revision: string;
    delegationMode: DelegationMode;
    maxConcurrent: number;
    sources: { delegationMode: "session" | "config"; maxConcurrent: "session" | "config" };
    runningCount: number;
    pendingCount: number;
    occupiedSlots: number;
    availableSlots: number;
}

export function effectiveSubagentSettings(
    settings: Pick<EffectiveSubagentSettings, "delegationMode" | "maxConcurrent" | "sources">,
    runningCount: number,
    pendingCount: number,
): EffectiveSubagentSettings {
    const revision = createHash("sha256").update(JSON.stringify([
        settings.delegationMode, settings.maxConcurrent, settings.sources.delegationMode, settings.sources.maxConcurrent,
    ])).digest("hex").slice(0, 12);
    const occupiedSlots = runningCount + pendingCount;
    return { ...settings, revision, runningCount, pendingCount, occupiedSlots,
        availableSlots: Math.max(0, settings.maxConcurrent - occupiedSlots) };
}

export function formatSubagentSettings(settings: EffectiveSubagentSettings): string {
    const manual = settings.delegationMode === "manual";
    const capacity = manual
        ? "The limit is a ceiling, not a target. In manual mode it bounds only work the user or an active workflow explicitly delegates; no slot count is an invitation to launch work."
        : "The limit is a ceiling, not a target. Launch ready, independent, useful work when a suitable subagent is available.";
    // No occupancy counters here. This text is injected into the conversation and
    // may only ever be appended to, so anything volatile would force either a
    // rewrite of already-sent content (which invalidates the provider's cached
    // prefix) or one more copy per change. Admission rechecks capacity at the
    // spawn anyway; live counts stay available through the subagent_settings tool.
    return [
        `Subagent settings: revision ${settings.revision}`,
        `Delegation: ${settings.delegationMode} (${settings.sources.delegationMode})`,
        `Concurrency limit: ${settings.maxConcurrent} (${settings.sources.maxConcurrent})`,
        // Mode first: the policy governs the settings that follow it.
        delegationPrompt(settings.delegationMode),
        capacity + " Spawn admission rechecks capacity; lower the limit without stopping existing runs.",
    ].join("\n");
}

/**
 * Append the delegation policy to the end of the system prompt.
 *
 * The system prompt is not part of the compaction window, so the policy survives
 * a summary that rewrites the conversation. It is also part of the cached
 * prefix, so it costs nothing per request while it stays unchanged.
 *
 * Nothing volatile goes in here: live occupancy would rewrite the cached prefix
 * on every run, and admission rechecks capacity at spawn anyway.
 */
export function appendSubagentSettings(systemPrompt: string, settings: EffectiveSubagentSettings): string {
    const policy = formatSubagentSettings(settings);
    return systemPrompt.includes(policy) ? systemPrompt : `${systemPrompt}\n\n${policy}`;
}

export function subagentSettingsTool(Type: any, read: () => EffectiveSubagentSettings) {
    return {
        name: "subagent_settings",
        label: "Subagent Settings",
        description: "Inspect effective subagent delegation mode, concurrency limit, setting sources, revision, and running/reserved/available slots. Read-only; does not change settings or launch work. The limit is a ceiling, not a target.",
        parameters: Type.Object({}),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        outputSchema: Type.Object({
            revision: Type.String(), delegationMode: Type.String(), maxConcurrent: Type.Number({ minimum: 1, multipleOf: 1 }),
            sources: Type.Object({ delegationMode: Type.String(), maxConcurrent: Type.String() }),
            runningCount: Type.Number({ minimum: 0, multipleOf: 1 }), pendingCount: Type.Number({ minimum: 0, multipleOf: 1 }),
            occupiedSlots: Type.Number({ minimum: 0, multipleOf: 1 }), availableSlots: Type.Number({ minimum: 0, multipleOf: 1 }),
        }),
        async execute() {
            const settings = read();
            return { content: [{ type: "text" as const, text: formatSubagentSettings(settings) }],
                details: settings, structuredContent: settings };
        },
    };
}