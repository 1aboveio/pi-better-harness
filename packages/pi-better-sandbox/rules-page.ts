/**
 * The `/sandbox rules` page.
 *
 * A compact keyboard-first editor for the write-deny rules: one selector
 * listing the rules in force in the open project, then any stored rule that
 * cannot apply here, then three actions (add, remove the highlighted rule,
 * restore the packaged defaults). Arrow keys and enter drive it; escape closes
 * it. Nothing here validates a path, reads or
 * writes the override, or touches the controller — every action is one call
 * into `DenyRuleManager`, the same object `/sandbox deny …` drives, which is
 * what makes the page and the commands incapable of disagreeing.
 *
 * The page is human-only in the same three ways the rest of the package is: it
 * is reachable only from a slash command, no tool is registered that can open
 * or drive it, and it refuses to run without an interactive UI rather than
 * silently applying a default answer.
 */

import { basename } from "node:path";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { DenyRuleError, type DenyRule, type DenyRuleManager, type DenyRuleReport } from "./deny-rules.ts";

const ADD_ACTION = "+ Add a write-denied path…";
const RESTORE_ACTION = "↺ Restore the packaged defaults";
const CLOSE_ACTION = "Close";

const ADD_PROMPT = "Deny writes to";
const ADD_PLACEHOLDER = "project-relative path, ~/path, or /absolute/path";

export const RULES_PAGE_NO_UI_REJECTION =
    "/sandbox rules needs an interactive UI. Use /sandbox deny list, add, remove, or reset instead.";

/**
 * Open the rules page and run it until the human closes it.
 *
 * Resolves once the page is closed. Every accepted change is already persisted
 * and in force by then, because the manager applies and announces before it
 * returns.
 */
export async function openSandboxRulesPage(
    manager: DenyRuleManager,
    ctx: ExtensionCommandContext,
): Promise<void> {
    if (!ctx.hasUI) {
        ctx.ui.notify(RULES_PAGE_NO_UI_REJECTION, "error");
        return;
    }

    let report = manager.report();
    for (;;) {
        // Rules in force first, then any stored rule that cannot apply here.
        // Both are selectable, because a stale global rule is exactly the kind a
        // human opens this page to delete.
        const choices = new Map<string, Row>();
        for (const rule of report.rules) choices.set(describeRule(rule), { template: rule.template, label: rule.path });
        for (const rule of report.inert) {
            choices.set(`${rule.template}   (not applied in this project)`, {
                template: rule.template,
                label: rule.template,
                inertReason: rule.reason,
            });
        }
        const options = [...choices.keys(), ADD_ACTION, RESTORE_ACTION, CLOSE_ACTION];

        // Escape returns undefined, which closes the page the same way Close does.
        const chosen = await ctx.ui.select(pageTitle(report), options);
        if (chosen === undefined || chosen === CLOSE_ACTION) return;

        if (chosen === ADD_ACTION) {
            report = (await addRule(manager, ctx)) ?? report;
            continue;
        }

        if (chosen === RESTORE_ACTION) {
            report = (await restoreDefaults(manager, ctx, report)) ?? report;
            continue;
        }

        const row = choices.get(chosen);
        if (row === undefined) continue;
        report = (await removeRule(manager, ctx, row)) ?? report;
    }
}

/** One selectable line: a rule in force, or a stored rule that is not. */
type Row = { template: string; label: string; inertReason?: string };

/** `<n> write-denied paths · <project> · packaged defaults | your override` */
function pageTitle(report: DenyRuleReport): string {
    const project = report.status.projectRoot;
    const count = report.rules.length;
    return [
        `${count} write-denied ${count === 1 ? "path" : "paths"}`,
        project === undefined ? undefined : basename(project),
        report.origin === "override" ? "your override" : "packaged defaults",
    ]
        .filter((part) => part !== undefined)
        .join(" · ");
}

/**
 * One rule as one line: the canonical absolute path it denies right now, and
 * the stored template when that differs, so a relative rule never looks like it
 * only applies here.
 */
function describeRule(rule: DenyRule): string {
    return rule.template === rule.path ? rule.path : `${rule.path}   [${rule.template}]`;
}

async function addRule(
    manager: DenyRuleManager,
    ctx: ExtensionCommandContext,
): Promise<DenyRuleReport | undefined> {
    const entry = await ctx.ui.input(ADD_PROMPT, ADD_PLACEHOLDER);
    if (entry === undefined || entry.trim() === "") return undefined;
    return applyChange(ctx, () => manager.add(entry));
}

async function removeRule(
    manager: DenyRuleManager,
    ctx: ExtensionCommandContext,
    row: Row,
): Promise<DenyRuleReport | undefined> {
    const confirmed = await ctx.ui.confirm(
        row.inertReason === undefined
            ? "Stop denying writes to this path?"
            : "Delete this rule from your global rule set?",
        row.inertReason === undefined
            ? `${row.label}\n\nOperations started after this will be able to write there again.`
            : `${row.label}\n\nIt is not applied here — ${row.inertReason} Deleting it removes it from every project.`,
    );
    if (!confirmed) return undefined;
    return applyChange(ctx, () => manager.remove(row.template));
}

async function restoreDefaults(
    manager: DenyRuleManager,
    ctx: ExtensionCommandContext,
    report: DenyRuleReport,
): Promise<DenyRuleReport | undefined> {
    if (report.origin !== "override" && report.overrideProblem === undefined) {
        ctx.ui.notify("The packaged defaults are already in force.", "info");
        return undefined;
    }
    const confirmed = await ctx.ui.confirm(
        "Restore the packaged write-deny defaults?",
        `Your override at ${report.overridePath} will be deleted and every rule you added or removed will be forgotten.`,
    );
    if (!confirmed) return undefined;
    return applyChange(ctx, () => manager.reset());
}

/**
 * Run one manager call, show the outcome, and keep the page open either way.
 *
 * A refused change is reported and the page is left showing the rules that are
 * really in force — never a hopeful view of the change that did not happen.
 */
function applyChange(
    ctx: ExtensionCommandContext,
    change: () => DenyRuleReport,
): DenyRuleReport | undefined {
    try {
        const report = change();
        ctx.ui.notify(report.summary, "info");
        return report;
    } catch (error) {
        if (error instanceof DenyRuleError) {
            ctx.ui.notify(error.message, "error");
            return undefined;
        }
        throw error;
    }
}
