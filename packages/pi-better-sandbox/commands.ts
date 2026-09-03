/**
 * The `/sandbox` slash command.
 *
 * Sandbox state is human-only by construction: this is a slash command, and the
 * package registers no tool that can read or change it, so the model has no way
 * to disable its own confinement or edit its own deny rules. Turning protection
 * off additionally requires an interactive confirmation and is refused outright
 * without an interactive UI.
 *
 * The `deny` subcommands and the `rules` page are two front ends over one
 * `DenyRuleManager`; this module only parses arguments and renders outcomes.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import {
    DenyRuleError,
    type DenyRuleManager,
    type DenyRuleReport,
    formatDenyRuleReport,
} from "./deny-rules.ts";
import { openSandboxRulesPage } from "./rules-page.ts";
import { formatSandboxReport } from "./status.ts";
import type { ForegroundSandboxController, ForegroundSandboxStatus } from "./state.ts";

export const SANDBOX_COMMAND_NAME = "sandbox";

export const SANDBOX_COMMAND_DESCRIPTION =
    "Show the foreground write sandbox, change session or persistent activation, or manage write-denied paths";

const USAGE = [
    "Usage:",
    "  /sandbox",
    "  /sandbox on",
    "  /sandbox off",
    "  /sandbox default on",
    "  /sandbox default off",
    "  /sandbox deny list",
    "  /sandbox deny add <path>",
    "  /sandbox deny remove <path>",
    "  /sandbox deny reset",
    "  /sandbox rules",
].join("\n");

const DENY_USAGE = [
    "Usage:",
    "  /sandbox deny list",
    "  /sandbox deny add <path>",
    "  /sandbox deny remove <path>",
    "  /sandbox deny reset",
].join("\n");

const DISABLE_TITLE = "Disable the foreground write sandbox?";

const DISABLE_MESSAGE = [
    "The built-in bash, write, and edit tools and user-entered ! / !! commands",
    "will run with normal host write access for the rest of this session. The",
    "next session applies your persisted foreground sandbox default.",
].join("\n");

const NO_UI_REJECTION =
    "/sandbox off needs an interactive confirmation and there is no interactive UI here, so the sandbox state is unchanged.";

const DEFAULT_OFF_TITLE = "Keep the foreground write sandbox off by default?";

const DEFAULT_OFF_MESSAGE = [
    "This session and future sessions will run foreground tools and local background",
    "tasks with normal host write access until you run /sandbox on or change the",
    "persistent default.",
].join("\n");

const RESET_TITLE = "Restore the packaged write-deny defaults?";

export type SandboxCommandDeps = {
    controller: ForegroundSandboxController;
    /** The one validation and persistence path for write-deny rules. */
    denyRules: DenyRuleManager;
    /** Called after any state change so the footer and consumers stay truthful. */
    onStateChange: (status: ForegroundSandboxStatus) => void;
    /** Persist a default and apply it to the current session. */
    setDefault: (enabled: boolean) => ForegroundSandboxStatus;
};

/** Build the `/sandbox` handler. Exported so its behaviour is directly testable. */
export function createSandboxCommandHandler({
    controller,
    denyRules,
    onStateChange,
    setDefault,
}: SandboxCommandDeps) {
    return async function handleSandboxCommand(
        args: string,
        ctx: ExtensionCommandContext,
    ): Promise<void> {
        // Only the verbs are case-folded. Everything after them is a path, and
        // paths are case-sensitive on the filesystems this package supports.
        const trimmed = args.trim();
        const [verb = "", ...tail] = trimmed.split(/\s+/);
        const subcommand = verb.toLowerCase();
        const rest = trimmed.slice(verb.length).trim();

        if (subcommand === "") {
            ctx.ui.notify(formatSandboxReport(controller.status()), "info");
            return;
        }

        if (subcommand === "on") {
            const status = controller.enable();
            onStateChange(status);
            ctx.ui.notify(
                status.state === "enabled"
                    ? `Foreground sandbox on. ${status.reason}`
                    : `Foreground sandbox requested but not active: ${status.reason}`,
                status.state === "enabled" ? "info" : "warning",
            );
            return;
        }

        if (subcommand === "off") {
            if (controller.status().state === "inactive") {
                ctx.ui.notify(
                    "Foreground sandbox is already inactive by default. Use /sandbox default on to opt in persistently.",
                    "info",
                );
                return;
            }
            if (!ctx.hasUI) {
                ctx.ui.notify(NO_UI_REJECTION, "error");
                return;
            }
            const confirmed = await ctx.ui.confirm(DISABLE_TITLE, DISABLE_MESSAGE);
            if (!confirmed) {
                ctx.ui.notify("Foreground sandbox left on.", "info");
                return;
            }
            const status = controller.disable();
            onStateChange(status);
            ctx.ui.notify(
                "Foreground sandbox OFF for this session. Shell commands can now write anywhere.",
                "warning",
            );
            return;
        }

        if (subcommand === "default") {
            const mode = tail[0]?.toLowerCase();
            if (mode !== "on" && mode !== "off") {
                ctx.ui.notify("/sandbox default needs on or off.\n\n" + USAGE, "error");
                return;
            }
            if (mode === "off") {
                if (!ctx.hasUI) {
                    ctx.ui.notify(
                        "/sandbox default off needs an interactive confirmation and there is no interactive UI here.",
                        "error",
                    );
                    return;
                }
                const confirmed = await ctx.ui.confirm(DEFAULT_OFF_TITLE, DEFAULT_OFF_MESSAGE);
                if (!confirmed) {
                    ctx.ui.notify("The sandbox default was left unchanged.", "info");
                    return;
                }
            }
            try {
                const status = setDefault(mode === "on");
                onStateChange(status);
                ctx.ui.notify(
                    mode === "on"
                        ? `Foreground sandbox default is ON. ${status.reason}`
                        : "Foreground sandbox default is off. Foreground tools and local background tasks are unconfined.",
                    mode === "on" && status.state !== "enabled" ? "warning" : "info",
                );
            } catch (error) {
                ctx.ui.notify(
                    `Could not save the sandbox default: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
            return;
        }

        if (subcommand === "deny") {
            await handleDeny(denyRules, ctx, tail[0]?.toLowerCase() ?? "list", rest);
            return;
        }

        if (subcommand === "rules") {
            await openSandboxRulesPage(denyRules, ctx);
            return;
        }

        ctx.ui.notify(`Unknown /sandbox subcommand: ${subcommand}\n\n${USAGE}`, "error");
    };
}

async function handleDeny(
    denyRules: DenyRuleManager,
    ctx: ExtensionCommandContext,
    action: string,
    rest: string,
): Promise<void> {
    // `rest` still carries the action word; the path is whatever follows it,
    // verbatim, so a path containing spaces survives intact.
    const argument = rest.slice(action.length).trim();

    if (action === "list") {
        ctx.ui.notify(formatDenyRuleReport(denyRules.report()), "info");
        return;
    }

    if (action === "add" || action === "remove") {
        if (argument === "") {
            ctx.ui.notify(`/sandbox deny ${action} needs a path.\n\n${DENY_USAGE}`, "error");
            return;
        }
        announce(ctx, () =>
            action === "add" ? denyRules.add(argument) : denyRules.remove(argument),
        );
        return;
    }

    if (action === "reset") {
        // Resetting discards rules the human wrote, so it is confirmed wherever
        // there is someone to confirm it.
        if (ctx.hasUI && denyRules.hasOverride()) {
            const confirmed = await ctx.ui.confirm(
                RESET_TITLE,
                "Every write-deny rule you added or removed will be forgotten.",
            );
            if (!confirmed) {
                ctx.ui.notify("Your write-deny rules were left as they are.", "info");
                return;
            }
        }
        announce(ctx, () => denyRules.reset());
        return;
    }

    ctx.ui.notify(`Unknown /sandbox deny action: ${action}\n\n${DENY_USAGE}`, "error");
}

/** Run one rule change and show either the new rule set or why it was refused. */
function announce(ctx: ExtensionCommandContext, change: () => DenyRuleReport): void {
    try {
        ctx.ui.notify(formatDenyRuleReport(change()), "info");
    } catch (error) {
        if (error instanceof DenyRuleError) {
            ctx.ui.notify(error.message, "error");
            return;
        }
        throw error;
    }
}

const SUBCOMMANDS = ["on", "off", "default", "deny", "rules"] as const;
const DENY_ACTIONS = ["list", "add", "remove", "reset"] as const;

/** Argument completions for `/sandbox`, including the `deny` actions. */
export function sandboxArgumentCompletions(argumentPrefix: string) {
    const prefix = argumentPrefix.trimStart().toLowerCase();
    const denyPrefix = /^deny(\s|$)/.test(prefix) ? prefix.replace(/^deny\s*/, "") : undefined;
    const defaultPrefix = /^default(\s|$)/.test(prefix)
        ? prefix.replace(/^default\s*/, "")
        : undefined;

    const values =
        denyPrefix !== undefined
            ? DENY_ACTIONS.filter((value) => value.startsWith(denyPrefix)).map(
                  (value) => `deny ${value}`,
              )
            : defaultPrefix !== undefined
              ? ["on", "off"]
                    .filter((value) => value.startsWith(defaultPrefix))
                    .map((value) => `default ${value}`)
              : SUBCOMMANDS.filter((value) => value.startsWith(prefix));

    return values.map((value) => ({ value, label: value }));
}
