/**
 * Windows sandbox plan compiler (inert; no launcher wired yet).
 *
 * This module turns a sandbox policy into a platform-neutral *plan* for the
 * Windows restricted-token backend described in ADR 0010: the SIDs the launched
 * task's restricted token must carry, the access-control entries (ACEs) each
 * real path needs, and the deny-list paths to materialize first. It performs no
 * Win32 calls and touches no filesystem, so it runs and is unit-tested on every
 * OS. Applying the plan (opening tokens, writing DACLs, `CreateProcessAsUserW`)
 * is a separate Windows-only step, and the pipe blocker in ADR 0010 keeps that
 * step from being wired: on win32 the sandbox still fails closed exactly as it
 * did before this module existed.
 *
 * The compiler never invents SIDs. Each rule name is mapped to a persisted
 * `S-1-5-21-…` SID by the caller's `sid` resolver, mirroring how the macOS and
 * Linux backends receive their canonical paths: the mechanism owns the shape of
 * the plan, the caller owns identity and persistence.
 */

/** A single access-control entry the applier must ensure on a real path. */
export type WindowsAce = {
    /** Canonical win32 path the ACE sits on. */
    readonly path: string;
    /** The rule this ACE enforces; the applier resolves it to a concrete SID. */
    readonly rule: WindowsRule;
    /** Symbolic rights, mapped to Win32 access masks by the applier. */
    readonly rights: readonly WindowsRight[];
    /** `allow` narrows (harness SIDs only ever narrow); `deny` blocks the task. */
    readonly mode: "allow" | "deny";
    /** Inherited by children (a tree grant) or set on the entry alone (an anchor). */
    readonly inherit: boolean;
    /** Registry ACEs sit on `HKCU\…` keys, not the filesystem. */
    readonly object: "file" | "registry";
};

/** Symbolic access rights. The applier maps these to Win32 masks. */
export type WindowsRight =
    | "read" | "execute" | "write" | "delete" | "writeDac" | "writeOwner" | "all";

/**
 * The rules a plan can name. Each maps to one persisted SID. `home-read`,
 * `home-write` and the disposable/removal rule are shared across a launch;
 * per-path rules (`credential`, `no-write`, `anchor`, the project rules) reuse a
 * single SID per role, since a restricted token lists each SID once.
 */
export type WindowsRule =
    | "home-read" | "home-write" | "removable"
    | "project-read" | "project-write" | "project-delete" | "project-deny"
    | "credential" | "no-write" | "anchor" | "scratch";

/** A deny-list path the applier must create before launch so its ACE can sit on it. */
export type WindowsMaterialize = { readonly path: string; readonly kind: "file" | "dir" };

/** The compiled Windows sandbox plan. */
export type WindowsSandboxPlan = {
    /**
     * SIDs the task's restricted token carries as restricting SIDs, beyond the
     * fixed well-known set the applier always adds (Everyone, Users, RESTRICTED,
     * the logon SID). Access needs both the user check and this set to pass.
     */
    readonly restrictingSids: readonly string[];
    /** Whether Authenticated Users joins the restricting set (Write & delete). */
    readonly authenticatedUsers: boolean;
    /** Every ACE to ensure, ordered deny-before-allow for a stable apply. */
    readonly aces: readonly WindowsAce[];
    /** Absent deny-list entries to create before the first launch. */
    readonly materialize: readonly WindowsMaterialize[];
    /** Grants dropped because they were rooted inside a denied tree (diagnostics). */
    readonly droppedInsideDenied: readonly string[];
    /** Network access; `false` is unenforceable on Windows and refused upstream. */
    readonly network: boolean;
};

export type SandboxFileAccess = "off" | "read" | "write" | "read-write";

export type WindowsPermissions = {
    readonly projectFiles: SandboxFileAccess;
    readonly outsideProject: SandboxFileAccess;
    readonly storedCredentials: "off" | "read" | "read-write";
    readonly commands: boolean;
    readonly network: boolean;
};

/** Windows known folders the plan needs, resolved by the caller (no env reads here). */
export type WindowsKnownFolders = {
    readonly localAppData: string;
    readonly appData: string;
    /** Documents, possibly redirected to OneDrive; PowerShell profiles live under it. */
    readonly documents: string;
    /** The per-user Startup folder. */
    readonly startup: string;
};

export type WindowsPlanInput = {
    readonly permissions: WindowsPermissions;
    /** The user's home (profile) directory. */
    readonly home: string;
    /** The workspace (project) root. */
    readonly workspace: string;
    /** Caller-supplied extra deny-write paths (`/sandbox deny`). */
    readonly denyWrite?: readonly string[];
    /** Worktree folders discovered within three levels of home. */
    readonly worktreeFolders?: readonly string[];
    /** Per-launch private scratch directory (created empty; removable, all rights). */
    readonly scratch?: string;
    readonly knownFolders: WindowsKnownFolders;
    /** Resolve a rule name to its persisted SID. */
    readonly sid: (rule: WindowsRule) => string;
    /** Paths already present on disk (defaults to none: absent entries are materialized). */
    readonly exists?: (path: string) => boolean;
};

// ---------------------------------------------------------------------------
// Win32 path handling. Implemented here rather than via node:path so the plan
// is identical whatever OS runs the compiler. NTFS is case-insensitive, so
// containment folds case; drive roots (`C:\`) and UNC shares are recognized so
// a rule can never be rooted at a whole volume.
// ---------------------------------------------------------------------------

/** Normalize a win32 path: backslash separators, lower-cased drive, no trailing slash. */
export function normalizeWin32(path: string): string {
    let p = path.replace(/\//g, "\\");
    // Lower-case a leading drive letter; the rest keeps its case for display.
    p = p.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
    const unc = p.startsWith("\\\\");
    // Collapse repeated separators (but keep the UNC `\\` prefix).
    p = (unc ? "\\\\" : "") + p.slice(unc ? 2 : 0).replace(/\\+/g, "\\");
    // Resolve `.` and `..` lexically.
    const isAbs = unc || /^[a-zA-Z]:\\/.test(p);
    const prefix = unc ? "\\\\" : /^[a-zA-Z]:/.test(p) ? p.slice(0, 2) : "";
    const rest = p.slice(prefix.length).replace(/^\\/, "");
    const out: string[] = [];
    for (const part of rest.split("\\")) {
        if (part === "" || part === ".") continue;
        if (part === ".." && out.length && out[out.length - 1] !== "..") { out.pop(); continue; }
        if (part === ".." && !isAbs) { out.push(".."); continue; }
        if (part === "..") continue;
        out.push(part);
    }
    const joined = out.join("\\");
    if (unc) return `\\\\${joined}`;
    if (prefix) return joined ? `${prefix}\\${joined}` : `${prefix}\\`;
    return joined;
}

/** Case-insensitive comparison key for a normalized win32 path. */
function key(path: string): string {
    return normalizeWin32(path).toLowerCase();
}

/** Whether `root` is `target` or an ancestor of it (case-insensitive). */
export function containsWin32(root: string, target: string): boolean {
    const r = key(root), t = key(target);
    if (r === t) return true;
    const withSep = r.endsWith("\\") ? r : `${r}\\`;
    return t.startsWith(withSep);
}

/** Parent directory of a normalized win32 path, or the path itself at a root. */
function parentWin32(path: string): string {
    const p = normalizeWin32(path);
    const idx = p.lastIndexOf("\\");
    if (idx < 0) return p;
    // Drive root (`c:\`) or UNC share root: no further parent.
    if (/^[a-zA-Z]:\\?$/.test(p) || (p.startsWith("\\\\") && p.slice(2).split("\\").length <= 2)) return p;
    const head = p.slice(0, idx);
    if (/^[a-zA-Z]:$/.test(head)) return `${head}\\`;
    if (head.startsWith("\\\\") && head.slice(2).split("\\").length < 2) return p;
    return head || p;
}

/** Whether a normalized path is a volume or share root (never a legal rule target). */
export function isWin32Root(path: string): boolean {
    const p = normalizeWin32(path);
    return /^[a-zA-Z]:\\?$/.test(p) || (p.startsWith("\\\\") && p.slice(2).split("\\").filter(Boolean).length <= 2);
}

function join(base: string, ...parts: string[]): string {
    return normalizeWin32([base, ...parts].join("\\"));
}

/** Strict ancestors of `path`, nearest first, stopping above the volume root. */
function ancestors(path: string): string[] {
    const out: string[] = [];
    let current = normalizeWin32(path);
    for (let parent = parentWin32(current); parent !== current; parent = parentWin32(current)) {
        out.push(parent);
        current = parent;
    }
    return out;
}

// ---------------------------------------------------------------------------
// The fixed Windows lists (ADR 0010). Home-relative entries are joined onto the
// real home; known-folder entries onto their resolved folder. `dir` entries are
// created as directories when absent so their deny ACE has somewhere to sit.
// ---------------------------------------------------------------------------

/** Credential stores: never readable or writable, whatever the row says. */
const WINDOWS_CREDENTIALS: readonly PathSpec[] = [
    { under: "home", rel: ".ssh", kind: "dir" },
    { under: "home", rel: ".aws", kind: "dir" },
    { under: "home", rel: ".azure", kind: "dir" },
    { under: "home", rel: ".kube", kind: "dir" },
    { under: "home", rel: ".npmrc", kind: "file" },
    { under: "home", rel: ".netrc", kind: "file" },
    { under: "home", rel: ".git-credentials", kind: "file" },
    { under: "home", rel: ".pgpass", kind: "file" },
    { under: "appData", rel: "GitHub CLI", kind: "dir" },
    { under: "appData", rel: "gcloud", kind: "dir" },
    { under: "appData", rel: "rclone", kind: "dir" },
    { under: "appData", rel: "Microsoft\\Credentials", kind: "dir" },
    { under: "localAppData", rel: "Microsoft\\Credentials", kind: "dir" },
    { under: "appData", rel: "Microsoft\\Protect", kind: "dir" },
    { under: "localAppData", rel: "Microsoft\\Vault", kind: "dir" },
];

/** Code that runs later: readable, never writable/removable/renamable. */
const WINDOWS_CODE_LATER: readonly PathSpec[] = [
    { under: "home", rel: "bin", kind: "dir" },
    { under: "home", rel: ".local\\bin", kind: "dir" },
    { under: "home", rel: ".gitconfig", kind: "file" },
    { under: "home", rel: ".config\\git", kind: "dir" },
    { under: "home", rel: ".git-templates", kind: "dir" },
    { under: "home", rel: ".pi", kind: "dir" },
    { under: "home", rel: ".claude", kind: "dir" },
    { under: "home", rel: ".agents", kind: "dir" },
    { under: "documents", rel: "PowerShell", kind: "dir" },
    { under: "documents", rel: "WindowsPowerShell", kind: "dir" },
    { under: "startup", rel: "", kind: "dir" },
];

/**
 * HKCU autostart keys treated as code that runs later. Whether a restricted
 * token already blocks all HKCU writes is unresolved (ADR 0010 open problem);
 * these deny ACEs hold either way, and are the minimum the plan asserts.
 */
const WINDOWS_REGISTRY_AUTOSTART: readonly string[] = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce",
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnceEx",
    "HKCU\\Software\\Microsoft\\Command Processor",
];

type PathSpec = { under: keyof WindowsKnownFolders | "home"; rel: string; kind: "file" | "dir" };

function resolveSpec(spec: PathSpec, home: string, folders: WindowsKnownFolders): string {
    const base = spec.under === "home" ? home : folders[spec.under];
    return spec.rel ? join(base, spec.rel) : normalizeWin32(base);
}

// ---------------------------------------------------------------------------
// Compiler.
// ---------------------------------------------------------------------------

const RIGHTS_NO_WRITE: readonly WindowsRight[] = ["write", "delete", "writeDac", "writeOwner"];

/**
 * Compile a Windows sandbox plan. Pure: no Win32 calls, no filesystem access
 * beyond the injected `exists` predicate. The result feeds a Windows-only
 * applier that is not yet wired.
 */
export function compileWindowsSandboxPlan(input: WindowsPlanInput): WindowsSandboxPlan {
    const { permissions, sid } = input;
    const home = normalizeWin32(input.home);
    const workspace = normalizeWin32(input.workspace);
    const folders: WindowsKnownFolders = {
        localAppData: normalizeWin32(input.knownFolders.localAppData),
        appData: normalizeWin32(input.knownFolders.appData),
        documents: normalizeWin32(input.knownFolders.documents),
        startup: normalizeWin32(input.knownFolders.startup),
    };
    const exists = input.exists ?? (() => false);

    if (isWin32Root(home)) throw new Error("The Windows sandbox needs a real home directory, not a drive or share root.");
    if (isWin32Root(workspace)) throw new Error("The Windows sandbox needs a project directory, not a drive or share root.");
    if (containsWin32(workspace, home)) throw new Error("The Windows sandbox needs a project inside or beside home, not home itself.");

    const broad = permissions.outsideProject === "write";
    const aces: WindowsAce[] = [];
    const denyAces: WindowsAce[] = [];
    const restricting = new Set<string>();
    const materialize: WindowsMaterialize[] = [];
    const dropped: string[] = [];

    const use = (rule: WindowsRule) => { const s = sid(rule); restricting.add(s); return s; };
    const allow = (path: string, rule: WindowsRule, rights: readonly WindowsRight[], inherit = true, object: "file" | "registry" = "file") => {
        use(rule);
        aces.push({ path: normalizeWin32(path), rule, rights, mode: "allow", inherit, object });
    };
    const deny = (path: string, rule: WindowsRule, rights: readonly WindowsRight[], inherit = true, object: "file" | "registry" = "file") => {
        use(rule);
        denyAces.push({ path: normalizeWin32(path), rule, rights, mode: "deny", inherit, object });
    };

    // Protected paths: credentials, code that runs later, caller deny-write, and
    // (when the project is not writable) the workspace. Their removal anchors and
    // the "rooted inside a denied tree" check below both use this set.
    const credentialPaths = permissions.storedCredentials === "read-write" && !broad
        ? [] // Only the broad profile forces credentials off; other levels may expose them.
        : WINDOWS_CREDENTIALS.map((spec) => resolveSpec(spec, home, folders));
    const codePaths = WINDOWS_CODE_LATER.map((spec) => resolveSpec(spec, home, folders));
    const callerDeny = (input.denyWrite ?? []).map(normalizeWin32).filter((p) => !isWin32Root(p));
    const noWritePaths = [...codePaths, ...callerDeny];
    const protectedPaths = [...credentialPaths, ...noWritePaths,
        ...(canWrite(permissions.projectFiles) ? [] : [workspace])];

    // A grant is dropped when a denied/protected path is a strict ancestor of it:
    // an explicit allow there would outrank the inherited deny.
    const insideDenied = (grantPath: string): boolean =>
        protectedPaths.some((p) => key(p) !== key(grantPath) && containsWin32(p, grantPath));

    // Home read/write, unless Outside is Off (then only the project is reachable).
    if (permissions.outsideProject !== "off") {
        allow(home, "home-read", ["read", "execute"]);
        if (broad) allow(home, "home-write", ["write"]);
    }

    // Removal grants (a separate SID granting DELETE), by level.
    if (broad) {
        // Disposable places: top-level dot entries of home, %LOCALAPPDATA%\Temp,
        // worktree folders. Ordinary home folders get write (above) but no delete.
        const removableRoots = [
            join(folders.localAppData, "Temp"),
            ...(input.worktreeFolders ?? []).map(normalizeWin32),
        ];
        // Dot entries of home are matched by the applier at walk time; the plan
        // records the ones known now plus the marker rule so the SID is carried.
        use("removable");
        for (const root of removableRoots) {
            if (insideDenied(root)) { dropped.push(root); continue; }
            allow(root, "removable", ["delete"]);
        }
    } else if (permissions.outsideProject === "read-write") {
        // Write & delete outside: home-wide removal, and Authenticated Users so
        // data drives that grant it are writable, as on macOS.
        allow(home, "home-read", ["read", "execute"]);
        allow(home, "home-write", ["write"]);
        allow(home, "removable", ["delete"]);
    }

    // Project row.
    if (permissions.projectFiles === "off") {
        deny(workspace, "project-deny", ["all"]);
    } else {
        allow(workspace, "project-read", ["read", "execute"]);
        if (canWrite(permissions.projectFiles)) allow(workspace, "project-write", ["write"]);
        else deny(workspace, "project-deny", RIGHTS_NO_WRITE);
        if (permissions.projectFiles === "read-write") allow(workspace, "project-delete", ["delete"]);
        else {
            // Project = Write: only worktree folders inside the project are removable.
            for (const wt of (input.worktreeFolders ?? []).map(normalizeWin32)) {
                if (containsWin32(workspace, wt)) allow(wt, "project-delete", ["delete"]);
            }
        }
    }

    // Per-launch scratch: all rights on the empty directory (goes with it).
    if (input.scratch) allow(normalizeWin32(input.scratch), "scratch", ["all"]);

    // Deny list. Credentials deny all; code-that-runs-later and caller deny-write
    // deny write/delete/writeDac/writeOwner. A registry autostart key denies write.
    for (const path of credentialPaths) {
        deny(path, "credential", ["all"]);
        maybeMaterialize(path);
    }
    for (const path of noWritePaths) {
        deny(path, "no-write", RIGHTS_NO_WRITE);
        maybeMaterialize(path);
    }
    for (const regKey of WINDOWS_REGISTRY_AUTOSTART) {
        deny(regKey, "no-write", RIGHTS_NO_WRITE, true, "registry");
    }

    // Anchors: deny DELETE (not inherited) on every ancestor of a protected path
    // and of the workspace, so renaming a parent cannot move a protected subtree
    // or redirect the next launch. Bounded to ancestors within home or the drive.
    const anchorTargets = [...protectedPaths, workspace];
    const anchorSet = new Set<string>();
    for (const target of anchorTargets) {
        for (const parent of ancestors(target)) {
            if (isWin32Root(parent)) continue;
            anchorSet.add(parent);
        }
    }
    // The workspace itself is anchored too (its own directory entry).
    anchorSet.add(workspace);
    for (const path of [...anchorSet].sort()) deny(path, "anchor", ["delete"], false);

    // Deny before allow gives the applier a stable, safe order.
    const orderedAces = [...denyAces, ...aces];

    return {
        restrictingSids: [...restricting].sort(),
        authenticatedUsers: permissions.outsideProject === "read-write",
        aces: orderedAces,
        materialize,
        droppedInsideDenied: dropped.sort(),
        network: permissions.network,
    };

    function maybeMaterialize(path: string): void {
        if (exists(path)) return;
        const spec = [...WINDOWS_CREDENTIALS, ...WINDOWS_CODE_LATER]
            .find((s) => key(resolveSpec(s, home, folders)) === key(path));
        materialize.push({ path: normalizeWin32(path), kind: spec?.kind ?? "file" });
    }
}

function canWrite(mode: SandboxFileAccess): boolean {
    return mode === "write" || mode === "read-write";
}
