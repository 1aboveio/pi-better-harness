// Generated fixed launch domain from packages/pi-better-subagents/git-workspace.ts. Do not edit directly.
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
import { dirname, join, relative, resolve } from "node:path";
import { readGitRemotes, syncGitRemotes } from "./git-remotes.domain.mjs";
export { readGitRemotes, syncGitRemotes };
const GIT_WORKSPACE_COMMAND_TIMEOUT_MS = 60_000;
function runGit(cwd, args, env) {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...(env ?? process.env), GIT_TERMINAL_PROMPT: "0" },
            timeout: GIT_WORKSPACE_COMMAND_TIMEOUT_MS,
            killSignal: "SIGKILL",
        }).trim();
    }
    catch (err) {
        if (err.code === "ETIMEDOUT") {
            throw new Error(`git ${args[0]} timed out after ${GIT_WORKSPACE_COMMAND_TIMEOUT_MS / 1_000} seconds in ${cwd}`, { cause: err });
        }
        const message = err.message ?? String(err);
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`, { cause: err });
    }
}
/** Resolve `path` to an absolute, real path. Falls back to resolve() if the path does not exist. */
function realPath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return resolve(path);
    }
}
/**
 * Inspect a directory that is expected to be a Git working tree.
 *
 * Returns whether the directory is a linked worktree and where its Git
 * metadata lives. Throws if the directory is not inside a Git repository.
 */
export function inspectGitWorkspace(dir) {
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
export function isGitMetadataOutsideSandbox(info, sandboxRoot) {
    const root = realPath(sandboxRoot);
    const gitDir = info.gitDir;
    // Outside means the git dir is not the sandbox root itself and does not
    // start with the sandbox root followed by a path separator.
    if (gitDir === root)
        return false;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return !gitDir.startsWith(prefix);
}
function readCurrentCommit(dir) {
    return runGit(dir, ["rev-parse", "HEAD"]);
}
function readCurrentBranch(dir) {
    try {
        const branch = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
        if (branch && branch !== "HEAD")
            return branch;
    }
    catch {
        // Detached HEAD or missing ref.
    }
    return undefined;
}
function readCurrentBranchOrCommit(dir) {
    return readCurrentBranch(dir) ?? readCurrentCommit(dir);
}
/**
 * Build the `git clone` argv for a disposable workspace.
 *
 * Exported so tests can assert the preferred AC5 shape without re-deriving it:
 * `--reference-if-able <local-reference> --dissociate <clone-url> <target>`.
 */
export function buildGitCloneArgs(options) {
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
export function resolveCloneUrl(sourceDir, info) {
    const remotes = readGitRemotes(sourceDir);
    const origin = remotes.find((remote) => remote.name === "origin");
    if (origin?.urls[0])
        return origin.urls[0];
    // Any configured remote is still better than rewriting origin to the parent tree.
    if (remotes[0]?.urls[0])
        return remotes[0].urls[0];
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
function isLocalBranchName(dir, ref) {
    if (!ref || ref === "HEAD" || ref.startsWith("refs/"))
        return false;
    try {
        runGit(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
        return true;
    }
    catch {
        return false;
    }
}
function checkoutSourceRef(options) {
    const { sourceDir, targetDir, info, checkout } = options;
    const sourceCommit = runGit(sourceDir, ["rev-parse", `${checkout}^{commit}`]);
    const sourceBranch = readCurrentBranch(sourceDir);
    // Prefer an explicitly requested named branch (checkout:"side") even when the
    // source working tree is currently on a different branch. "HEAD" preserves the
    // source's current branch. Raw commits / tags stay detached.
    let branchName;
    if (checkout === "HEAD") {
        branchName = sourceBranch;
    }
    else if (isLocalBranchName(sourceDir, checkout)) {
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
    }
    catch {
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
/**
 * Resolve the subagent's working directory and sandbox root.
 *
 * When `gitCloneWorkspace` is true, the source workspace is cloned into a
 * disposable, self-contained Git workspace under the sandbox root. This keeps
 * Git metadata inside the writable sandbox directory for Git-mutating
 * subagents.
 */
export function resolveSubagentWorkspace(options) {
    let cwd = options.sandboxDir ?? options.cwd ?? options.ctxCwd;
    let requestedSandboxDir = options.sandboxEnabled
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
function hasLinkedWorktreePointer(dir) {
    const gitDot = resolve(dir, ".git");
    try {
        return existsSync(gitDot) && !lstatSync(gitDot).isDirectory();
    }
    catch {
        return false;
    }
}
/** An ignored subdirectory can contain a separate, non-Git workspace. */
export function isIgnoredGitSubdirectory(root, subdir) {
    if (!subdir)
        return false;
    try {
        runGit(root, ["-c", "core.fsmonitor=false", "check-ignore", "--quiet", "--", subdir], Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))));
        return true;
    }
    catch (error) {
        if (error.cause?.status === 1)
            return false;
        throw error;
    }
}
/** Locate shared metadata even when a caller supplies a subdirectory of the checkout. */
export function linkedWorktreeGitDir(cwd) {
    const workspace = realPath(cwd);
    let directory = workspace;
    for (;;) {
        const gitMarker = join(directory, ".git");
        if (existsSync(gitMarker)) {
            if (!hasLinkedWorktreePointer(directory))
                return undefined;
            try {
                const info = inspectGitWorkspace(directory);
                if (isIgnoredGitSubdirectory(info.repoRoot, relative(info.repoRoot, workspace)))
                    return undefined;
                return info.gitDir;
            }
            catch {
                throw linkedWorktreeError(directory);
            }
        }
        const parent = dirname(directory);
        if (parent === directory)
            return undefined;
        directory = parent;
    }
}
export function prepareGitCloneWorkspace(options) {
    const sourceDir = realPath(options.sourceDir);
    const targetDir = realPath(options.targetDir);
    // Detect the linked-worktree layout from the filesystem first so a broken
    // pointer still fails with the AC8 outside-sandbox explanation rather than
    // a generic "not a git repository" error from rev-parse.
    const linkedPointer = hasLinkedWorktreePointer(sourceDir);
    let info;
    try {
        info = inspectGitWorkspace(sourceDir);
    }
    catch (err) {
        if (linkedPointer) {
            throw linkedWorktreeError(sourceDir);
        }
        throw new Error(`git_clone_workspace requires a Git repository. ${err.message}`);
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
        runGit(dirname(targetDir), cloneArgs);
    }
    catch (err) {
        if (info.isLinkedWorktree) {
            throw new Error(`${linkedWorktreeError(sourceDir).message} Clone preparation failed: ${err.message}`);
        }
        throw err;
    }
    try {
        checkoutSourceRef({ sourceDir, targetDir, info, checkout });
    }
    catch (err) {
        throw new Error(`git_clone_workspace could not checkout ${checkout}: ${err.message}`);
    }
    // Verify the clone is self-contained.
    const cloneDotGit = resolve(targetDir, ".git");
    if (!existsSync(cloneDotGit) || !lstatSync(cloneDotGit).isDirectory()) {
        throw new Error(`git_clone_workspace produced a workspace without a real .git directory at ${cloneDotGit}`);
    }
    const alternates = resolve(cloneDotGit, "objects", "info", "alternates");
    if (existsSync(alternates)) {
        throw new Error(`git_clone_workspace left a live alternates link at ${alternates}; clone is not self-contained`);
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
const REPO_LOCAL_GIT_IDENTITY_KEYS = ["user.name", "user.email", "user.signingkey"];
function copyRepoLocalGitIdentity(sourceDir, targetDir) {
    for (const key of REPO_LOCAL_GIT_IDENTITY_KEYS) {
        let value;
        try {
            value = runGit(sourceDir, ["config", "--local", "--get", key]);
        }
        catch {
            // Key is not set in the source's repo-local config; leave the clone alone.
            continue;
        }
        if (!value)
            continue;
        runGit(targetDir, ["config", "--local", key, value]);
    }
}
function linkedWorktreeError(sourceDir) {
    return new Error(`Linked worktree at ${sourceDir} has Git metadata outside the sandbox. ` +
        `Use git_clone_workspace:true to request a disposable clone workspace ` +
        `so the subagent can mutate Git safely.`);
}
/**
 * Verify that a sandboxed Git-mutating request will not launch into a linked
 * worktree whose metadata lives outside the sandbox root.
 *
 * When the caller has explicitly requested a clone workspace, the workspace
 * will be converted; this guard is for callers that requested Git mutation
 * without clone preparation.
 */
export function assertSafeGitWorkspace(workspaceDir, sandboxRoot) {
    const info = inspectGitWorkspace(workspaceDir);
    if (info.isLinkedWorktree && isGitMetadataOutsideSandbox(info, sandboxRoot)) {
        throw linkedWorktreeError(workspaceDir);
    }
}
