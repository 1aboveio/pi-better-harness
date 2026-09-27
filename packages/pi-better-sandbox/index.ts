/**
 * pi-better-sandbox - an opt-in write sandbox for foreground tool execution.
 *
 * Installing this package loads an extension; it ships no launcher, so users
 * keep starting Pi with plain `pi`. While enabled, the built-in `bash` tool and
 * user-entered `!` / `!!` commands run under macOS Seatbelt or Linux Bubblewrap
 * with one writable root — the canonical directory Pi was launched from — and
 * the packaged write-denied paths carved back out of it. Selected file,
 * credential-file, command, and network permissions apply to protected tools.
 * File-tool syscalls and shell commands run under the same kernel policy.
 *
 * This is a tool-execution sandbox. Pi's own process, `pi.exec` calls, and
 * unrelated third-party extension code are not confined by it.
 */

import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
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
import { DenyRuleManager } from "./deny-rules.ts";
import {
    FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
    publishForegroundSandboxPolicy,
} from "./events.ts";
import { installTaskTools, runtimeCodeRoot } from "./shared-task-sandbox.ts";
import { discoverTrustedTools } from "./shared-task-tools.ts";
import { writeSandboxDefault } from "./preferences.ts";
import { readPermissionSettings, writePermissionSettings } from "./permission-settings.ts";
import { defaultSandboxPermissions, describeLoosening, type SandboxPermissionSettings } from "./permissions.ts";
import { openPermissionsPage } from "./permissions-page.ts";

import { footerTone, formatFooterStatus } from "./status.ts";
import { ForegroundSandboxController, type ForegroundSandboxStatus } from "./state.ts";

const FOOTER_KEY = "sandbox";

export default function piBetterSandbox(pi: ExtensionAPI): void {
    const controller = new ForegroundSandboxController();

    // Pi's shell setting is only readable once a session directory is known, so
    // it is resolved lazily and re-read on every session start.
    let shellPath: string | undefined;
    const ownEntry = fileURLToPath(import.meta.url);
    const boundary = installTaskTools(pi, { controller, cwd: process.cwd(), shellPath: () => shellPath,
        trustedSources: [ownEntry,
            join(dirname(ownEntry), "../../extensions/sandbox/index.ts"),
            join(dirname(ownEntry), "../pi-better-harness/extensions/sandbox/index.ts")],
    });

    pi.on("tool_call", (event) => {
        const status = controller.status();
        if (status.state === "inactive" || status.state === "disabled") return;
        const permissions = status.permissions;
        if (!permissions) return;
        const name = event.toolName;
        const action = (event.input as { action?: string }).action;
        const launch = ["bash", "powershell", "remote_bash", "subagent_spawn", "subagent_spawn_batch", "bg_task_spawn", "bg_task_watch"].includes(name) ||
            (name === "bg_task" && (action === "spawn" || action === "watch"));
        if (!permissions.commands && (launch || name === "grep" || name === "find")) {
            return { block: true, reason: "Sandbox: Run commands & applications is Off. Change it in /sandbox to launch work." };
        }
        if (!permissions.network && (["web_search", "web_fetch", "firecrawl_scrape", "firecrawl_extract", "remote_bash", "mcp", "mcpScript"].includes(name) || name.startsWith("mcp__") ||
            (launch && Boolean((event.input as { ssh?: unknown }).ssh)))) {
            return { block: true, reason: "Sandbox: Network access is Off." };
        }
        if (name === "powershell" || name === "remote_bash") {
            return { block: true, reason: `Sandbox: ${name} is not a confined execution surface; use bash (including ssh through bash).` };
        }
        if (status.readPolicy === "restricted" && ["grep", "find", "ls"].includes(name)) {
            return { block: true, reason: "Sandbox: use the guarded read tool or a confined bash command for restricted file access." };
        }
    });

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

    // The one validation and persistence path for write-deny rules, shared by
    // `/sandbox deny ...` and the `/sandbox rules` page.
    const denyRules = new DenyRuleManager({ controller, onStateChange: announce });

    pi.on("session_start", (_event, ctx: ExtensionContext) => {
        shellPath = resolveShellPath(ctx.cwd);
        boundary.register(ctx.cwd);
        paintFooter = (status) => {
            ctx.ui.setStatus(
                FOOTER_KEY,
                formatFooterStatus(status, (tone, text) => ctx.ui.theme.fg(tone, text)),
            );
        };

        // Re-read saved profiles on each session. Malformed policy blocks protected
        // operations rather than silently widening a restricted session.
        let settings = defaultSandboxPermissions();
        try {
            settings = readPermissionSettings();
        } catch (error) {
            controller.beginSession(ctx.cwd, true);
            const message = `Sandbox permissions could not be loaded: ${error instanceof Error ? error.message : String(error)}`;
            settings.main.enabled = true;
            settings.main.commands = false;
            settings.subagents.commands = false;
            settings.subagentTools = { applyPatch: true, trusted: [] };
            controller.setPermissionSettings(settings);
            announce(controller.block(message));
            ctx.ui.notify(message, "error");
            return;
        }
        controller.beginSession(ctx.cwd, settings.main.enabled);
        controller.protectRuntimePaths((pi.getAllTools?.() ?? [])
            .map((tool) => tool.sourceInfo?.path).filter((path): path is string => typeof path === "string" && isAbsolute(path))
            .map(runtimeCodeRoot));
        controller.setPermissionSettings(settings);
        controller.applyDefault(settings.main.enabled);

        // Then the rules are re-read and re-resolved, because the same global
        // template set means different absolute paths in a different project.
        // Loading is what announces the session's first policy, so consumers and
        // the footer never see the pre-rule state.
        const report = denyRules.load();
        const status = report.status;

        if (report.overrideProblem !== undefined) {
            ctx.ui.notify(report.overrideProblem, "warning");
        }
        for (const rule of report.inert) {
            ctx.ui.notify(
                `Write-deny rule ${rule.template} is not applied in this project: ${rule.reason}`,
                "warning",
            );
        }
        if (status.state !== "enabled" && status.state !== "inactive") {
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
        handler: createSandboxCommandHandler({
            controller,
            denyRules,
            onStateChange: announce,
            setDefault: (enabled) => {
                const settings = controller.permissionSettings() ?? defaultSandboxPermissions();
                settings.main.enabled = enabled;
                writePermissionSettings(settings);
                writeSandboxDefault(enabled ? "on" : "off");
                return controller.setPermissionSettings(settings);
            },
            openPermissions: async (ctx) => {
                await openPermissionsPage(ctx, {
                    getConfig: () => controller.permissionSettings() ?? defaultSandboxPermissions(),
                    // Trusted-tool candidates: what this Pi has actually registered, by owning package.
                    discoverTools: () => discoverTrustedTools(pi.getAllTools?.() ?? []),
                    change: (settings) => announce(controller.setPermissionSettings(settings)),
                    save: (settings) => writePermissionSettings(settings),
                    // Persisting a looser default needs a second, explicit Enter.
                    loosening: (settings) => {
                        let previous: SandboxPermissionSettings;
                        try { previous = readPermissionSettings(); } catch { previous = defaultSandboxPermissions(); }
                        return describeLoosening(previous, settings);
                    },
                });
            },
        }),
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
    FOREGROUND_SANDBOX_REMEDY,
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
    clearDenyRuleOverride,
    DENY_RULES_FILE_NAME,
    DENY_RULES_FORMAT_VERSION,
    type DenyRule,
    DenyRuleError,
    type DenyRuleErrorKind,
    DenyRuleManager,
    type DenyRuleManagerDeps,
    type DenyRuleReport,
    denyRuleOverridePath,
    type DenyRuleSeams,
    type DenyRuleStoreSeams,
    describeDenyRules,
    formatDenyRuleReport,
    type InertDenyRule,
    normalizeDenyRuleTemplate,
    partitionDenyRules,
    planDenyRuleAddition,
    planDenyRuleRemoval,
    readDenyRuleOverride,
    writeDenyRuleOverride,
} from "./deny-rules.ts";
export {
    readSandboxDefault,
    SANDBOX_PREFERENCES_FILE_NAME,
    SANDBOX_PREFERENCES_FORMAT_VERSION,
    SandboxPreferenceError,
    sandboxPreferencesPath,
    type SandboxDefaultMode,
    type SandboxPreferenceSeams,
    writeSandboxDefault,
} from "./preferences.ts";
export { openSandboxRulesPage, RULES_PAGE_NO_UI_REJECTION } from "./rules-page.ts";
export {
    describeUnsafeProjectRoot,
    PACKAGED_DENY_WRITE_TEMPLATES,
    resolveDenyWriteTemplate,
    resolveDenyWriteTemplates,
    unsafeProjectRoots,
} from "./policy.ts";
export {
    createForegroundWriteGuard,
    createSandboxedEditOperations,
    createSandboxedWriteOperations,
    type DeniedWriteAccess,
    ForegroundSandboxWriteDeniedError,
    type ForegroundWriteGuard,
    type MutationKind,
    type SandboxedEditOperationsOptions,
    type SandboxedWriteOperationsOptions,
} from "./files.ts";
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
