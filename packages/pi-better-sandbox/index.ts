/**
 * pi-better-sandbox - a default-on write sandbox for foreground shell execution.
 *
 * Installing this package loads an extension; it ships no launcher, so users
 * keep starting Pi with plain `pi`. While enabled, the built-in `bash` tool and
 * user-entered `!` / `!!` commands run under macOS Seatbelt or Linux Bubblewrap
 * with one writable root — the canonical directory Pi was launched from — and
 * the packaged write-denied paths carved back out of it. Reads and network are
 * untouched.
 *
 * This is a tool-execution sandbox. Pi's own process, `pi.exec` calls, and
 * unrelated third-party extension code are not confined by it.
 */

import {
    createBashToolDefinition,
    SettingsManager,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    createSandboxCommandHandler,
    SANDBOX_COMMAND_DESCRIPTION,
    SANDBOX_COMMAND_NAME,
    sandboxArgumentCompletions,
} from "./commands.ts";
import {
    FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
    publishForegroundSandboxPolicy,
} from "./events.ts";
import { createSandboxedBashOperations } from "./shell.ts";
import { footerTone, formatFooterStatus } from "./status.ts";
import { ForegroundSandboxController, type ForegroundSandboxStatus } from "./state.ts";

const FOOTER_KEY = "sandbox";

export default function piBetterSandbox(pi: ExtensionAPI): void {
    const controller = new ForegroundSandboxController();

    // Pi's shell setting is only readable once a session directory is known, so
    // it is resolved lazily and re-read on every session start.
    let shellPath: string | undefined;
    const operations = createSandboxedBashOperations(controller, { shellPath: () => shellPath });

    // Overriding the built-in bash tool by name. Only `operations` changes:
    // Pi's own definition still owns the schema, streaming, timeout,
    // cancellation, truncation, session environment, result details, and both
    // renderers, so every bash contract stays the built-in one.
    pi.registerTool(createBashToolDefinition(process.cwd(), { operations }));

    // The same backend for user-entered ! and !! commands.
    pi.on("user_bash", () => ({ operations }));

    let paintFooter: ((status: ForegroundSandboxStatus) => void) | undefined;

    const announce = (status: ForegroundSandboxStatus): void => {
        publishForegroundSandboxPolicy(pi.events, status);
        paintFooter?.(status);
    };

    // A consumer that loaded after the last publication can ask for the current
    // policy instead of waiting for the next change.
    pi.events.on(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, () => {
        publishForegroundSandboxPolicy(pi.events, controller.status());
    });

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        shellPath = resolveShellPath(ctx.cwd);
        paintFooter = (status) => {
            ctx.ui.setStatus(
                FOOTER_KEY,
                formatFooterStatus(status, (tone, text) => ctx.ui.theme.fg(tone, text)),
            );
        };

        // Every session start re-captures the project root and re-arms
        // protection, so an earlier /sandbox off never survives into a new,
        // resumed, forked, or reloaded session.
        const status = controller.beginSession(ctx.cwd);
        announce(status);

        if (status.state !== "enabled") {
            ctx.ui.notify(
                `Foreground sandbox ${status.state}: ${status.reason}`,
                status.state === "disabled" ? "info" : "warning",
            );
        }
    });

    pi.on("session_shutdown", () => {
        controller.dispose();
    });

    pi.registerCommand(SANDBOX_COMMAND_NAME, {
        description: SANDBOX_COMMAND_DESCRIPTION,
        getArgumentCompletions: sandboxArgumentCompletions,
        handler: createSandboxCommandHandler({ controller, onStateChange: announce }),
    });
}

function resolveShellPath(cwd: string): string | undefined {
    try {
        return SettingsManager.create(cwd).getShellPath();
    } catch {
        // A malformed or unreadable settings file must not decide whether the
        // sandbox runs; fall back to Pi's own shell resolution.
        return undefined;
    }
}

export { footerTone, formatFooterStatus, formatSandboxReport } from "./status.ts";
export {
    ForegroundSandboxBlockedError,
    ForegroundSandboxController,
    type ForegroundSandboxLaunchPlan,
    type ForegroundSandboxSeams,
    type ForegroundSandboxState,
    type ForegroundSandboxStatus,
} from "./state.ts";
export {
    FOREGROUND_SANDBOX_POLICY_CHANNEL,
    FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
    type ForegroundSandboxPolicyEvent,
    freezePolicy,
    publishForegroundSandboxPolicy,
    requestForegroundSandboxPolicy,
    subscribeForegroundSandboxPolicy,
} from "./events.ts";
export {
    describeUnsafeProjectRoot,
    PACKAGED_DENY_WRITE_TEMPLATES,
    resolveDenyWriteTemplate,
    resolveDenyWriteTemplates,
    unsafeProjectRoots,
} from "./policy.ts";
export {
    buildSandboxedShellCommand,
    createSandboxedBashOperations,
    quoteForPosixShell,
} from "./shell.ts";
export {
    createSandboxCommandHandler,
    SANDBOX_COMMAND_DESCRIPTION,
    SANDBOX_COMMAND_NAME,
    sandboxArgumentCompletions,
} from "./commands.ts";
