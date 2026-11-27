// Generated fixed launch domain from packages/pi-better-subagents/tier-policy.ts. Do not edit directly.
/**
 * Approved model membership only. `openai/gpt-6.1-sol`, `openai/gpt-6-luna`, and
 * `openai/gpt-6-astra` are not fallbacks for each other.
 */
export const DEFAULT_TIER_POLICY = {
    tiers: {
        efficient: { members: ["openai/gpt-6-luna"], candidates: [] },
        balanced: { members: ["openai/gpt-6.1-sol"], candidates: [] },
        frontier: { members: ["openai/gpt-6-astra"], candidates: [] },
    },
};
/** Replace named tiers. Unmentioned built-in tiers stay as in `base`. */
export function configureTierPolicy(overrides, base = DEFAULT_TIER_POLICY) {
    return {
        tiers: {
            ...base.tiers,
            ...overrides,
        },
    };
}
export function normalizeTierPolicy(policy = DEFAULT_TIER_POLICY) {
    const tiers = {};
    const ignored = [];
    const names = Object.keys(policy.tiers).sort();
    for (const name of names) {
        const spec = policy.tiers[name];
        if (!spec || typeof spec !== "object") {
            ignored.push(`tier ${name} is not a membership/candidate spec`);
            continue;
        }
        const members = [];
        const seenMembers = new Set();
        for (const member of spec.members ?? []) {
            const model = typeof member === "string" ? member.trim() : "";
            if (!model || seenMembers.has(model)) {
                if (member !== undefined && !model)
                    ignored.push(`tier ${name} dropped an empty member`);
                continue;
            }
            seenMembers.add(model);
            members.push(model);
        }
        const candidates = [];
        const seenCandidates = new Set();
        for (const candidate of spec.candidates ?? []) {
            const parsed = normalizeCandidate(candidate);
            if (!parsed) {
                ignored.push(`tier ${name} dropped a candidate that is not provider/model`);
                continue;
            }
            if (seenCandidates.has(parsed.model))
                continue;
            seenCandidates.add(parsed.model);
            candidates.push(parsed);
        }
        tiers[name] = { members, candidates };
    }
    return { tiers, ignored };
}
function normalizeCandidate(candidate) {
    const model = typeof candidate === "string" ? candidate.trim() : candidate?.model?.trim();
    const crossProvider = typeof candidate === "string" ? false : candidate?.crossProvider === true;
    if (!model)
        return undefined;
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1)
        return undefined;
    return {
        model,
        provider: model.slice(0, slash),
        id: model.slice(slash + 1),
        crossProvider,
    };
}
