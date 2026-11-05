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
 * Publish the delegation policy as its own prompt section.
 *
 * A section survives a summary that rewrites the conversation without being
 * appended text, and it is part of the cached prefix, so it costs nothing per
 * request while it stays unchanged. Assignment is idempotent: a repeated turn
 * rewrites the same value and pi's section diff reports no change.
 *
 * Nothing volatile goes in here: live occupancy would rewrite the cached prefix
 * on every run, and admission rechecks capacity at spawn anyway.
 */
export const SUBAGENT_SETTINGS_SECTION = "subagents";

/** `sections` is optional because the repo typechecks against older pi typings. */
export interface PromptSectionTarget {
    sections?: Record<string, string>;
}

/**
 * Published with the settings block: the block is the authority on delegation, so
 * the sentence that says so has to sit beside it rather than in a separate section
 * whose position would depend on package load order.
 */
const SUBAGENT_DELEGATION_NOTE = "Treat the Subagent settings block at the end of this prompt as the authoritative delegation mode and cap. Its delegation guidance replaces earlier mode-specific guidance, including guidance in a plan. Live occupancy is not pushed into context: inspect subagent_settings when it matters, and never treat the concurrency limit as a target number of agents.";

export function publishSubagentSettings<T extends PromptSectionTarget>(options: T, settings: EffectiveSubagentSettings): T {
    // Note first, block last: the note points at "the settings block at the end of
    // this prompt", so reversing them would describe the wrong thing and would
    // also change what the model reads last on every turn.
    const sections = (options.sections ??= {});
    sections[SUBAGENT_SETTINGS_SECTION] = `${SUBAGENT_DELEGATION_NOTE}\n\n${formatSubagentSettings(settings)}`;
    return options;
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