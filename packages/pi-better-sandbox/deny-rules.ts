/**
 * The one place write-deny rules are validated, stored, and put into force.
 *
 * `/sandbox deny list|add|remove|reset` and the `/sandbox rules` page are two
 * presentations of this module and nothing else: neither validates a path,
 * touches the override file, or talks to the controller on its own. That is
 * what keeps the slash commands and the settings page from drifting apart.
 *
 * Three ideas carry the design.
 *
 * **Templates, not paths.** A rule is stored as the human typed it (normalized)
 * — `.env` stays relative, `~/.aws` stays home-relative, `/etc/hosts` stays
 * absolute — and is resolved against the open project every time it is applied
 * or displayed. That is what "one global template set, not a per-project
 * database" means: the same relative rule denies the same relative path in
 * every project, while the UI always shows the canonical absolute path it
 * currently resolves to.
 *
 * **Nothing is written until a rule changes.** Installing the package writes no
 * settings file; the packaged defaults live in source (`policy.ts`). The
 * override file appears on the first `add` or `remove`, and `reset` deletes it
 * again, which is exactly what "restore the defaults from the installed package
 * version" requires — a copy of the defaults on disk would go stale the next
 * time the package shipped different ones.
 *
 * **Validation reuses enforcement.** Every check below resolves through
 * `resolveDenyWriteTemplate` and decides containment with `evaluateWriteAccess`
 * — the same functions the write/edit guard and the kernel profile builders use
 * — so a rule can never be accepted by validation and then mean something else
 * to the sandbox.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import {
    PACKAGED_DENY_WRITE_TEMPLATES,
    type PolicySeams,
    resolveDenyWriteTemplate,
} from "./policy.ts";
import {
    type CompiledSandboxWritePolicy,
    evaluateWriteAccess,
} from "./shared-sandbox-core.ts";
import type { ForegroundSandboxController, ForegroundSandboxStatus } from "./state.ts";

/** The override file, alongside the extension settings pi's own example uses. */
export const DENY_RULES_FILE_NAME = "pi-better-sandbox.json";

/** Bumped only if the stored shape ever has to change incompatibly. */
export const DENY_RULES_FORMAT_VERSION = 1;

/** Why a rule change was refused. Every kind carries an actionable message. */
export type DenyRuleErrorKind =
    | "malformed"
    | "unsafe"
    | "duplicate"
    | "overlapping"
    | "unknown"
    | "no-project"
    | "unreadable-override";

/** A refused rule change. The message is written to be shown to the human. */
export class DenyRuleError extends Error {
    readonly kind: DenyRuleErrorKind;

    constructor(kind: DenyRuleErrorKind, message: string) {
        super(message);
        this.name = "DenyRuleError";
        this.kind = kind;
    }
}

/** One stored rule, together with what it currently denies in the open project. */
export type DenyRule = {
    /** As stored: relative, `~`-relative, or absolute. */
    readonly template: string;
    /** The canonical absolute path it resolves to in this project. */
    readonly path: string;
};

/** A stored rule that cannot be applied to the open project, and why. */
export type InertDenyRule = {
    readonly template: string;
    readonly reason: string;
};

/** Everything a surface needs to render the rule set after a read or a change. */
export type DenyRuleReport = {
    /** The stored template set, sorted. */
    readonly templates: readonly string[];
    /** Those templates resolved against the open project, sorted by path. */
    readonly rules: readonly DenyRule[];
    /** Templates held out of the effective policy for this project, and why. */
    readonly inert: readonly InertDenyRule[];
    /** Whether the rules come from the packaged defaults or a user override. */
    readonly origin: "packaged" | "override";
    /** Where the user override lives, whether or not it exists yet. */
    readonly overridePath: string;
    /** The effective sandbox status after the rules were applied. */
    readonly status: ForegroundSandboxStatus;
    /** One line describing what the caller just did. */
    readonly summary: string;
    /** Present when the override file exists but could not be understood. */
    readonly overrideProblem: string | undefined;
};

export type DenyRuleStoreSeams = {
    /**
     * The pi agent directory the override lives under. Defaults to the SDK's
     * `getAgentDir()` (`$PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Injected in
     * tests so no test ever reads or writes the developer's real pi state.
     */
    agentDir?: () => string;
};

export type DenyRuleSeams = PolicySeams & DenyRuleStoreSeams;

/** Where the user override lives. Reading it is the only reason to need this. */
export function denyRuleOverridePath(seams: DenyRuleStoreSeams = {}): string {
    return join((seams.agentDir ?? getAgentDir)(), "extensions", DENY_RULES_FILE_NAME);
}

/**
 * Normalize one entry into the template that will be stored.
 *
 * This is where malformed input is refused. Everything that survives is a
 * concrete path in one of the three supported shapes, with redundant `./`,
 * doubled separators, and a trailing separator removed so `.git/hooks/` and
 * `.git/hooks` can never both be stored as separate rules.
 */
export function normalizeDenyRuleTemplate(entry: string): string {
    const trimmed = entry.trim();
    if (trimmed === "") {
        throw new DenyRuleError("malformed", "A write-denied path may not be empty.");
    }
    if (/[\0\r\n]/.test(trimmed)) {
        throw new DenyRuleError(
            "malformed",
            "A write-denied path may not contain line breaks or null bytes.",
        );
    }
    if (/[*?[\]{}]/.test(trimmed)) {
        throw new DenyRuleError(
            "malformed",
            `Deny rules are concrete paths, not patterns, so "${trimmed}" would never match anything. Add the specific file or directory instead.`,
        );
    }
    if (trimmed === "~") return "~";
    if (trimmed.startsWith(`~${sep}`)) {
        const tail = trimTrailingSeparator(trimmed.slice(2));
        // `~/` and `~/.` are the home directory itself, spelled the long way.
        return tail === "." || tail === sep ? "~" : `~${sep}${tail}`;
    }
    return trimTrailingSeparator(trimmed);
}

function trimTrailingSeparator(value: string): string {
    const normalized = normalize(value);
    if (normalized === sep || normalized === "") return sep;
    return normalized.endsWith(sep) ? normalized.slice(0, -1) : normalized;
}

/**
 * Ask the enforcement rule itself whether one canonical rule denies one
 * canonical path.
 *
 * Borrowing `evaluateWriteAccess` rather than re-deriving containment is
 * deliberate: overlap detection and the write guard are then provably the same
 * predicate, so no rule can be accepted as distinct and later behave as a
 * duplicate.
 */
function ruleDenies(canonicalRule: string, canonicalTarget: string, seams: DenyRuleSeams): boolean {
    const policy: CompiledSandboxWritePolicy = {
        writableRoot: sep,
        denyWrite: [canonicalRule],
        home: sep,
    };
    return !evaluateWriteAccess(canonicalTarget, policy, seams).allowed;
}

/** Resolve a template set into displayable rules, sorted by effective path. */
export function describeDenyRules(
    templates: readonly string[],
    projectRoot: string,
    seams: DenyRuleSeams = {},
): DenyRule[] {
    return templates
        .map((template) => ({
            template,
            path: resolveDenyWriteTemplate(template, projectRoot, seams),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The template set with the rules that cannot apply to this project removed.
 *
 * A rule that resolves to the project root or one of its ancestors would deny
 * the entire writable root — every write in the project would fail and the
 * sandbox would look broken rather than protective. `add` refuses such a rule
 * outright, but a global template added in one project can become an ancestor
 * in another, so the set is filtered again on every load and the held-out rules
 * are reported instead of silently dropped.
 */
export function partitionDenyRules(
    templates: readonly string[],
    projectRoot: string,
    seams: DenyRuleSeams = {},
): { applicable: string[]; inert: InertDenyRule[] } {
    const applicable: string[] = [];
    const inert: InertDenyRule[] = [];
    for (const template of templates) {
        let path: string;
        try {
            path = resolveDenyWriteTemplate(template, projectRoot, seams);
        } catch (error) {
            inert.push({ template, reason: messageOf(error) });
            continue;
        }
        if (ruleDenies(path, projectRoot, seams)) {
            inert.push({
                template,
                reason: `it resolves to ${path}, which contains this project root, so applying it would make the whole project unwritable.`,
            });
            continue;
        }
        applicable.push(template);
    }
    return { applicable, inert };
}

/**
 * Validate an added rule against the rules already stored, and return the new
 * template set.
 *
 * Overlap is refused in both directions rather than silently subsumed: a rule
 * already covered by another is redundant, and a rule that would swallow
 * existing rules would quietly retire rules the human never named. Both errors
 * say which stored rule is in the way and what to do about it.
 */
export function planDenyRuleAddition(
    entry: string,
    templates: readonly string[],
    projectRoot: string,
    seams: DenyRuleSeams = {},
): { template: string; path: string; templates: string[] } {
    const template = normalizeDenyRuleTemplate(entry);
    const path = resolveDenyWriteTemplate(template, projectRoot, seams);

    if (ruleDenies(path, projectRoot, seams)) {
        throw new DenyRuleError(
            "unsafe",
            `${template} resolves to ${path}, which contains the project root ${projectRoot}. Denying it would make every write in the project fail. Deny a path inside the project instead, or use /sandbox off if you meant to turn protection off.`,
        );
    }

    for (const existing of describeDenyRules(templates, projectRoot, seams)) {
        if (existing.path === path) {
            throw new DenyRuleError(
                "duplicate",
                existing.template === template
                    ? `${path} is already write-denied by the rule ${template}.`
                    : `${template} resolves to ${path}, which the rule ${existing.template} already denies.`,
            );
        }
        if (ruleDenies(existing.path, path, seams)) {
            throw new DenyRuleError(
                "overlapping",
                `${path} is already inside the write-denied directory ${existing.path} (rule ${existing.template}), so the new rule would change nothing.`,
            );
        }
        if (ruleDenies(path, existing.path, seams)) {
            throw new DenyRuleError(
                "overlapping",
                `${path} would cover the narrower rule ${existing.template} (${existing.path}). Remove that rule first with /sandbox deny remove ${existing.template}, then add this one.`,
            );
        }
    }

    return { template, path, templates: [...templates, template].sort() };
}

/**
 * Validate a removal and return the new template set.
 *
 * A rule can be named either the way it is stored or by the canonical absolute
 * path the UI displays, because those are the two strings a human has actually
 * seen.
 */
export function planDenyRuleRemoval(
    entry: string,
    templates: readonly string[],
    projectRoot: string,
    seams: DenyRuleSeams = {},
): { template: string; path: string; templates: string[] } {
    const wanted = normalizeDenyRuleTemplate(entry);
    const rules = describeDenyRules(templates, projectRoot, seams);
    const wantedPath = tryResolve(wanted, projectRoot, seams);

    const match =
        rules.find((rule) => rule.template === wanted) ??
        (wantedPath === undefined ? undefined : rules.find((rule) => rule.path === wantedPath));

    if (match === undefined) {
        const known = rules.length === 0 ? "none" : rules.map((rule) => rule.template).join(", ");
        throw new DenyRuleError(
            "unknown",
            `${wanted} is not a write-deny rule. Current rules: ${known}.`,
        );
    }

    return {
        template: match.template,
        path: match.path,
        templates: templates.filter((template) => template !== match.template).sort(),
    };
}

function tryResolve(
    template: string,
    projectRoot: string,
    seams: DenyRuleSeams,
): string | undefined {
    try {
        return resolveDenyWriteTemplate(template, projectRoot, seams);
    } catch {
        return undefined;
    }
}

/** The persisted shape. Read defensively; every field is validated on load. */
type DenyRuleOverrideFile = {
    version: number;
    denyWrite: string[];
};

/**
 * Read the user override, or `undefined` when none exists.
 *
 * Throws `DenyRuleError("unreadable-override")` when the file exists but cannot
 * be understood. The caller keeps the packaged defaults in force and refuses to
 * overwrite the file until the human resets it, so a typo in a hand-edited
 * override is never silently converted into a lost rule set.
 */
export function readDenyRuleOverride(
    seams: DenyRuleStoreSeams = {},
): readonly string[] | undefined {
    const path = denyRuleOverridePath(seams);
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new DenyRuleError(
            "unreadable-override",
            `The write-deny override at ${path} could not be read: ${messageOf(error)}`,
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        throw new DenyRuleError(
            "unreadable-override",
            `The write-deny override at ${path} is not valid JSON: ${messageOf(error)}`,
        );
    }

    const denyWrite = (parsed as Partial<DenyRuleOverrideFile> | null)?.denyWrite;
    if (!Array.isArray(denyWrite) || denyWrite.some((entry) => typeof entry !== "string")) {
        throw new DenyRuleError(
            "unreadable-override",
            `The write-deny override at ${path} must contain a "denyWrite" array of path strings.`,
        );
    }

    // Entries are normalized on the way in so a hand-edited file behaves exactly
    // as the same paths typed at the command would.
    try {
        return denyWrite.map((entry) => normalizeDenyRuleTemplate(entry)).sort();
    } catch (error) {
        throw new DenyRuleError(
            "unreadable-override",
            `The write-deny override at ${path} contains an entry that is not a usable path: ${messageOf(error)}`,
        );
    }
}

/** Write the user override. This is the only thing that creates the file. */
export function writeDenyRuleOverride(
    templates: readonly string[],
    seams: DenyRuleStoreSeams = {},
): string {
    const path = denyRuleOverridePath(seams);
    mkdirSync(dirname(path), { recursive: true });
    const contents = `${JSON.stringify(
        { version: DENY_RULES_FORMAT_VERSION, denyWrite: [...templates].sort() } satisfies DenyRuleOverrideFile,
        undefined,
        2,
    )}\n`;
    // Written through a temporary file so a reader never observes a half-written
    // rule set, and a failed write leaves the previous rules intact.
    const pending = `${path}.${process.pid}.tmp`;
    writeFileSync(pending, contents, "utf8");
    renameSync(pending, path);
    return path;
}

/** Delete the user override. Returns whether there was one to delete. */
export function clearDenyRuleOverride(seams: DenyRuleStoreSeams = {}): boolean {
    const path = denyRuleOverridePath(seams);
    try {
        rmSync(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw new DenyRuleError(
            "unreadable-override",
            `The write-deny override at ${path} could not be removed: ${messageOf(error)}`,
        );
    }
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export type DenyRuleManagerDeps = {
    controller: ForegroundSandboxController;
    /** Called after every change so the footer and `pi.events` stay truthful. */
    onStateChange: (status: ForegroundSandboxStatus) => void;
    seams?: DenyRuleSeams;
};

/**
 * The rule set of one pi session: what is stored, what applies here, and what
 * the sandbox is currently enforcing.
 *
 * Every mutating method validates, persists, re-applies to the controller, and
 * announces — in that order — so a surface cannot perform three of those four
 * steps and leave the footer or a consuming extension describing rules that are
 * not in force.
 */
export class DenyRuleManager {
    readonly #controller: ForegroundSandboxController;
    readonly #onStateChange: (status: ForegroundSandboxStatus) => void;
    readonly #seams: DenyRuleSeams;
    #templates: readonly string[] = PACKAGED_DENY_WRITE_TEMPLATES;
    #origin: "packaged" | "override" = "packaged";
    #overrideProblem: string | undefined;

    constructor({ controller, onStateChange, seams = {} }: DenyRuleManagerDeps) {
        this.#controller = controller;
        this.#onStateChange = onStateChange;
        this.#seams = seams;
    }

    /**
     * Re-read the override and put the resulting rules into force.
     *
     * Called at every session start, after the controller has captured the
     * project root, because the same global template set resolves differently in
     * a different project.
     */
    load(): DenyRuleReport {
        try {
            const stored = readDenyRuleOverride(this.#seams);
            this.#templates = stored ?? PACKAGED_DENY_WRITE_TEMPLATES;
            this.#origin = stored === undefined ? "packaged" : "override";
            this.#overrideProblem = undefined;
        } catch (error) {
            // A broken override never reduces protection to nothing: the packaged
            // defaults stay in force and the problem is surfaced instead.
            this.#templates = PACKAGED_DENY_WRITE_TEMPLATES;
            this.#origin = "packaged";
            this.#overrideProblem = messageOf(error);
        }
        return this.#apply(
            this.#origin === "override"
                ? "Loaded the write-deny rules from your override."
                : "Using the packaged write-deny defaults.",
        );
    }

    /** The current rule set, without re-reading or changing anything. */
    report(): DenyRuleReport {
        return this.#describe(this.#summaryForListing());
    }

    /** Add one rule, persist the override, and put it into force. */
    add(entry: string): DenyRuleReport {
        this.#requireWritableOverride();
        const projectRoot = this.#requireProjectRoot();
        const plan = planDenyRuleAddition(entry, this.#templates, projectRoot, this.#seams);
        this.#persist(plan.templates);
        return this.#apply(`Write-denied ${plan.path} (rule ${plan.template}).`);
    }

    /** Remove one rule, persist the override, and put the change into force. */
    remove(entry: string): DenyRuleReport {
        this.#requireWritableOverride();
        const projectRoot = this.#requireProjectRoot();
        const plan = planDenyRuleRemoval(entry, this.#templates, projectRoot, this.#seams);
        this.#persist(plan.templates);
        return this.#apply(`Removed the write-deny rule ${plan.template} (${plan.path}).`);
    }

    /**
     * Drop the user override and restore the defaults shipped by the installed
     * package version.
     *
     * The defaults are read from source rather than from a copy on disk, so a
     * package upgrade that changes them is picked up by a reset.
     */
    reset(): DenyRuleReport {
        const removed = clearDenyRuleOverride(this.#seams);
        this.#templates = PACKAGED_DENY_WRITE_TEMPLATES;
        this.#origin = "packaged";
        this.#overrideProblem = undefined;
        return this.#apply(
            removed
                ? "Removed your write-deny override and restored the packaged defaults."
                : "There was no write-deny override; the packaged defaults were already in force.",
        );
    }

    /** Whether a user override currently exists. */
    hasOverride(): boolean {
        return this.#origin === "override";
    }

    #persist(templates: readonly string[]): void {
        writeDenyRuleOverride(templates, this.#seams);
        this.#templates = templates;
        this.#origin = "override";
    }

    #requireWritableOverride(): void {
        if (this.#overrideProblem === undefined) return;
        throw new DenyRuleError(
            "unreadable-override",
            `${this.#overrideProblem} The packaged defaults are in force. Fix that file by hand, or run /sandbox deny reset to discard it.`,
        );
    }

    #requireProjectRoot(): string {
        const projectRoot = this.#controller.status().projectRoot;
        if (projectRoot === undefined) {
            throw new DenyRuleError(
                "no-project",
                "No session has captured a project root yet, so a rule cannot be resolved or displayed.",
            );
        }
        return projectRoot;
    }

    /** Recompute what applies here, hand it to the controller, and announce. */
    #apply(summary: string): DenyRuleReport {
        const status = this.#controller.setDenyWriteTemplates(this.#partition().applicable);
        this.#onStateChange(status);
        return this.#describe(summary);
    }

    /**
     * Describe the rule set exactly as it is being enforced.
     *
     * `rules` holds only what is actually in force here and `inert` holds the
     * rest, so no surface can show a stored rule as if it were protecting
     * something when it is not.
     */
    #describe(summary: string): DenyRuleReport {
        const status = this.#controller.status();
        const partition = this.#partition();
        return Object.freeze({
            templates: Object.freeze([...this.#templates].sort()),
            rules: Object.freeze(
                status.projectRoot === undefined
                    ? []
                    : describeDenyRules(partition.applicable, status.projectRoot, this.#seams),
            ),
            inert: Object.freeze(partition.inert),
            origin: this.#origin,
            overridePath: denyRuleOverridePath(this.#seams),
            status,
            summary,
            overrideProblem: this.#overrideProblem,
        });
    }

    #partition(): { applicable: string[]; inert: InertDenyRule[] } {
        const projectRoot = this.#controller.status().projectRoot;
        return projectRoot === undefined
            ? { applicable: [...this.#templates], inert: [] }
            : partitionDenyRules(this.#templates, projectRoot, this.#seams);
    }

    #summaryForListing(): string {
        return this.#origin === "override"
            ? `Write-deny rules from your override at ${denyRuleOverridePath(this.#seams)}.`
            : "Write-deny rules from the packaged defaults; no override has been created.";
    }
}

/** Render a rule set for `/sandbox deny list` and the `/sandbox` report. */
export function formatDenyRuleReport(report: DenyRuleReport): string {
    const lines = [report.summary, ""];
    if (report.rules.length === 0) lines.push("  (no write-denied paths)");
    else
        for (const rule of report.rules) {
            lines.push(rule.template === rule.path ? `  ${rule.path}` : `  ${rule.path}   [${rule.template}]`);
        }

    if (report.inert.length > 0) {
        lines.push("", "Not applied in this project:");
        for (const rule of report.inert) lines.push(`  ${rule.template} — ${rule.reason}`);
    }
    if (report.overrideProblem !== undefined) lines.push("", report.overrideProblem);
    return lines.join("\n");
}
