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
    return [
        `Subagent settings: revision ${settings.revision}`,
        `Delegation: ${settings.delegationMode} (${settings.sources.delegationMode})`,
        `Concurrency limit: ${settings.maxConcurrent} (${settings.sources.maxConcurrent})`,
        `Running: ${settings.runningCount}; reserved: ${settings.pendingCount}`,
        `Occupied slots: ${settings.occupiedSlots}`,
        `Available slots: ${settings.availableSlots}`,
        "The limit is a ceiling, not a target. Launch ready, independent, useful work within available capacity. " +
            "This is a point-in-time snapshot; spawn admission rechecks capacity. Lowering the limit does not stop existing runs.",
        delegationPrompt(settings.delegationMode),
    ].join("\n");
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