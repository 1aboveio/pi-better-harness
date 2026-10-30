/** Pi adapter for the portable catalog resolver. */
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import * as core from "./model-resolution-core.ts";
import type { CatalogSnapshot } from "./catalog-store.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./thinking.ts";

export * from "./model-resolution-core.ts";

export function supportedEfforts(model: core.ResolvableModel): ThinkingLevel[] {
    const levels = getSupportedThinkingLevels(model as Model<Api>);
    return THINKING_LEVELS.filter((level) => levels.includes(level));
}

function context<T extends core.ModelResolutionContext>(input: T): T {
    return { ...input, effortSupport: input.effortSupport ?? supportedEfforts };
}

export function resolveModel(input: core.ResolveModelInput): core.ModelDecision {
    return core.resolveModel(context(input));
}

export function assessSelection(
    snapshot: CatalogSnapshot,
    selector: { agentId?: string; roleId?: string },
    input: core.ModelResolutionContext,
): core.CatalogResolutionAttachment {
    return core.assessSelection(snapshot, selector, context(input));
}

export function assessCatalog(snapshot: CatalogSnapshot, input: core.ModelResolutionContext): core.CatalogResolutionAttachment[] {
    return core.assessCatalog(snapshot, context(input));
}