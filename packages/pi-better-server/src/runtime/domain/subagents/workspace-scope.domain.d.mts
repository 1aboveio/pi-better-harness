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
/** Canonical absolute form of one workspace path (realpath when it exists). */
export declare function normalizeWorkspacePath(path: string): string;
/**
 * True when `candidateCwd` is `scopeCwd` itself or lies beneath it.
 *
 * A missing or empty candidate is never inside a workspace: metadata that does
 * not name a workspace cannot be placed in the caller's folder.
 */
export declare function isWithinWorkspace(candidateCwd: string, scopeCwd: string): boolean;
/** Folder where the parent requested the work. The execution cwd stays on the run for delivery and authorization. */
export declare function discoveryWorkspace(meta: {
    cwd: string;
    recipe?: {
        workspace?: {
            source: string;
            subdir: string;
        };
    };
}): string;
