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

import {
    buildSandboxCommand as buildSharedSandboxCommand,
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
};

/** Map the subagent's single-writable-directory shape onto the shared policy. */
function sharedArgs(args: SandboxCommandArgs): SharedSandboxCommandArgs {
    return {
        profilePath: args.profilePath,
        // Subagents have no write-deny list: the run directory is the policy.
        policy: { writableRoot: args.writableDir, home: args.home },
        execPath: args.piBin,
        execArgs: args.piArgs,
    };
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
    return maybeBuildSharedSandboxCommand(sharedArgs(args), request);
}

/**
 * Return the selected backend's executable and ordered argv wrapper around pi.
 * The fallback preserves the pre-existing direct-call result for callers that
 * bypass the request-policy helper above.
 */
export function buildSandboxCommand(args: SandboxCommandArgs): SandboxCommand {
    return buildSharedSandboxCommand(sharedArgs(args));
}
