import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Current branch of the git work tree containing `cwd`, read from `.git/HEAD`
 * without spawning git. Handles linked worktrees (`.git` file). A detached HEAD
 * reports the short commit id; no repository reports nothing.
 */
export function readGitBranch(cwd: string): string | undefined {
  try {
    let dir = resolve(cwd);
    for (;;) {
      const dotGit = join(dir, ".git");
      if (existsSync(dotGit)) {
        const gitDir = statSync(dotGit).isDirectory() ? dotGit : resolveGitFile(dotGit, dir);
        const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
        const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
        if (ref) return ref[1];
        return /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : undefined;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

function resolveGitFile(file: string, base: string): string {
  const match = /^gitdir: (.+)$/m.exec(readFileSync(file, "utf8"));
  if (!match?.[1]) throw new Error("not a gitdir file");
  const target = match[1].trim();
  return isAbsolute(target) ? target : resolve(base, target);
}
