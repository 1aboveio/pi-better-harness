// Generated fixed launch domain from packages/pi-better-subagents/workspace-scope.ts. Do not edit directly.
/**
 * Workspace (folder) scope for cross-session discovery.
 *
 * `subagent_list` defaults to the caller's current folder and its descendants,
 * not to the foreground session that spawned a run. A folder is identified by
 * its canonical path: two foreground sessions in the same folder share one
 * list scope, and a run in a sibling folder that merely shares a name prefix
 * (`/repo-other` vs `/repo`) is a different workspace.
 *
 * Paths are compared with `node:path.relative`, never with string prefixes, so
 * `..`, separators, and sibling names cannot be mistaken for descendants. An
 * existing directory is resolved through `realpath` first (a symlinked
 * workspace and its target are the same folder); a path that no longer exists
 * falls back to `path.resolve` so a deleted run workspace still compares
 * predictably.
 *
 * This helper is shared with the parent name resolver, so it owns no list-only
 * state and performs no I/O beyond `realpath`.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
/** Canonical absolute form of one workspace path (realpath when it exists). */
export function normalizeWorkspacePath(path) {
    const absolute = resolve(path);
    try {
        return realpathSync(absolute);
    }
    catch {
        // Missing or unreadable directory (for example a reclaimed run
        // workspace): keep the lexically normalized path rather than guessing.
        return absolute;
    }
}
/**
 * True when `candidateCwd` is `scopeCwd` itself or lies beneath it.
 *
 * A missing or empty candidate is never inside a workspace: metadata that does
 * not name a workspace cannot be placed in the caller's folder.
 */
export function isWithinWorkspace(candidateCwd, scopeCwd) {
    if (typeof candidateCwd !== "string" || candidateCwd === "")
        return false;
    if (typeof scopeCwd !== "string" || scopeCwd === "")
        return false;
    const candidate = normalizeWorkspacePath(candidateCwd);
    const scope = normalizeWorkspacePath(scopeCwd);
    const rel = relative(scope, candidate);
    if (rel === "")
        return true;
    return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
/** Folder where the parent requested the work. The execution cwd stays on the run for delivery and authorization. */
export function discoveryWorkspace(meta) {
    const workspace = meta.recipe?.workspace;
    return workspace ? resolve(workspace.source, workspace.subdir) : meta.cwd;
}
