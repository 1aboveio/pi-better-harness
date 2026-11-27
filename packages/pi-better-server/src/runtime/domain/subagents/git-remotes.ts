/**
 * First-class Git remote semantics for disposable clone workspaces
 * (issue #103 normal fetch-URL + pushurl topologies + issue #109 edge cases).
 *
 * Invariant (`git-remote-preservation`): disposable clone preparation must
 * preserve every source remote name, **every** configured `remote.<name>.url`
 * value, and **every** configured `remote.<name>.pushurl` value — not just the
 * first of either. Git permits multi-valued keys for both:
 *
 * - With no explicit pushurl, `git remote get-url --push --all` returns all
 *   fetch URLs and one `git push` reaches every URL.
 * - With explicit pushurl(s), push uses those destinations only.
 * - Push-only remotes (issue #109): zero `remote.<name>.url` entries and one or
 *   more `remote.<name>.pushurl` entries. Model `urls` as an empty ordered list;
 *   never invent a fetch URL from the first pushurl.
 *
 * Collapsing either multi-valued set rewrites producer push/fetch topology.
 *
 * Values are read from null-delimited `git config` output rather than
 * `git remote -v` line parsing, which drops any URL containing spaces.
 *
 * Source remote read-failure safety (issue #109): if source remote config cannot
 * be read because the source is missing/unreadable/not a Git repo,
 * `syncGitRemotes` fails before mutating the target. A valid Git repo with no
 * remote keys still returns `[]` and may clear target remotes.
 *
 * Consumed by disposable clone workspace preparation (issue #78 / PR #89).
 */

import { execFileSync } from "node:child_process";

/** One configured Git remote, including every fetch URL and every explicit push URL. */
export interface GitRemote {
    name: string;
    /**
     * Every configured `remote.<name>.url`, in config order.
     * Empty for push-only remotes (zero fetch URLs, one or more pushurls).
     * Git fetches from the first when present and, when no pushurl is set,
     * pushes to all.
     */
    urls: string[];
    /**
     * Every configured `remote.<name>.pushurl`, in config order.
     * Empty when the remote has no explicit push URL (Git then pushes to every
     * entry in `urls`).
     */
    pushUrls: string[];
}

function runGit(cwd: string, args: string[]): string {
    try {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message}`);
    }
}

/**
 * Confirm `dir` is a readable Git repository (work tree or bare).
 *
 * `git config --get-regexp` exits 1 both when there are no matching keys in a
 * valid repo and when the directory is not a Git repo, so callers must validate
 * the repository first. Missing paths and permission errors also surface here.
 */
function assertGitRepository(dir: string): void {
    try {
        execFileSync("git", ["rev-parse", "--git-dir"], {
            cwd: dir,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (err) {
        const message = (err as Error).message ?? String(err);
        throw new Error(
            `cannot read Git remotes from ${dir}: not a readable Git repository (${message})`,
        );
    }
}

/**
 * Read remote fetch/push URLs from structured Git config.
 *
 * Uses `git config --null --get-regexp` so URL values may contain spaces, tabs,
 * or other whitespace without being truncated. Collects **every**
 * `remote.<name>.url` and **every** `remote.<name>.pushurl` entry (Git allows
 * multiple of each; multi-url with no pushurl is a multi-destination push set;
 * push-only remotes keep `urls: []`).
 *
 * A valid Git repository with no matching remote keys returns `[]`.
 * Missing/unreadable/non-git paths throw (do not conflate with empty).
 */
export function readGitRemotes(dir: string): GitRemote[] {
    // Validate the repository before interpreting get-regexp exit status.
    // git config --get-regexp exits 1 for "no match" AND for "not a git repo",
    // so empty-valid vs operational failure is only distinguishable after this.
    assertGitRepository(dir);

    let raw: string;
    try {
        // Call git directly (not runGit) so we do not .trim() away trailing
        // structure from null-delimited config output.
        raw = execFileSync(
            "git",
            ["config", "--null", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
            {
                cwd: dir,
                encoding: "utf-8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
    } catch (err) {
        const status = (err as { status?: number }).status;
        // Exit 1 with empty output = no matching keys in a valid repo.
        if (status === 1) {
            return [];
        }
        const message = (err as Error).message ?? String(err);
        throw new Error(
            `cannot read Git remote config from ${dir}: ${message}`,
        );
    }
    if (!raw) return [];

    const byName = new Map<string, { fetch: string[]; push: string[] }>();
    for (const record of raw.split("\0")) {
        if (!record) continue;
        const nl = record.indexOf("\n");
        if (nl < 0) continue;
        const key = record.slice(0, nl);
        const value = record.slice(nl + 1);
        // Empty values are not meaningful remote URLs; skip.
        if (value === "") continue;

        // remote.<name>.url | remote.<name>.pushurl — name may itself contain dots.
        const match = key.match(/^remote\.(.+)\.(url|pushurl)$/);
        if (!match) continue;
        const [, name, kind] = match;
        const entry = byName.get(name) ?? { fetch: [], push: [] };
        if (kind === "url") {
            // Preserve every fetch URL in config order — do not collapse to one.
            entry.fetch.push(value);
        } else {
            // Preserve every pushurl in config order — do not collapse to one.
            entry.push.push(value);
        }
        byName.set(name, entry);
    }

    const remotes: GitRemote[] = [];
    for (const [name, urls] of byName.entries()) {
        // Push-only remotes (issue #109): zero url keys, one or more pushurls.
        // Keep urls as an empty ordered list — never invent a fetch URL.
        if (urls.fetch.length === 0 && urls.push.length === 0) continue;
        remotes.push({
            name,
            urls: [...urls.fetch],
            pushUrls: [...urls.push],
        });
    }
    // Stable order by remote name so tests and sync are deterministic.
    remotes.sort((a, b) => a.name.localeCompare(b.name));
    return remotes;
}

/**
 * Make `targetDir`'s remotes match `sourceDir`'s remote contract: names, every
 * fetch URL (possibly zero for push-only remotes), and every configured push
 * URL. Removes stale remotes that exist only on the target (typical after a
 * path-style clone).
 *
 * Reads and validates the source remote set **before** mutating the target.
 * If source remote config cannot be read, throws and leaves the target unchanged.
 */
export function syncGitRemotes(sourceDir: string, targetDir: string): void {
    // Read source first. Any throw here (missing/unreadable/not-a-repo) aborts
    // before target remotes are inspected or mutated (#109 non-mutation).
    const sourceRemotes = readGitRemotes(sourceDir);
    const targetRemotes = readGitRemotes(targetDir);
    const sourceNames = new Set(sourceRemotes.map((remote) => remote.name));

    // Drop remotes the source does not have (typical case: clone-from-path set
    // origin to the parent working tree, or leftover scratch remotes).
    for (const remote of targetRemotes) {
        if (!sourceNames.has(remote.name)) {
            runGit(targetDir, ["remote", "remove", remote.name]);
        }
    }

    for (const remote of sourceRemotes) {
        const existing = targetRemotes.find((entry) => entry.name === remote.name);
        if (!existing) {
            ensureRemoteExists(targetDir, remote);
        }
        applyFetchUrls(
            targetDir,
            remote.name,
            remote.urls,
            existing?.urls ?? (remote.urls.length > 0 ? [remote.urls[0]] : []),
        );
        applyPushUrls(
            targetDir,
            remote.name,
            remote.pushUrls,
            existing?.pushUrls ?? [],
        );
    }
}

/**
 * Ensure a remote name exists on the target so url/pushurl keys can be applied.
 *
 * `git remote add` requires a fetch URL, so push-only remotes are created via
 * `git config` (fetch refspec + pushurls) rather than inventing a fetch URL.
 */
function ensureRemoteExists(dir: string, remote: GitRemote): void {
    if (remote.urls.length > 0) {
        // Normal path: create with the first fetch URL; applyFetchUrls rebuilds the full set.
        runGit(dir, ["remote", "add", remote.name, remote.urls[0]]);
        return;
    }
    // Push-only: create the remote section without a url key.
    // A fetch refspec is enough for Git to list the remote name.
    try {
        runGit(dir, ["config", "--get", `remote.${remote.name}.fetch`]);
    } catch {
        runGit(dir, [
            "config",
            `remote.${remote.name}.fetch`,
            `+refs/heads/*:refs/remotes/${remote.name}/*`,
        ]);
    }
}

/**
 * Replace the target remote's fetch URL set with `desired`.
 *
 * Same multi-value constraint as pushurls: `git remote set-url <name> <url>`
 * fatals when the key already has multiple values. Always clear the complete
 * existing url set first (`git config --unset-all`), then rebuild with
 * set-url + --add when desired is non-empty. When desired is empty (push-only),
 * leave the remote with no `remote.<name>.url` keys.
 *
 * Never use regex `--delete` of URL text.
 */
function applyFetchUrls(
    dir: string,
    name: string,
    desired: string[],
    existing: string[],
): void {
    // Fast path: already identical in order — nothing to do (including both empty).
    if (
        existing.length === desired.length &&
        existing.every((url, i) => url === desired[i])
    ) {
        return;
    }

    // Always clear the complete existing url set first. A bare `set-url`
    // cannot replace a multi-valued set (Git fatals). For push-only desired
    // sets this is the whole operation (no rebuild).
    clearAllFetchUrls(dir, name);

    if (desired.length === 0) {
        // Push-only: remote remains with fetch refspec + pushurls only.
        return;
    }

    // Rebuild desired ordered set: first set-url, then --add.
    // If the remote has no url key (e.g. was push-only), set-url still works
    // when the remote section exists; otherwise ensureRemoteExists already added it.
    runGit(dir, ["remote", "set-url", name, desired[0]]);
    for (let i = 1; i < desired.length; i++) {
        runGit(dir, ["remote", "set-url", "--add", name, desired[i]]);
    }
}

/**
 * Replace the target remote's push URL set with `desired`.
 *
 * Git has no "set all pushurls" primitive. Critically, `git remote set-url
 * --push <name> <url>` is rejected when the target already has multiple
 * pushurl values (`warning: remote.<name>.pushurl has multiple values;
 * fatal: could not set ...`). Always clear the complete existing pushurl
 * set first, then rebuild the desired ordered set with set-url + --add.
 * When the desired set is empty, every existing pushurl is deleted so push
 * falls back to every configured fetch URL.
 *
 * For push-only remotes (no fetch URL), rebuild via `git config --add
 * remote.<name>.pushurl` because `git remote set-url --push` may require an
 * existing remote url section depending on Git version; config keys are the
 * durable representation either way.
 */
function applyPushUrls(
    dir: string,
    name: string,
    desired: string[],
    existing: string[],
): void {
    // Fast path: already identical in order — nothing to do (desired empty or not).
    if (
        existing.length === desired.length &&
        existing.every((url, i) => url === desired[i])
    ) {
        return;
    }

    // Always clear the complete existing pushurl set first. A bare
    // `set-url --push` cannot replace a multi-valued set (Git fatals).
    clearAllPushUrls(dir, name);

    if (desired.length === 0) {
        // Desired is empty: after unset-all, Git's default (push → all fetch
        // URLs) holds when fetch URLs exist. `get-url --push --all` reports
        // fetch URL(s) when no pushurl key exists, so treat remaining entries
        // equal to fetch set as already-default.
        const remaining = safePushUrlsAll(dir, name);
        const fetchUrls = safeFetchUrlsAll(dir, name);
        const isDefaultOnly =
            remaining.length === 0 ||
            (remaining.length === fetchUrls.length &&
                remaining.every((url, i) => url === fetchUrls[i]));
        if (isDefaultOnly) return;

        // Retry once if values somehow remain (should not happen after unset-all).
        clearAllPushUrls(dir, name);
        const still = safePushUrlsAll(dir, name);
        const stillDefaultOnly =
            still.length === 0 ||
            (still.length === fetchUrls.length &&
                still.every((url, i) => url === fetchUrls[i]));
        if (!stillDefaultOnly) {
            throw new Error(
                `unable to clear multi-valued remote.${name}.pushurl in ${dir}`,
            );
        }
        return;
    }

    // Prefer git-config direct writes so push-only remotes (no url key) work
    // the same as normal remotes. set-url --push can behave oddly when there
    // is no fetch URL (it may treat the remote name as a URL).
    for (const url of desired) {
        runGit(dir, ["config", "--add", `remote.${name}.pushurl`, url]);
    }
}

/**
 * Delete every configured fetch URL for `name` as a complete set.
 *
 * Must NOT use `git remote set-url --delete <name> <url>`: that treats the
 * final argument as a regex, so legal local paths containing unmatched
 * metacharacters (e.g. `[`) fail to match and leave stale destinations intact.
 * `git config --unset-all remote.<name>.url` drops the multi-valued key
 * wholesale without interpreting URL text as a pattern.
 *
 * Note: after unset-all the remote still exists (fetch refspec remains) but
 * has no url until rebuild. Callers must rebuild immediately when desired
 * is non-empty; empty desired is the push-only topology.
 */
function clearAllFetchUrls(dir: string, name: string): void {
    try {
        runGit(dir, ["config", "--unset-all", `remote.${name}.url`]);
    } catch {
        // Key already absent (git exits non-zero) — nothing to clear.
    }
}

/**
 * Delete every configured pushurl for `name` as a complete set.
 *
 * Must NOT use `git remote set-url --push --delete <name> <url>`: that treats
 * the final argument as a regex, so legal local paths containing unmatched
 * metacharacters (e.g. `[`) fail to match and leave stale destinations intact.
 * `git config --unset-all remote.<name>.pushurl` drops the multi-valued key
 * wholesale without interpreting URL text as a pattern.
 */
function clearAllPushUrls(dir: string, name: string): void {
    try {
        runGit(dir, ["config", "--unset-all", `remote.${name}.pushurl`]);
    } catch {
        // Key already absent (git exits non-zero) — nothing to clear.
    }
}

function safePushUrlsAll(dir: string, name: string): string[] {
    try {
        const out = runGit(dir, ["remote", "get-url", "--push", "--all", name]);
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}

function safeFetchUrlsAll(dir: string, name: string): string[] {
    try {
        const out = runGit(dir, ["remote", "get-url", "--all", name]);
        return out
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
    } catch {
        return [];
    }
}
