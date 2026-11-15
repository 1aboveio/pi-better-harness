/**
 * Model choices for the agent catalog's session-settings picker.
 *
 * Pi scopes model selection with `--models` / `enabledModels` and exposes the
 * resolved set to extensions as `ctx.scopedModels`. Pi's contract for that
 * field (pi-coding-agent extension types): "Empty when no scoping is
 * configured (all available models are usable)." Pi's own `/model` selector
 * applies the same rule: it starts in the `scoped` view when the resolved set
 * is non-empty and in the `all` view when it is empty.
 *
 * The catalog picker follows those semantics, because an agent's model is a
 * per-session preference rather than a second model policy:
 *
 * - non-empty scope: offer exactly the scoped models, in the order the session
 *   configured them;
 * - empty scope: nothing is restricted, so fall back to the foreground
 *   registry's available models, which is what the picker offered before
 *   scoping existed.
 *
 * A saved preference outside the scope is never rewritten: it stays on the
 * definition and in the detail view, but the picker does not offer it, so the
 * scope is the only source of selectable models. Only in the no-scope fallback
 * does the current value stay in the list when it is no longer available, which
 * is what the picker did before scoping existed. Nothing here validates or
 * restricts launches: catalog and launch resolution keep using the value they
 * already had.
 */

/** Structural view of one `ctx.scopedModels` entry (`{ model, thinkingLevel? }`). */
export interface ScopedModelLike {
    readonly model?: { readonly provider?: unknown; readonly id?: unknown } | null;
    readonly provider?: unknown;
    readonly id?: unknown;
}

export type CatalogModelScope = "scoped" | "all";

export interface CatalogModelChoices {
    /** Values the picker offers, in display order. */
    values: string[];
    /** `scoped` when the session restricts models; `all` when the fallback applies. */
    scope: CatalogModelScope;
    /** True when no session scope was configured and available models were used. */
    fallback: boolean;
    /**
     * Saved value the offered set does not contain. Scoped mode leaves it out of
     * `values`; the no-scope fallback keeps it in `values` so it stays selectable.
     */
    retained?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function referencePart(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Canonical `provider/model` reference for a scoped model entry.
 * Accepts `{ model: { provider, id } }` (Pi's shape) and a bare
 * `{ provider, id }` so callers can pass either.
 */
export function modelReference(entry: unknown): string | undefined {
    const record = asRecord(entry);
    if (!record) return undefined;
    const scoped = asRecord(record.model) ?? record;
    const provider = referencePart(scoped.provider);
    const id = referencePart(scoped.id);
    return provider && id ? `${provider}/${id}` : undefined;
}

/** Scoped model references, in session order, with malformed and duplicate entries dropped. */
export function scopedModelReferences(scoped: readonly unknown[] | null | undefined): string[] {
    const seen = new Set<string>();
    const references: string[] = [];
    for (const entry of scoped ?? []) {
        const reference = modelReference(entry);
        if (!reference || seen.has(reference)) continue;
        seen.add(reference);
        references.push(reference);
    }
    return references;
}

/**
 * Picker choices for the model field.
 *
 * `scoped` is the session scope (`ctx.scopedModels`); `available` is the
 * foreground registry's available models used only when the scope is empty;
 * `current` is the saved catalog/session value, reported through `retained`
 * when the offered set does not contain it.
 */
export function catalogModelChoices(input: {
    scoped?: readonly unknown[] | null;
    available?: readonly string[] | null;
    current?: string | null;
}): CatalogModelChoices {
    const scoped = scopedModelReferences(input.scoped);
    const fallback = scoped.length === 0;
    const values = fallback
        ? [...new Set((input.available ?? []).map((value) => value.trim()).filter((value) => value.length > 0))].sort()
        : [...scoped];
    const current = referencePart(input.current);
    const retained = current && !values.includes(current) ? current : undefined;
    if (retained && fallback) values.push(retained);
    return { values, scope: fallback ? "all" : "scoped", fallback, ...(retained ? { retained } : {}) };
}

/** One-line note above the model list explaining where the options come from. */
export function catalogModelScopeLabel(choices: CatalogModelChoices): string {
    if (choices.fallback) return "All available models \u00b7 no session scope";
    const count = choices.values.length;
    const scope = `Session model scope \u00b7 ${count} model${count === 1 ? "" : "s"}`;
    return choices.retained ? `${scope} \u00b7 saved value is outside this scope` : scope;
}

/** Option label; only the retained saved value of the no-scope fallback is annotated. */
export function catalogModelOptionLabel(choices: CatalogModelChoices, value: string): string {
    if (choices.scope !== "all" || !choices.retained || value !== choices.retained) return value;
    return `${value} \u00b7 saved, unavailable`;
}
