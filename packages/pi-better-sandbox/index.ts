/**
 * pi-better-sandbox - an opt-in write sandbox for foreground tool execution.
 *
 * Installing this package loads an extension; it ships no launcher, so users
 * keep starting Pi with plain `pi`. While enabled, the built-in `bash` tool and
 * user-entered `!` / `!!` commands run under macOS Seatbelt or Linux Bubblewrap
 * with one writable root — the canonical directory Pi was launched from — and
 * the packaged write-denied paths carved back out of it. Selected file,
 * credential-file, command, and network permissions apply to protected tools.
 * In-process file tools use the same canonical policy as spawned commands.
 *
 * This is a tool-execution sandbox. Pi's own process, `pi.exec` calls, and
 * unrelated third-party extension code are not confined by it.
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
    createBashToolDefinition,
    createReadToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
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
import {
    createSandboxedEditOperations,
    createSandboxedWriteOperations,
    createForegroundReadGuard,
} from "./files.ts";
import { writeSandboxDefault } from "./preferences.ts";
import { readPermissionSettings, writePermissionSettings } from "./permission-settings.ts";
import { defaultSandboxPermissions } from "./permissions.ts";
import { openPermissionsPage } from "./permissions-page.ts";
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

    // Overriding the built-in write and edit tools the same way: only their
    // file operations change, so Pi's own definitions keep the parameter
    // schemas, prompt guidance, call rendering, write previews, edit diffs,
    // result details, file-mutation queue, and cancellation checks. The guarded
    // operations run inside that queue, which is where the enforcement belongs.
    const writeOperations = createSandboxedWriteOperations(controller);
    const editOperations = createSandboxedEditOperations(controller);
    const assertReadable = createForegroundReadGuard(controller);

    // `cwd` is what these tools resolve a relative `path` against, so it has to
    // be the directory Pi itself resolves against. Registration is re-run when
    // a session reports a different cwd (`pi --cwd ...`), which Pi supports and
    // refreshes in the same session.
    let fileToolCwd: string | undefined;
    const registerFileTools = (cwd: string): void => {
        if (fileToolCwd === cwd) return;
        fileToolCwd = cwd;
        pi.registerTool(createWriteToolDefinition(cwd, { operations: writeOperations }));
        pi.registerTool(createEditToolDefinition(cwd, { operations: editOperations }));
        const read = createReadToolDefinition(cwd);
        pi.registerTool({
            ...read,
            execute: (id, params, signal, update, ctx) => {
                const path = params.path.replace(/^@/, "");
                const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
                return read.execute(id, { ...params, path: assertReadable(expanded) }, signal, update, ctx);
            },
        });
    };
    registerFileTools(process.cwd());

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
        registerFileTools(ctx.cwd);
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
            controller.setPermissionSettings(settings);
            announce(controller.block(message));
            ctx.ui.notify(message, "error");
            return;
        }
        controller.beginSession(ctx.cwd, settings.main.enabled);
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
                    change: (settings) => announce(controller.setPermissionSettings(settings)),
                    save: (settings) => writePermissionSettings(settings),
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
