/**
 * Skill exposure for one subagent launch (#664).
 *
 * A child launched by `subagent_spawn` otherwise inherits the whole user-level
 * skills catalog, which is most of a long system prompt even when the task names
 * the one `SKILL.md` it needs by path. Pi's CLI has exactly three observable
 * states, and this module maps a launch onto them:
 *
 * | Choice | Child argv | Meaning |
 * | --- | --- | --- |
 * | absent | (no flag) | discovery of the user catalog |
 * | `[]` | `--no-skills` | no skills at all |
 * | `["/abs/SKILL.md", …]` | `--no-skills --skill <path>…` | exactly those skills |
 *
 * An absent value therefore means "inherit", an empty array means "none", and a
 * non-empty array means "exactly these". The three cases stay distinct because
 * `[]` is a real choice, not a missing one.
 *
 * `exclude_skills` is deliberately not part of this contract: Pi cannot remove a
 * single entry from a discovered catalog without also taking over discovery.
 */
import { isAbsolute, resolve } from "node:path";

export type SkillExposureMode = "inherit" | "none" | "explicit";

/**
 * Where the effective choice came from. `recipe` is a continuation replaying a
 * frozen launch, and `default` is the ultimate fallback: discovery.
 */
export type SkillExposureSource = "launch" | "catalog" | "session" | "config" | "default" | "recipe";

export interface SkillExposure {
    mode: SkillExposureMode;
    /** Absolute paths, in the order the flag appears. Empty unless `explicit`. */
    paths: readonly string[];
    source: SkillExposureSource;
}

export interface ConfiguredSkillExposure {
    mode: SkillExposureMode;
    paths: string[];
    /** `config` when the key is present (including null/[]), `default` when absent. */
    source: "config" | "default";
}

/**
 * Turn the saved global `defaultSkills` value into the same three states a
 * launch uses. An absent key and `null` both mean discovery; `[]` is the
 * explicit "none" choice and paths are exactly those skills.
 */
export function configuredSkillExposure(value: unknown): ConfiguredSkillExposure {
    if (value === undefined) return { mode: "inherit", paths: [], source: "default" };
    const paths = normalizeSkillExposure(value, "config defaultSkills");
    if (paths === undefined) return { mode: "inherit", paths: [], source: "config" };
    if (paths.length === 0) return { mode: "none", paths: [], source: "config" };
    return { mode: "explicit", paths, source: "config" };
}

export interface SkillExposureInput {
    /**
     * Present only on a continuation. The frozen recipe decides, including its
     * absence: a recipe that recorded no `skills` keeps discovery instead of
     * picking up a catalog or config choice that appeared later.
     */
    saved?: { paths?: readonly string[] };
    /** Per-launch (or batch-merged) `skills` option. */
    requested?: unknown;
    /** Catalog role/agent choice for this launch. */
    catalog?: unknown;
    /**
     * A current-session override. Presence is the choice: `{}` means discovery,
     * `{ value: [] }` means none, and `{ value: paths }` means exactly those.
     * It must beat the saved config without reopening discovery.
     */
    session?: { value?: unknown };
    /** Global `defaultSkills` from the subagent config. */
    configured?: unknown;
    /** Workspace the child runs in; relative paths are resolved against it. */
    cwd?: string;
}

const LABELS = {
    launch: "skills",
    catalog: "the catalog definition's skills",
    session: "session skills default",
    config: "config defaultSkills",
} as const;

/**
 * Shape-only validation: `undefined`/`null` mean "not set", and an array of
 * non-empty strings is accepted as written. Absolutizing happens later, because
 * the workspace a relative path belongs to is only known once it is resolved.
 */
export function normalizeSkillExposure(value: unknown, label: string): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) {
        throw new Error(
            `${label} must be an array of absolute paths to a SKILL.md file or a skill directory. ` +
            `Omit it to inherit skill discovery, or pass [] to load no skills.`,
        );
    }
    return value.map((entry, index) => {
        if (typeof entry !== "string" || entry.trim() === "") {
            throw new Error(
                `${label}[${index}] must be a non-empty path to a SKILL.md file or a skill directory.`,
            );
        }
        return entry.trim();
    });
}

/** Resolve paths against the child's workspace so a frozen recipe replays the same files. */
export function absolutizeSkillPaths(paths: readonly string[], cwd: string | undefined): string[] {
    return paths.map((path) => {
        if (cwd === undefined) return isAbsolute(path) ? resolve(path) : path;
        return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
    });
}

/**
 * Resolve the effective exposure for an attempt.
 *
 * Precedence, highest first: the frozen recipe (continuation), the launch
 * option, the catalog role/agent choice, the current-session default, the saved
 * global config default, discovery. Every level distinguishes "not set" from
 * `[]`; an absent session override falls through, a present one decides even
 * when it means discovery.
 */
export function resolveSkillExposure(input: SkillExposureInput): SkillExposure {
    if (input.saved) {
        // A recipe written before this option existed has no key at all. That is
        // the same "not set" the launch level uses, so it keeps discovery instead
        // of reading as an explicit "none".
        if (input.saved.paths === undefined) return { mode: "inherit", paths: [], source: "recipe" };
        return exposureFrom([...input.saved.paths], "recipe");
    }
    for (const source of ["launch", "catalog"] as const) {
        const value = source === "launch" ? input.requested : input.catalog;
        const normalized = normalizeSkillExposure(value, LABELS[source]);
        if (normalized === undefined) continue;
        return exposureFrom(absolutizeSkillPaths(normalized, input.cwd), source);
    }
    if (input.session) {
        const normalized = normalizeSkillExposure(input.session.value, LABELS.session);
        if (normalized === undefined) return { mode: "inherit", paths: [], source: "session" };
        return exposureFrom(absolutizeSkillPaths(normalized, input.cwd), "session");
    }
    const configured = normalizeSkillExposure(input.configured, LABELS.config);
    if (configured !== undefined) return exposureFrom(absolutizeSkillPaths(configured, input.cwd), "config");
    return { mode: "inherit", paths: [], source: "default" };
}

function exposureFrom(paths: readonly string[], source: SkillExposureSource): SkillExposure {
    if (paths.length === 0) return { mode: "none", paths: [], source };
    return { mode: "explicit", paths, source };
}

/**
 * The child's argv for this exposure, in flag order.
 *
 * `inherit` emits nothing at all, which is what keeps every existing launch
 * byte-identical. The other two states always disable discovery first; Pi merges
 * `--skill` into that reduced set rather than re-enabling discovery.
 */
export function skillLaunchArgs(exposure: SkillExposure): string[] {
    if (exposure.mode === "inherit") return [];
    return ["--no-skills", ...exposure.paths.flatMap((path) => ["--skill", path])];
}

/** One line for a launch confirmation or a continuation message. */
export function describeSkillExposure(exposure: SkillExposure): string {
    if (exposure.mode === "inherit") {
        // An ordinary launch chose nothing, so naming a source would only add
        // noise. A session override that chose discovery is different: the user
        // needs to see that the saved path list is not in effect.
        const source = exposure.source === "session" ? " · source session" : "";
        return `Skills: discovery (user catalog)${source}`;
    }
    const detail = exposure.mode === "none"
        ? "none (--no-skills)"
        : `${exposure.paths.length} explicit (${exposure.paths.join(", ")})`;
    return `Skills: ${detail} · source ${exposure.source}`;
}
