// Generated fixed launch domain from packages/pi-better-subagents/model-resolution.ts. Do not edit directly.
/** Pi adapter for the portable catalog resolver. */
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import * as core from "./model-resolution-core.domain.mjs";
import { THINKING_LEVELS } from "./thinking.domain.mjs";
export * from "./model-resolution-core.domain.mjs";
export function supportedEfforts(model) {
    const levels = getSupportedThinkingLevels(model);
    return THINKING_LEVELS.filter((level) => levels.includes(level));
}
function context(input) {
    return { ...input, effortSupport: input.effortSupport ?? supportedEfforts };
}
export function resolveModel(input) {
    return core.resolveModel(context(input));
}
export function assessSelection(snapshot, selector, input) {
    return core.assessSelection(snapshot, selector, context(input));
}
export function assessCatalog(snapshot, input) {
    return core.assessCatalog(snapshot, context(input));
}
