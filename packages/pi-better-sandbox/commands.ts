/**
 * The `/sandbox` slash command.
 *
 * Sandbox state is human-only by construction: this is a slash command, and the
 * package registers no tool that can read or change it, so the model has no way
 * to disable its own confinement. Turning protection off additionally requires
 * an interactive confirmation and is refused outright without an interactive UI.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatSandboxReport } from "./status.ts";
import type { ForegroundSandboxController, ForegroundSandboxStatus } from "./state.ts";

export const SANDBOX_COMMAND_NAME = "sandbox";

export const SANDBOX_COMMAND_DESCRIPTION =
    "Show the foreground write sandbox, or turn it on or off for this session";

const USAGE = ["Usage:", "  /sandbox", "  /sandbox on", "  /sandbox off"].join("\n");

const DISABLE_TITLE = "Disable the foreground write sandbox?";

const DISABLE_MESSAGE = [
    "Built-in bash and ! / !! commands will run with normal host write access",
    "for the rest of this session. New, resumed, forked, and reloaded sessions",
    "start protected again.",
].join("\n");

const NO_UI_REJECTION =
    "/sandbox off needs an interactive confirmation and there is no interactive UI here, so the sandbox stays on.";

export type SandboxCommandDeps = {
    controller: ForegroundSandboxController;
    /** Called after any state change so the footer and consumers stay truthful. */
    onStateChange: (status: ForegroundSandboxStatus) => void;
};

/** Build the `/sandbox` handler. Exported so its behaviour is directly testable. */
export function createSandboxCommandHandler({ controller, onStateChange }: SandboxCommandDeps) {
    return async function handleSandboxCommand(
        args: string,
        ctx: ExtensionCommandContext,
    ): Promise<void> {
        const subcommand = args.trim().toLowerCase();

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
                    : `Foreground sandbox re-armed but not active: ${status.reason}`,
                status.state === "enabled" ? "info" : "warning",
            );
            return;
        }

        if (subcommand === "off") {
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

        ctx.ui.notify(`Unknown /sandbox subcommand: ${subcommand}\n\n${USAGE}`, "error");
    };
}

/** Argument completions for `/sandbox`. */
export function sandboxArgumentCompletions(argumentPrefix: string) {
    return ["on", "off"]
        .filter((value) => value.startsWith(argumentPrefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
}
