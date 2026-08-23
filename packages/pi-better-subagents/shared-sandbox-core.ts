// Generated from packages/sandbox-core/index.ts. Do not edit directly.
/**
 * OS-level write sandbox mechanism shared by Pi extensions.
 *
 * Kernel-enforced confinement: the sandboxed process may READ anywhere and use
 * the network (so web_fetch and the model API keep working), but may only WRITE
 * under a single canonical root plus the system paths pi itself needs. Unlike a
 * cooperative guardrails layer (which pattern-matches tool inputs), this cannot
 * be evaded by a crafted bash command — the write syscall itself is denied.
 *
 * This module owns the mechanism only: backend discovery, canonical path
 * containment, write-deny compilation, macOS SBPL profile construction, Linux
 * Bubblewrap mount construction, ordered executable/argv wrapping, and support
 * diagnostics. It owns no Pi tool, TUI, background-task, or subagent lifecycle
 * policy — callers decide when a sandbox is requested and what it may write.
 *
 * Every platform/filesystem dependency is reachable through the optional
 * `SandboxSeams` argument so callers can plan deterministically in tests.
 */

import { platform as osPlatform } from "node:os";
import {
    accessSync,
    closeSync,
    constants,
    existsSync,
    mkdirSync,
    openSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve, sep } from "node:path";

/** Identifies which kernel mechanism a plan will use. */
export type SandboxBackendId = "macos-seatbelt" | "linux-bubblewrap";

/**
 * What a sandboxed process may write. `writableRoot` and `denyWrite` entries may
 * be relative or contain symlinks; they are canonicalized before use.
 */
export type SandboxWritePolicy = {
    /** The single directory subtree the sandboxed process may write under. */
    writableRoot: string;
    /**
     * Concrete paths that stay non-writable even inside `writableRoot`. A
     * directory entry denies its whole subtree; a file entry denies that file.
     *
     * An entry need not exist. The Linux backend needs a mount point, so it
     * materializes an absent entry as an empty file (see `materializeDenyPath`);
     * an entry that has to be a *directory* must therefore already exist when the
     * command is built. Callers denying their own state directory create it
     * first, which they do anyway to write into it.
     */
    denyWrite?: readonly string[];
    /** Home directory whose `~/.pi` state stays writable on macOS. */
    home: string;
};

/** The executable and argv to run inside the sandbox, preserved verbatim. */
export type SandboxTarget = {
    execPath: string;
    execArgs: readonly string[];
};

export type SandboxCommandArgs = SandboxTarget & {
    /** Where the macOS backend writes its generated SBPL profile. */
    profilePath: string;
    policy: SandboxWritePolicy;
};

/** The wrapper command to spawn: the backend executable and its full argv. */
export type SandboxCommand = { file: string; fileArgs: string[] };

/** The caller's default-on / explicit-request / opt-out decision. */
export type SandboxRequest = {
    sandboxEnabled: boolean;
    explicitSandbox: boolean;
    /**
     * What this caller's operator can actually do about a missing backend,
     * appended when an explicit request has to be refused. Surfaces differ: a
     * subagent tool takes `sandbox:false`, a foreground session takes
     * `/sandbox off`, so the remedy cannot be stated here.
     */
    remedy?: string;
};

/** Injectable platform and filesystem dependencies. Defaults hit the real OS. */
export type SandboxSeams = {
    /** Defaults to `os.platform()`. */
    platform?: () => string;
    /** Defaults to a PATH scan that stats and access-checks without executing. */
    lookupExecutable?: (name: string) => string | undefined;
    /** Defaults to `fs.realpathSync`. Must throw when the path does not exist. */
    canonicalize?: (path: string) => string;
    /** Defaults to `fs.writeFileSync`. */
    writeProfile?: (path: string, contents: string) => void;
    /**
     * Defaults to creating an empty placeholder file for an absent denied path
     * (see `materializeDenyPath`). Returns whether the path exists afterwards.
     * Injected by tests that plan Linux argv for paths that do not exist on the
     * host running them.
     */
    materializeDenyPath?: (path: string) => boolean;
};

/** A policy with every path canonicalized, deduplicated, and ordered. */
export type CompiledSandboxWritePolicy = {
    readonly writableRoot: string;
    readonly denyWrite: readonly string[];
    readonly home: string;
};

/** Why a write target is or is not permitted by a compiled policy. */
export type WriteAccessDecision =
    | { allowed: true; path: string }
    | {
          allowed: false;
          path: string;
          reason: "outside-writable-root" | "write-denied";
          /** The compiled deny entry that matched, for `write-denied` only. */
          deniedBy?: string;
      };

/** What the current platform can enforce, and why it cannot when it cannot. */
export type SandboxSupport =
    | { supported: true; platform: string; backend: SandboxBackendId; executable: string }
    | {
          supported: false;
          platform: string;
          backend: undefined;
          executable: undefined;
          reason: string;
      };

type SandboxBackend = {
    id: SandboxBackendId;
    executable: string;
    buildCommand(args: SandboxCommandArgs, seams: SandboxSeams): SandboxCommand;
};

const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";

function currentPlatform(seams: SandboxSeams): string {
    return (seams.platform ?? osPlatform)();
}

/**
 * Resolve `path` to an absolute canonical path. Symlinks are resolved on the
 * longest existing ancestor so a target that does not exist yet still
 * canonicalizes through its real parent chain.
 */
export function canonicalizePath(path: string, seams: SandboxSeams = {}): string {
    const canonicalize = seams.canonicalize ?? realpathSync;
    const absolute = resolve(path);
    try {
        return canonicalize(absolute);
    } catch {
        // Not created yet (or unreadable): canonicalize the parent instead.
    }
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(canonicalizePath(parent, seams), basename(absolute));
}

function compile(
    policy: SandboxWritePolicy,
    seams: SandboxSeams,
    strictRoot: boolean,
): CompiledSandboxWritePolicy {
    // The Linux backend has always required the writable root to exist before it
    // bind-mounts it; the macOS backend has always tolerated a not-yet-created
    // one. Keep both behaviors rather than unifying them here.
    const writableRoot = strictRoot
        ? (seams.canonicalize ?? realpathSync)(policy.writableRoot)
        : canonicalizePath(policy.writableRoot, seams);

    const denyWrite = [
        ...new Set((policy.denyWrite ?? []).map((entry) => canonicalizePath(entry, seams))),
    ].sort();

    return { writableRoot, denyWrite, home: policy.home };
}

/**
 * Canonicalize a write policy once so containment checks and backend rules
 * agree on exactly which paths they are talking about.
 */
export function compileWritePolicy(
    policy: SandboxWritePolicy,
    seams: SandboxSeams = {},
): CompiledSandboxWritePolicy {
    return compile(policy, seams, false);
}

function contains(root: string, target: string): boolean {
    if (target === root) return true;
    return target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * Decide whether an in-process write to `target` is permitted by a compiled
 * policy. This is the same containment rule the kernel backends enforce, for
 * callers that mutate files directly instead of spawning a child.
 */
export function evaluateWriteAccess(
    target: string,
    policy: CompiledSandboxWritePolicy,
    seams: SandboxSeams = {},
): WriteAccessDecision {
    const path = canonicalizePath(target, seams);
    if (!contains(policy.writableRoot, path)) {
        return { allowed: false, path, reason: "outside-writable-root" };
    }
    for (const denied of policy.denyWrite) {
        if (contains(denied, path)) {
            return { allowed: false, path, reason: "write-denied", deniedBy: denied };
        }
    }
    return { allowed: true, path };
}

/** Quote a path as an SBPL string literal. */
function sbpl(path: string): string {
    return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Build the macOS sandbox-exec wrapper and its SBPL profile. */
function buildMacOSSandboxCommand(args: SandboxCommandArgs, seams: SandboxSeams): SandboxCommand {
    // Match on the real (symlink-resolved) path — sandbox-exec evaluates the
    // canonical path, so /tmp/x must be written as /private/tmp/x.
    const policy = compile(args.policy, seams, false);

    const profile = [
        "(version 1)",
        "(allow default)",          // permissive base: reads, exec, network
        "(deny file-write*)",       // ...then deny all writes...
        `(allow file-write* (subpath ${sbpl(policy.writableRoot)}))`,   // ...except here
        `(allow file-write* (subpath ${sbpl(`${policy.home}/.pi`)}))`,  // pi state
        '(allow file-write* (subpath "/private/var/folders"))',         // macOS temp / our runtime
        '(allow file-write* (subpath "/private/tmp"))',
        '(allow file-write* (subpath "/dev"))',                         // /dev/null etc.
        // Deny rules come last: SBPL applies the last matching rule, so these
        // carve holes back out of the allowances above.
        ...policy.denyWrite.map((path) => `(deny file-write* (subpath ${sbpl(path)}))`),
        "",
    ].join("\n");
    (seams.writeProfile ?? writeFileSync)(args.profilePath, profile);

    return {
        file: MACOS_SANDBOX_EXEC,
        fileArgs: ["-f", args.profilePath, args.execPath, ...args.execArgs],
    };
}

const macOSSandboxBackend: SandboxBackend = {
    id: "macos-seatbelt",
    executable: MACOS_SANDBOX_EXEC,
    buildCommand: buildMacOSSandboxCommand,
};

/** Resolve an executable from PATH without starting it or probing namespaces. */
export function executableFromPath(name: string): string | undefined {
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

/**
 * Give an absent denied path something the kernel can hold out.
 *
 * A mount needs a mount point. `--ro-bind-try` skips a source that does not
 * exist, so before this a denied path that had not been created yet was not
 * denied at all: inside the sandbox `echo secret > .env.local` simply created
 * it. `.env` and `.env.local` are absent in most projects, which made the
 * packaged defaults hold on macOS — SBPL denies by resolved path, existing or
 * not — and not on Linux.
 *
 * Nothing bubblewrap offers closes that without a mount point, and every
 * bubblewrap operation that would create one (`--dir`, `--file`, `--tmpfs`)
 * creates it through the read-write bind of the project, which is to say on the
 * real filesystem anyway. So the placeholder is created here, deliberately and
 * visibly, rather than as a side effect of a mount operation.
 *
 * An empty regular file is the least destructive placeholder: a later
 * `cp .env.example .env` overwrites it, where an empty *directory* at that path
 * would fail. Callers whose denied entry has to be a directory create it before
 * building the command, and an entry that already exists — file or directory —
 * is bound as it is. The file is created with O_EXCL, so anything that appears
 * in the meantime is bound rather than clobbered, and it is left in place
 * afterwards because a resumed task re-runs the launch vector it captured and
 * its `--ro-bind` sources have to still be there.
 *
 * Returns false when the placeholder could not be created. That is not a hole:
 * the confined process runs as this same user, so a path this process cannot
 * create is a path that process cannot create either.
 */
function materializeDenyPath(path: string): boolean {
    if (existsSync(path)) return true;
    try {
        mkdirSync(dirname(path), { recursive: true });
        closeSync(openSync(path, "wx"));
        return true;
    } catch {
        // Re-check rather than trust the errno. EEXIST from the O_EXCL create
        // means the path appeared in between, which is the outcome we wanted and
        // not ours to overwrite; EEXIST from the mkdir means a parent is a
        // regular file, and nothing can exist under it. Only the first leaves a
        // source a bind can use.
        return existsSync(path);
    }
}

/**
 * Whether a denied path lies in a region this backend binds read-write.
 *
 * Everywhere else is already covered by the read-only bind of `/`, so a
 * placeholder there would deny nothing that is not denied already — and would
 * scatter empty files across the host for the sake of it. Materializing is
 * confined to the two regions that are genuinely writable inside the sandbox:
 * the writable root, and the `/tmp` rebind that pi's own tooling needs.
 */
function writableInsideLinuxSandbox(path: string, writableRoot: string): boolean {
    return contains(writableRoot, path) || contains("/tmp", path);
}

function buildLinuxSandboxCommand(
    bwrap: string,
    args: SandboxCommandArgs,
    seams: SandboxSeams,
): SandboxCommand {
    // The caller creates the selected work directory before it reaches this
    // boundary. Canonicalizing it before bind-mounting keeps symlink aliases from
    // widening the writable root.
    const policy = compile(args.policy, seams, true);
    const materialize = seams.materializeDenyPath ?? materializeDenyPath;
    const denyBinds = policy.denyWrite.flatMap((path) => {
        const mountable = writableInsideLinuxSandbox(path, policy.writableRoot) && materialize(path);
        return [mountable ? "--ro-bind" : "--ro-bind-try", path, path];
    });
    return {
        file: bwrap,
        fileArgs: [
            "--ro-bind", "/", "/",
            "--bind", policy.writableRoot, policy.writableRoot,
            "--bind", "/tmp", "/tmp",
            "--dev", "/dev",
            // Layered last so a denied path wins over every writable bind above.
            // A denied path need not exist yet, so one inside a writable region
            // is materialized first; `-try` remains for the paths that are
            // read-only regardless and for the ones that could not be created,
            // which are paths the confined process cannot create either.
            ...denyBinds,
            "--",
            args.execPath, ...args.execArgs,
        ],
    };
}

function linuxSandboxBackend(seams: SandboxSeams): SandboxBackend | undefined {
    const bwrap = (seams.lookupExecutable ?? executableFromPath)("bwrap");
    if (!bwrap) return undefined;
    return {
        id: "linux-bubblewrap",
        executable: bwrap,
        buildCommand: (args, buildSeams) => buildLinuxSandboxCommand(bwrap, args, buildSeams),
    };
}

function selectedSandboxBackend(seams: SandboxSeams): SandboxBackend | undefined {
    const platform = currentPlatform(seams);
    if (platform === "darwin") return macOSSandboxBackend;
    if (platform === "linux") return linuxSandboxBackend(seams);
    return undefined;
}

/**
 * Why no backend applies here. The requirement only: what a caller can do
 * instead is a property of that caller's surface, not of the platform, and is
 * supplied through `SandboxRequest.remedy`.
 */
function unavailableMessage(platform: string): string {
    if (platform === "linux") {
        return "Linux sandbox requires executable bubblewrap (bwrap) on PATH. Install bubblewrap to enable it.";
    }
    if (platform === "darwin") {
        return "macOS sandbox requires /usr/bin/sandbox-exec, which is missing here.";
    }
    return `sandbox is unsupported on ${platform}.`;
}

/** Report which backend this platform would select, and why it would not. */
export function describeSandboxSupport(seams: SandboxSeams = {}): SandboxSupport {
    const platform = currentPlatform(seams);
    const backend = selectedSandboxBackend(seams);
    if (!backend) {
        return {
            supported: false,
            platform,
            backend: undefined,
            executable: undefined,
            reason: unavailableMessage(platform),
        };
    }
    return { supported: true, platform, backend: backend.id, executable: backend.executable };
}

/** The message explaining why no backend is available on this platform. */
export function sandboxUnavailableMessage(seams: SandboxSeams = {}): string {
    return unavailableMessage(currentPlatform(seams));
}

/** True when an OS write-sandbox backend can be applied on this platform. */
export function sandboxSupported(seams: SandboxSeams = {}): boolean {
    return selectedSandboxBackend(seams) !== undefined;
}

/**
 * Resolve the caller's default-on, explicit-request, and opt-out policy before
 * spawning. A selected backend always returns its wrapper; callers never retry
 * the child directly when that wrapper exits or cannot initialize.
 */
export function maybeBuildSandboxCommand(
    args: SandboxCommandArgs,
    request: SandboxRequest,
    seams: SandboxSeams = {},
): SandboxCommand | undefined {
    if (!request.sandboxEnabled) return undefined;

    const backend = selectedSandboxBackend(seams);
    if (!backend) {
        if (request.explicitSandbox) {
            const reason = sandboxUnavailableMessage(seams);
            throw new Error(request.remedy ? `${reason} ${request.remedy}` : reason);
        }
        return undefined;
    }
    return backend.buildCommand(args, seams);
}

/**
 * Return the selected backend's executable and ordered argv wrapper around the
 * target. The fallback preserves the pre-existing direct-call result for callers
 * that bypass the request-policy helper above.
 */
export function buildSandboxCommand(
    args: SandboxCommandArgs,
    seams: SandboxSeams = {},
): SandboxCommand {
    return (selectedSandboxBackend(seams) ?? macOSSandboxBackend).buildCommand(args, seams);
}
