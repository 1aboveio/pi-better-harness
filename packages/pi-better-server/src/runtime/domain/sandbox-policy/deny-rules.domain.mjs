// Generated fixed launch domain from packages/pi-better-sandbox/deny-rules.ts. Do not edit directly.
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
 * override key appears on the first `add` or `remove`, and `reset` replaces it
 * with a null migration sentinel to restore defaults from the installed package
 * version — a copy of the defaults on disk would go stale the next
 * time the package shipped different ones.
 *
 * **Validation reuses enforcement.** Every check below resolves through
 * `resolveDenyWriteTemplate` and decides containment with `evaluateWriteAccess`
 * — the same functions the write/edit guard and the kernel profile builders use
 * — so a rule can never be accepted by validation and then mean something else
 * to the sandbox.
 */
import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "./shared-harness-settings.domain.mjs";
import { PACKAGED_DENY_WRITE_TEMPLATES, resolveDenyWriteTemplate, } from "./policy.domain.mjs";
import { evaluateWriteAccess, } from "./shared-sandbox-core.domain.mjs";
/** The legacy override filename, retained for migration only. */
export const DENY_RULES_FILE_NAME = "pi-better-sandbox.json";
/** Bumped only if the stored shape ever has to change incompatibly. */
export const DENY_RULES_FORMAT_VERSION = 1;
/** A refused rule change. The message is written to be shown to the human. */
export class DenyRuleError extends Error {
    kind;
    constructor(kind, message) {
        super(message);
        this.name = "DenyRuleError";
        this.kind = kind;
    }
}
/** Where the user override lives. Reading it is the only reason to need this. */
export function denyRuleOverridePath(seams = {}) {
    return harnessSettingsPath(seams);
}
function legacyDenyRuleOverridePath(seams) {
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
export function normalizeDenyRuleTemplate(entry) {
    const trimmed = entry.trim();
    if (trimmed === "") {
        throw new DenyRuleError("malformed", "A write-denied path may not be empty.");
    }
    if (/[\0\r\n]/.test(trimmed)) {
        throw new DenyRuleError("malformed", "A write-denied path may not contain line breaks or null bytes.");
    }
    if (/[*?[\]{}]/.test(trimmed)) {
        throw new DenyRuleError("malformed", `Deny rules are concrete paths, not patterns, so "${trimmed}" would never match anything. Add the specific file or directory instead.`);
    }
    if (trimmed === "~")
        return "~";
    if (trimmed.startsWith(`~${sep}`)) {
        const tail = trimTrailingSeparator(trimmed.slice(2));
        // `~/` and `~/.` are the home directory itself, spelled the long way.
        return tail === "." || tail === sep ? "~" : `~${sep}${tail}`;
    }
    return trimTrailingSeparator(trimmed);
}
function trimTrailingSeparator(value) {
    const normalized = normalize(value);
    if (normalized === sep || normalized === "")
        return sep;
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
function ruleDenies(canonicalRule, canonicalTarget, seams) {
    const policy = {
        writableRoot: sep,
        denyWrite: [canonicalRule],
        home: sep,
    };
    return !evaluateWriteAccess(canonicalTarget, policy, seams).allowed;
}
/** Resolve a template set into displayable rules, sorted by effective path. */
export function describeDenyRules(templates, projectRoot, seams = {}) {
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
export function partitionDenyRules(templates, projectRoot, seams = {}) {
    const applicable = [];
    const inert = [];
    for (const template of templates) {
        let path;
        try {
            path = resolveDenyWriteTemplate(template, projectRoot, seams);
        }
        catch (error) {
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
export function planDenyRuleAddition(entry, templates, projectRoot, seams = {}) {
    const template = normalizeDenyRuleTemplate(entry);
    const path = resolveDenyWriteTemplate(template, projectRoot, seams);
    if (ruleDenies(path, projectRoot, seams)) {
        throw new DenyRuleError("unsafe", `${template} resolves to ${path}, which contains the project root ${projectRoot}. Denying it would make every write in the project fail. Deny a path inside the project instead, or use /sandbox off if you meant to turn protection off.`);
    }
    for (const existing of describeDenyRules(templates, projectRoot, seams)) {
        if (existing.path === path) {
            throw new DenyRuleError("duplicate", existing.template === template
                ? `${path} is already write-denied by the rule ${template}.`
                : `${template} resolves to ${path}, which the rule ${existing.template} already denies.`);
        }
        if (ruleDenies(existing.path, path, seams)) {
            throw new DenyRuleError("overlapping", `${path} is already inside the write-denied directory ${existing.path} (rule ${existing.template}), so the new rule would change nothing.`);
        }
        if (ruleDenies(path, existing.path, seams)) {
            throw new DenyRuleError("overlapping", `${path} would cover the narrower rule ${existing.template} (${existing.path}). Remove that rule first with /sandbox deny remove ${existing.template}, then add this one.`);
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
export function planDenyRuleRemoval(entry, templates, projectRoot, seams = {}) {
    const wanted = normalizeDenyRuleTemplate(entry);
    const rules = describeDenyRules(templates, projectRoot, seams);
    const wantedPath = tryResolve(wanted, projectRoot, seams);
    const match = rules.find((rule) => rule.template === wanted) ??
        (wantedPath === undefined ? undefined : rules.find((rule) => rule.path === wantedPath));
    if (match === undefined) {
        const known = rules.length === 0 ? "none" : rules.map((rule) => rule.template).join(", ");
        throw new DenyRuleError("unknown", `${wanted} is not a write-deny rule. Current rules: ${known}.`);
    }
    return {
        template: match.template,
        path: match.path,
        templates: templates.filter((template) => template !== match.template).sort(),
    };
}
function tryResolve(template, projectRoot, seams) {
    try {
        return resolveDenyWriteTemplate(template, projectRoot, seams);
    }
    catch {
        return undefined;
    }
}
/**
 * Read the user override, or `undefined` when none exists.
 *
 * Throws `DenyRuleError("unreadable-override")` when the stored override cannot
 * be understood. The caller keeps the packaged defaults in force and refuses to
 * overwrite the override until the human resets it, so a typo in a hand-edited
 * override is never silently converted into a lost rule set.
 */
export function readDenyRuleOverride(seams = {}) {
    const path = denyRuleOverridePath(seams);
    try {
        const stored = readHarnessSetting("sandboxDenyRules", seams, {
            path: legacyDenyRuleOverridePath(seams),
            parse: (value) => ({ version: DENY_RULES_FORMAT_VERSION, denyWrite: parseDenyRuleOverride(value, path) }),
        });
        return stored === undefined || stored === null ? undefined : parseDenyRuleOverride(stored, path);
    }
    catch (error) {
        if (error instanceof DenyRuleError)
            throw error;
        throw new DenyRuleError("unreadable-override", `The write-deny override at ${path} could not be read: ${messageOf(error)}`);
    }
}
function parseDenyRuleOverride(parsed, path) {
    const denyWrite = parsed?.denyWrite;
    if (!Array.isArray(denyWrite) || denyWrite.some((entry) => typeof entry !== "string")) {
        throw new DenyRuleError("unreadable-override", `The write-deny override at ${path} must contain a "denyWrite" array of path strings.`);
    }
    // Entries are normalized on the way in so a hand-edited file behaves exactly
    // as the same paths typed at the command would.
    try {
        return denyWrite.map((entry) => normalizeDenyRuleTemplate(entry)).sort();
    }
    catch (error) {
        throw new DenyRuleError("unreadable-override", `The write-deny override at ${path} contains an entry that is not a usable path: ${messageOf(error)}`);
    }
}
/** Write the user override without changing any other global setting. */
export function writeDenyRuleOverride(templates, seams = {}) {
    const path = denyRuleOverridePath(seams);
    const value = { version: DENY_RULES_FORMAT_VERSION, denyWrite: [...templates].sort() };
    updateHarnessSetting("sandboxDenyRules", () => value, seams);
    return path;
}
/** Restore packaged rules; null prevents a retained legacy file from migrating again. */
export function clearDenyRuleOverride(seams = {}) {
    const path = denyRuleOverridePath(seams);
    try {
        const current = readHarnessSetting("sandboxDenyRules", seams);
        const legacyExists = existsSync(legacyDenyRuleOverridePath(seams));
        if (current === null || (current === undefined && !legacyExists))
            return false;
        let removed = false;
        updateHarnessSetting("sandboxDenyRules", (value) => {
            removed = value !== null && (value !== undefined || legacyExists);
            return null;
        }, seams);
        return removed;
    }
    catch (error) {
        throw new DenyRuleError("unreadable-override", `The write-deny override at ${path} could not be removed: ${messageOf(error)}`);
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
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
    #controller;
    #onStateChange;
    #seams;
    #templates = PACKAGED_DENY_WRITE_TEMPLATES;
    #origin = "packaged";
    #overrideProblem;
    constructor({ controller, onStateChange, seams = {} }) {
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
    load() {
        try {
            const stored = readDenyRuleOverride(this.#seams);
            this.#templates = stored ?? PACKAGED_DENY_WRITE_TEMPLATES;
            this.#origin = stored === undefined ? "packaged" : "override";
            this.#overrideProblem = undefined;
        }
        catch (error) {
            // A broken override never reduces protection to nothing: the packaged
            // defaults stay in force and the problem is surfaced instead.
            this.#templates = PACKAGED_DENY_WRITE_TEMPLATES;
            this.#origin = "packaged";
            this.#overrideProblem = messageOf(error);
        }
        return this.#apply(this.#origin === "override"
            ? "Loaded the write-deny rules from your override."
            : "Using the packaged write-deny defaults.");
    }
    /** The current rule set, without re-reading or changing anything. */
    report() {
        return this.#describe(this.#summaryForListing());
    }
    /** Add one rule, persist the override, and put it into force. */
    add(entry) {
        this.#requireWritableOverride();
        const projectRoot = this.#requireProjectRoot();
        const plan = planDenyRuleAddition(entry, this.#templates, projectRoot, this.#seams);
        this.#persist(plan.templates);
        return this.#apply(`Write-denied ${plan.path} (rule ${plan.template}).`);
    }
    /** Remove one rule, persist the override, and put the change into force. */
    remove(entry) {
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
    reset() {
        const removed = clearDenyRuleOverride(this.#seams);
        this.#templates = PACKAGED_DENY_WRITE_TEMPLATES;
        this.#origin = "packaged";
        this.#overrideProblem = undefined;
        return this.#apply(removed
            ? "Removed your write-deny override and restored the packaged defaults."
            : "There was no write-deny override; the packaged defaults were already in force.");
    }
    /** Whether a user override currently exists. */
    hasOverride() {
        return this.#origin === "override";
    }
    #persist(templates) {
        writeDenyRuleOverride(templates, this.#seams);
        this.#templates = templates;
        this.#origin = "override";
    }
    #requireWritableOverride() {
        if (this.#overrideProblem === undefined)
            return;
        throw new DenyRuleError("unreadable-override", `${this.#overrideProblem} The packaged defaults are in force. Fix that file by hand, or run /sandbox deny reset to discard it.`);
    }
    #requireProjectRoot() {
        const projectRoot = this.#controller.status().projectRoot;
        if (projectRoot === undefined) {
            throw new DenyRuleError("no-project", "No session has captured a project root yet, so a rule cannot be resolved or displayed.");
        }
        return projectRoot;
    }
    /** Recompute what applies here, hand it to the controller, and announce. */
    #apply(summary) {
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
    #describe(summary) {
        const status = this.#controller.status();
        const partition = this.#partition();
        return Object.freeze({
            templates: Object.freeze([...this.#templates].sort()),
            rules: Object.freeze(status.projectRoot === undefined
                ? []
                : describeDenyRules(partition.applicable, status.projectRoot, this.#seams)),
            inert: Object.freeze(partition.inert),
            origin: this.#origin,
            overridePath: denyRuleOverridePath(this.#seams),
            status,
            summary,
            overrideProblem: this.#overrideProblem,
        });
    }
    #partition() {
        const projectRoot = this.#controller.status().projectRoot;
        return projectRoot === undefined
            ? { applicable: [...this.#templates], inert: [] }
            : partitionDenyRules(this.#templates, projectRoot, this.#seams);
    }
    #summaryForListing() {
        return this.#origin === "override"
            ? `Write-deny rules from your override at ${denyRuleOverridePath(this.#seams)}.`
            : "Write-deny rules from the packaged defaults; no override has been created.";
    }
}
/** Render a rule set for `/sandbox deny list` and the `/sandbox` report. */
export function formatDenyRuleReport(report) {
    const lines = [report.summary, ""];
    if (report.rules.length === 0)
        lines.push("  (no write-denied paths)");
    else
        for (const rule of report.rules) {
            lines.push(rule.template === rule.path ? `  ${rule.path}` : `  ${rule.path}   [${rule.template}]`);
        }
    if (report.inert.length > 0) {
        lines.push("", "Not applied in this project:");
        for (const rule of report.inert)
            lines.push(`  ${rule.template} — ${rule.reason}`);
    }
    if (report.overrideProblem !== undefined)
        lines.push("", report.overrideProblem);
    return lines.join("\n");
}
