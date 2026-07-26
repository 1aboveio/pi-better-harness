/**
 * OS-level write sandbox for subagent children.
 *
 * Kernel-enforced confinement: the child may READ anywhere and use the network
 * (so web_fetch and the model API keep working), but may only WRITE under a
 * single directory plus the system paths pi itself needs to function. Unlike the
 * cooperative guardrails layer (which pattern-matches tool inputs), this cannot
 * be evaded by a crafted bash command — the write syscall itself is denied.
 *
 * Backends are selected here so callers retain a platform-neutral support query
 * and command-wrapper contract. Linux support adds a backend without changing
 * detached spawning policy in the extension.
 */

import { platform } from "node:os";
import { accessSync, constants, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";

type SandboxCommandArgs = {
    profilePath: string;
    writableDir: string;
    home: string;
    piBin: string;
    piArgs: string[];
};

type SandboxCommand = { file: string; fileArgs: string[] };

type SandboxBackend = {
    buildCommand(args: SandboxCommandArgs): SandboxCommand;
};

type SandboxRequest = {
    sandboxEnabled: boolean;
    explicitSandbox: boolean;
};

/** Quote a path as an SBPL string literal. */
function sbpl(path: string): string {
    return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build the existing macOS sandbox-exec wrapper and SBPL profile. */
function buildMacOSSandboxCommand(args: SandboxCommandArgs): SandboxCommand {
    // Match on the real (symlink-resolved) path — sandbox-exec evaluates the
    // canonical path, so /tmp/x must be written as /private/tmp/x.
    let dir = args.writableDir;
    try { dir = realpathSync(dir); } catch { /* not yet created; use as given */ }

    const profile = [
        "(version 1)",
        "(allow default)",          // permissive base: reads, exec, network
        "(deny file-write*)",       // ...then deny all writes...
        `(allow file-write* (subpath ${sbpl(dir)}))`,               // ...except here
        `(allow file-write* (subpath ${sbpl(`${args.home}/.pi`)}))`, // pi state
        '(allow file-write* (subpath "/private/var/folders"))',      // macOS temp / our runtime
        '(allow file-write* (subpath "/private/tmp"))',
        '(allow file-write* (subpath "/dev"))',                      // /dev/null etc.
        "",
    ].join("\n");
    writeFileSync(args.profilePath, profile);

    return {
        file: "/usr/bin/sandbox-exec",
        fileArgs: ["-f", args.profilePath, args.piBin, ...args.piArgs],
    };
}

const macOSSandboxBackend: SandboxBackend = {
    buildCommand: buildMacOSSandboxCommand,
};

/** Resolve an executable from PATH without starting it or probing namespaces. */
function executableFromPath(name: string): string | undefined {
    const path = process.env.PATH;
    if (!path) return undefined;

    for (const entry of path.split(delimiter)) {
        const candidate = resolve(entry || ".", name);
        try {
            if (!statSync(candidate).isFile()) continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {
            // A PATH entry may disappear or be inaccessible between lookup and use.
        }
    }
    return undefined;
}

function buildLinuxSandboxCommand(bwrap: string, args: SandboxCommandArgs): SandboxCommand {
    // The caller creates the selected work directory before it reaches this
    // boundary. Canonicalizing it before bind-mounting keeps symlink aliases from
    // widening the writable root.
    const dir = realpathSync(args.writableDir);
    return {
        file: bwrap,
        fileArgs: [
            "--ro-bind", "/", "/",
            "--bind", dir, dir,
            "--bind", "/tmp", "/tmp",
            "--dev", "/dev",
            "--",
            args.piBin, ...args.piArgs,
        ],
    };
}

function linuxSandboxBackend(): SandboxBackend | undefined {
    const bwrap = executableFromPath("bwrap");
    if (!bwrap) return undefined;
    return { buildCommand: (args) => buildLinuxSandboxCommand(bwrap, args) };
}

function selectedSandboxBackend(): SandboxBackend | undefined {
    const currentPlatform = platform();
    if (currentPlatform === "darwin") return macOSSandboxBackend;
    if (currentPlatform === "linux") return linuxSandboxBackend();
    return undefined;
}

function sandboxUnavailableMessage(): string {
    const currentPlatform = platform();
    if (currentPlatform === "linux") {
        return "Linux sandbox requires executable bubblewrap (bwrap) on PATH. Install bubblewrap or pass sandbox:false.";
    }
    if (currentPlatform === "darwin") {
        return "macOS sandbox requires /usr/bin/sandbox-exec. Pass sandbox:false if it is unavailable.";
    }
    return `sandbox is unsupported on ${currentPlatform}. Pass sandbox:false on this platform.`;
}

/** True when an OS write-sandbox backend can be applied on this platform. */
export function sandboxSupported(): boolean {
    return selectedSandboxBackend() !== undefined;
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
    if (!request.sandboxEnabled) return undefined;

    const backend = selectedSandboxBackend();
    if (!backend) {
        if (request.explicitSandbox) throw new Error(sandboxUnavailableMessage());
        return undefined;
    }
    return backend.buildCommand(args);
}

/**
 * Return the selected backend's executable and ordered argv wrapper around pi.
 * The fallback preserves the pre-existing direct-call result for callers that
 * bypass the request-policy helper above.
 */
export function buildSandboxCommand(args: SandboxCommandArgs): SandboxCommand {
    return (selectedSandboxBackend() ?? macOSSandboxBackend).buildCommand(args);
}
