/**
 * Foreground write policy: which directory is writable, and which concrete
 * paths stay non-writable inside it.
 *
 * The mechanism (backends, profiles, argv wrapping) lives in `sandbox-core`.
 * This module owns the product decisions layered on top of it: the packaged
 * deny defaults, how a rule template resolves against a project, and which
 * launch directories are too broad to confine usefully.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";

import { canonicalizePath, type SandboxSeams } from "./shared-sandbox-core.ts";

/**
 * Paths that stay non-writable inside every project root, shipped in source.
 *
 * Entries are `PROJECT_ROOT`-relative templates, so the same relative path is
 * denied in every project. Persisting and editing this set is not this module's
 * job — it hands out the packaged defaults and resolves whatever set it is
 * given.
 */
export const PACKAGED_DENY_WRITE_TEMPLATES: readonly string[] = Object.freeze([
    ".git/hooks",
    ".env",
    ".env.local",
]);

/** Seams for resolving a policy without touching the real home or filesystem. */
export type PolicySeams = SandboxSeams & {
    /** Defaults to `os.homedir()`. */
    home?: () => string;
};

function homeOf(seams: PolicySeams): string {
    return (seams.home ?? homedir)();
}

/**
 * Resolve one deny-write template against a project root.
 *
 * `~` resolves against the user's home, an absolute entry is taken as written,
 * and everything else resolves against `PROJECT_ROOT`. The result is
 * canonicalized so a symlinked alias cannot slip past the same rule.
 */
export function resolveDenyWriteTemplate(
    template: string,
    projectRoot: string,
    seams: PolicySeams = {},
): string {
    const trimmed = template.trim();
    if (trimmed === "") throw new Error("A write-denied path may not be empty.");

    const home = homeOf(seams);
    let expanded = trimmed;
    if (trimmed === "~") expanded = home;
    else if (trimmed.startsWith(`~${sep}`)) expanded = resolve(home, trimmed.slice(2));

    const absolute = isAbsolute(expanded) ? expanded : resolve(projectRoot, expanded);
    return canonicalizePath(absolute, seams);
}

/** Resolve a whole deny-write template set against a project root. */
export function resolveDenyWriteTemplates(
    templates: readonly string[],
    projectRoot: string,
    seams: PolicySeams = {},
): string[] {
    return [
        ...new Set(templates.map((template) => resolveDenyWriteTemplate(template, projectRoot, seams))),
    ].sort();
}

/**
 * Launch directories that must never become the writable root.
 *
 * Confining writes to `/` or to the whole home directory would present the
 * sandbox as active while protecting nothing, so those launches fail closed
 * instead.
 */
export function unsafeProjectRoots(seams: PolicySeams = {}): string[] {
    const roots = [resolve(sep), homeOf(seams)];
    return [...new Set(roots.map((root) => canonicalizePath(root, seams)))];
}

/**
 * Explain why a canonical project root is too broad to confine, or return
 * `undefined` when it is a usable writable root.
 */
export function describeUnsafeProjectRoot(
    projectRoot: string,
    seams: PolicySeams = {},
): string | undefined {
    if (!unsafeProjectRoots(seams).includes(projectRoot)) return undefined;
    return [
        `The sandbox will not treat ${projectRoot} as a writable project root:`,
        "it is broad enough that confining writes to it would protect nothing.",
        "Relaunch pi from the directory you are actually working in, or disable",
        "the foreground sandbox on purpose with /sandbox off.",
    ].join(" ");
}
