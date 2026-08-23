/**
 * Foreground shell confinement.
 *
 * Pi's own bash backend keeps doing all the process work — streaming, timeout,
 * cancellation, process-tree termination, session environment — and this module
 * changes exactly one thing: the command handed to it now `exec`s the sandbox
 * wrapper around the same shell running the same command.
 *
 * The wrapper argv is built by `sandbox-core` and passed through single-quote
 * escaping, so the user's command text is never re-tokenized: it travels as one
 * argv element to the inner shell, exactly as Pi would have passed it.
 */

import { createLocalBashOperations, getShellConfig } from "@earendil-works/pi-coding-agent";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

import {
    maybeBuildSandboxCommand,
    type SandboxSeams,
    sandboxUnavailableMessage,
} from "./shared-sandbox-core.ts";
import { FOREGROUND_SANDBOX_REMEDY } from "./state.ts";
import type { ForegroundSandboxController, ForegroundSandboxLaunchPlan } from "./state.ts";

/**
 * Quote one argv element for a POSIX shell.
 *
 * Single quotes suppress every expansion, so the only character needing care is
 * the single quote itself. This is a lossless transport of one argv element,
 * not an attempt to parse the command.
 */
export function quoteForPosixShell(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

export type ForegroundShellSeams = SandboxSeams & {
    /** Explicit shell path from Pi's settings, when the user configured one. */
    shellPath?: () => string | undefined;
};

/**
 * Build the command Pi's local shell backend should run so that `command`
 * executes inside the sandbox.
 *
 * `exec` replaces the outer shell with the wrapper, so the process Pi tracks
 * and kills is the sandboxed one.
 */
export function buildSandboxedShellCommand(
    command: string,
    plan: Extract<ForegroundSandboxLaunchPlan, { confined: true }>,
    seams: ForegroundShellSeams = {},
): string {
    const shellConfig = getShellConfig(seams.shellPath?.());
    if (shellConfig.commandTransport === "stdin") {
        throw new Error(
            `Foreground sandbox cannot wrap ${shellConfig.shell}: it accepts commands on stdin only, which no supported sandbox backend can wrap. ${sandboxUnavailableMessage(seams)} ${FOREGROUND_SANDBOX_REMEDY}`,
        );
    }

    const sandboxCommand = maybeBuildSandboxCommand(
        {
            profilePath: plan.profilePath,
            policy: plan.policy,
            execPath: shellConfig.shell,
            execArgs: [...shellConfig.args, command],
        },
        // Fail closed: an enabled foreground sandbox with no backend must block
        // the operation, never fall through to an unconfined child.
        { sandboxEnabled: true, explicitSandbox: true, remedy: FOREGROUND_SANDBOX_REMEDY },
        seams,
    );
    if (!sandboxCommand) {
        throw new Error(`${sandboxUnavailableMessage(seams)} ${FOREGROUND_SANDBOX_REMEDY}`);
    }

    // `exec` stays unquoted so the outer shell replaces itself with the wrapper:
    // the process pi tracks, signals, and kills is the sandboxed one.
    const argv = [sandboxCommand.file, ...sandboxCommand.fileArgs].map(quoteForPosixShell);
    return `exec ${argv.join(" ")}`;
}

export type SandboxedBashOperationsOptions = ForegroundShellSeams & {
    /**
     * Pi's local shell backend. Defaults to `createLocalBashOperations()`, which
     * is what preserves every process contract the built-in bash tool relies on.
     */
    localOperations?: BashOperations;
};

/**
 * Pluggable bash operations that confine every command they run.
 *
 * The launch decision is taken per command, so `/sandbox on` and `/sandbox off`
 * affect operations started after the toggle while already-running commands
 * keep the policy they launched with.
 */
export function createSandboxedBashOperations(
    controller: ForegroundSandboxController,
    options: SandboxedBashOperationsOptions = {},
): BashOperations {
    // Pi's shell setting is only readable once a session exists, which is after
    // this factory runs, so the local backend is built on first use and reused
    // until the resolved shell path changes.
    let cachedShellPath: string | undefined;
    let cachedLocal: BashOperations | undefined;
    const localOperations = (): BashOperations => {
        if (options.localOperations) return options.localOperations;
        const shellPath = options.shellPath?.();
        if (!cachedLocal || cachedShellPath !== shellPath) {
            cachedShellPath = shellPath;
            cachedLocal = createLocalBashOperations(shellPath === undefined ? {} : { shellPath });
        }
        return cachedLocal;
    };

    return {
        async exec(command, cwd, execOptions) {
            const local = localOperations();
            // Rejects when the sandbox is enabled but cannot be applied. The
            // caller never retries the command unconfined.
            const plan = controller.requireLaunchPlan();
            if (!plan.confined) return local.exec(command, cwd, execOptions);
            return local.exec(buildSandboxedShellCommand(command, plan, options), cwd, execOptions);
        },
    };
}
