/**
 * `/agents` skill edits persisted through the catalog's definition save path.
 *
 * Skill exposure belongs to `defaults.skills` (roles) and `overrides.skills`
 * (named agents), so unlike model and effort it is not a settings.json
 * preference: changing it must rewrite that definition through
 * `saveDefinition`. The edit is surgical. The prompt, description, and every
 * other preference stay as they were, and `inherit` deletes the key instead of
 * writing a null or copying an inherited value back into the file.
 *
 * A bundled definition is immutable. Editing its skills writes a personal
 * definition with the bundled content unchanged except for the skill value;
 * that is the catalog's existing whole-definition override mechanism. An
 * untrusted project never reaches this code because its definitions are not
 * loaded at all.
 */
import {
    applySkillExposure,
    definitionSkillPreference,
    type CatalogDefinition,
    type SkillExposureEdit,
} from "./catalog-schema.ts";
import { loadCatalog, saveDefinition, type LoadCatalogInput } from "./catalog-store.ts";

export interface SkillDefinitionTarget {
    id: string;
    /** The winning source shown when the screen opened; catches a stale edit. */
    winningSource?: { path: string; contentDigest: string };
}

export interface SkillSaveResult {
    ok: boolean;
    message: string;
    path?: string;
    scope?: "user" | "project";
}

function sameSkillValue(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
    if (left === undefined || right === undefined) return left === right;
    if (left === null || right === null) return left === right;
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function actionLabel(edit: SkillExposureEdit): string {
    if (edit.mode === "inherit") return "inherit";
    if (edit.mode === "none") return "none (--no-skills)";
    return `${edit.paths.length} selected`;
}

function alreadyMessage(definition: CatalogDefinition, edit: SkillExposureEdit): string {
    if (edit.mode === "inherit") {
        return definition.kind === "role"
            ? `Skills already inherit for ${definition.id}; nothing was written.`
            : `Skills already inherit the base role for ${definition.id}; nothing was written.`;
    }
    return `Skills already ${actionLabel(edit)} for ${definition.id}; nothing was written.`;
}

/**
 * Save one skill choice for the definition behind an `/agents` screen.
 *
 * Returns `ok: false` without writing when the screen is stale, the definition
 * is not structurally valid, or the definition save refuses the scope. The
 * caller keeps its screen and reports the message.
 */
export function saveSkillExposure(
    input: LoadCatalogInput & { entry: SkillDefinitionTarget },
    edit: SkillExposureEdit,
): SkillSaveResult {
    try {
        const snapshot = loadCatalog(input);
        const entry = snapshot.roles.get(input.entry.id) ?? snapshot.agents.get(input.entry.id);
        if (!entry?.definition || !entry.structurallyValid || entry.duplicate) {
            throw new Error(`Cannot save skills for ${input.entry.id}: repair the catalog definition first. Nothing changed.`);
        }
        const source = input.entry.winningSource;
        if (!source) throw new Error(`Cannot save skills for ${input.entry.id}: the definition source is unavailable. Reopen its settings.`);
        if (source.path !== entry.path || source.contentDigest !== entry.contentDigest) {
            throw new Error(`${input.entry.id} changed since this screen opened. Reopen its settings. Nothing changed.`);
        }

        const before = definitionSkillPreference(entry.definition);
        const next = applySkillExposure(entry.definition, edit);
        const after = definitionSkillPreference(next);
        if (sameSkillValue(before, after)) return { ok: true, message: alreadyMessage(entry.definition, edit) };

        const scope = entry.scope === "project" ? "project" : "user";
        const copiedFromBundled = entry.scope === "bundled";
        const saved = saveDefinition({
            ...input,
            definition: next,
            scope,
            replace: true,
        });
        if (!saved.ok || !saved.path) {
            throw new Error(saved.diagnostics.map((item) => item.message).join(" ") || `The ${scope} definition was not written.`);
        }

        const reloaded = loadCatalog(input);
        const persisted = reloaded.roles.get(entry.id) ?? reloaded.agents.get(entry.id);
        const reloadedValue = persisted?.definition ? definitionSkillPreference(persisted.definition) : undefined;
        if (!persisted || !persisted.structurallyValid || !sameSkillValue(reloadedValue, after)) {
            throw new Error(`Saved ${saved.path}, but the reloaded catalog did not report that skill value. Reopen its settings before relying on it.`);
        }

        const prefix = copiedFromBundled ? "Personal definition saved" : "Skills saved";
        return {
            ok: true,
            path: saved.path,
            scope: saved.scope,
            message: `${prefix} (${saved.scope}): ${entry.id} · ${actionLabel(edit)}`,
        };
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
}
