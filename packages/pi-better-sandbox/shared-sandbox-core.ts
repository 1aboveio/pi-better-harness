// Generated from packages/sandbox-core/index.ts. Do not edit directly.
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

import { spawn, spawnSync } from "node:child_process";
import { platform as osPlatform } from "node:os";
import {
    accessSync,
    closeSync,
    constants,
    existsSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readlinkSync,
    realpathSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

/** Identifies which kernel mechanism a plan will use. */
export type SandboxBackendId = "macos-seatbelt" | "linux-bubblewrap";

/**
 * File access levels for the Project files and Outside project rows.
 *
 * - `off`: no access.
 * - `read`: read only.
 * - `write`: read, create and overwrite in place. Nothing can be removed or
 *   renamed away (unlink, rmdir, rename of an existing entry, or a rename that
 *   replaces one), except in the always-disposable places: temp, hidden (dot)
 *   entries of the home directory, and git worktree folders (`.worktrees/`,
 *   `*-worktrees/`). For Outside project this is the broad-write profile:
 *   writes across home and temp, and the fixed deny list.
 * - `read-write`: "Write & delete" — the historical read/write level.
 */
export type SandboxFileAccess = "off" | "read" | "write" | "read-write";

export type SandboxPermissions = {
    projectFiles: SandboxFileAccess;
    outsideProject: SandboxFileAccess;
    storedCredentials: "off" | "read" | "read-write";
    commands: boolean;
    network: boolean;
};

/** Whether a file access level allows creating and overwriting files. */
export function canWrite(mode: SandboxFileAccess | undefined): boolean {
    return mode === "write" || mode === "read-write";
}

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
    /** Bounded historical default runtime directories; inactive without a capability profile. */
    runtimeCompatibility?: boolean;
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
    /** Fixed internal helper only: expose its executable in a hidden Linux root. */
    internalHelperExecutable?: boolean;
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
    /** Defaults to /usr/bin/getconf with a minimal environment (macOS only). */
    getconf?: (name: "DARWIN_USER_TEMP_DIR" | "DARWIN_USER_CACHE_DIR") => string | undefined;
    /** Broad-write Linux planning: directory listing (defaults to `readdirSync`). */
    listDirectory?: (path: string) => { name: string; directory: boolean; symlink: boolean }[];
    /** Broad-write Linux planning: existence (defaults to `existsSync`). */
    pathExists?: (path: string) => boolean;
    /** Broad-write Linux planning: whether an existing path is a directory. */
    isDirectory?: (path: string) => boolean;
    /** Broad-write Linux planning: create an absent directory-type deny entry. */
    makeDirectory?: (path: string) => void;
    /** Broad-write Linux planning: empty mode-000 mask sources. */
    maskSources?: (profilePath: string) => { directory: string; file: string };
};

/** A policy with every path canonicalized, deduplicated, and ordered. */
export type CompiledSandboxWritePolicy = {
    readonly writableRoot: string;
    readonly denyWrite: readonly string[];
    readonly home: string;
    readonly permissions?: SandboxPermissions;
    readonly credentialPaths?: readonly string[];
    readonly runtimeWrite?: readonly string[];
    readonly compatibilityWrite?: readonly string[];
    /** Present only for the broad-write profile (Outside project = `write`). */
    readonly broad?: CompiledBroadWrite;
};

/** The canonical inputs of a broad-write profile. */
export type CompiledBroadWrite = {
    /** Canonical home directory. Writes are allowed under it, minus the deny list. */
    readonly home: string;
    /** Canonical temp roots (writable and removal-allowed). */
    readonly tempRoots: readonly string[];
    /** Canonical removal-allowed roots besides temp, dot entries and worktree folders: a Write & delete workspace and runtime scratch. */
    readonly deleteRoots: readonly string[];
    /** Code that runs later: never writable, removable or renamable. Still readable. */
    readonly codePaths: readonly string[];
};

/** Why a write target is or is not permitted by a compiled policy. */
export type WriteAccessDecision =
    | { allowed: true; path: string }
    | {
          allowed: false;
          path: string;
          reason: "outside-writable-root" | "write-denied" | "permission-denied" | "delete-denied";
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

/**
 * Credential stores added by the broad-write profile. They are never readable
 * or writable there, whatever the Stored credentials row says.
 */
const BROAD_CREDENTIAL_LOCATIONS = [
    "Library/Keychains", ".claude/.credentials.json", ".claude.json", ".gnupg",
    ".codex/auth.json", ".cargo/credentials.toml", ".cargo/credentials", ".pgpass", ".config/rclone",
] as const;

/**
 * Code that runs later: shell startup files, agent/harness configuration and
 * login agents. The broad-write profile keeps them readable (skills and
 * extension sources are read by confined tasks) but never writable, removable
 * or renamable. This list is fixed; callers extend it with `denyWrite`.
 */
const CODE_LATER_LOCATIONS = [
    ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile",
    ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
    ".config/fish", ".config/git", ".gitconfig", ".config/systemd/user", ".config/autostart",
    ".pi", ".claude", ".agents", "Library/LaunchAgents",
    ".local/bin", "bin", ".git-templates", ".oh-my-zsh/custom", ".gradle/init.d",
    ".cargo/config.toml", ".cargo/config",
] as const;

/** Deny-list entries that are directories when they exist (Linux materializes them as such). */
const DIRECTORY_LOCATIONS = new Set([
    ".ssh", ".aws", ".config/gh", ".config/gcloud", ".azure", ".kube", "Library/Keychains",
    ".config/fish", ".config/git", ".config/systemd/user", ".config/autostart",
    ".pi", ".claude", ".agents", "Library/LaunchAgents", ".gnupg", ".config/rclone",
    ".local/bin", "bin", ".git-templates", ".oh-my-zsh/custom", ".gradle/init.d",
]);

const BROAD_TEMP_ROOTS: Record<string, readonly string[]> = {
    darwin: ["/private/tmp", "/private/var/folders", "/private/var/tmp"],
    linux: ["/tmp", "/var/tmp", "/dev/shm"],
};

// Executables, dynamic libraries and OS frameworks needed to start a child.
// This deliberately excludes the home directory, /etc, and credential stores.
// A process relying on /etc or /proc configuration (DNS, certificates, NSS)
// may not start or function under Linux outsideProject=off; callers must not
// silently remount these broad host trees to work around that failure.
const RUNTIME_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/System/Library", "/System/Cryptexes", "/Library/Apple", "/Library/Developer", "/opt/homebrew"];
const TEMP_ROOTS = ["/private/var/folders", "/private/tmp", "/tmp", "/dev"];
const READ_RUNTIME_ROOTS = [...RUNTIME_ROOTS, "/dev"];

function systemGetconf(name: "DARWIN_USER_TEMP_DIR" | "DARWIN_USER_CACHE_DIR"): string | undefined {
    const result = spawnSync("/usr/bin/getconf", [name], {
        encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" }, timeout: 3000, maxBuffer: 4096,
    });
    return result.status === 0 ? result.stdout.trim() : undefined;
}

function compatibilityPaths(policy: SandboxWritePolicy, seams: SandboxSeams): string[] {
    if (!policy.permissions || !policy.runtimeCompatibility || policy.permissions.outsideProject === "off") return [];
    const platform = currentPlatform(seams);
    if (platform === "linux") return [canonicalizePath("/tmp", seams)];
    if (platform !== "darwin") return [];
    const home = canonicalizePath(policy.home, seams);
    const project = canonicalizePath(policy.writableRoot, seams);
    const paths = [canonicalizePath("/tmp", seams)];
    for (const [key, leaf] of [["DARWIN_USER_TEMP_DIR", ""], ["DARWIN_USER_CACHE_DIR", "mds"]] as const) {
        const raw = (seams.getconf ?? systemGetconf)(key);
        if (!raw || !raw.startsWith("/") || raw.includes("\0") ||
            raw.split("/").some((part) => part === "." || part === "..")) {
            throw new Error(`Invalid ${key} runtime directory`);
        }
        // getconf returns /var/folders on macOS; /var is a system alias for /private/var.
        const normalized = resolve(raw.replace(/^\/var\/folders\//, "/private/var/folders/"));
        const expected = /^\/private\/var\/folders\/[^/]+\/[^/]+\/[TC]$/.test(normalized) &&
            normalized.endsWith(key === "DARWIN_USER_TEMP_DIR" ? "/T" : "/C");
        const canonical = canonicalizePath(normalized, seams);
        if (!expected || canonical !== normalized ||
            (contains(home, canonical) || contains(canonical, home) || contains(project, canonical))) {
            throw new Error(`Unsafe ${key} runtime directory`);
        }
        paths.push(leaf ? join(canonical, leaf) : canonical);
    }
    // An existing MDS symlink must not redirect the narrow write allowance.
    const mds = paths[2];
    if (!mds || canonicalizePath(mds, seams) !== mds || contains(mds, project) || contains(project, mds)) {
        throw new Error("Unsafe MDS runtime directory");
    }
    return [...new Set(paths)];
}

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

    // The broad profile also keeps each literal entry: its removal grants would
    // otherwise let a task replace a symlinked control path.
    const lexicalDeny = isBroadWritePermissions(policy.permissions);
    const denyWrite = [
        ...new Set((policy.denyWrite ?? []).flatMap((entry) => lexicalDeny
            ? [resolve(entry), ...symlinkHops(entry), canonicalizePath(entry, seams)] : [canonicalizePath(entry, seams)])),
    ].sort();

    const broadMode = isBroadWritePermissions(policy.permissions);
    const compatibilityWrite = broadMode ? [] : compatibilityPaths(policy, seams);
    const runtimeWrite = [...new Set([
        ...(policy.runtimeWrite ?? []).map((path) => canonicalizePath(path, seams)),
        ...compatibilityWrite,
    ])];
    return {
        writableRoot, denyWrite, home: policy.home,
        ...(policy.permissions && {
            // The broad-write profile's credential deny list is not optional.
            permissions: broadMode
                ? { ...policy.permissions, storedCredentials: "off" as const }
                : { ...policy.permissions },
            credentialPaths: broadMode ? broadCredentialPaths(policy.home, seams) : credentialFilePaths(policy.home, seams),
            compatibilityWrite,
            runtimeWrite,
        }),
        ...(broadMode && {
            broad: compileBroadWrite(policy, writableRoot, runtimeWrite, seams),
        }),
    };
}

/** True when a permission profile selects the broad-write profile. */
export function isBroadWritePermissions(permissions: SandboxPermissions | undefined): boolean {
    return permissions?.outsideProject === "write";
}

function expandHome(path: string, home: string): string {
    return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * A fixed-list location both as the literal entry under the canonical home and
 * as the path it resolves to. A dotfiles manager (stow, chezmoi) makes
 * `~/.zshrc` a symlink into an ordinary folder: guarding only the target would
 * let a task remove the link and put a real file in its place.
 */
function lexicalAndCanonical(home: string, name: string, seams: SandboxSeams): string[] {
    const lexical = join(canonicalizePath(home, seams), name);
    return [lexical, ...symlinkHops(lexical), canonicalizePath(lexical, seams)];
}

/**
 * Every symlink directory entry met while resolving `path`, component by
 * component (as `readlink` would follow them), plus where a dangling chain
 * would land. A chain such as
 * `~/.zshrc -> ~/.dotfiles/zshrc -> ~/dotfiles/zshrc` has an intermediate link
 * in a removable directory; replacing it would retarget the protected entry, so
 * each hop the user could replace is protected too. When a followed link
 * points at something missing, creating it would give the entry content, so
 * the first missing component (which covers every missing directory below it)
 * and the full path it would resolve to are protected as well. Bounded: a loop
 * or more than 40 hops stops the walk (such a path resolves to nothing).
 */
function symlinkHops(path: string): string[] {
    const { hops, unresolved } = walkSymlinks(path);
    return [...hops, ...unresolved];
}

function walkSymlinks(path: string): { hops: string[]; unresolved: string[] } {
    const hops: string[] = [];
    const seen = new Set<string>();
    let followed = 0;
    const absolute = resolve(path);
    let current = parse(absolute).root;
    let pending = absolute.slice(current.length).split(sep);
    while (pending.length) {
        const component = pending.shift()!;
        if (!component || component === ".") continue;
        if (component === "..") { current = dirname(current); continue; }
        const entry = join(current, component);
        let link: boolean;
        try {
            link = lstatSync(entry).isSymbolicLink();
        } catch {
            // Missing. Only a followed link makes this a dangling target; a
            // plain absent path is guarded as it is.
            return { hops, unresolved: followed ? [...new Set([entry, resolve(entry, ...pending)])] : [] };
        }
        if (!link) { current = entry; continue; }
        if (++followed > 40 || seen.has(entry)) break;
        seen.add(entry);
        // Only a link the user can replace matters (not e.g. macOS's root-owned /tmp -> private/tmp).
        try { accessSync(current, constants.W_OK); hops.push(entry); } catch { /* immutable entry */ }
        let target: string;
        try { target = readlinkSync(entry); } catch { break; }
        if (isAbsolute(target)) {
            current = parse(target).root;
            pending = [...target.slice(current.length).split(sep), ...pending];
        } else {
            pending = [...target.split(sep), ...pending];
        }
    }
    return { hops, unresolved: [] };
}

/** Whether a symlink resolves to nothing: dangling (ENOENT), or looping or over 40 hops (ELOOP). */
function unresolvable(path: string): boolean {
    try { statSync(path); return false; } catch { return true; }
}

function broadCredentialPaths(home: string, seams: SandboxSeams): string[] {
    const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
    return [...new Set([
        ...credentialFilePaths(home, seams),
        ...[...CREDENTIAL_LOCATIONS, ...BROAD_CREDENTIAL_LOCATIONS].flatMap((name) => lexicalAndCanonical(home, name, seams)),
        ...(configuredAgentDir ? [resolve(expandHome(configuredAgentDir, home), "auth.json"),
            ...symlinkHops(resolve(expandHome(configuredAgentDir, home), "auth.json"))] : []),
    ])].sort();
}

function compileBroadWrite(
    policy: SandboxWritePolicy,
    writableRoot: string,
    runtimeWrite: readonly string[],
    seams: SandboxSeams,
): CompiledBroadWrite {
    const permissions = policy.permissions!;
    const home = canonicalizePath(policy.home, seams);
    if (home === sep || RUNTIME_ROOTS.some((root) => contains(canonicalizePath(root, seams), home))) {
        throw new Error("The broad-write sandbox profile needs a real home directory, not / or a system runtime root.");
    }
    if (writableRoot === home || contains(writableRoot, home)) {
        throw new Error("The broad-write sandbox profile needs a project directory inside or beside home, not home itself.");
    }
    const tempRoots = [...new Set((BROAD_TEMP_ROOTS[currentPlatform(seams)] ?? [])
        .map((path) => canonicalizePath(path, seams)))];
    const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
    const codePaths = [...new Set([
        ...CODE_LATER_LOCATIONS.flatMap((name) => lexicalAndCanonical(home, name, seams)),
        ...(configuredAgentDir ? [resolve(expandHome(configuredAgentDir, home)),
            ...symlinkHops(expandHome(configuredAgentDir, home)),
            canonicalizePath(expandHome(configuredAgentDir, home), seams)] : []),
    ])].sort();
    return {
        home,
        tempRoots,
        deleteRoots: [...new Set([
            ...(permissions.projectFiles === "read-write" ? [writableRoot] : []),
            ...runtimeWrite,
        ])].sort(),
        codePaths,
    };
}

/** Inside a git worktree folder (`.worktrees/`, `*-worktrees/`) below `root`: its contents, not the folder. */
function insideWorktreeFolder(path: string, root: string): boolean {
    if (!contains(root, path) || path === root) return false;
    return path.slice(root.length + 1).split(sep).slice(0, -1)
        .some((part) => part === ".worktrees" || /^[^/]+-worktrees$/.test(part));
}

/** Hidden entries of home, and git worktree folders anywhere under it. */
function disposableHomePath(path: string, home: string): boolean {
    if (!contains(home, path) || path === home) return false;
    return path.slice(home.length + 1).startsWith(".") || insideWorktreeFolder(path, home);
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
    if (policy.broad) {
        const denied = isCredential(path, policy) ||
            (permissions.projectFiles === "off" && contains(policy.writableRoot, path));
        return denied ? { allowed: false, path, reason: "read-denied" } : { allowed: true, path };
    }
    const mode = isCredential(path, policy) ? permissions.storedCredentials
        : policy.runtimeWrite?.some((root) => !policy.compatibilityWrite?.includes(root) && contains(root, path)) ? "read-write"
        : contains(policy.writableRoot, path) ? permissions.projectFiles
        : policy.compatibilityWrite?.some((root) => contains(root, path)) ? "read-write"
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
    if (policy.broad) return evaluateBroadWrite(path, policy, policy.broad, seams);
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
            : policy.runtimeWrite?.some((root) => !policy.compatibilityWrite?.includes(root) && contains(root, path)) ? "read-write"
            : contains(policy.writableRoot, path) ? policy.permissions.projectFiles
            : policy.compatibilityWrite?.some((root) => contains(root, path)) ? "read-write"
            : contains(canonicalizePath("/dev", seams), path) ? "read-write"
            : policy.permissions.outsideProject;
        if (!canWrite(mode)) return { allowed: false, path, reason: "permission-denied" };
    }
    return { allowed: true, path };
}

function evaluateBroadWrite(
    path: string,
    policy: CompiledSandboxWritePolicy,
    broad: CompiledBroadWrite,
    seams: SandboxSeams,
): WriteAccessDecision {
    for (const denied of [...policy.denyWrite, ...broad.codePaths]) {
        if (contains(denied, path)) return { allowed: false, path, reason: "write-denied", deniedBy: denied };
    }
    if (isCredential(path, policy)) return { allowed: false, path, reason: "permission-denied" };
    if (policy.runtimeWrite?.some((root) => contains(root, path))) return { allowed: true, path };
    if (contains(policy.writableRoot, path)) {
        return canWrite(policy.permissions!.projectFiles)
            ? { allowed: true, path } : { allowed: false, path, reason: "permission-denied" };
    }
    if ([...broad.tempRoots, ...broad.deleteRoots, canonicalizePath("/dev", seams)].some((root) => contains(root, path))) {
        return { allowed: true, path };
    }
    if (contains(broad.home, path)) {
        // Linux cannot separate removal from writing, so its fallback keeps
        // ordinary (non-dot) top-level home folders read-only instead.
        if (currentPlatform(seams) === "linux" && !disposableHomePath(path, broad.home)) {
            return { allowed: false, path, reason: "permission-denied" };
        }
        return { allowed: true, path };
    }
    return { allowed: false, path, reason: "permission-denied" };
}

/**
 * Decide whether `target` may be removed or renamed away (unlink, rmdir,
 * rename of the source, or rename over an existing destination). Outside the
 * broad-write profile removal follows write access.
 */
export function evaluateDeleteAccess(
    target: string,
    policy: CompiledSandboxWritePolicy,
    seams: SandboxSeams = {},
): WriteAccessDecision {
    const write = evaluateWriteAccess(target, policy, seams);
    const broad = policy.broad;
    if (!write.allowed) return write;
    const path = write.path;
    if (!broad) {
        // Project files = Write outside the broad profile: nothing in the
        // project is removable except worktree folders' contents.
        return policy.permissions?.projectFiles === "write" && contains(policy.writableRoot, path) &&
            !insideWorktreeFolder(path, policy.writableRoot)
            ? { allowed: false, path, reason: "delete-denied" } : write;
    }
    const anchors = broadProtectedPaths(policy, broad);
    if (anchors.some((protectedPath) => protectedPath !== path && contains(path, protectedPath))) {
        return { allowed: false, path, reason: "delete-denied" };
    }
    if (path === policy.writableRoot || contains(path, policy.writableRoot)) {
        return { allowed: false, path, reason: "delete-denied" };
    }
    if ([...broad.tempRoots, ...broad.deleteRoots].some((root) => contains(root, path)) ||
        disposableHomePath(path, broad.home)) {
        return write;
    }
    return { allowed: false, path, reason: "delete-denied" };
}

/**
 * Whether an already-canonical path lies where a Write level still allows
 * removal: temp, hidden home entries, worktree folders, a Write & delete
 * workspace and runtime scratch (broad profile), or a worktree folder inside a
 * Project files = Write workspace. The leaf is not re-resolved, so a caller can
 * ask about a symlink's own directory entry.
 */
export function isRemovableUnderWrite(path: string, policy: CompiledSandboxWritePolicy): boolean {
    const broad = policy.broad;
    if (broad) {
        if (broadProtectedPaths(policy, broad).some((guard) => contains(guard, path) || contains(path, guard))) return false;
        return [...broad.tempRoots, ...broad.deleteRoots].some((root) => contains(root, path)) ||
            disposableHomePath(path, broad.home);
    }
    return policy.permissions?.projectFiles === "write" && insideWorktreeFolder(path, policy.writableRoot);
}

/** Outcome of a finished snapshot attempt. */
export type RecoverySnapshotOutcome = { ok: boolean; detail: string };

/** Result of a best-effort recovery snapshot request. */
export type RecoverySnapshotResult =
    | { started: true; done: Promise<RecoverySnapshotOutcome> }
    | { started: false; reason: "not-needed" | "unsupported" | "rate-limited" };

export type RecoverySnapshotSeams = {
    platform?: () => string;
    now?: () => number;
    /** Defaults to an unref'd `/usr/bin/tmutil localsnapshot` child with a 30 s limit. */
    run?: () => Promise<RecoverySnapshotOutcome>;
};

let lastRecoverySnapshot = 0;
const RECOVERY_SNAPSHOT_INTERVAL_MS = 15 * 60 * 1000;

function runLocalSnapshot(): Promise<RecoverySnapshotOutcome> {
    return new Promise((resolveOutcome) => {
        let output = "";
        let settled = false;
        const finish = (outcome: RecoverySnapshotOutcome) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolveOutcome(outcome);
        };
        const child = spawn("/usr/bin/tmutil", ["localsnapshot"], {
            env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"],
        });
        const timer = setTimeout(() => { child.kill("SIGKILL"); finish({ ok: false, detail: "tmutil timed out after 30 s" }); }, 30_000);
        timer.unref();
        child.unref();
        for (const stream of [child.stdout, child.stderr]) {
            stream?.on("data", (chunk: Buffer) => { output = (output + chunk.toString()).slice(-2048); });
            (stream as { unref?: () => void } | null)?.unref?.();
        }
        child.on("error", (error) => finish({ ok: false, detail: error.message }));
        child.on("close", (code) => finish(code === 0
            ? { ok: true, detail: output.trim() }
            : { ok: false, detail: output.trim() || `tmutil exited ${code}` }));
    });
}

/**
 * Start an APFS local snapshot (`tmutil localsnapshot`) before a confined run
 * whose Outside project level lets it change files outside the project: Write
 * & delete can remove them, and Write can still truncate, chmod or chflags
 * them in place. macOS only; it needs no elevated privileges. The snapshot
 * runs in the background and never blocks or fails the run; callers log a
 * failed outcome. Snapshots are volume-wide and purgeable, so one per 15
 * minutes per process is enough. `PI_SANDBOX_RECOVERY_SNAPSHOT=off` disables it
 * (test suites set it so they do not create real snapshots).
 */
export function takeRecoverySnapshot(
    permissions: SandboxPermissions | undefined,
    seams: RecoverySnapshotSeams = {},
): RecoverySnapshotResult {
    if (!canWrite(permissions?.outsideProject) || process.env.PI_SANDBOX_RECOVERY_SNAPSHOT === "off") {
        return { started: false, reason: "not-needed" };
    }
    if ((seams.platform ?? osPlatform)() !== "darwin") return { started: false, reason: "unsupported" };
    const now = (seams.now ?? Date.now)();
    if (lastRecoverySnapshot && now - lastRecoverySnapshot < RECOVERY_SNAPSHOT_INTERVAL_MS) {
        return { started: false, reason: "rate-limited" };
    }
    lastRecoverySnapshot = now;
    let done: Promise<RecoverySnapshotOutcome>;
    try {
        done = (seams.run ?? runLocalSnapshot)().catch((error: unknown) =>
            ({ ok: false, detail: error instanceof Error ? error.message : String(error) }));
    } catch (error) {
        done = Promise.resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    return { started: true, done };
}

/** Test hook: forget the last snapshot time. */
export function resetRecoverySnapshotClock(): void {
    lastRecoverySnapshot = 0;
}

function broadProtectedPaths(policy: CompiledSandboxWritePolicy, broad: CompiledBroadWrite): string[] {
    return [...policy.denyWrite, ...(policy.credentialPaths ?? []), ...broad.codePaths,
        ...(!canWrite(policy.permissions?.projectFiles) ? [policy.writableRoot] : [])];
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
        ...(policy.compatibilityWrite ?? []),
    ];
    if (permissions.outsideProject === "write") throw new Error("Outside project = Write uses the broad-write profile.");
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
        if (canWrite(mode)) rules.push(`(allow file-write* (subpath ${sbpl(root)}))`);
        else rules.push(`(deny file-write* (subpath ${sbpl(root)}))`);
    };
    // Last matching SBPL rule wins. Credential rules override project and outside;
    // explicit denyWrite entries always override every write allowance.
    for (const path of policy.compatibilityWrite ?? []) scoped(path, "read-write");
    scoped(policy.writableRoot, permissions.projectFiles);
    if (permissions.projectFiles === "write" && !TEMP_ROOTS.filter((root) => root !== "/dev")
        .some((root) => contains(canonicalizePath(root, seams), policy.writableRoot))) {
        // Write without delete: only a worktree folder's contents stay removable.
        const project = sbplRegexPath(policy.writableRoot);
        rules.push(`(deny file-write-unlink (subpath ${sbpl(policy.writableRoot)}))`,
            `(allow file-write-unlink (regex #"^${project}/(.+/)?[.]worktrees/."))`,
            `(allow file-write-unlink (regex #"^${project}/(.+/)?[^/]+-worktrees/."))`);
    }
    for (const path of (policy.runtimeWrite ?? []).filter((path) => !policy.compatibilityWrite?.includes(path))) scoped(path, "read-write");
    for (const path of policy.credentialPaths ?? []) scoped(path, permissions.storedCredentials);
    // Explicit unlink denials too: a `file-write-unlink` allowance above would
    // otherwise outrank a `file-write*` denial.
    for (const path of policy.denyWrite) {
        rules.push(`(deny file-write* (subpath ${sbpl(path)}))`);
        if (permissions.projectFiles === "write") rules.push(`(deny file-write-unlink (subpath ${sbpl(path)}))`);
    }
    // Protect the directory entries, not their contents: unrelated children can
    // still be created, while renaming a parent cannot move a denied subtree.
    for (const path of protectedAncestors(protectedPaths)) rules.push(`(deny file-write-unlink (literal ${sbpl(path)}))`);
    for (const path of policy.compatibilityWrite ?? []) rules.push(`(deny file-write-unlink (literal ${sbpl(path)}))`);
    if (!permissions.network) rules.push("(deny network*)");
    return [...rules, ""].join("\n");
}

/** Escape a canonical path for an SBPL regular expression literal. */
function sbplRegexPath(path: string): string {
    return path.replace(/[\\.^$|?*+()[\]{}"]/g, (char) => `\\${char}`);
}

/**
 * The broad-write profile on Seatbelt.
 *
 * Seatbelt has no separate rename operation: `file-write-unlink` guards unlink,
 * rmdir, the source of a rename, and an existing destination a rename replaces.
 * Denying it outside the disposable roots therefore refuses `rm`, `rm -rf` and
 * `mv dir elsewhere`, and also a save that renames a temp file over an existing
 * file there. Writing a file in place (truncate + write) stays allowed.
 */
function buildBroadProfile(policy: CompiledSandboxWritePolicy, seams: SandboxSeams): string {
    const permissions = policy.permissions!;
    const broad = policy.broad!;
    const rules = ["(version 1)", "(allow default)", "(deny file-write*)",
        `(allow file-write* (subpath ${sbpl(broad.home)}))`];
    const project = policy.writableRoot;
    for (const root of [...broad.tempRoots, canonicalizePath("/dev", seams), ...broad.deleteRoots,
        ...(policy.runtimeWrite ?? []), ...(canWrite(permissions.projectFiles) ? [project] : [])]) {
        rules.push(`(allow file-write* (subpath ${sbpl(root)}))`);
    }
    if (permissions.projectFiles === "off") rules.push(`(deny file-read* (subpath ${sbpl(project)}))`);
    rules.push("(deny file-write-unlink)");
    for (const root of [...broad.tempRoots, ...broad.deleteRoots]) {
        rules.push(`(allow file-write-unlink (subpath ${sbpl(root)}))`);
    }
    const home = sbplRegexPath(broad.home);
    rules.push(
        `(allow file-write-unlink (regex #"^${home}/[.][^/]+$"))`,
        `(allow file-write-unlink (regex #"^${home}/[.][^/]+/"))`,
        `(allow file-write-unlink (regex #"^${home}/(.+/)?[.]worktrees/."))`,
        `(allow file-write-unlink (regex #"^${home}/(.+/)?[^/]+-worktrees/."))`,
    );
    // The fixed deny list overrides every grant above. A rule naming
    // `file-write-unlink` outranks a `file-write*` wildcard whatever their
    // order (verified on the real kernel), so each protected path also gets an
    // explicit unlink denial; otherwise the removal grants above would reopen it.
    const denyWrite = (path: string) => rules.push(
        `(deny file-write* (subpath ${sbpl(path)}))`, `(deny file-write-unlink (subpath ${sbpl(path)}))`);
    if (!canWrite(permissions.projectFiles)) denyWrite(project);
    for (const path of broad.codePaths) denyWrite(path);
    for (const path of policy.credentialPaths ?? []) {
        rules.push(`(deny file-read* (subpath ${sbpl(path)}))`);
        denyWrite(path);
    }
    for (const path of policy.denyWrite) denyWrite(path);
    // Renaming an ancestor would move a protected subtree to an unprotected path,
    // and renaming the workspace's ancestors could redirect the next launch.
    const anchors = [...broadProtectedPaths(policy, broad), project];
    for (const path of [...new Set([...protectedAncestors(anchors), project])]) {
        rules.push(`(deny file-write-unlink (literal ${sbpl(path)}))`);
    }
    if (!permissions.network) rules.push("(deny network*)");
    return [...rules, ""].join("\n");
}

/** Build the macOS sandbox-exec wrapper and its SBPL profile. */
function buildMacOSSandboxCommand(args: SandboxCommandArgs, seams: SandboxSeams): SandboxCommand {
    // Match on the real (symlink-resolved) path — sandbox-exec evaluates the
    // canonical path, so /tmp/x must be written as /private/tmp/x.
    const policy = compile(args.policy, seams, false);

    const profile = policy.broad ? buildBroadProfile(policy, seams)
        : policy.permissions ? buildPermissionProfile(policy, seams) : [
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

/** Resolve only a root-owned system executable; never inspect task PATH. */
function systemSandboxExecutable(name: string): string | undefined {
    // Never resolve the host-side confinement launcher through task-influenced PATH.
    for (const directory of ["/usr/bin", "/bin"]) {
        const candidate = join(directory, name);
        try {
            const info = statSync(candidate);
            if (!info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch { /* Try the next system location. */ }
    }
    return undefined;
}

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
 * Returns false when the placeholder could not be created. Callers must fail
 * closed for writable regions: a task may replace or chmod the blocking parent.
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
    if (policy.broad) return buildLinuxBroadCommand(bwrap, args, policy, seams);
    if (policy.permissions) return buildLinuxPermissionCommand(bwrap, args, policy, seams);
    const materialize = seams.materializeDenyPath ?? materializeDenyPath;
    const denyBinds = policy.denyWrite.flatMap((path) => {
        const writable = writableInsideLinuxSandbox(path, policy.writableRoot);
        if (writable && !materialize(path)) throw new Error(`Cannot protect denied path: ${path}`);
        return [writable ? "--ro-bind" : "--ro-bind-try", path, path];
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
            // read-only regardless. A writable region whose guard cannot be
            // materialized must fail before launching the task.
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
    if (permissions.projectFiles === "write" || permissions.outsideProject === "write") {
        throw new Error("Linux bubblewrap cannot separate removal from writing for Project files; use Write & delete or Read.");
    }
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
        if (args.internalHelperExecutable) {
            const executable = canonicalizePath(args.execPath, seams);
            if (!RUNTIME_ROOTS.some((root) => contains(canonicalizePath(root, seams), executable))) {
                mounts.push("--ro-bind", executable, executable);
            }
        }
    } else {
        mounts.push(permissions.outsideProject === "read" && !policy.compatibilityWrite?.includes(canonicalizePath("/tmp", seams)) ? "--ro-bind" : "--bind", "/tmp", "/tmp");
    }
    mounts.push("--dev", "/dev");
    const scopedMounts: { option: "--bind" | "--ro-bind"; path: string }[] = [];
    const writableAncestors = new Set<string>();
    const readOnlyGuards = new Set<string>();
    if (permissions.outsideProject === "off" && permissions.storedCredentials === "read") {
        for (const path of credentials) {
            if (existsSync(path) && !contains(project, path)) readOnlyGuards.add(path);
        }
    }
    // A broad /tmp bind is already present for visible outside roots. Cover
    // existing leaves and absent leaves via a read-only existing ancestor; do
    // not create credential or control files in host runtime directories.
    const compatibility = policy.compatibilityWrite ?? [];
    if (compatibility.length) {
        const tmp = canonicalizePath("/tmp", seams);
        const protectedInTmp = [...policy.denyWrite, ...(permissions.storedCredentials !== "read-write" ? credentials : [])]
            .filter((path) => contains(tmp, path) && !contains(project, path));
        if (permissions.storedCredentials === "off" && protectedInTmp.some((path) =>
            credentials.some((credential) => credential === path))) {
            throw new Error("Linux bubblewrap cannot hide credentials under a writable runtime directory.");
        }
        if (policy.denyWrite.some((path) => contains(path, tmp))) {
            throw new Error("Runtime directory overlaps a write-denied control path.");
        }
        const guards = new Set<string>();
        for (const path of protectedInTmp) {
            let guard = path;
            while (!existsSync(guard) && contains(tmp, guard) && guard !== tmp) guard = dirname(guard);
            if (guard === tmp || !contains(tmp, guard)) {
                throw new Error("Cannot protect an absent path directly under writable runtime directory.");
            }
            guards.add(guard);
        }
        for (const guard of [...guards].sort((a, b) => a.length - b.length)) {
            if ([...guards].some((parent) => parent !== guard && contains(parent, guard))) continue;
            for (const parent of protectedAncestors([guard]).filter((parent) => contains(tmp, parent) && parent !== tmp)) {
                writableAncestors.add(parent);
            }
            readOnlyGuards.add(guard);
        }
        // A writable /tmp can rename any directory above the captured project
        // root, then substitute a symlink before the next launch. Anchor each
        // ancestor even when there are no explicit control or credential guards.
        if (permissions.projectFiles !== "off" && contains(tmp, project)) {
            for (const parent of protectedAncestors([project]).filter((path) => contains(tmp, path) && path !== tmp)) {
                writableAncestors.add(parent);
            }
        }
    }
    if (permissions.projectFiles !== "off") {
        scopedMounts.push({ option: writableProject ? "--bind" : "--ro-bind", path: project });
    }
    for (const path of policy.runtimeWrite ?? []) {
        if (compatibility.includes(path)) continue;
        if (credentials.some((protectedPath) => contains(path, protectedPath) || contains(protectedPath, path)) ||
            policy.denyWrite.some((protectedPath) => contains(protectedPath, path))) {
            throw new Error("Runtime directory overlaps protected credentials or control paths.");
        }
        scopedMounts.push({ option: "--bind", path });
    }
    const protectedPaths = [...policy.denyWrite,
        ...(permissions.storedCredentials !== "read-write" ? overlappingCredentials : [])];
    for (const writableRoot of [...(writableProject ? [project] : []),
        ...(policy.runtimeWrite ?? []).filter((path) => !compatibility.includes(path))]) {
        const materialize = seams.materializeDenyPath ?? materializeDenyPath;
        const leaves = protectedPaths.filter((path) => contains(writableRoot, path));
        for (const path of leaves) {
            if (!materialize(path)) throw new Error(`Cannot protect denied path: ${path}`);
        }
        for (const parent of protectedAncestors(leaves).filter((path) => contains(writableRoot, path) && path !== writableRoot)) {
            writableAncestors.add(parent);
        }
        for (const path of leaves) readOnlyGuards.add(path);
    }
    // A nearest-existing guard can be an ancestor of an unrelated writable
    // project (e.g. absent ~/.npmrc with a project under ~/work). Mount that
    // broad guard in path order, keeping its intervening anchors read-only;
    // only the disjoint project subtree may be rebound writable afterwards.
    const ancestorGuards = [...readOnlyGuards].filter((guard) =>
        scopedMounts.some(({ option, path }) => option === "--bind" && guard !== path && contains(guard, path)));
    for (const guard of ancestorGuards) {
        scopedMounts.push({ option: "--ro-bind", path: guard });
        readOnlyGuards.delete(guard);
    }
    for (const path of writableAncestors) scopedMounts.push({
        option: ancestorGuards.some((guard) => contains(guard, path)) ? "--ro-bind" : "--bind", path,
    });
    scopedMounts.sort((a, b) => a.path.length - b.path.length);
    for (const { option, path } of scopedMounts) mounts.push(option, path, path);
    for (const path of [...readOnlyGuards].sort((a, b) => a.length - b.length)) {
        mounts.push("--ro-bind", path, path);
    }
    return {
        file: bwrap,
        fileArgs: [...mounts, ...(!permissions.network ? ["--unshare-net"] : []),
            "--", args.execPath, ...args.execArgs],
    };
}

type DirectoryEntry = { name: string; directory: boolean; symlink: boolean };

function systemListDirectory(path: string): DirectoryEntry[] {
    try {
        return readdirSync(path, { withFileTypes: true }).map((entry) => ({
            name: entry.name, directory: entry.isDirectory(), symlink: entry.isSymbolicLink(),
        }));
    } catch {
        return [];
    }
}

/**
 * Worktree folders (`.worktrees`, `*-worktrees`) within three levels of home.
 * Bounded so a large home cannot stall a launch; a folder created after launch
 * or deeper than that stays read-only on Linux.
 */
function discoverWorktreeFolders(home: string, list: (path: string) => DirectoryEntry[]): string[] {
    const found: string[] = [];
    let budget = 4000;
    const walk = (directory: string, depth: number) => {
        for (const entry of list(directory)) {
            if (--budget < 0 || !entry.directory || entry.symlink) continue;
            const path = join(directory, entry.name);
            if (entry.name === ".worktrees" || entry.name.endsWith("-worktrees")) found.push(path);
            else if (!entry.name.startsWith(".") && depth < 3) walk(path, depth + 1);
        }
    };
    walk(home, 1);
    return found;
}

/** Empty, mode-000 mask sources a hidden credential is bound over. */
function maskSources(profilePath: string): { directory: string; file: string } {
    const base = join(dirname(profilePath), ".pi-sandbox-mask");
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const directory = join(base, "directory");
    const file = join(base, "file");
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o000 });
    if (!existsSync(file)) closeSync(openSync(file, "wx", 0o000));
    for (const [path, isDirectory] of [[directory, true], [file, false]] as const) {
        const info = lstatSync(path);
        if (info.isDirectory() !== isDirectory || (info.mode & 0o777) !== 0 || (!isDirectory && info.size !== 0)) {
            throw new Error(`Unsafe sandbox mask source: ${path}`);
        }
    }
    return { directory, file };
}

/**
 * The broad-write profile on Bubblewrap.
 *
 * Mount namespaces cannot separate removal from writing, and Landlock is not
 * reachable from Node or bwrap here, so Linux uses the documented fallback:
 * the root is read-only; temp, the workspace, hidden home entries and worktree
 * folders are writable (removal included); ordinary top-level home folders and
 * home itself stay read-only, so sibling repositories cannot even be edited in
 * place there. Credentials are masked by empty mode-000 mounts; code that runs
 * later and caller-denied paths are read-only binds. Every writable bind and
 * protected leaf is a mount point, which Linux refuses to rename. A protected
 * symlink inside a writable directory (a stow link in `~/.config`) makes that
 * directory read-only with each existing entry bound writable again, so only
 * new top-level entries there are refused.
 */
function buildLinuxBroadCommand(
    bwrap: string,
    args: SandboxCommandArgs,
    policy: CompiledSandboxWritePolicy,
    seams: SandboxSeams,
): SandboxCommand {
    const permissions = policy.permissions!;
    const broad = policy.broad!;
    const project = policy.writableRoot;
    if (permissions.projectFiles === "off") {
        throw new Error("Linux bubblewrap cannot hide a project inside the broad-write profile's visible root.");
    }
    if (permissions.projectFiles === "write") {
        throw new Error("Linux bubblewrap cannot separate removal from writing for Project files; use Write & delete or Read.");
    }
    const credentials = policy.credentialPaths ?? [];
    const writeDenied = [...broad.codePaths, ...policy.denyWrite];
    if (permissions.projectFiles === "read-write" &&
        [...credentials, ...writeDenied].some((path) => path !== project && contains(path, project))) {
        throw new Error("Linux bubblewrap cannot make a project writable inside a protected directory.");
    }
    const list = seams.listDirectory ?? systemListDirectory;
    const exists = (path: string) => (seams.pathExists ?? existsSync)(path);
    const protectedPaths = [...credentials, ...writeDenied];
    const insideProtected = (path: string) => protectedPaths.some((guard) => contains(guard, path));

    const writable = new Set<string>();
    for (const root of broad.tempRoots) if (exists(root)) writable.add(root);
    for (const entry of list(broad.home)) {
        if (entry.symlink) continue;
        const path = join(broad.home, entry.name);
        if (entry.name.startsWith(".") && !insideProtected(path)) writable.add(path);
    }
    for (const path of discoverWorktreeFolders(broad.home, list)) if (!insideProtected(path)) writable.add(path);
    for (const path of [...broad.deleteRoots, ...(policy.runtimeWrite ?? [])]) {
        if (path === project || !exists(path)) continue;
        if (insideProtected(path)) throw new Error(`Writable sandbox root overlaps a protected path: ${path}`);
        writable.add(path);
    }
    if (permissions.projectFiles === "read-write") writable.add(project);
    const writableRoots = [...writable];
    const writableAt = (path: string) => writableRoots.some((root) => contains(root, path));

    const mask = (seams.maskSources ?? maskSources)(args.profilePath);
    const materialize = seams.materializeDenyPath ?? materializeDenyPath;
    const hidden: { path: string; source: string }[] = [];
    const readOnly = new Set<string>();
    const directoryLocation = (path: string) => [...DIRECTORY_LOCATIONS]
        .some((name) => canonicalizePath(join(broad.home, name), seams) === path);
    // Directories holding a protected symlink: read-only, so the link cannot be
    // replaced, with their existing entries bound writable again below.
    const linkParents = new Set<string>();
    const danglingTargets = new Set(protectedPaths.flatMap((path) => walkSymlinks(path).unresolved));
    const guard = (path: string, hide: boolean) => {
        let directory: boolean | undefined;
        let link = false;
        try { link = lstatSync(path).isSymbolicLink(); } catch { /* absent or intermediate link */ }
        if (canonicalizePath(path, seams) !== path || (link && unresolvable(path))) {
            // A literal twin of a canonical deny entry: its target is guarded on
            // its own. A looping link resolves to nothing (ELOOP), and a dangling
            // one's missing target is guarded below, so only the link itself
            // needs guarding here. A symlink leaf inside a writable root could be
            // replaced, so its directory is protected; home already is.
            if (link && dirname(path) !== broad.home && writableAt(dirname(path))) linkParents.add(dirname(path));
            return;
        }
        if (danglingTargets.has(path)) {
            // Where a dangling link would land: nothing may be created there.
            // Lock its nearest existing ancestor (entries stay writable, see
            // below) rather than plant a placeholder in the user's files. Temp
            // and the workspace root stay open to new entries, so a placeholder
            // is bound there instead, failing closed if it cannot be made.
            if (!writableAt(path)) return;
            let ancestor = dirname(path);
            while (!exists(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
            if (ancestor === project || broad.tempRoots.includes(ancestor)) {
                if (!materialize(path)) throw new Error(`Cannot protect denied path: ${path}`);
                readOnly.add(path);
            } else if (ancestor !== broad.home) {
                linkParents.add(ancestor);
            }
            return;
        }
        if (!exists(path)) {
            if (!writableAt(path)) return; // Nothing inside the sandbox can create it.
            let ancestor = dirname(path);
            while (!exists(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
            if (directoryLocation(path)) {
                (seams.makeDirectory ?? ((target: string) => mkdirSync(target, { recursive: true, mode: 0o700 })))(path);
                directory = true;
            } else if (writableRoots.includes(ancestor) || contains(project, ancestor) ||
                broad.tempRoots.some((root) => contains(root, ancestor))) {
                if (!materialize(path)) throw new Error(`Cannot protect denied path: ${path}`);
            } else {
                readOnly.add(ancestor);
                return;
            }
        }
        if (hide) {
            directory ??= seams.isDirectory ? seams.isDirectory(path) : statSync(path).isDirectory();
            hidden.push({ path, source: directory ? mask.directory : mask.file });
        } else {
            readOnly.add(path);
        }
    };
    for (const path of credentials) guard(path, true);
    for (const path of writeDenied) guard(path, false);
    if (permissions.projectFiles === "read") readOnly.add(project);

    // A read-only link parent keeps its existing entries writable: each one is
    // bound back read-write (a mount point, so it cannot be renamed away either).
    // Only new top-level entries in that directory are lost. Protected entries
    // keep their own mounts, and a symlink entry is never bound: a bind follows
    // it, and writes through it already meet its target's own mounts.
    const rebound = new Set<string>();
    for (const parent of linkParents) readOnly.add(parent);
    for (const parent of linkParents) {
        for (const entry of list(parent)) {
            if (entry.symlink) continue;
            const path = join(parent, entry.name);
            if (insideProtected(path) || readOnly.has(path) || writable.has(path)) continue;
            rebound.add(path);
        }
    }

    // Intermediate directories between a writable root and anything bound
    // inside it become mount points too, so none of them can be renamed away.
    const anchors = new Set<string>();
    for (const target of [...writableRoots, ...readOnly, ...hidden.map((entry) => entry.path)]) {
        for (const parent of protectedAncestors([target])) {
            if (writableRoots.some((root) => root !== parent && contains(root, parent)) &&
                !readOnly.has(parent) && !writable.has(parent) && !rebound.has(parent)) anchors.add(parent);
        }
    }
    type Mount = { option: "--bind" | "--bind-try" | "--ro-bind"; source: string; path: string; rank: number };
    const mounts: Mount[] = [
        ...[...anchors].map((path) => ({ option: "--bind" as const, source: path, path, rank: 0 })),
        ...writableRoots.map((path) => ({ option: "--bind" as const, source: path, path, rank: 1 })),
        // `-try`: an entry removed before a resumed launch stays read-only instead of failing it.
        ...[...rebound].map((path) => ({ option: "--bind-try" as const, source: path, path, rank: 1 })),
        ...[...readOnly].map((path) => ({ option: "--ro-bind" as const, source: path, path, rank: 2 })),
        ...hidden.map(({ path, source }) => ({ option: "--ro-bind" as const, source, path, rank: 3 })),
    ].sort((a, b) => a.path.length - b.path.length || a.rank - b.rank);
    const seen = new Set<string>();
    const fileArgs = ["--ro-bind", "/", "/", "--dev", "/dev"];
    for (const mount of mounts) {
        const key = `${mount.option}\0${mount.source}\0${mount.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fileArgs.push(mount.option, mount.source, mount.path);
    }
    return {
        file: bwrap,
        fileArgs: [...fileArgs, ...(!permissions.network ? ["--unshare-net"] : []),
            "--", args.execPath, ...args.execArgs],
    };
}

function linuxSandboxBackend(seams: SandboxSeams): SandboxBackend | undefined {
    const bwrap = (seams.lookupExecutable ?? systemSandboxExecutable)("bwrap");
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
        return "Linux sandbox requires executable bubblewrap (bwrap) in /usr/bin or /bin. Install bubblewrap to enable it.";
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
