/** Shared worker planning. No Pi imports, provider discovery, or child execution. */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadCatalog, type CatalogSnapshot } from "./catalog-store.ts";
import { resolveSelection } from "./catalog-resolver.ts";
import { resolveModel, type ModelDecision, type ResolvableModel } from "./model-resolution-core.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.ts";
import type { TierPolicy } from "./tier-policy.ts";

export const WORKER_ROLES = {
    implementer: "developer",
    explorer: "explorer",
    diagnoser: "developer",
    reviewer: "reviewer",
} as const;
export type WorkerSlot = keyof typeof WORKER_ROLES;
export type WorkerRole = typeof WORKER_ROLES[WorkerSlot];
export type WorkerHost = "pi" | "codex" | "claude-code";

export interface WorkerOverride { model?: string; effort?: ThinkingLevel }
export interface AvailableWorkerModel {
    /** Canonical identity; never inferred from a native host model name. */
    model: string;
    nativeModel?: string;
    supportedEfforts: readonly ThinkingLevel[];
}
export interface WorkerCatalogRequest {
    version: 1;
    harness: WorkerHost;
    cwd: string;
    userRoot?: string;
    projectTrusted?: boolean;
    available: readonly AvailableWorkerModel[];
    foregroundModel?: string;
    /** Non-Pi hosts must explicitly opt into foreground fallback. */
    fallbackToForeground?: boolean;
    /** Current-turn launch controls. Prompt text is not model selection. */
    launchCapabilities?: { model: boolean; effort: boolean; instructions: boolean };
    /** Explicit host configuration, below task overrides and above role defaults. */
    hostPreferences?: Partial<Record<WorkerRole, WorkerOverride>>;
    overrides?: Partial<Record<WorkerSlot, WorkerOverride>>;
    tiers?: TierPolicy;
}
export interface WorkerDiagnostic { code: string; message: string; blocking: boolean; slot?: WorkerSlot }
export interface WorkerPlan {
    role: WorkerRole;
    model: string | null;
    nativeModel: string | null;
    effort: ThinkingLevel | null;
    instructions: string;
    selection: { model: ModelDecision["modelSelection"]; effort: ModelDecision["effortSelection"] } | null;
    launch: null | Record<string, unknown>;
    catalogDigest: string;
    diagnostics: WorkerDiagnostic[];
}
export interface WorkerCatalogPlan {
    version: 1;
    ok: boolean;
    harness: WorkerHost;
    catalogDigest: string;
    slots: Record<WorkerSlot, WorkerPlan>;
    diagnostics: WorkerDiagnostic[];
}

export function planWorkers(request: WorkerCatalogRequest, snapshot?: CatalogSnapshot): WorkerCatalogPlan {
    validateRequest(request);
    const catalog = snapshot ?? loadCatalog({
        cwd: request.cwd,
        userRoot: request.userRoot ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
        projectTrusted: request.projectTrusted === true,
    });
    const models: ResolvableModel[] = request.available.map((entry) => {
        const slash = entry.model.indexOf("/");
        return {
            provider: entry.model.slice(0, slash), id: entry.model.slice(slash + 1),
            reasoning: entry.supportedEfforts.some((level) => level !== "off"),
            supportedEffortLevels: [...entry.supportedEfforts],
        };
    });
    const slots = Object.fromEntries(Object.entries(WORKER_ROLES).map(([slot, role]) => {
        const key = slot as WorkerSlot;
        const resolved = resolveSelection(catalog, { roleId: `role.${role}` });
        const worker: WorkerPlan = {
            role, model: null, nativeModel: null, effort: null,
            instructions: resolved.effective?.instructions ?? "", selection: null,
            launch: null, catalogDigest: catalog.digest,
            diagnostics: resolved.diagnostics.map((item) => ({ code: item.code, message: item.message, blocking: item.blocking, slot: key })),
        };
        if (!resolved.launchable || !resolved.effective) return [key, worker];
        const override = request.overrides?.[key];
        const hostPreference = request.hostPreferences?.[role];
        const decision = resolveModel({
            effective: resolved.effective,
            registry: { getAvailable: () => models }, tiers: request.tiers,
            foregroundModel: request.harness === "pi" || request.fallbackToForeground === true ? request.foregroundModel : undefined,
            invocation: { model: override?.model, thinking: override?.effort },
            authoritative: { model: hostPreference?.model, effort: hostPreference?.effort },
        });
        worker.model = decision.modelSelection.actual;
        worker.effort = decision.effortSelection.actual;
        worker.selection = { model: decision.modelSelection, effort: decision.effortSelection };
        worker.diagnostics.push(...decision.diagnostics.map((item) => ({ code: item.code, message: item.message, blocking: item.blocking, slot: key })));
        if (decision.status !== "ready") return [key, worker];
        const available = request.available.find((item) => item.model === worker.model);
        worker.nativeModel = available?.nativeModel ?? (request.harness === "pi" ? worker.model : null);
        if (request.harness === "pi") {
            // Let the live Pi catalog apply its own defaults; do not turn them into invocation overrides.
            worker.launch = {
                role,
                ...(decision.modelSelection.explicitRequest ? { model: worker.model } : {}),
                ...(decision.effortSelection.explicit && worker.effort ? { thinking: worker.effort } : {}),
            };
        } else if (!worker.nativeModel || request.launchCapabilities?.model !== true ||
            request.launchCapabilities?.instructions !== true || (worker.effort !== null && request.launchCapabilities?.effort !== true)) {
            worker.diagnostics.push({ code: "host-launch-unsupported", message: `${request.harness} must advertise model, instruction, and requested effort controls and an explicit nativeModel mapping. Prompt text cannot select a model.`, blocking: true, slot: key });
        } else {
            worker.launch = { model: worker.nativeModel, effort: worker.effort, instructions: worker.instructions };
        }
        return [key, worker];
    })) as Record<WorkerSlot, WorkerPlan>;
    if (slots.implementer.model && slots.implementer.model === slots.reviewer.model) {
        slots.reviewer.launch = null;
        slots.reviewer.diagnostics.push({ code: "reviewer-not-independent", message: "Implementer and reviewer resolve to the same model. Configure a distinct reviewer; no replacement was invented.", blocking: true, slot: "reviewer" });
    }
    const diagnostics = Object.values(slots).flatMap((slot) => slot.diagnostics);
    const ok = Object.values(slots).every((slot) => slot.launch !== null) && !diagnostics.some((item) => item.blocking);
    // A failed preflight is not a partial launch authorization.
    if (!ok) for (const slot of Object.values(slots)) slot.launch = null;
    return { version: 1, ok, harness: request.harness, catalogDigest: catalog.digest, slots, diagnostics };
}

function validateRequest(request: WorkerCatalogRequest): void {
    if (!request || request.version !== 1 || !["pi", "codex", "claude-code"].includes(request.harness) ||
        typeof request.cwd !== "string" || !request.cwd.trim() || !Array.isArray(request.available)) {
        throw new Error("invalid-worker-request: supply version 1, harness, cwd, and current-host available model capabilities.");
    }
    const ids = new Set<string>();
    const nativeIds = new Set<string>();
    for (const model of request.available) {
        if (!model || typeof model.model !== "string" || !/^[^\s/@]+\/[^\s@]+$/.test(model.model) || ids.has(model.model) ||
            !Array.isArray(model.supportedEfforts) || model.supportedEfforts.length === 0 ||
            model.supportedEfforts.some((level: ThinkingLevel) => !THINKING_LEVELS.includes(level)) ||
            new Set(model.supportedEfforts).size !== model.supportedEfforts.length ||
            (model.nativeModel !== undefined && (typeof model.nativeModel !== "string" || !model.nativeModel.trim() || nativeIds.has(model.nativeModel)))) {
            throw new Error("invalid-model-capabilities: supply unique provider/model identities, native mappings, and verified supportedEfforts.");
        }
        ids.add(model.model);
        if (model.nativeModel) nativeIds.add(model.nativeModel);
    }
    for (const [preferences, allowed] of [[request.overrides, Object.keys(WORKER_ROLES)], [request.hostPreferences, Object.values(WORKER_ROLES)]] as const) {
        if (preferences === undefined) continue;
        if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) throw new Error("invalid-worker-preferences: expected an object.");
        for (const [key, preference] of Object.entries(preferences)) {
            if (!(allowed as readonly string[]).includes(key) || !preference || typeof preference !== "object" || Array.isArray(preference) ||
                Object.keys(preference).some((field) => !["model", "effort"].includes(field)) ||
                (preference.model !== undefined && (typeof preference.model !== "string" || !preference.model.trim())) ||
                (preference.effort !== undefined && !THINKING_LEVELS.includes(preference.effort))) {
                throw new Error(`invalid-worker-preferences: invalid model or effort for ${key}.`);
            }
        }
    }
}