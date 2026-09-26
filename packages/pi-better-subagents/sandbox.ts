/**
 * Subagent policy adapter over the shared OS write-sandbox mechanism.
 *
 * The mechanism itself — backend discovery, canonical containment, profile and
 * mount construction, ordered argv wrapping — lives in `sandbox-core` and is
 * vendored here as `shared-sandbox-core.ts`. This file holds only the subagent
 * shape of that call: the detached child's writable directory is the whole
 * policy, and the wrapped executable is always the pi binary. Detached spawning
 * policy (default-on, explicit request, explicit opt-out) stays in index.ts and
 * is passed through unchanged.
 */

import type { PermissionProfile } from "./permission-policy.ts";
import {
    buildSandboxCommand as buildSharedSandboxCommand,
    compileWritePolicy,
    maybeBuildSandboxCommand as maybeBuildSharedSandboxCommand,
    sandboxSupported as sharedSandboxSupported,
    type SandboxCommand,
    type SandboxCommandArgs as SharedSandboxCommandArgs,
    type SandboxRequest,
} from "./shared-sandbox-core.ts";

type SandboxCommandArgs = {
    profilePath: string;
    writableDir: string;
    home: string;
    piBin: string;
    piArgs: string[];
    permissions?: Omit<PermissionProfile, "enabled">;
    denyWrite?: readonly string[];
    runtimeDir?: string;
};

/** Map the subagent's single-writable-directory shape onto the shared policy. */
function sharedArgs(args: SandboxCommandArgs): SharedSandboxCommandArgs {
    return {
        profilePath: args.profilePath,
        // Parent-owned run artifacts must never be writable by the child.
        policy: { writableRoot: args.writableDir, home: args.home,
            ...(args.permissions ? { permissions: args.permissions } : {}),
            ...(args.denyWrite ? { denyWrite: args.denyWrite } : {}),
            ...(args.runtimeDir ? { runtimeWrite: [args.runtimeDir] } : {}),
        },
        execPath: args.runtimeDir ? "/usr/bin/env" : args.piBin,
        execArgs: args.runtimeDir
            ? [`TMPDIR=${args.runtimeDir}`, `TMP=${args.runtimeDir}`, `TEMP=${args.runtimeDir}`, args.piBin, ...args.piArgs]
            : args.piArgs,
    };
}

function assertPermissionCore(args: SandboxCommandArgs): void {
    if (args.permissions && !("permissions" in compileWritePolicy(sharedArgs(args).policy))) {
        throw new Error("Permission-aware sandbox core is unavailable; update the sandbox packages before launching a subagent.");
    }
}

/** True when an OS write-sandbox backend can be applied on this platform. */
export function sandboxSupported(): boolean {
    return sharedSandboxSupported();
}

/**
 * Resolve the caller's default-on, explicit-request, and opt-out policy before
 * spawning. A selected backend always returns its wrapper; callers never retry
 * the child directly when that wrapper exits or cannot initialize.
 */
export function maybeBuildSandboxCommand(
    args: SandboxCommandArgs,
    request: SandboxRequest,
): SandboxCommand | undefined {
    // `sandbox:false` is this surface's opt-out, and the only one its operator
    // has: a subagent has no slash commands. A caller that states its own remedy
    // keeps it.
    assertPermissionCore(args);
    return maybeBuildSharedSandboxCommand(sharedArgs(args), {
        ...request,
        remedy: request.remedy ?? (args.permissions
            ? "Change the Subagents permissions in /sandbox."
            : "Pass sandbox:false to run this subagent unconfined."),
    });
}

/**
 * Return the selected backend's executable and ordered argv wrapper around pi.
 * The fallback preserves the pre-existing direct-call result for callers that
 * bypass the request-policy helper above.
 */
export function buildSandboxCommand(args: SandboxCommandArgs): SandboxCommand {
    assertPermissionCore(args);
    return buildSharedSandboxCommand(sharedArgs(args));
}
