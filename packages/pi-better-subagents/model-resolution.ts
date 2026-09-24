/**
 * Model and effort resolution for one catalog launch, or for a catalog-free call.
 *
 * The runtime does not read task prose. Callers translate an authoritative
 * workflow or skill instruction into `invocation` / `authoritative` before
 * this runs. Spawn only `decision.launch` when `status` is `"ready"`.
 *
 * Effort support comes from Pi's `getSupportedThinkingLevels` (installed
 * pi-ai). Inherited substitution uses nearest distance on the ordered effort
 * list and breaks ties toward the lower effort. That is intentional: Pi's
 * `clampThinkingLevel` walks upward first and is not the catalog rule.
 * Availability is the foreground registry snapshot only. This module does not
 * call a provider, retry, or substitute after a later startup failure.
 */
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { resolveSelection, type EffectiveDefinition, type FieldValue } from "./catalog-resolver.ts";
import type { CatalogSnapshot } from "./catalog-store.ts";
import type { Diagnostic } from "./catalog-schema.ts";
import { THINKING_LEVELS, parseModelThinking, type ThinkingLevel } from "./thinking.ts";
import {
    normalizeTierPolicy,
    type NormalizedTierCandidate,
    type TierPolicy,
    DEFAULT_TIER_POLICY,
} from "./tier-policy.ts";

export type { TierPolicy, TierSpec, TierCandidate } from "./tier-policy.ts";
export { DEFAULT_TIER_POLICY, configureTierPolicy, normalizeTierPolicy } from "./tier-policy.ts";

export const ModelResolutionCodes = {
    unavailableExplicitModel: "unavailable-explicit-model",
    ambiguousModel: "ambiguous-model",
    invalidEffort: "invalid-effort",
    unsupportedExplicitEffort: "unsupported-explicit-effort",
    unknownTier: "unknown-tier",
    modelFallback: "model-fallback",
    effortAdjusted: "effort-adjusted",
    noUsableModel: "no-usable-model",
    registryRequired: "registry-required",
    registryUnreadable: "registry-unreadable",
    notLaunchable: "not-launchable",
} as const;

export type ModelRequestSource =
    | "invocation"
    | "authoritative"
    | "agent-override"
    | "role-default"
    | "configured-default"
    | "foreground"
    | "absent";

export type ModelActualSource = ModelRequestSource | "tier-candidate";

export type EffortSource =
    | "invocation-thinking"
    | "invocation-suffix"
    | "authoritative-effort"
    | "authoritative-suffix"
    | "agent-override"
    | "role-default"
    | "configured-default"
    | "foreground-suffix"
    | "absent";

/** Fields Pi's support helper actually reads. Callers may pass a full `Model`. */
export interface ResolvableModel {
    id: string;
    provider: string;
    reasoning: boolean;
    thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

export interface ModelRegistryView {
    /** Foreground available set. Must not perform a live inference probe. */
    getAvailable(): readonly ResolvableModel[];
    /** Optional registry lookup for a clearer unavailable-model diagnostic. Not availability. */
    find?(provider: string, modelId: string): ResolvableModel | undefined;
}

export interface ModelResolutionContext {
    registry?: ModelRegistryView;
    tiers?: TierPolicy;
    /** `provider/model` of the foreground session. Its effort is not an input. */
    foregroundModel?: string;
    /** Existing subagent `defaultModel`. Used only when the catalog has no model preference. */
    configuredDefaultModel?: string | null;
}

export interface ResolveModelInput extends ModelResolutionContext {
    /**
     * Omit for a catalog-free call. Precedence then stays invocation model,
     * configured default, foreground model, with explicit thinking above the
     * selected string's `@effort` suffix. Availability and nearest-effort
     * adjustment are not applied.
     */
    effective?: EffectiveDefinition;
    /** Structured tool/command parameters. Not a prompt. */
    invocation?: {
        model?: string;
        thinking?: ThinkingLevel | string;
    };
    /**
     * Structured translation of an authoritative task, workflow, or skill
     * instruction. Read only when `effective` is set, so a catalog-free call
     * cannot grow a new input. Below invocation, above saved overrides.
     */
    authoritative?: {
        model?: string;
        effort?: ThinkingLevel | string;
    };
}

export interface ModelSelection {
    requested: string | null;
    requestedSource: ModelRequestSource;
    actual: string | null;
    source: ModelActualSource;
    /** Invocation or authoritative model. Default fallback must not replace it. */
    explicitRequest: boolean;
    reason: string;
}

export interface EffortSelection {
    requested: ThinkingLevel | null;
    requestedSource: EffortSource;
    actual: ThinkingLevel | null;
    source: EffortSource;
    /** Saved agent overrides and invocation/authoritative choices are explicit. Role defaults are not. */
    explicit: boolean;
    adjusted: boolean;
    reason: string;
}

export const STARTUP_FAILURE_POLICY = {
    action: "surface-error-no-retry-no-substitution",
    detail: "Foreground registry availability does not prove the child provider will initialize. If startup fails, surface that lifecycle error. Do not resolve again to swap models and do not retry the launch automatically.",
} as const;

export interface ModelDecision {
    status: "ready" | "blocked";
    catalogFree: boolean;
    /**
     * The only spawn payload. Null when blocked. `thinking` omitted means the
     * child keeps the model default; foreground effort is never copied.
     */
    launch: null | { model?: string; thinking?: ThinkingLevel };
    modelSelection: ModelSelection;
    effortSelection: EffortSelection;
    diagnostics: Diagnostic[];
    automaticRetry: false;
    substitutionAfterStart: false;
    availabilityIsStartupGuarantee: false;
    startupFailure: typeof STARTUP_FAILURE_POLICY;
}

export type CatalogAvailability =
    | "preferred"
    | "same-tier"
    | "foreground"
    | "configured-default"
    | "unavailable"
    | "catalog-blocked";

export interface CatalogResolutionAttachment {
    id: string;
    schemaLaunchable: boolean;
    /** Schema launchable and a default launch (no invocation override) is ready. */
    launchable: boolean;
    /** Registry membership of the catalog model field before fallback. Null when the field is empty. */
    preferredModelAvailable: boolean | null;
    availability: CatalogAvailability;
    decision?: ModelDecision;
    /** The catalog capability object, unchanged. Resolution grants nothing. */
    capabilities: EffectiveDefinition["capabilities"];
    diagnostics: readonly Diagnostic[];
}

const NO_CAPABILITY_GRANT: EffectiveDefinition["capabilities"] = {
    grantedByCatalog: false,
    note: "Tool selection, extension loading, sandbox, workspace, and nested delegation stay on the existing spawn path. Model resolution does not grant or remove capabilities.",
};

interface AvailableIndex {
    models: Map<string, ResolvableModel>;
    find?: ModelRegistryView["find"];
}

interface LocatedModel {
    status: "available" | "missing" | "ambiguous" | "malformed";
    model?: ResolvableModel;
    canonical?: string;
    matches?: string[];
}

interface SplitModel {
    model?: string;
    suffix?: ThinkingLevel;
    error?: string;
}

interface EffortPick {
    value: ThinkingLevel | null;
    source: EffortSource;
    explicit: boolean;
}

export function resolveModel(input: ResolveModelInput): ModelDecision {
    if (!input.effective) return resolveCatalogFree(input);
    if (!input.effective.launchable) return blockedDefinition(input.effective);
    const registry = readRegistry(input.registry);
    if (!registry.ok) {
        return finish(true, false, emptyModel("absent", registry.message), emptyEffort(registry.message), [
            problem(input.effective, registry.code, registry.message, true, "model"),
        ]);
    }
    return resolveCatalog(input.effective, input, registry.index);
}

/** Spawn helper. Throws when resolution blocked, so a child cannot start from a failed decision. */
export function launchParameters(decision: ModelDecision): { model?: string; thinking?: ThinkingLevel } {
    if (decision.status !== "ready" || decision.launch === null) {
        const detail = decision.diagnostics.map((item) => item.message).join(" ") || "Model resolution blocked launch.";
        throw new Error(`${detail} No child was started.`);
    }
    return decision.launch;
}

export function assessSelection(
    snapshot: CatalogSnapshot,
    selector: { agentId?: string; roleId?: string },
    context: ModelResolutionContext,
): CatalogResolutionAttachment {
    const resolved = resolveSelection(snapshot, selector);
    const effective = resolved.effective;
    const id = effective?.id ?? selector.agentId ?? selector.roleId ?? "";
    const capabilities = effective?.capabilities ?? NO_CAPABILITY_GRANT;
    if (!effective || !resolved.launchable) {
        return {
            id,
            schemaLaunchable: false,
            launchable: false,
            preferredModelAvailable: preferredAvailability(effective, context.registry),
            availability: "catalog-blocked",
            capabilities,
            diagnostics: resolved.diagnostics,
        };
    }
    const decision = resolveModel({
        effective,
        registry: context.registry,
        tiers: context.tiers,
        foregroundModel: context.foregroundModel,
        configuredDefaultModel: context.configuredDefaultModel,
    });
    return {
        id,
        schemaLaunchable: true,
        launchable: decision.status === "ready",
        preferredModelAvailable: preferredAvailability(effective, context.registry),
        availability: availabilityOf(decision),
        decision,
        capabilities,
        diagnostics: [...resolved.diagnostics, ...decision.diagnostics],
    };
}

export function assessCatalog(snapshot: CatalogSnapshot, context: ModelResolutionContext): CatalogResolutionAttachment[] {
    const entries = [...snapshot.roles.values(), ...snapshot.agents.values(), ...snapshot.blocked];
    const seen = new Set<string>();
    const attachments: CatalogResolutionAttachment[] = [];
    for (const entry of entries) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        const selector = entry.kind === "agent" ? { agentId: entry.id } : { roleId: entry.id };
        attachments.push(assessSelection(snapshot, selector, context));
    }
    attachments.sort((left, right) => left.id.localeCompare(right.id));
    return attachments;
}

/**
 * Nearest supported effort. Equal distance keeps the lower level.
 * `supported` should be Pi's `getSupportedThinkingLevels` result.
 */
export function nearestSupportedEffort(
    requested: ThinkingLevel,
    supported: readonly ThinkingLevel[],
): { level: ThinkingLevel; tied: boolean } | undefined {
    const supportedSet = THINKING_LEVELS.filter((level) => supported.includes(level));
    const requestedIndex = THINKING_LEVELS.indexOf(requested);
    if (supportedSet.length === 0 || requestedIndex < 0) return undefined;
    if (supportedSet.includes(requested)) return { level: requested, tied: false };
    let bestDistance = Number.POSITIVE_INFINITY;
    let best: ThinkingLevel[] = [];
    for (const level of supportedSet) {
        const distance = Math.abs(THINKING_LEVELS.indexOf(level) - requestedIndex);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = [level];
        } else if (distance === bestDistance) best.push(level);
    }
    best.sort((left, right) => THINKING_LEVELS.indexOf(left) - THINKING_LEVELS.indexOf(right));
    const level = best[0];
    if (!level) return undefined;
    return { level, tied: best.length > 1 };
}

export function supportedEfforts(model: ResolvableModel): ThinkingLevel[] {
    const levels = getSupportedThinkingLevels(model as Model<Api>);
    return THINKING_LEVELS.filter((level) => levels.includes(level));
}

function resolveCatalog(effective: EffectiveDefinition, input: ResolveModelInput, index: AvailableIndex): ModelDecision {
    const invocation = splitModelInput(input.invocation?.model);
    const authoritative = splitModelInput(input.authoritative?.model);
    const invocationEffort = parseEffort(input.invocation?.thinking, "invocation thinking");
    const authoritativeEffort = parseEffort(input.authoritative?.effort, "authoritative effort");
    if (!invocationEffort.ok || !authoritativeEffort.ok || invocation.error || authoritative.error) {
        const invalid = [
            invocation.error,
            authoritative.error,
            invocationEffort.ok ? undefined : invocationEffort.error,
            authoritativeEffort.ok ? undefined : authoritativeEffort.error,
        ].filter((item): item is string => Boolean(item));
        return finish(false, false, {
            requested: invocation.model ?? authoritative.model ?? catalogRequestedModel(effective),
            requestedSource: invocation.model ? "invocation" : authoritative.model ? "authoritative" : catalogRequestedSource(effective),
            actual: null,
            source: "absent",
            explicitRequest: Boolean(invocation.model || authoritative.model),
            reason: invalid.join(" "),
        }, emptyEffort(invalid.join(" ")), [
            problem(effective, ModelResolutionCodes.invalidEffort, `${invalid.join(" ")} No child was started.`, true, "effort"),
        ]);
    }

    const modelOutcome = selectCatalogModel(effective, input, index, invocation, authoritative);
    const effortPick = pickEffort(effective, invocation, authoritative, invocationEffort.value, authoritativeEffort.value);
    if (!modelOutcome.ok || !modelOutcome.model) {
        return finish(false, false, modelOutcome.selection, describeUnresolvedEffort(effortPick, modelOutcome.selection.reason), modelOutcome.diagnostics);
    }

    const effortOutcome = applyEffort(effective, modelOutcome.model, effortPick);
    if (!effortOutcome.ok) {
        return finish(false, false, modelOutcome.selection, effortOutcome.selection, [
            ...modelOutcome.diagnostics,
            effortOutcome.diagnostic,
        ]);
    }
    return finish(false, true, modelOutcome.selection, effortOutcome.selection, [
        ...modelOutcome.diagnostics,
        ...effortOutcome.diagnostics,
    ], {
        model: modelOutcome.selection.actual ?? undefined,
        thinking: effortOutcome.selection.actual ?? undefined,
    });
}

function resolveCatalogFree(input: ResolveModelInput): ModelDecision {
    const effort = parseEffort(input.invocation?.thinking, "invocation thinking");
    if (!effort.ok) {
        return finish(true, false, emptyModel("absent", effort.error), emptyEffort(effort.error), [
            problem(undefined, ModelResolutionCodes.invalidEffort, `${effort.error} No child was started.`, true, "effort"),
        ]);
    }
    const chosen = firstText(input.invocation?.model, input.configuredDefaultModel, input.foregroundModel);
    const requestedSource: ModelRequestSource = text(input.invocation?.model)
        ? "invocation"
        : text(input.configuredDefaultModel)
            ? "configured-default"
            : text(input.foregroundModel)
                ? "foreground"
                : "absent";
    let parsed: { model: string | undefined; thinking: ThinkingLevel | undefined };
    try {
        parsed = parseModelThinking(chosen, effort.value);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return finish(true, false, {
            requested: chosen ?? null,
            requestedSource,
            actual: null,
            source: "absent",
            explicitRequest: requestedSource === "invocation",
            reason: message,
        }, emptyEffort(message), [
            problem(undefined, ModelResolutionCodes.invalidEffort, `${message} No child was started.`, true, "effort"),
        ]);
    }
    const suffixSource: EffortSource = !parsed.thinking
        ? "absent"
        : effort.value
            ? "invocation-thinking"
            : requestedSource === "configured-default"
                ? "configured-default"
                : requestedSource === "foreground"
                    ? "foreground-suffix"
                    : "invocation-suffix";
    const modelReason = parsed.model
        ? `Catalog-free model ${parsed.model} came from ${requestedSource}. Availability was not checked.`
        : "Catalog-free call did not set a model. The child keeps Pi's own model default.";
    const effortReason = parsed.thinking
        ? `Catalog-free effort ${parsed.thinking} came from ${suffixSource}. Supported-effort adjustment was not applied.`
        : "Catalog-free call did not set an effort. Foreground effort was not copied.";
    return finish(true, true, {
        requested: parsed.model ?? null,
        requestedSource,
        actual: parsed.model ?? null,
        source: parsed.model ? requestedSource : "absent",
        explicitRequest: requestedSource === "invocation" && Boolean(parsed.model),
        reason: modelReason,
    }, {
        requested: parsed.thinking ?? null,
        requestedSource: suffixSource,
        actual: parsed.thinking ?? null,
        source: suffixSource,
        explicit: suffixSource !== "absent",
        adjusted: false,
        reason: effortReason,
    }, [], {
        model: parsed.model,
        thinking: parsed.thinking,
    });
}

interface ModelOutcome {
    ok: boolean;
    model?: ResolvableModel;
    selection: ModelSelection;
    diagnostics: Diagnostic[];
}

function selectCatalogModel(
    effective: EffectiveDefinition,
    input: ResolveModelInput,
    index: AvailableIndex,
    invocation: SplitModel,
    authoritative: SplitModel,
): ModelOutcome {
    if (invocation.model) {
        return explicitModel(effective, index, invocation.model, "invocation");
    }
    if (authoritative.model) {
        return explicitModel(effective, index, authoritative.model, "authoritative");
    }
    const preference = readModelField(effective.model);
    if (preference.kind === "preference") {
        const located = locate(preference.model, index, false);
        if (located.status === "available" && located.model && located.canonical) {
            return {
                ok: true,
                model: located.model,
                selection: {
                    requested: preference.model,
                    requestedSource: preference.source,
                    actual: located.canonical,
                    source: preference.source,
                    explicitRequest: false,
                    reason: `Preferred ${preference.source} model ${located.canonical} is in the foreground available set.`,
                },
                diagnostics: [],
            };
        }
        return fallbackPreference(effective, input, index, preference.model, preference.source, located);
    }
    return runtimeDefaultChain(effective, input, index, preference.source);
}

function explicitModel(
    effective: EffectiveDefinition,
    index: AvailableIndex,
    requested: string,
    source: "invocation" | "authoritative",
): ModelOutcome {
    const located = locate(requested, index, true);
    if (located.status === "available" && located.model && located.canonical) {
        return {
            ok: true,
            model: located.model,
            selection: {
                requested,
                requestedSource: source,
                actual: located.canonical,
                source,
                explicitRequest: true,
                reason: `Explicit ${source} model ${located.canonical} is in the foreground available set. Default-model fallback was not considered.`,
            },
            diagnostics: [],
        };
    }
    if (located.status === "ambiguous") {
        const message = `Explicit ${source} model ${JSON.stringify(requested)} matches more than one foreground model (${located.matches?.join(", ")}). Pass provider/model. No substitute was selected and no child was started.`;
        return {
            ok: false,
            selection: {
                requested,
                requestedSource: source,
                actual: null,
                source: "absent",
                explicitRequest: true,
                reason: message,
            },
            diagnostics: [problem(effective, ModelResolutionCodes.ambiguousModel, message, true, "model")],
        };
    }
    const known = knownUnavailable(requested, index.find);
    const message = `Explicit ${source} model ${requested} is not in the foreground available set.${known} Default-model, same-tier, and foreground fallback were not applied. Choose an available provider/model or make this one available. No child was started.`;
    return {
        ok: false,
        selection: {
            requested,
            requestedSource: source,
            actual: null,
            source: "absent",
            explicitRequest: true,
            reason: message,
        },
        diagnostics: [problem(effective, ModelResolutionCodes.unavailableExplicitModel, message, true, "model")],
    };
}

function fallbackPreference(
    effective: EffectiveDefinition,
    input: ResolveModelInput,
    index: AvailableIndex,
    requested: string,
    requestedSource: "agent-override" | "role-default",
    located: LocatedModel,
): ModelOutcome {
    const tier = readTier(effective.tier);
    const policy = normalizeTierPolicy(input.tiers ?? DEFAULT_TIER_POLICY);
    const skipped: string[] = [];
    const diagnostics: Diagnostic[] = [];
    let tierKnown = false;
    if (tier.value) {
        const spec = policy.tiers[tier.value];
        if (!spec) {
            diagnostics.push(problem(
                effective,
                ModelResolutionCodes.unknownTier,
                `Tier ${JSON.stringify(tier.value)} has no configured membership. No model from another tier was guessed.`,
                false,
                "tier",
                "warning",
            ));
        } else {
            tierKnown = true;
            for (const note of policy.ignored) skipped.push(note);
            const selected = firstEligibleCandidate(spec.members, spec.candidates, requested, index, skipped);
            if (selected) {
                const why = skipped.length > 0 ? ` Skipped: ${skipped.join("; ")}.` : "";
                const reason = `Preferred ${requestedSource} model ${requested} is not usable (${unusableBecause(located)}). Selected configured same-tier candidate ${selected.canonical} from tier ${tier.value}.${why} Resolved effort is kept and was not taken from this model.`;
                diagnostics.push(problem(effective, ModelResolutionCodes.modelFallback, reason, false, "model", "info"));
                return {
                    ok: true,
                    model: selected.model,
                    selection: {
                        requested,
                        requestedSource,
                        actual: selected.canonical,
                        source: "tier-candidate",
                        explicitRequest: false,
                        reason,
                    },
                    diagnostics,
                };
            }
        }
    } else {
        diagnostics.push(problem(
            effective,
            ModelResolutionCodes.unknownTier,
            "No tier mapping is set on the definition. Same-tier substitution was not guessed.",
            false,
            "tier",
            "warning",
        ));
    }
    const tierReason = tierKnown
        ? `Tier ${tier.value} has no eligible available candidate.${skipped.length > 0 ? ` Skipped: ${skipped.join("; ")}.` : " No candidates are configured."}`
        : tier.value
            ? `Tier ${JSON.stringify(tier.value)} is not a configured tier.`
            : "Tier mapping is absent.";
    return useForeground(effective, input, index, {
        requested,
        requestedSource,
        explicitRequest: false,
        prefix: `Preferred ${requestedSource} model ${requested} is not usable (${unusableBecause(located)}). ${tierReason}`,
    }, diagnostics);
}

function runtimeDefaultChain(
    effective: EffectiveDefinition,
    input: ResolveModelInput,
    index: AvailableIndex,
    requestedSource: ModelRequestSource,
): ModelOutcome {
    const cleared = requestedSource === "agent-override"
        ? "The saved agent model override is null, so the role model was not used."
        : "The catalog definition has no model preference.";
    const configured = splitModelInput(input.configuredDefaultModel ?? undefined);
    if (configured.model && !configured.error) {
        const located = locate(configured.model, index, true);
        if (located.status === "available" && located.model && located.canonical) {
            const reason = `${cleared} Using configured default model ${located.canonical}. Tier candidates were not consulted.`;
            return {
                ok: true,
                model: located.model,
                selection: {
                    requested: null,
                    requestedSource,
                    actual: located.canonical,
                    source: "configured-default",
                    explicitRequest: false,
                    reason,
                },
                diagnostics: [problem(effective, ModelResolutionCodes.modelFallback, reason, false, "model", "info")],
            };
        }
    }
    return useForeground(effective, input, index, {
        requested: null,
        requestedSource,
        explicitRequest: false,
        prefix: `${cleared} Configured default model ${text(input.configuredDefaultModel) ? input.configuredDefaultModel : "(none)"} was not an available provider/model.`,
    }, []);
}

function useForeground(
    effective: EffectiveDefinition,
    input: ResolveModelInput,
    index: AvailableIndex,
    base: { requested: string | null; requestedSource: ModelRequestSource; explicitRequest: boolean; prefix: string },
    diagnostics: Diagnostic[],
): ModelOutcome {
    const foreground = splitModelInput(input.foregroundModel);
    const located = foreground.model && !foreground.error ? locate(foreground.model, index, true) : { status: "missing" as const };
    if (located.status === "available" && located.model && located.canonical) {
        const reason = `${base.prefix} Using foreground model ${located.canonical}. Foreground effort was not inherited.`;
        diagnostics.push(problem(effective, ModelResolutionCodes.modelFallback, reason, false, "model", "info"));
        return {
            ok: true,
            model: located.model,
            selection: {
                requested: base.requested,
                requestedSource: base.requestedSource,
                actual: located.canonical,
                source: "foreground",
                explicitRequest: false,
                reason,
            },
            diagnostics,
        };
    }
    const message = `${base.prefix} Foreground model ${text(input.foregroundModel) ? input.foregroundModel : "(not set)"} is not in the foreground available set. No child was started. Recovery: make the preferred model available, add an ordered same-tier candidate (set crossProvider only to opt into another provider), or switch the foreground session to an available provider/model. This resolver does not probe the provider and will not retry.`;
    diagnostics.push(problem(effective, ModelResolutionCodes.noUsableModel, message, true, "model"));
    return {
        ok: false,
        selection: {
            requested: base.requested,
            requestedSource: base.requestedSource,
            actual: null,
            source: "absent",
            explicitRequest: base.explicitRequest,
            reason: message,
        },
        diagnostics,
    };
}

function firstEligibleCandidate(
    members: readonly string[],
    candidates: readonly NormalizedTierCandidate[],
    preferred: string,
    index: AvailableIndex,
    skipped: string[],
): { model: ResolvableModel; canonical: string } | undefined {
    const memberSet = new Set(members);
    const preferredProvider = providerOf(preferred);
    for (const candidate of candidates) {
        if (!memberSet.has(candidate.model)) {
            skipped.push(`${candidate.model} is not a member of the tier`);
            continue;
        }
        const cross = preferredProvider === undefined || candidate.provider !== preferredProvider;
        if (cross && !candidate.crossProvider) {
            skipped.push(`${candidate.model} is cross-provider without opt-in`);
            continue;
        }
        const found = index.models.get(candidate.model);
        if (!found) {
            skipped.push(`${candidate.model} is not in the foreground available set`);
            continue;
        }
        return { model: found, canonical: `${found.provider}/${found.id}` };
    }
    return undefined;
}

function pickEffort(
    effective: EffectiveDefinition,
    invocation: SplitModel,
    authoritative: SplitModel,
    invocationThinking: ThinkingLevel | undefined,
    authoritativeThinking: ThinkingLevel | undefined,
): EffortPick {
    if (invocationThinking) return { value: invocationThinking, source: "invocation-thinking", explicit: true };
    if (invocation.suffix) return { value: invocation.suffix, source: "invocation-suffix", explicit: true };
    if (authoritativeThinking) return { value: authoritativeThinking, source: "authoritative-effort", explicit: true };
    if (authoritative.suffix) return { value: authoritative.suffix, source: "authoritative-suffix", explicit: true };
    if (effective.effort.explicit) {
        return {
            value: effective.effort.value,
            source: "agent-override",
            explicit: true,
        };
    }
    if (effective.effort.value) return { value: effective.effort.value, source: "role-default", explicit: false };
    return { value: null, source: "absent", explicit: false };
}

function applyEffort(
    effective: EffectiveDefinition,
    model: ResolvableModel,
    pick: EffortPick,
): { ok: true; selection: EffortSelection; diagnostics: Diagnostic[] } | { ok: false; selection: EffortSelection; diagnostic: Diagnostic } {
    if (pick.value === null) {
        const reason = pick.explicit
            ? "Saved agent effort override is null, so the role effort was not used. The child keeps the model default. Foreground effort was not copied."
            : "No effort was requested. The child keeps the model default. Foreground effort was not copied.";
        return {
            ok: true,
            selection: {
                requested: null,
                requestedSource: pick.source,
                actual: null,
                source: pick.source,
                explicit: pick.explicit,
                adjusted: false,
                reason,
            },
            diagnostics: [],
        };
    }
    const supported = supportedEfforts(model);
    const modelId = `${model.provider}/${model.id}`;
    if (supported.includes(pick.value)) {
        const kept = pick.explicit ? "Explicit effort is supported by the resolved model." : "Inherited effort is supported by the resolved model and was kept.";
        return {
            ok: true,
            selection: {
                requested: pick.value,
                requestedSource: pick.source,
                actual: pick.value,
                source: pick.source,
                explicit: pick.explicit,
                adjusted: false,
                reason: `${kept} Requested ${pick.value}, actual ${pick.value}, source ${pick.source}.`,
            },
            diagnostics: [],
        };
    }
    if (pick.explicit) {
        const reason = `Explicit effort ${pick.value} (${pick.source}) is not supported by ${modelId}. Supported levels: ${supported.join(", ") || "(none)"}. Saved agent overrides stay explicit on fallback and are not moved to a nearby level. No child was started.`;
        return {
            ok: false,
            selection: {
                requested: pick.value,
                requestedSource: pick.source,
                actual: null,
                source: pick.source,
                explicit: true,
                adjusted: false,
                reason,
            },
            diagnostic: problem(effective, ModelResolutionCodes.unsupportedExplicitEffort, reason, true, "effort"),
        };
    }
    const nearest = nearestSupportedEffort(pick.value, supported);
    if (!nearest) {
        const reason = `Inherited effort ${pick.value} cannot be adjusted because ${modelId} reports no supported effort. No child was started.`;
        return {
            ok: false,
            selection: {
                requested: pick.value,
                requestedSource: pick.source,
                actual: null,
                source: pick.source,
                explicit: false,
                adjusted: false,
                reason,
            },
            diagnostic: problem(effective, ModelResolutionCodes.noUsableModel, reason, true, "effort"),
        };
    }
    const tie = nearest.tied ? " Equal-distance candidates were broken toward the lower effort." : "";
    const reason = `Inherited effort ${pick.value} (${pick.source}) is not supported by ${modelId}. Actual effort is ${nearest.level}. Supported levels: ${supported.join(", ")}.${tie} The model was not changed to chase an effort.`;
    return {
        ok: true,
        selection: {
            requested: pick.value,
            requestedSource: pick.source,
            actual: nearest.level,
            source: pick.source,
            explicit: false,
            adjusted: true,
            reason,
        },
        diagnostics: [problem(effective, ModelResolutionCodes.effortAdjusted, reason, false, "effort", "warning")],
    };
}

function readModelField(field: FieldValue<string>): { kind: "preference"; model: string; source: "agent-override" | "role-default" } | { kind: "none"; source: ModelRequestSource } {
    if (field.explicit) {
        if (field.value && field.value.trim()) return { kind: "preference", model: field.value.trim(), source: "agent-override" };
        return { kind: "none", source: "agent-override" };
    }
    if (field.value && field.value.trim()) return { kind: "preference", model: field.value.trim(), source: "role-default" };
    return { kind: "none", source: "absent" };
}

function readTier(field: FieldValue<string>): { value: string | null; explicit: boolean } {
    if (field.explicit) return { value: field.value?.trim() || null, explicit: true };
    if (field.value && field.value.trim()) return { value: field.value.trim(), explicit: false };
    return { value: null, explicit: false };
}

function locate(raw: string, index: AvailableIndex, allowUniqueId: boolean): LocatedModel {
    const trimmed = raw.trim();
    const slash = trimmed.indexOf("/");
    if (slash > 0 && slash < trimmed.length - 1) {
        const found = index.models.get(trimmed);
        if (!found) return { status: "missing" };
        return { status: "available", model: found, canonical: `${found.provider}/${found.id}` };
    }
    if (!allowUniqueId) return { status: "malformed" };
    const matches = [...index.models.values()].filter((model) => model.id === trimmed);
    if (matches.length === 1 && matches[0]) {
        return { status: "available", model: matches[0], canonical: `${matches[0].provider}/${matches[0].id}` };
    }
    if (matches.length > 1) return { status: "ambiguous", matches: matches.map((model) => `${model.provider}/${model.id}`) };
    return { status: "missing" };
}

function readRegistry(registry: ModelRegistryView | undefined): { ok: true; index: AvailableIndex } | { ok: false; code: string; message: string } {
    if (!registry || typeof registry.getAvailable !== "function") {
        return {
            ok: false,
            code: ModelResolutionCodes.registryRequired,
            message: "Catalog model resolution needs the foreground model registry (getAvailable). No provider was probed and no child was started.",
        };
    }
    let listed: readonly ResolvableModel[];
    try {
        listed = registry.getAvailable();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            code: ModelResolutionCodes.registryUnreadable,
            message: `Foreground model registry could not be read (${detail}). No provider was probed and no child was started.`,
        };
    }
    if (!Array.isArray(listed)) {
        return {
            ok: false,
            code: ModelResolutionCodes.registryUnreadable,
            message: "Foreground model registry getAvailable did not return a list. No child was started.",
        };
    }
    const models = new Map<string, ResolvableModel>();
    for (const model of listed) {
        if (!model || typeof model.provider !== "string" || typeof model.id !== "string" || typeof model.reasoning !== "boolean") continue;
        models.set(`${model.provider}/${model.id}`, model);
    }
    return { ok: true, index: { models, find: registry.find } };
}

function knownUnavailable(raw: string, find: ModelRegistryView["find"]): string {
    if (!find) return "";
    const slash = raw.indexOf("/");
    if (slash <= 0 || slash === raw.length - 1) return "";
    try {
        const found = find(raw.slice(0, slash), raw.slice(slash + 1));
        if (found) return ` ${raw} is known to the registry but is not in the foreground available set.`;
    } catch {
        return "";
    }
    return "";
}

function preferredAvailability(effective: EffectiveDefinition | undefined, registry: ModelRegistryView | undefined): boolean | null {
    const value = effective?.model.value?.trim();
    if (!value) return null;
    const read = readRegistry(registry);
    if (!read.ok) return false;
    return read.index.models.has(value);
}

function availabilityOf(decision: ModelDecision): CatalogAvailability {
    if (decision.status !== "ready") return "unavailable";
    if (decision.modelSelection.source === "tier-candidate") return "same-tier";
    if (decision.modelSelection.source === "foreground") return "foreground";
    if (decision.modelSelection.source === "configured-default") return "configured-default";
    return "preferred";
}

function blockedDefinition(effective: EffectiveDefinition): ModelDecision {
    const diagnostics = [...effective.diagnostics];
    if (!diagnostics.some((item) => item.blocking)) {
        diagnostics.push(problem(
            effective,
            ModelResolutionCodes.notLaunchable,
            `Definition ${effective.id} is not launchable. No model was selected and no child was started.`,
            true,
            "model",
        ));
    }
    return finish(false, false, {
        requested: catalogRequestedModel(effective),
        requestedSource: catalogRequestedSource(effective),
        actual: null,
        source: "absent",
        explicitRequest: false,
        reason: `Definition ${effective.id} is not launchable. No child was started.`,
    }, {
        requested: effective.effort.value,
        requestedSource: effective.effort.explicit ? "agent-override" : effective.effort.value ? "role-default" : "absent",
        actual: null,
        source: effective.effort.explicit ? "agent-override" : effective.effort.value ? "role-default" : "absent",
        explicit: effective.effort.explicit,
        adjusted: false,
        reason: "Effort was not applied because the definition is not launchable.",
    }, diagnostics);
}

function catalogRequestedModel(effective: EffectiveDefinition): string | null {
    return effective.model.value;
}

function catalogRequestedSource(effective: EffectiveDefinition): ModelRequestSource {
    if (effective.model.explicit) return "agent-override";
    if (effective.model.value) return "role-default";
    return "absent";
}

function describeUnresolvedEffort(pick: EffortPick, because: string): EffortSelection {
    return {
        requested: pick.value,
        requestedSource: pick.source,
        actual: null,
        source: pick.source,
        explicit: pick.explicit,
        adjusted: false,
        reason: `Effort ${pick.value ?? "(none)"} from ${pick.source} was not applied. ${because}`,
    };
}

function unusableBecause(located: LocatedModel): string {
    if (located.status === "malformed") return "it is not provider/model";
    if (located.status === "ambiguous") return "it matches more than one foreground model";
    return "it is not in the foreground available set";
}

function providerOf(model: string): string | undefined {
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return undefined;
    return model.slice(0, slash);
}

function splitModelInput(model: string | undefined): SplitModel {
    if (model === undefined || model === null) return {};
    if (typeof model !== "string") return { error: `model must be a string; got ${typeof model}` };
    const trimmed = model.trim();
    if (!trimmed) return {};
    try {
        const parsed = parseModelThinking(trimmed, undefined);
        return { model: parsed.model, suffix: parsed.thinking };
    } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
    }
}

function parseEffort(value: unknown, label: string): { ok: true; value?: ThinkingLevel; error?: undefined } | { ok: false; error: string } {
    if (value === undefined || value === null) return { ok: true };
    if (typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value)) {
        return { ok: true, value: value as ThinkingLevel };
    }
    return { ok: false, error: `${label} must be one of: ${THINKING_LEVELS.join(", ")}; got ${JSON.stringify(value)}.` };
}

function text(value: string | null | undefined): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function firstText(...values: Array<string | null | undefined>): string | undefined {
    for (const value of values) {
        const trimmed = text(value);
        if (trimmed) return trimmed;
    }
    return undefined;
}

function compactLaunch(launch?: { model?: string; thinking?: ThinkingLevel }): { model?: string; thinking?: ThinkingLevel } {
    const compacted: { model?: string; thinking?: ThinkingLevel } = {};
    if (launch?.model) compacted.model = launch.model;
    if (launch?.thinking) compacted.thinking = launch.thinking;
    return compacted;
}

function emptyModel(source: ModelRequestSource, reason: string): ModelSelection {
    return { requested: null, requestedSource: source, actual: null, source: "absent", explicitRequest: false, reason };
}

function emptyEffort(reason: string): EffortSelection {
    return {
        requested: null,
        requestedSource: "absent",
        actual: null,
        source: "absent",
        explicit: false,
        adjusted: false,
        reason,
    };
}

function finish(
    catalogFree: boolean,
    ready: boolean,
    modelSelection: ModelSelection,
    effortSelection: EffortSelection,
    diagnostics: Diagnostic[],
    launch?: { model?: string; thinking?: ThinkingLevel },
): ModelDecision {
    return {
        status: ready ? "ready" : "blocked",
        catalogFree,
        launch: ready ? compactLaunch(launch) : null,
        modelSelection,
        effortSelection,
        diagnostics,
        automaticRetry: false,
        substitutionAfterStart: false,
        availabilityIsStartupGuarantee: false,
        startupFailure: STARTUP_FAILURE_POLICY,
    };
}

function problem(
    effective: EffectiveDefinition | undefined,
    code: string,
    message: string,
    blocking: boolean,
    field: string,
    severity: Diagnostic["severity"] = blocking ? "error" : "info",
): Diagnostic {
    return {
        severity,
        code,
        message,
        id: effective?.id,
        path: effective?.source?.path,
        scope: effective?.source?.scope,
        field,
        blocking,
        structural: false,
    };
}
