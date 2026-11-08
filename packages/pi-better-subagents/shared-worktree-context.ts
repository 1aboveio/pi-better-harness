// Generated from packages/pi-better-harness/extensions/worktree-context.ts. Do not edit directly.
/**
 * Project context follows the linked worktree that owns the working directory.
 *
 * Pi loads one global context file from the agent directory and one file from
 * every ancestor of the working directory. In a linked worktree (`git worktree
 * add`) those ancestors include the main checkout, so the worktree inherits its
 * instructions in addition to its own. The worktree is the project context root:
 * keep the global file and files at or below the worktree root, drop everything
 * loaded above it. A worktree without its own context file therefore starts
 * without the main checkout's file instead of falling back to it.
 *
 * This module only filters. It never adds a context file or a prompt section, so
 * `--no-context-files` keeps its empty list, and it returns nothing to Pi, so
 * guidance keeps arriving as sections (ADR 0016, ADR 0021). A host that
 * rebuilds the prompt from `systemPromptOptions` after the `before_agent_start`
 * handlers applies the filtered list; on a host that does not rebuild, the
 * mutation is inert rather than a whole-prompt return.
 *
 * Subagent children use a vendored copy of this file
 * (`packages/pi-better-subagents/shared-worktree-context.ts`) because a
 * standalone Subagents install has no Harness package.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** The subset of a loaded context file this module needs to read. */
export interface ProjectContextFile {
    path: string;
}

/** The subset of Pi's structured prompt options this module edits. */
export interface ProjectContextOptions {
    /** Working directory the prompt was built for. Falls back to `process.cwd()`. */
    cwd?: string;
    contextFiles?: ProjectContextFile[];
}

interface GitPaths {
    /** Directory holding the `.git` file or directory found for the working tree. */
    repoDir: string;
    /** Git directory for this working tree (`.git/worktrees/<name>` when linked). */
    gitDir: string;
    /** Git directory holding the shared object database and administrative state. */
    commonGitDir: string;
}

function canonicalizePath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return path;
    }
}

/** Compare paths the way the host does: resolved, and case-folded on Windows. */
function comparisonKey(path: string): string {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or inside it. */
function isPathWithin(parent: string, child: string): boolean {
    const parentKey = comparisonKey(parent);
    const childKey = comparisonKey(child);
    if (childKey === parentKey) return true;
    return childKey.startsWith(parentKey.endsWith(sep) ? parentKey : `${parentKey}${sep}`);
}

/** Find the nearest working tree above `startDir` without running Git. */
function findGitPaths(startDir: string): GitPaths | undefined {
    let dir = resolve(startDir);
    while (true) {
        const gitPath = join(dir, ".git");
        if (existsSync(gitPath)) {
            try {
                const stat = statSync(gitPath);
                if (stat.isFile()) {
                    const content = readFileSync(gitPath, "utf8").trim();
                    if (!content.startsWith("gitdir: ")) return undefined;
                    const gitDir = resolve(dir, content.slice(8).trim());
                    if (!existsSync(join(gitDir, "HEAD"))) return undefined;
                    // A linked worktree has `commondir`; a submodule's gitdir has none,
                    // and keeps ordinary ancestor inheritance.
                    const commonDirPath = join(gitDir, "commondir");
                    const commonGitDir = existsSync(commonDirPath)
                        ? resolve(gitDir, readFileSync(commonDirPath, "utf8").trim())
                        : gitDir;
                    return { repoDir: dir, gitDir, commonGitDir };
                }
                if (stat.isDirectory()) {
                    if (!existsSync(join(gitPath, "HEAD"))) return undefined;
                    return { repoDir: dir, gitDir: gitPath, commonGitDir: gitPath };
                }
            } catch {
                return undefined;
            }
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/**
 * The linked worktree root that owns `cwd`, or undefined for an ordinary
 * checkout. Returned canonicalized, because a worktree's `.git` file records the
 * real path while `cwd` may still be a symlink (macOS `/tmp` → `/private/tmp`).
 */
export function findLinkedWorktreeRoot(cwd: string): string | undefined {
    const gitPaths = findGitPaths(canonicalizePath(cwd));
    // Only a shared object store makes this a worktree; the main checkout, a
    // separate `.git` directory and a submodule keep ordinary inheritance.
    if (!gitPaths || gitPaths.gitDir === gitPaths.commonGitDir) return undefined;
    return canonicalizePath(gitPaths.repoDir);
}

/**
 * Drop project context loaded above the linked worktree that owns `cwd`.
 *
 * The global file under `agentDir` always survives. Outside a linked worktree
 * this is a no-op, so ordinary repositories keep every ancestor file. Mutates
 * `options.contextFiles` in place because Pi hands the handler its mutable
 * prompt options.
 */
export function restrictContextFilesToWorktree(options: ProjectContextOptions, agentDir: string): void {
    const files = options.contextFiles;
    if (!files || files.length === 0) return;
    const worktreeRoot = findLinkedWorktreeRoot(options.cwd ?? process.cwd());
    if (!worktreeRoot) return;
    const allowedRoots = [worktreeRoot, canonicalizePath(agentDir)];
    const kept = files.filter((file) => {
        const path = canonicalizePath(file.path);
        return allowedRoots.some((root) => isPathWithin(root, path));
    });
    if (kept.length === files.length) return;
    options.contextFiles = kept;
}
