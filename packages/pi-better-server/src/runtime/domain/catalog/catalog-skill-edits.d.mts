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
import { type SkillExposureEdit } from "./catalog-schema.mjs";
import { type LoadCatalogInput } from "./catalog-store.mjs";
export interface SkillDefinitionTarget {
    id: string;
    /** The winning source shown when the screen opened; catches a stale edit. */
    winningSource?: {
        path: string;
        contentDigest: string;
    };
}
export interface SkillSaveResult {
    ok: boolean;
    message: string;
    path?: string;
    scope?: "user" | "project";
}
/**
 * Save one skill choice for the definition behind an `/agents` screen.
 *
 * Returns `ok: false` without writing when the screen is stale, the definition
 * is not structurally valid, or the definition save refuses the scope. The
 * caller keeps its screen and reports the message.
 */
export declare function saveSkillExposure(input: LoadCatalogInput & {
    entry: SkillDefinitionTarget;
}, edit: SkillExposureEdit): SkillSaveResult;
