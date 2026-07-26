/**
 * Disposable Git clone workspace preparation for sandboxed subagents.
 *
 * Sandboxed subagents that need to mutate Git cannot safely run in a linked
 * Git worktree: the worktree's `.git` file points back to administrative state
 * under the main repository, outside the sandbox writable root. This module
 * prepares a self-contained clone whose `.git/` directory lives inside the
 * sandbox root.
 *
 * Preferred clone strategy:
 *   git clone --reference-if-able <local-reference-repo> --dissociate \
 *             <remote-url> <sandbox-workspace>
 *
 * --reference-if-able borrows local objects during setup; --dissociate makes
 * the resulting clone independent of the reference repository afterwards.
 * The clone source prefers the source workspace's upstream remote URL so the
 * disposable workspace's `origin` points at the real remote, not the parent
 * working tree. The local repository is used only as a reference (and as a
 * content fallback when no remote URL is configured).
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { readGitRemotes, syncGitRemotes, type GitRemote } from "./git-remotes.ts";

export { readGitRemotes, syncGitRemotes, type GitRemote };

export interface GitWorkspaceInfo {
    /** Absolute path to the working tree root. */
    repoRoot: string;
    /** Absolute path to the git directory for this working tree. */
    gitDir: string;
    /** Absolute path to the common git directory containing the object database. */
    commonGitDir: string;
    /** True when this working tree is a linked worktree (its `.git` is a file). */
    isLinkedWorktree: boolean;
}

function runGit(cwd: string, args: string[], opts?: { encoding?: BufferEncoding; stdio?: any }): string {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            ...opts,
        }).trim();
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
    }
}

/** Resolve `path` to an absolute, real path. Falls back to resolve() if the path does not exist. */
function realPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

/**
 * Inspect a directory that is expected to be a Git working tree.
 *
 * Returns whether the directory is a linked worktree and where its Git
 * metadata lives. Throws if the directory is not inside a Git repository.
 */
export function inspectGitWorkspace(dir: string): GitWorkspaceInfo {
    const repoRoot = runGit(dir, ["rev-parse", "--show-toplevel"]);
    const gitDir = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const commonGitDir = runGit(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

    const gitDot = resolve(repoRoot, ".git");
    const isLinkedWorktree = existsSync(gitDot) && !lstatSync(gitDot).isDirectory();

    return {
        repoRoot: realPath(repoRoot),
        gitDir: realPath(gitDir),
        commonGitDir: realPath(commonGitDir),
        isLinkedWorktree,
    };
}

/** True when the Git metadata for `info` lives outside `sandboxRoot`. */
export function isGitMetadataOutsideSandbox(info: GitWorkspaceInfo, sandboxRoot: string): boolean {
    const root = realPath(sandboxRoot);
    const gitDir = info.gitDir;
    // Outside means the git dir is not the sandbox root itself and does not
    // start with the sandbox root followed by a path separator.
    if (gitDir === root) return false;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return !gitDir.startsWith(prefix);
}

function readCurrentCommit(dir: string): string {
    return runGit(dir, ["rev-parse", "HEAD"]);
}

function readCurrentBranch(dir: string): string | undefined {
    try {
        const branch = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (branch && branch !== "HEAD") return branch;
    } catch {
        // Detached HEAD or missing ref.
    }
    return undefined;
}

function readCurrentBranchOrCommit(dir: string): string {
    return readCurrentBranch(dir) ?? readCurrentCommit(dir);
}

/**
 * Build the `git clone` argv for a disposable workspace.
 *
 * Exported so tests can assert the preferred AC5 shape without re-deriving it:
 * `--reference-if-able <local-reference> --dissociate <clone-url> <target>`.
 */
export function buildGitCloneArgs(options: {
    referenceRepo: string;
    cloneUrl: string;
    targetDir: string;
}): string[] {
    return [
        "clone",
        "--reference-if-able", options.referenceRepo,
        "--dissociate",
        options.cloneUrl,
        options.targetDir,
    ];
}

/**
 * Choose the clone URL for a disposable workspace.
 *
 * Prefer the source's `origin` fetch URL so the clone's default remote points at
 * the real upstream rather than the parent working tree. Fall back to the local
 * repository path only when no origin URL is configured.
 */
export function resolveCloneUrl(sourceDir: string, info: GitWorkspaceInfo): string {
    const remotes = readGitRemotes(sourceDir);
    const origin = remotes.find((remote) => remote.name === "origin");
    if (origin?.urls[0]) return origin.urls[0];
    // Any configured remote is still better than rewriting origin to the parent tree.
    if (remotes[0]?.urls[0]) return remotes[0].urls[0];
    return info.repoRoot;
}

/**
 * Ensure the disposable clone has the source's commit and, when applicable, the
 * same branch name checked out. Objects may come from the upstream clone, the
 * local reference, or an explicit fetch from the source working tree.
 */
/**
 * True when `ref` names a local branch in the source repository (not a tag,
 * remote-tracking ref, or raw commit). Used so an explicit `checkout:"side"`
 * request lands on symbolic branch `side` even when the source is on another branch.
 */
function isLocalBranchName(dir: string, ref: string): boolean {
    if (!ref || ref === "HEAD" || ref.startsWith("refs/")) return false;
    try {
        runGit(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
        return true;
    } catch {
        return false;
    }
}

function checkoutSourceRef(options: {
    sourceDir: string;
    targetDir: string;
    info: GitWorkspaceInfo;
    checkout: string;
}): void {
    const { sourceDir, targetDir, info, checkout } = options;
    const sourceCommit = runGit(sourceDir, ["rev-parse", `${checkout}^{commit}`]);
    const sourceBranch = readCurrentBranch(sourceDir);

    // Prefer an explicitly requested named branch (checkout:"side") even when the
    // source working tree is currently on a different branch. "HEAD" preserves the
    // source's current branch. Raw commits / tags stay detached.
    let branchName: string | undefined;
    if (checkout === "HEAD") {
        branchName = sourceBranch;
    } else if (isLocalBranchName(sourceDir, checkout)) {
        branchName = checkout;
    }

    // Fast path: ref already present after the clone.
    try {
        if (branchName) {
            runGit(targetDir, ["checkout", "-B", branchName, sourceCommit]);
            return;
        }
        runGit(targetDir, ["checkout", "--detach", sourceCommit]);
        return;
    } catch {
        // Need objects/refs from the local source workspace.
    }

    // Fetch the exact commit from the local source. --reference-if-able may already
    // have the objects; this makes the ref available even for local-only commits.
    runGit(targetDir, ["fetch", "--no-tags", info.repoRoot, sourceCommit]);
    const fetched = runGit(targetDir, ["rev-parse", "FETCH_HEAD"]);
    if (branchName) {
        runGit(targetDir, ["checkout", "-B", branchName, fetched]);
        return;
    }
    runGit(targetDir, ["checkout", "--detach", fetched]);
}

export interface SubagentWorkspaceOptions {
    /** Current working directory from the extension context. */
    ctxCwd: string;
    /** Per-call cwd override. */
    cwd?: string;
    /** Per-call sandbox_dir override. */
    sandboxDir?: string;
    /** Whether the caller requested a disposable Git clone workspace. */
    gitCloneWorkspace?: boolean;
    /** Run id, used to build a workspace path under the run directory. */
    runId: string;
    /** Absolute path to the run directory for this subagent. */
    runDirPath: string;
    /** Whether the OS sandbox is enabled for this subagent. */
    sandboxEnabled: boolean;
}

export interface SubagentWorkspace {
    /** Working directory the child should run in. */
    cwd: string;
    /** Sandbox writable root, when sandboxing is enabled. */
    requestedSandboxDir?: string;
}

/**
 * Resolve the subagent's working directory and sandbox root.
 *
 * When `gitCloneWorkspace` is true, the source workspace is cloned into a
 * disposable, self-contained Git workspace under the sandbox root. This keeps
 * Git metadata inside the writable sandbox directory for Git-mutating
 * subagents.
 */
export function resolveSubagentWorkspace(options: SubagentWorkspaceOptions): SubagentWorkspace {
    let cwd = options.sandboxDir ?? options.cwd ?? options.ctxCwd;
    let requestedSandboxDir: string | undefined = options.sandboxEnabled
        ? (options.sandboxDir ?? cwd)
        : undefined;

    if (options.gitCloneWorkspace) {
        const sourceDir = options.cwd ?? options.ctxCwd;
        const cloneTarget = options.sandboxDir ?? join(options.runDirPath, "workspace");
        mkdirSync(cloneTarget, { recursive: true });
        cwd = prepareGitCloneWorkspace({ sourceDir, targetDir: cloneTarget });
        if (options.sandboxEnabled) {
            requestedSandboxDir = cwd;
        }
    }

    return { cwd, requestedSandboxDir };
}

export interface PrepareGitCloneWorkspaceOptions {
    /** Directory of the source working tree to clone. */
    sourceDir: string;
    /** Directory to clone into. Created if missing. */
    targetDir: string;
    /**
     * Branch or commit to checkout after cloning. Defaults to the source's
     * current branch/commit.
     */
    checkout?: string;
    /**
     * Override the local reference repository used with `--reference-if-able`.
     * Intended for tests that exercise unavailable-reference fallback.
     */
    referenceRepo?: string;
}

/**
 * Prepare a disposable, self-contained Git clone workspace for a sandboxed
 * subagent that will mutate Git.
 *
 * The returned directory is a full Git working tree with a real `.git/`
 * directory inside it. No live alternates link to the parent repo remains.
 * Source remotes are preserved so pushes target the real upstream, not the
 * parent working tree.
 */
/** True when `dir` has a `.git` file pointer (linked worktree layout). */
function hasLinkedWorktreePointer(dir: string): boolean {
    const gitDot = resolve(dir, ".git");
    try {
        return existsSync(gitDot) && !lstatSync(gitDot).isDirectory();
    } catch {
        return false;
    }
}

export function prepareGitCloneWorkspace(options: PrepareGitCloneWorkspaceOptions): string {
    const sourceDir = realPath(options.sourceDir);
    const targetDir = realPath(options.targetDir);

    // Detect the linked-worktree layout from the filesystem first so a broken
    // pointer still fails with the AC8 outside-sandbox explanation rather than
    // a generic "not a git repository" error from rev-parse.
    const linkedPointer = hasLinkedWorktreePointer(sourceDir);

    let info: GitWorkspaceInfo;
    try {
        info = inspectGitWorkspace(sourceDir);
    } catch (err) {
        if (linkedPointer) {
            throw linkedWorktreeError(sourceDir);
        }
        throw new Error(
            `git_clone_workspace requires a Git repository. ${(err as Error).message}`,
        );
    }

    if (info.isLinkedWorktree && isGitMetadataOutsideSandbox(info, sourceDir)) {
        // A linked worktree's `.git` pointer references metadata outside the
        // source directory. The only safe path is to prepare a writable clone.
        // If we cannot, fail fast rather than launch into a broken sandbox.
        if (!existsSync(info.commonGitDir) || !lstatSync(info.commonGitDir).isDirectory()) {
            throw linkedWorktreeError(sourceDir);
        }
    }

    mkdirSync(targetDir, { recursive: true });

    // Use the common git directory as the local reference so linked worktrees
    // benefit from object sharing with the main repository. Callers (tests) may
    // override this to exercise --reference-if-able fallback.
    const referenceRepo = options.referenceRepo ?? info.commonGitDir;
    const checkout = options.checkout ?? readCurrentBranchOrCommit(sourceDir);
    const cloneUrl = resolveCloneUrl(sourceDir, info);

    // Preferred AC5 shape: remote URL as clone source, local repo as reference.
    // --reference-if-able is best-effort: an unavailable reference falls back to
    // a normal clone. --dissociate removes the alternates link after setup.
    const cloneArgs = buildGitCloneArgs({ referenceRepo, cloneUrl, targetDir });

    try {
        runGit(dirname(targetDir), cloneArgs, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
        if (info.isLinkedWorktree) {
            throw linkedWorktreeError(sourceDir);
        }
        throw err;
    }

    try {
        checkoutSourceRef({ sourceDir, targetDir, info, checkout });
    } catch (err) {
        throw new Error(
            `git_clone_workspace could not checkout ${checkout}: ${(err as Error).message}`,
        );
    }

    // Verify the clone is self-contained.
    const cloneDotGit = resolve(targetDir, ".git");
    if (!existsSync(cloneDotGit) || !lstatSync(cloneDotGit).isDirectory()) {
        throw new Error(
            `git_clone_workspace produced a workspace without a real .git directory at ${cloneDotGit}`,
        );
    }
    const alternates = resolve(cloneDotGit, "objects", "info", "alternates");
    if (existsSync(alternates)) {
        throw new Error(
            `git_clone_workspace left a live alternates link at ${alternates}; clone is not self-contained`,
        );
    }

    // Whether we cloned from a remote URL or a local path, force remotes to
    // match the source so pushes never target the parent working tree.
    syncGitRemotes(sourceDir, targetDir);

    // `git clone` does not copy repo-local config. Preserve identity settings
    // the source already has so Git-mutating producers can commit inside the
    // disposable workspace without reconfiguring author identity.
    copyRepoLocalGitIdentity(sourceDir, targetDir);

    return targetDir;
}

/**
 * Repo-local Git config keys that Git-mutating producers need for ordinary
 * commits. Only values that are set in the source's local config scope are
 * copied — global/system identity is intentionally not mirrored.
 */
const REPO_LOCAL_GIT_IDENTITY_KEYS = ["user.name", "user.email", "user.signingkey"] as const;

function copyRepoLocalGitIdentity(sourceDir: string, targetDir: string): void {
    for (const key of REPO_LOCAL_GIT_IDENTITY_KEYS) {
        let value: string;
        try {
            value = runGit(sourceDir, ["config", "--local", "--get", key]);
        } catch {
            // Key is not set in the source's repo-local config; leave the clone alone.
            continue;
        }
        if (!value) continue;
        runGit(targetDir, ["config", "--local", key, value]);
    }
}

function linkedWorktreeError(sourceDir: string): Error {
    return new Error(
        `Linked worktree at ${sourceDir} has Git metadata outside the sandbox. ` +
        `Use git_clone_workspace:true to request a disposable clone workspace ` +
        `so the subagent can mutate Git safely.`,
    );
}

/**
 * Verify that a sandboxed Git-mutating request will not launch into a linked
 * worktree whose metadata lives outside the sandbox root.
 *
 * When the caller has explicitly requested a clone workspace, the workspace
 * will be converted; this guard is for callers that requested Git mutation
 * without clone preparation.
 */
export function assertSafeGitWorkspace(workspaceDir: string, sandboxRoot: string): void {
    const info = inspectGitWorkspace(workspaceDir);
    if (info.isLinkedWorktree && isGitMetadataOutsideSandbox(info, sandboxRoot)) {
        throw linkedWorktreeError(workspaceDir);
    }
}
