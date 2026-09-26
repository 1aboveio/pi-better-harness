/**
 * OS-level write sandbox mechanism shared by Pi extensions.
 *
 * Legacy policies are write-only: a sandboxed process may READ anywhere and use
 * the network, but may only WRITE under a canonical root plus runtime paths.
 * Optional permissions add capability restrictions for reads, writes, launches
 * and network access. They cover known credential files, not OS keychains,
 * credential services, or tokens inherited in the child environment.
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

export type SandboxPermissions = {
    projectFiles: "off" | "read" | "read-write";
    outsideProject: "off" | "read" | "read-write";
    storedCredentials: "off" | "read" | "read-write";
    commands: boolean;
    network: boolean;
};

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
    /** Optional capability profile; omission preserves the original write-only sandbox. */
    permissions?: SandboxPermissions;
    /** Trusted per-launch runtime state, never supplied by model tool arguments. */
    runtimeWrite?: readonly string[];
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
    readonly permissions?: SandboxPermissions;
    readonly credentialPaths?: readonly string[];
    readonly runtimeWrite?: readonly string[];
};

/** Why a write target is or is not permitted by a compiled policy. */
export type WriteAccessDecision =
    | { allowed: true; path: string }
    | {
          allowed: false;
          path: string;
          reason: "outside-writable-root" | "write-denied" | "permission-denied";
          /** The compiled deny entry that matched, for `write-denied` only. */
          deniedBy?: string;
      };

export type ReadAccessDecision =
    | { allowed: true; path: string }
    | { allowed: false; path: string; reason: "read-denied" };

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

const CREDENTIAL_LOCATIONS = [
    ".ssh", ".aws", ".config/gh", ".config/gcloud", ".azure", ".kube",
    ".docker/config.json", ".npmrc", ".netrc", ".git-credentials", ".pi/agent/auth.json",
] as const;

// Executables, dynamic libraries and OS frameworks needed to start a child.
// This deliberately excludes the home directory, /etc, and credential stores.
// A process relying on /etc or /proc configuration (DNS, certificates, NSS)
// may not start or function under Linux outsideProject=off; callers must not
// silently remount these broad host trees to work around that failure.
const RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/System/Library", "/System/Cryptexes", "/Library/Apple", "/Library/Developer", "/opt/homebrew"];
const TEMP_ROOTS = ["/private/var/folders", "/private/tmp", "/tmp", "/dev"];
const READ_RUNTIME_ROOTS = [...RUNTIME_ROOTS, "/dev"];

/** Only known on-disk credentials: keychains, services and inherited env tokens are out of scope. */
export function credentialFilePaths(home: string, seams: SandboxSeams = {}): string[] {
    const paths = CREDENTIAL_LOCATIONS.map((name) => join(home, name));
    const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
    if (configuredAgentDir) paths.push(join(configuredAgentDir.startsWith("~/")
        ? join(home, configuredAgentDir.slice(2)) : configuredAgentDir, "auth.json"));
    return [...new Set(paths.map((path) => canonicalizePath(path, seams)))].sort();
}

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
        const resolved = canonicalize(absolute);
        // APFS firmlinks are not resolved by realpath. Normalize the Data-volume
        // alias only when both names demonstrably refer to the same inode.
        const dataPrefix = "/System/Volumes/Data";
        if (!seams.canonicalize && currentPlatform(seams) === "darwin" && resolved.startsWith(`${dataPrefix}/`)) {
            const candidate = resolved.slice(dataPrefix.length);
            try {
                const source = statSync(resolved);
                const alias = statSync(candidate);
                if (source.dev === alias.dev && source.ino === alias.ino) return realpathSync(candidate);
            } catch { /* An unrelated Data-volume path keeps its original identity. */ }
        }
        return resolved;
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

    return {
        writableRoot, denyWrite, home: policy.home,
        ...(policy.permissions && {
            permissions: { ...policy.permissions },
            credentialPaths: credentialFilePaths(policy.home, seams),
            runtimeWrite: (policy.runtimeWrite ?? []).map((path) => canonicalizePath(path, seams)),
        }),
    };
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

function isCredential(path: string, policy: CompiledSandboxWritePolicy): boolean {
    return (policy.credentialPaths ?? []).some((credential) => contains(credential, path));
}

function runtimeRoots(seams: SandboxSeams): string[] {
    return [...new Set(READ_RUNTIME_ROOTS.map((path) => canonicalizePath(path, seams)))];
}

/** Decide read access using the same canonical path and capability precedence as writes. */
export function evaluateReadAccess(
    target: string,
    policy: CompiledSandboxWritePolicy,
    seams: SandboxSeams = {},
): ReadAccessDecision {
    const path = canonicalizePath(target, seams);
    const permissions = policy.permissions;
    if (!permissions) return { allowed: true, path };
    const mode = isCredential(path, policy) ? permissions.storedCredentials
        : policy.runtimeWrite?.some((root) => contains(root, path)) ? "read-write"
        : contains(policy.writableRoot, path) ? permissions.projectFiles
        : path === sep || runtimeRoots(seams).some((root) => contains(root, path)) ? "read"
        : permissions.outsideProject;
    return mode === "off" ? { allowed: false, path, reason: "read-denied" } : { allowed: true, path };
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
    if (!policy.permissions && !contains(policy.writableRoot, path)) {
        return { allowed: false, path, reason: "outside-writable-root" };
    }
    for (const denied of policy.denyWrite) {
        if (contains(denied, path)) {
            return { allowed: false, path, reason: "write-denied", deniedBy: denied };
        }
    }
    if (policy.permissions) {
        const mode = isCredential(path, policy) ? policy.permissions.storedCredentials
            : policy.runtimeWrite?.some((root) => contains(root, path)) ? "read-write"
            : contains(policy.writableRoot, path) ? policy.permissions.projectFiles
            : contains(canonicalizePath("/dev", seams), path) ? "read-write"
            : policy.permissions.outsideProject;
        if (mode !== "read-write") return { allowed: false, path, reason: "permission-denied" };
    }
    return { allowed: true, path };
}

/** Quote a path as an SBPL string literal. */
function sbpl(path: string): string {
    return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function validateRuntimeHome(policy: CompiledSandboxWritePolicy, seams: SandboxSeams): void {
    if (policy.permissions?.outsideProject !== "off") return;
    const home = canonicalizePath(policy.home, seams);
    if (RUNTIME_ROOTS.some((root) => contains(canonicalizePath(root, seams), home))) {
        throw new Error("outsideProject=off cannot expose a home under a required system runtime root; move the home or use another permission mode.");
    }
}

function protectedAncestors(paths: readonly string[]): string[] {
    const parents = new Set<string>();
    for (const path of paths) {
        for (let parent = dirname(path); dirname(parent) !== parent; parent = dirname(parent)) parents.add(parent);
    }
    return [...parents].sort((a, b) => a.length - b.length);
}

function buildPermissionProfile(policy: CompiledSandboxWritePolicy, seams: SandboxSeams): string {
    validateRuntimeHome(policy, seams);
    const permissions = policy.permissions!;
    const protectedPaths = [
        ...policy.denyWrite,
        ...(permissions.projectFiles !== "read-write" ? [policy.writableRoot] : []),
        ...(permissions.storedCredentials !== "read-write" ? policy.credentialPaths ?? [] : []),
    ];
    const rules = ["(version 1)", "(allow default)", "(deny file-write*)"];
    if (permissions.outsideProject === "off") {
        rules.push("(deny file-read*)", "(allow file-read-metadata)", '(allow file-read* (literal "/"))');
        for (const root of runtimeRoots(seams)) {
            rules.push(`(allow file-read* (subpath ${sbpl(root)}))`);
        }
    }
    if (permissions.outsideProject === "read-write") rules.push("(allow file-write*)");
    // Temporary host paths are not granted for off/read: doing so would expose
    // other users' files in temp. /dev remains necessary for basic shell I/O.
    for (const root of TEMP_ROOTS.filter((path) => permissions.outsideProject === "read-write" || path === "/dev")
        .map((path) => canonicalizePath(path, seams))) {
        rules.push(`(allow file-write* (subpath ${sbpl(root)}))`);
    }
    const scoped = (root: string, mode: SandboxPermissions["projectFiles"]) => {
        if (mode === "off") rules.push(`(deny file-read* (subpath ${sbpl(root)}))`);
        else rules.push(`(allow file-read* (subpath ${sbpl(root)}))`);
        if (mode === "read-write") rules.push(`(allow file-write* (subpath ${sbpl(root)}))`);
        else rules.push(`(deny file-write* (subpath ${sbpl(root)}))`);
    };
    // Last matching SBPL rule wins. Credential rules override project and outside;
    // explicit denyWrite entries always override every write allowance.
    scoped(policy.writableRoot, permissions.projectFiles);
    for (const path of policy.runtimeWrite ?? []) scoped(path, "read-write");
    for (const path of policy.credentialPaths ?? []) scoped(path, permissions.storedCredentials);
    for (const path of policy.denyWrite) rules.push(`(deny file-write* (subpath ${sbpl(path)}))`);
    // Protect the directory entries, not their contents: unrelated children can
    // still be created, while renaming a parent cannot move a denied subtree.
    for (const path of protectedAncestors(protectedPaths)) rules.push(`(deny file-write-unlink (literal ${sbpl(path)}))`);
    if (!permissions.network) rules.push("(deny network*)");
    return [...rules, ""].join("\n");
}

/** Build the macOS sandbox-exec wrapper and its SBPL profile. */
function buildMacOSSandboxCommand(args: SandboxCommandArgs, seams: SandboxSeams): SandboxCommand {
    // Match on the real (symlink-resolved) path — sandbox-exec evaluates the
    // canonical path, so /tmp/x must be written as /private/tmp/x.
    const policy = compile(args.policy, seams, false);

    const profile = policy.permissions ? buildPermissionProfile(policy, seams) : [
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
    if (policy.permissions) return buildLinuxPermissionCommand(bwrap, args, policy, seams);
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

function buildLinuxPermissionCommand(
    bwrap: string,
    args: SandboxCommandArgs,
    policy: CompiledSandboxWritePolicy,
    seams: SandboxSeams,
): SandboxCommand {
    const permissions = policy.permissions!;
    validateRuntimeHome(policy, seams);
    const project = policy.writableRoot;
    const credentials = policy.credentialPaths ?? [];
    const writableProject = permissions.projectFiles === "read-write";
    const overlappingCredentials = credentials.filter((path) => contains(project, path));
    if (credentials.some((path) => contains(path, project)) &&
        permissions.projectFiles !== permissions.storedCredentials) {
        throw new Error("Linux bubblewrap cannot apply differing project and credential permissions when a credential directory contains the project.");
    }
    if (writableProject && policy.denyWrite.some((path) => contains(path, project))) {
        throw new Error("Linux bubblewrap cannot make a project writable inside a write-denied directory.");
    }
    // Protected leaves and their writable ancestors become mount points below.
    // Linux refuses renaming mount points, preventing ancestor replacement.
    if (permissions.outsideProject === "read-write" && (
        permissions.projectFiles !== "read-write" || permissions.storedCredentials !== "read-write" ||
        policy.denyWrite.length > 0
    )) {
        throw new Error("Linux bubblewrap cannot enforce restricted project/credential/denyWrite paths under a writable outsideProject mount.");
    }
    if (permissions.outsideProject === "read" && permissions.storedCredentials === "read-write" &&
        credentials.some((path) => !contains(project, path))) {
        throw new Error("Linux bubblewrap cannot write credential stores under a read-only outsideProject root.");
    }
    if (permissions.projectFiles === "read" && permissions.storedCredentials === "read-write" &&
        overlappingCredentials.length > 0) {
        throw new Error("Linux bubblewrap cannot write credential stores under a read-only project mount.");
    }
    if (permissions.outsideProject === "read" && permissions.storedCredentials === "off") {
        throw new Error("Linux bubblewrap cannot hide stored credentials in a read-only whole-root bind.");
    }
    if (permissions.outsideProject === "off" && permissions.storedCredentials === "off" &&
        credentials.some((path) => contains(project, path) && permissions.projectFiles !== "off")) {
        throw new Error("Linux bubblewrap cannot hide credentials inside a visible read-only project.");
    }
    if (permissions.outsideProject === "off" && permissions.projectFiles === "off" &&
        RUNTIME_ROOTS.some((root) => contains(canonicalizePath(root, seams), project))) {
        throw new Error("Linux bubblewrap cannot hide a project nested under a required system runtime bind.");
    }
    if (permissions.outsideProject === "off" && credentials.some((path) =>
        !contains(project, path) &&
        RUNTIME_ROOTS.some((root) => contains(canonicalizePath(root, seams), path)) &&
        permissions.storedCredentials === "off")) {
        throw new Error("Linux bubblewrap cannot hide credentials under a required system runtime bind.");
    }
    if (permissions.outsideProject === "off" && permissions.storedCredentials === "read-write" &&
        credentials.some((path) => !contains(project, path))) {
        throw new Error("Linux bubblewrap cannot create or safely bind writable credential stores outside a hidden root.");
    }
    if (permissions.outsideProject === "off" && permissions.projectFiles === "off" &&
        permissions.storedCredentials !== "off" && credentials.some((path) => contains(project, path))) {
        throw new Error("Linux bubblewrap cannot expose credentials inside a hidden project without exposing the project.");
    }
    if (permissions.outsideProject !== "off" && permissions.projectFiles === "off") {
        throw new Error("Linux bubblewrap cannot hide a project inside a visible outsideProject root.");
    }
    const mounts: string[] = permissions.outsideProject === "off" ? ["--tmpfs", "/"]
        : [permissions.outsideProject === "read" ? "--ro-bind" : "--bind", "/", "/"];
    if (permissions.outsideProject === "off") {
        // Bounded system executable/library roots only. /tmp is private, not a
        // host bind: otherwise outsideProject=off would expose user temp data.
        for (const root of RUNTIME_ROOTS) {
            if (existsSync(root)) mounts.push("--ro-bind", root, root);
        }
        mounts.push("--tmpfs", "/tmp");
    } else {
        mounts.push(permissions.outsideProject === "read" ? "--ro-bind" : "--bind", "/tmp", "/tmp");
    }
    mounts.push("--dev", "/dev");
    if (permissions.projectFiles !== "off") {
        mounts.push(writableProject ? "--bind" : "--ro-bind", project, project);
    }
    if (permissions.outsideProject === "off" && permissions.storedCredentials === "read") {
        for (const path of credentials) {
            if (existsSync(path) && !contains(project, path)) mounts.push("--ro-bind", path, path);
        }
    }
    for (const path of policy.runtimeWrite ?? []) {
        if ([...credentials, ...policy.denyWrite].some((protectedPath) => contains(path, protectedPath) || contains(protectedPath, path))) {
            throw new Error("Runtime directory overlaps protected credentials or control paths.");
        }
        mounts.push("--bind", path, path);
    }
    const protectedPaths = [...policy.denyWrite,
        ...(permissions.storedCredentials !== "read-write" ? overlappingCredentials : [])];
    if (writableProject) {
        const materialize = seams.materializeDenyPath ?? materializeDenyPath;
        const leaves = protectedPaths.filter((path) => contains(project, path) && materialize(path));
        for (const parent of protectedAncestors(leaves).filter((path) => contains(project, path) && path !== project)) {
            mounts.push("--bind", parent, parent);
        }
        for (const path of leaves) mounts.push("--ro-bind", path, path);
    }
    return {
        file: bwrap,
        fileArgs: [...mounts, ...(!permissions.network ? ["--unshare-net"] : []),
            "--", args.execPath, ...args.execArgs],
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
    if (args.policy.permissions?.commands === false) {
        throw new Error("Sandbox commands permission is off; enable commands before launching a sandboxed process (including bootstrap).");
    }
    if (!request.sandboxEnabled) return undefined;

    const backend = selectedSandboxBackend(seams);
    if (!backend) {
        if (args.policy.permissions) {
            throw new Error(`Cannot enforce sandbox permissions: ${sandboxUnavailableMessage(seams)}`);
        }
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
    if (args.policy.permissions?.commands === false) {
        throw new Error("Sandbox commands permission is off; enable commands before launching a sandboxed process (including bootstrap).");
    }
    const backend = selectedSandboxBackend(seams);
    if (!backend && args.policy.permissions) {
        throw new Error(`Cannot enforce sandbox permissions: ${sandboxUnavailableMessage(seams)}`);
    }
    return (backend ?? macOSSandboxBackend).buildCommand(args, seams);
}
