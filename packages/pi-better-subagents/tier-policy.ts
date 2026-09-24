/**
 * Catalog tier policy for default-model fallback.
 *
 * Membership and candidate order are explicit configuration. This module does
 * not infer that two model names are interchangeable, and it does not add
 * cross-provider substitutes. The approved DEV-23 roles name a tier; they do
 * not name a fallback list, so the built-in candidate lists stay empty.
 */
export interface TierCandidate {
    /** `provider/model` id. Providerless strings are not candidates. */
    model: string;
    /**
     * Required when this candidate's provider differs from the unavailable
     * preferred model. Same-provider candidates do not need it. A string
     * candidate never opts in.
     */
    crossProvider?: boolean;
}

export type TierCandidateInput = string | TierCandidate;

export interface TierSpec {
    /** Models that belong to this tier. Not an ordered fallback list. */
    members: readonly string[];
    /** First eligible available entry wins. Empty means no substitution. */
    candidates: readonly TierCandidateInput[];
}

export interface TierPolicy {
    tiers: Readonly<Record<string, TierSpec>>;
}

export interface NormalizedTierCandidate {
    model: string;
    provider: string;
    id: string;
    crossProvider: boolean;
}

export interface NormalizedTierSpec {
    members: readonly string[];
    candidates: readonly NormalizedTierCandidate[];
}

export interface NormalizedTierPolicy {
    tiers: Readonly<Record<string, NormalizedTierSpec>>;
    /** Dropped while normalizing. Resolution does not invent replacements. */
    ignored: readonly string[];
}

/**
 * Approved model membership only. `openai/gpt-6-sol`, `openai/gpt-6-luna`, and
 * `openai/gpt-6-astra` are not fallbacks for each other.
 */
export const DEFAULT_TIER_POLICY = {
    tiers: {
        efficient: { members: ["openai/gpt-6-luna"], candidates: [] },
        balanced: { members: ["openai/gpt-6-sol"], candidates: [] },
        frontier: { members: ["openai/gpt-6-astra"], candidates: [] },
    },
} as const satisfies TierPolicy;

/** Replace named tiers. Unmentioned built-in tiers stay as in `base`. */
export function configureTierPolicy(
    overrides: Readonly<Record<string, TierSpec>>,
    base: TierPolicy = DEFAULT_TIER_POLICY,
): TierPolicy {
    return {
        tiers: {
            ...base.tiers,
            ...overrides,
        },
    };
}

export function normalizeTierPolicy(policy: TierPolicy = DEFAULT_TIER_POLICY): NormalizedTierPolicy {
    const tiers: Record<string, NormalizedTierSpec> = {};
    const ignored: string[] = [];
    const names = Object.keys(policy.tiers).sort();
    for (const name of names) {
        const spec = policy.tiers[name];
        if (!spec || typeof spec !== "object") {
            ignored.push(`tier ${name} is not a membership/candidate spec`);
            continue;
        }
        const members: string[] = [];
        const seenMembers = new Set<string>();
        for (const member of spec.members ?? []) {
            const model = typeof member === "string" ? member.trim() : "";
            if (!model || seenMembers.has(model)) {
                if (member !== undefined && !model) ignored.push(`tier ${name} dropped an empty member`);
                continue;
            }
            seenMembers.add(model);
            members.push(model);
        }
        const candidates: NormalizedTierCandidate[] = [];
        const seenCandidates = new Set<string>();
        for (const candidate of spec.candidates ?? []) {
            const parsed = normalizeCandidate(candidate);
            if (!parsed) {
                ignored.push(`tier ${name} dropped a candidate that is not provider/model`);
                continue;
            }
            if (seenCandidates.has(parsed.model)) continue;
            seenCandidates.add(parsed.model);
            candidates.push(parsed);
        }
        tiers[name] = { members, candidates };
    }
    return { tiers, ignored };
}

function normalizeCandidate(candidate: TierCandidateInput): NormalizedTierCandidate | undefined {
    const model = typeof candidate === "string" ? candidate.trim() : candidate?.model?.trim();
    const crossProvider = typeof candidate === "string" ? false : candidate?.crossProvider === true;
    if (!model) return undefined;
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) return undefined;
    return {
        model,
        provider: model.slice(0, slash),
        id: model.slice(slash + 1),
        crossProvider,
    };
}
