/**
 * Complete Git remote semantics for disposable clone workspaces
 * (issue #103 normal topologies + issue #109 edge cases).
 *
 * Proves the `git-remote-preservation` invariant that repeatedly blocked PR #89:
 * multiple `remote.<name>.url` entries (default multi-push destinations),
 * multiple `remote.<name>.pushurl` entries, whitespace/metachar local paths,
 * multi-remote sets, fetch-only remotes, and stale clone-only remote removal.
 *
 * Issue #109 adds:
 * - push-only remotes (zero fetch URL, one or more pushurls) without inventing a fetch URL
 * - source remote read-failure must abort before mutating the target
 *
 * // @covers git_remotes.read
 * // @level unit
 * // @covers git_remotes.sync
 * // @level unit
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitRemotes, syncGitRemotes } from "../git-remotes.ts";

function requireGit() {
    try {
        execFileSync("git", ["--version"], { stdio: "ignore" });
    } catch {
        throw new Error("git is required for git_remotes tests (no skip)");
    }
}

function runGit(cwd, args, opts = {}) {
    const argv = Array.isArray(args) ? args : args.split(/\s+/).filter(Boolean);
    try {
        return execFileSync("git", argv, {
            cwd,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
            ...opts,
        }).trim();
    } catch (err) {
        const stderr = err?.stderr?.toString?.() ?? "";
        const stdout = err?.stdout?.toString?.() ?? "";
        throw new Error(
            `git ${argv.join(" ")} failed in ${cwd}: ${(err?.message ?? err)}\n${stdout}\n${stderr}`,
        );
    }
}

function real(p) {
    return realpathSync(p);
}

function initBare(path) {
    mkdirSync(path, { recursive: true });
    runGit(path, ["init", "--bare"]);
    return path;
}

function configureIdentity(path) {
    // CI runners have no global user.name/email; clones do not inherit the
    // source repo's local identity, so commits on the target would fail.
    runGit(path, ["config", "user.email", "test@example.com"]);
    runGit(path, ["config", "user.name", "Test"]);
}

function initRepo(path, { branch = "main" } = {}) {
    mkdirSync(path, { recursive: true });
    runGit(path, ["init"]);
    runGit(path, ["checkout", "-b", branch]);
    configureIdentity(path);
    writeFileSync(join(path, "a.txt"), "a\n");
    runGit(path, ["add", "a.txt"]);
    runGit(path, ["commit", "-m", "first"]);
    return path;
}

/** Clone `source` into `base/name` and configure a local commit identity. */
function cloneWithIdentity(base, source, name = "clone") {
    runGit(base, ["clone", source, name]);
    const target = join(base, name);
    configureIdentity(target);
    return target;
}

function fetchUrlsAll(dir, remote = "origin") {
    return runGit(dir, ["remote", "get-url", "--all", remote])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function pushUrlsAll(dir, remote = "origin") {
    return runGit(dir, ["remote", "get-url", "--push", "--all", remote])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
}

function branchList(bareDir, name) {
    return runGit(bareDir, ["branch", "--list", name]);
}

before(() => {
    requireGit();
});

describe("git_remotes.read", () => {
    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("reads remotes from structured null-delimited git config, preserving whitespace URLs", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-ws-"));
        try {
            const fetchRemote = join(base, "up stream.git");
            const pushRemote = join(base, "push dest.git");
            const otherRemote = join(base, "other remote.git");
            initBare(fetchRemote);
            initBare(pushRemote);
            initBare(otherRemote);

            const repo = initRepo(join(base, "repo"));
            runGit(repo, ["remote", "add", "origin", fetchRemote]);
            runGit(repo, ["remote", "set-url", "--push", "origin", pushRemote]);
            runGit(repo, ["remote", "add", "upstream", otherRemote]);

            const model = readGitRemotes(repo);
            assert.deepEqual(
                model.map((r) => r.name).sort(),
                ["origin", "upstream"],
                "must not drop remotes whose URLs contain spaces",
            );

            const origin = model.find((r) => r.name === "origin");
            const upstream = model.find((r) => r.name === "upstream");
            assert.deepEqual(origin.urls, [fetchRemote]);
            assert.deepEqual(origin.pushUrls, [pushRemote]);
            assert.deepEqual(upstream.urls, [otherRemote]);
            assert.deepEqual(
                upstream.pushUrls,
                [],
                "fetch-only remote must not invent pushUrls",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("preserves every configured remote.<name>.pushurl (multi-pushurl model)", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-push-"));
        try {
            const fetchRemote = join(base, "fetch.git");
            const push1 = join(base, "push one.git");
            const push2 = join(base, "push two.git");
            initBare(fetchRemote);
            initBare(push1);
            initBare(push2);

            const repo = initRepo(join(base, "repo"));
            runGit(repo, ["remote", "add", "origin", fetchRemote]);
            // Git replaces the default push target with the first --push set-url,
            // then --add --push appends further destinations.
            runGit(repo, ["remote", "set-url", "--push", "origin", push1]);
            runGit(repo, ["remote", "set-url", "--add", "--push", "origin", push2]);

            const configured = pushUrlsAll(repo, "origin");
            assert.equal(configured.length, 2, "fixture must configure two push URLs");
            assert.deepEqual(configured.map(real).sort(), [real(push1), real(push2)].sort());

            const model = readGitRemotes(repo);
            const origin = model.find((r) => r.name === "origin");
            assert.ok(origin, "origin must be present");
            assert.deepEqual(origin.urls.map(real), [real(fetchRemote)]);
            assert.ok(Array.isArray(origin.pushUrls), "pushUrls must be an array");
            assert.equal(
                origin.pushUrls.length,
                2,
                "must keep BOTH pushurls — collapsing to one is the PR #89 blocker",
            );
            assert.deepEqual(
                origin.pushUrls.map(real).sort(),
                [real(push1), real(push2)].sort(),
                "must not drop, collapse, or rewrite multi-pushurl entries",
            );
            // Regression: must not rewrite push destinations to the fetch URL.
            for (const u of origin.pushUrls) {
                assert.notEqual(real(u), real(fetchRemote), "pushurl must stay distinct from fetch URL");
            }
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.read
    // @level unit
    it("returns empty pushUrls when no explicit pushurl is configured", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-fetch-only-"));
        try {
            const originBare = join(base, "origin.git");
            initBare(originBare);
            const repo = initRepo(join(base, "repo"));
            runGit(repo, ["remote", "add", "origin", originBare]);

            const origin = readGitRemotes(repo).find((r) => r.name === "origin");
            assert.ok(origin);
            assert.deepEqual(origin.urls.map(real), [real(originBare)]);
            assert.deepEqual(origin.pushUrls, []);
            // Git default: get-url --push without explicit pushurl returns fetch URL.
            assert.equal(real(runGit(repo, ["remote", "get-url", "--push", "origin"])), real(originBare));
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("preserves every configured remote.<name>.url (multi-url model)", () => {
        // Git permits multiple remote.<name>.url values. With no pushurl,
        // `git remote get-url --push --all` returns all of them and one push
        // reaches every URL. Collapsing to the first drops effective destinations.
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-url-"));
        try {
            const url1 = join(base, "mirror-a.git");
            const url2 = join(base, "mirror-b.git");
            initBare(url1);
            initBare(url2);

            const repo = initRepo(join(base, "repo"));
            runGit(repo, ["remote", "add", "origin", url1]);
            runGit(repo, ["remote", "set-url", "--add", "origin", url2]);

            const configured = fetchUrlsAll(repo, "origin");
            assert.equal(configured.length, 2, "fixture must configure two fetch URLs");
            assert.deepEqual(configured.map(real), [real(url1), real(url2)]);

            // No explicit pushurl → push destinations equal all fetch URLs.
            assert.deepEqual(
                pushUrlsAll(repo, "origin").map(real),
                [real(url1), real(url2)],
                "without pushurl, get-url --push --all must list every fetch URL",
            );

            const model = readGitRemotes(repo);
            const origin = model.find((r) => r.name === "origin");
            assert.ok(origin, "origin must be present");
            assert.ok(Array.isArray(origin.urls), "urls must be an ordered array");
            assert.equal(
                origin.urls.length,
                2,
                "must keep BOTH remote.<name>.url values — keeping only the first drops push destinations",
            );
            assert.deepEqual(
                origin.urls.map(real),
                [real(url1), real(url2)],
                "must preserve ordered multi-url entries exactly",
            );
            assert.deepEqual(
                origin.pushUrls,
                [],
                "multi-url with no pushurl must not invent explicit pushUrls",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

describe("git_remotes.sync", () => {
    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("syncs multiple push URLs and proves pushes reach every destination", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-sync-multi-"));
        try {
            const fetchRemote = join(base, "fetch.git");
            const push1 = join(base, "push-a.git");
            const push2 = join(base, "push-b.git");
            initBare(fetchRemote);
            initBare(push1);
            initBare(push2);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", fetchRemote]);
            runGit(source, ["remote", "set-url", "--push", "origin", push1]);
            runGit(source, ["remote", "set-url", "--add", "--push", "origin", push2]);
            // Seed object availability on fetch remote is optional; pushes go to pushurls.
            runGit(source, ["push", "origin", "HEAD"]);

            // Simulate a path-style clone whose origin points at the parent working tree
            // and which may carry a single stale pushurl / extra remote.
            const target = cloneWithIdentity(base, source, "clone");
            // Path clone sets origin → source working tree. Add a stale remote too.
            runGit(target, ["remote", "add", "stale-only", join(base, "nowhere.git")]);
            // Give the clone a single wrong pushurl so sync must replace, not append-only.
            runGit(target, ["remote", "set-url", "--push", "origin", join(base, "wrong.git")]);

            syncGitRemotes(source, target);

            const cloneModel = readGitRemotes(target);
            assert.deepEqual(
                cloneModel.map((r) => r.name).sort(),
                ["origin"],
                "stale clone-only remotes must be removed",
            );
            const origin = cloneModel.find((r) => r.name === "origin");
            assert.deepEqual(origin.urls.map(real), [real(fetchRemote)], "fetch URL must match source");
            assert.equal(origin.pushUrls.length, 2, "both pushurls must be preserved on clone");
            assert.deepEqual(
                origin.pushUrls.map(real).sort(),
                [real(push1), real(push2)].sort(),
            );

            // Structured config on the clone must match Git's own multi-push view.
            assert.deepEqual(
                pushUrlsAll(target, "origin").map(real).sort(),
                [real(push1), real(push2)].sort(),
                "git remote get-url --push --all must list both destinations",
            );

            // Behavioral proof: one push reaches EVERY configured push destination.
            runGit(target, ["checkout", "-b", "multi-proof"]);
            writeFileSync(join(target, "proof.txt"), "proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "multi-proof"]);
            runGit(target, ["push", "-u", "origin", "multi-proof"]);

            assert.match(
                branchList(push1, "multi-proof"),
                /multi-proof/,
                "push must land on first pushurl",
            );
            assert.match(
                branchList(push2, "multi-proof"),
                /multi-proof/,
                "push must land on second pushurl — keeping only the first is the blocker",
            );
            assert.equal(
                branchList(fetchRemote, "multi-proof"),
                "",
                "push must not land on the fetch-only remote when explicit pushurls exist",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("replaces a multi-stale pushurl set with the multi-desired set and pushes only to desired destinations", () => {
        // Regression: `git remote set-url --push <name> <url>` is rejected when the
        // target already has multiple pushurl values ("has multiple values; fatal:
        // could not set ..."). Sync must clear the complete existing pushurl set
        // before rebuilding the desired ordered set — not attempt a single set-url.
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-stale-"));
        try {
            const fetchRemote = join(base, "fetch.git");
            const desired1 = join(base, "desired-a.git");
            const desired2 = join(base, "desired-b.git");
            const stale1 = join(base, "stale-a.git");
            const stale2 = join(base, "stale-b.git");
            initBare(fetchRemote);
            initBare(desired1);
            initBare(desired2);
            initBare(stale1);
            initBare(stale2);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", fetchRemote]);
            runGit(source, ["remote", "set-url", "--push", "origin", desired1]);
            runGit(source, ["remote", "set-url", "--add", "--push", "origin", desired2]);
            runGit(source, ["push", "origin", "HEAD"]);

            // Path-style clone carries origin → source working tree. Configure TWO
            // stale pushurls so the target push set is multi-valued before sync.
            const target = cloneWithIdentity(base, source, "clone");
            runGit(target, ["remote", "set-url", "--push", "origin", stale1]);
            runGit(target, ["remote", "set-url", "--add", "--push", "origin", stale2]);
            assert.equal(
                pushUrlsAll(target, "origin").length,
                2,
                "fixture must start with two stale pushurls (the multi-value case git rejects)",
            );

            // Must not throw: previously `set-url --push` fatals on multi-valued pushurl.
            syncGitRemotes(source, target);

            const origin = readGitRemotes(target).find((r) => r.name === "origin");
            assert.ok(origin, "origin must remain after sync");
            assert.deepEqual(origin.urls.map(real), [real(fetchRemote)], "fetch URL must match source");
            assert.equal(
                origin.pushUrls.length,
                2,
                "both desired pushurls must be present after clearing multi-stale set",
            );
            assert.deepEqual(
                origin.pushUrls.map(real).sort(),
                [real(desired1), real(desired2)].sort(),
                "stale push destinations must be fully replaced by the desired set",
            );
            assert.deepEqual(
                pushUrlsAll(target, "origin").map(real).sort(),
                [real(desired1), real(desired2)].sort(),
                "git remote get-url --push --all must list only the desired destinations",
            );

            // Behavioral proof: push from the synced target reaches every desired
            // destination and does NOT target any stale destination.
            runGit(target, ["checkout", "-b", "multi-stale-proof"]);
            writeFileSync(join(target, "proof.txt"), "multi-stale-proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "multi-stale-proof"]);
            runGit(target, ["push", "-u", "origin", "multi-stale-proof"]);

            assert.match(
                branchList(desired1, "multi-stale-proof"),
                /multi-stale-proof/,
                "push must land on first desired pushurl",
            );
            assert.match(
                branchList(desired2, "multi-stale-proof"),
                /multi-stale-proof/,
                "push must land on second desired pushurl",
            );
            assert.equal(
                branchList(stale1, "multi-stale-proof"),
                "",
                "push must not land on first stale pushurl",
            );
            assert.equal(
                branchList(stale2, "multi-stale-proof"),
                "",
                "push must not land on second stale pushurl",
            );
            assert.equal(
                branchList(fetchRemote, "multi-stale-proof"),
                "",
                "push must not land on the fetch-only remote when explicit pushurls exist",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("clears multi-stale pushurls whose paths contain regex metacharacters without treating URLs as regex", () => {
        // Regression: `git remote set-url --push --delete <name> <url>` treats the
        // final argument as a regex. Local paths with unmatched `[` (legal bare
        // names) make --delete fail, and swallowing that failure left stale
        // pushurls intact while rebuild threw. Clear must drop the config key as
        // a complete set (e.g. `git config --unset-all remote.<name>.pushurl`)
        // so URL text is never interpreted as a pattern.
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-pushurl-meta-"));
        try {
            const fetchRemote = join(base, "fetch.git");
            // Desired destinations also contain metacharacters so rebuild is covered.
            const desired1 = join(base, "desired[a].git");
            const desired2 = join(base, "desired[b].git");
            const stale1 = join(base, "stale[1].git");
            const stale2 = join(base, "stale[2].git");
            initBare(fetchRemote);
            initBare(desired1);
            initBare(desired2);
            initBare(stale1);
            initBare(stale2);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", fetchRemote]);
            runGit(source, ["remote", "set-url", "--push", "origin", desired1]);
            runGit(source, ["remote", "set-url", "--add", "--push", "origin", desired2]);
            runGit(source, ["push", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            runGit(target, ["remote", "set-url", "--push", "origin", stale1]);
            runGit(target, ["remote", "set-url", "--add", "--push", "origin", stale2]);
            assert.equal(
                pushUrlsAll(target, "origin").length,
                2,
                "fixture must start with two stale metacharacter pushurls",
            );

            // Must not throw even when stale URLs contain unmatched `[`.
            syncGitRemotes(source, target);

            const origin = readGitRemotes(target).find((r) => r.name === "origin");
            assert.ok(origin, "origin must remain after sync");
            assert.deepEqual(origin.urls.map(real), [real(fetchRemote)], "fetch URL must match source");
            assert.deepEqual(
                origin.pushUrls.map(real),
                [real(desired1), real(desired2)],
                "desired ordered pushurls must be rebuilt exactly after metachar clear",
            );
            assert.deepEqual(
                pushUrlsAll(target, "origin").map(real),
                [real(desired1), real(desired2)],
                "git must list only the desired ordered destinations after clear+rebuild",
            );

            // Behavioral proof: desired destinations receive the push; stale ones do not.
            runGit(target, ["checkout", "-b", "meta-proof"]);
            writeFileSync(join(target, "proof.txt"), "meta-proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "meta-proof"]);
            runGit(target, ["push", "-u", "origin", "meta-proof"]);

            assert.match(
                branchList(desired1, "meta-proof"),
                /meta-proof/,
                "push must land on first desired metachar pushurl",
            );
            assert.match(
                branchList(desired2, "meta-proof"),
                /meta-proof/,
                "push must land on second desired metachar pushurl",
            );
            assert.equal(
                branchList(stale1, "meta-proof"),
                "",
                "push must not land on first stale metachar pushurl",
            );
            assert.equal(
                branchList(stale2, "meta-proof"),
                "",
                "push must not land on second stale metachar pushurl",
            );
            assert.equal(
                branchList(fetchRemote, "meta-proof"),
                "",
                "push must not land on the fetch-only remote when explicit pushurls exist",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("syncs multiple remote.<name>.url values and proves push reaches every default destination", () => {
        // Class member: multi-url / no-pushurl. Git pushes to every configured
        // remote.<name>.url when no pushurl is set. Sync must preserve the full
        // ordered url list so source and target push to the same destinations.
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-sync-multi-url-"));
        try {
            const url1 = join(base, "mirror-a.git");
            const url2 = join(base, "mirror-b.git");
            initBare(url1);
            initBare(url2);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", url1]);
            runGit(source, ["remote", "set-url", "--add", "origin", url2]);
            // Seed both mirrors so objects exist on every default push destination.
            runGit(source, ["push", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            // Path clone leaves a single origin URL (source working tree).
            assert.equal(
                fetchUrlsAll(target, "origin").length,
                1,
                "path-style clone starts with a single origin URL",
            );
            // Leave a stale second URL + leftover pushurl so sync must rebuild.
            const staleUrl = join(base, "stale-url.git");
            const stalePush = join(base, "stale-push.git");
            initBare(staleUrl);
            initBare(stalePush);
            runGit(target, ["remote", "set-url", "--add", "origin", staleUrl]);
            runGit(target, ["remote", "set-url", "--push", "origin", stalePush]);

            syncGitRemotes(source, target);

            const origin = readGitRemotes(target).find((r) => r.name === "origin");
            assert.ok(origin, "origin must remain after sync");
            assert.deepEqual(
                origin.urls.map(real),
                [real(url1), real(url2)],
                "both remote.<name>.url values must be preserved in order",
            );
            assert.deepEqual(
                origin.pushUrls,
                [],
                "no-pushurl multi-url source must not invent pushUrls on the target",
            );
            assert.deepEqual(
                fetchUrlsAll(target, "origin").map(real),
                [real(url1), real(url2)],
                "git remote get-url --all must list both fetch URLs",
            );
            assert.deepEqual(
                pushUrlsAll(target, "origin").map(real),
                [real(url1), real(url2)],
                "without pushurl, get-url --push --all must equal all fetch URLs",
            );

            // Behavioral proof: one push from the synced target reaches EVERY
            // configured url (default multi-destination push semantics).
            runGit(target, ["checkout", "-b", "multi-url-proof"]);
            writeFileSync(join(target, "proof.txt"), "multi-url-proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "multi-url-proof"]);
            runGit(target, ["push", "-u", "origin", "multi-url-proof"]);

            assert.match(
                branchList(url1, "multi-url-proof"),
                /multi-url-proof/,
                "push must land on first remote.<name>.url",
            );
            assert.match(
                branchList(url2, "multi-url-proof"),
                /multi-url-proof/,
                "push must land on second remote.<name>.url — keeping only the first is the blocker",
            );
            assert.equal(
                branchList(staleUrl, "multi-url-proof"),
                "",
                "push must not land on a stale multi-url that source does not have",
            );
            assert.equal(
                branchList(stalePush, "multi-url-proof"),
                "",
                "push must not land on a leftover pushurl after clearing to multi-url default",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("syncs multi-url plus explicit pushurls and pushes only to the push destinations", () => {
        // Class member: multi-url + explicit pushurl(s). Fetch URLs stay multi-valued
        // for fetch topology; push must use only the configured pushurls.
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-url-push-"));
        try {
            const url1 = join(base, "fetch-a.git");
            const url2 = join(base, "fetch-b.git");
            const push1 = join(base, "push-a.git");
            const push2 = join(base, "push-b.git");
            initBare(url1);
            initBare(url2);
            initBare(push1);
            initBare(push2);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", url1]);
            runGit(source, ["remote", "set-url", "--add", "origin", url2]);
            runGit(source, ["remote", "set-url", "--push", "origin", push1]);
            runGit(source, ["remote", "set-url", "--add", "--push", "origin", push2]);
            runGit(source, ["push", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            // Corrupt both sets so sync must rebuild url + pushurl independently.
            const staleUrl = join(base, "stale-url.git");
            const stalePush = join(base, "stale-push.git");
            initBare(staleUrl);
            initBare(stalePush);
            runGit(target, ["remote", "set-url", "origin", staleUrl]);
            runGit(target, ["remote", "set-url", "--push", "origin", stalePush]);

            syncGitRemotes(source, target);

            const origin = readGitRemotes(target).find((r) => r.name === "origin");
            assert.deepEqual(
                origin.urls.map(real),
                [real(url1), real(url2)],
                "multi fetch URLs must be preserved alongside explicit pushurls",
            );
            assert.deepEqual(
                origin.pushUrls.map(real),
                [real(push1), real(push2)],
                "explicit multi pushurls must be preserved alongside multi fetch URLs",
            );
            assert.deepEqual(
                fetchUrlsAll(target, "origin").map(real),
                [real(url1), real(url2)],
            );
            assert.deepEqual(
                pushUrlsAll(target, "origin").map(real),
                [real(push1), real(push2)],
                "with pushurls present, get-url --push --all must list only push destinations",
            );

            runGit(target, ["checkout", "-b", "multi-url-push-proof"]);
            writeFileSync(join(target, "proof.txt"), "multi-url-push-proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "multi-url-push-proof"]);
            runGit(target, ["push", "-u", "origin", "multi-url-push-proof"]);

            assert.match(branchList(push1, "multi-url-push-proof"), /multi-url-push-proof/);
            assert.match(branchList(push2, "multi-url-push-proof"), /multi-url-push-proof/);
            assert.equal(branchList(url1, "multi-url-push-proof"), "",
                "push must not land on fetch URLs when explicit pushurls exist");
            assert.equal(branchList(url2, "multi-url-push-proof"), "",
                "push must not land on second fetch URL when explicit pushurls exist");
            assert.equal(branchList(staleUrl, "multi-url-push-proof"), "");
            assert.equal(branchList(stalePush, "multi-url-push-proof"), "");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("clears multi-stale remote.<name>.url values whose paths contain regex metacharacters", () => {
        // Class member: multi-url clear must use complete-set drop (unset-all),
        // never regex --delete of URL text — same hazard as multi-pushurl clear.
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-url-meta-"));
        try {
            const desired1 = join(base, "desired[a].git");
            const desired2 = join(base, "desired[b].git");
            const stale1 = join(base, "stale[1].git");
            const stale2 = join(base, "stale[2].git");
            initBare(desired1);
            initBare(desired2);
            initBare(stale1);
            initBare(stale2);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", desired1]);
            runGit(source, ["remote", "set-url", "--add", "origin", desired2]);
            runGit(source, ["push", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            // Force a multi-valued stale url set containing unmatched `[`.
            runGit(target, ["remote", "set-url", "origin", stale1]);
            runGit(target, ["remote", "set-url", "--add", "origin", stale2]);
            assert.equal(
                fetchUrlsAll(target, "origin").length,
                2,
                "fixture must start with two stale metacharacter fetch URLs",
            );

            syncGitRemotes(source, target);

            const origin = readGitRemotes(target).find((r) => r.name === "origin");
            assert.deepEqual(
                origin.urls.map(real),
                [real(desired1), real(desired2)],
                "desired ordered multi-url values must be rebuilt after metachar clear",
            );
            assert.deepEqual(origin.pushUrls, []);
            assert.deepEqual(
                fetchUrlsAll(target, "origin").map(real),
                [real(desired1), real(desired2)],
            );
            assert.deepEqual(
                pushUrlsAll(target, "origin").map(real),
                [real(desired1), real(desired2)],
            );

            runGit(target, ["checkout", "-b", "multi-url-meta-proof"]);
            writeFileSync(join(target, "proof.txt"), "multi-url-meta-proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "multi-url-meta-proof"]);
            runGit(target, ["push", "-u", "origin", "multi-url-meta-proof"]);

            assert.match(branchList(desired1, "multi-url-meta-proof"), /multi-url-meta-proof/);
            assert.match(branchList(desired2, "multi-url-meta-proof"), /multi-url-meta-proof/);
            assert.equal(branchList(stale1, "multi-url-meta-proof"), "");
            assert.equal(branchList(stale2, "multi-url-meta-proof"), "");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    it("preserves multiple remotes independently and removes stale clone-only remotes", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-multi-remote-"));
        try {
            const originBare = join(base, "origin.git");
            const mirrorBare = join(base, "mirror.git");
            initBare(originBare);
            initBare(mirrorBare);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", originBare]);
            runGit(source, ["remote", "add", "mirror", mirrorBare]);
            runGit(source, ["push", "-u", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            // Path-style origin points at source; invent an extra remote.
            runGit(target, ["remote", "add", "extra", join(base, "extra.git")]);

            syncGitRemotes(source, target);

            const names = readGitRemotes(target).map((r) => r.name).sort();
            assert.deepEqual(names, ["mirror", "origin"]);
            assert.equal(real(runGit(target, ["remote", "get-url", "origin"])), real(originBare));
            assert.equal(real(runGit(target, ["remote", "get-url", "mirror"])), real(mirrorBare));
            assert.notEqual(
                real(runGit(target, ["remote", "get-url", "origin"])),
                real(source),
                "origin must not remain pointed at the parent working tree",
            );
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    it("keeps fetch-only remotes semantically equivalent (no invented pushurl)", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-fetchonly-sync-"));
        try {
            const originBare = join(base, "origin.git");
            initBare(originBare);
            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", originBare]);
            runGit(source, ["push", "-u", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            // Give the clone a leftover distinct pushurl that source does not have.
            const leftover = join(base, "leftover.git");
            initBare(leftover);
            runGit(target, ["remote", "set-url", "--push", "origin", leftover]);

            syncGitRemotes(source, target);

            const origin = readGitRemotes(target).find((r) => r.name === "origin");
            assert.deepEqual(origin.pushUrls, [], "must clear leftover pushurls");
            // Default Git push behavior: push URL equals fetch URL when no pushurl set.
            assert.equal(
                real(runGit(target, ["remote", "get-url", "--push", "origin"])),
                real(originBare),
            );

            runGit(target, ["checkout", "-b", "fetch-only-proof"]);
            writeFileSync(join(target, "proof.txt"), "p\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "fetch-only-proof"]);
            runGit(target, ["push", "-u", "origin", "fetch-only-proof"]);
            assert.match(branchList(originBare, "fetch-only-proof"), /fetch-only-proof/);
            assert.equal(branchList(leftover, "fetch-only-proof"), "");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.sync
    // @level unit
    it("preserves whitespace local-path fetch and push URLs through sync", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-ws-sync-"));
        try {
            const fetchRemote = join(base, "up stream.git");
            const pushRemote = join(base, "push dest.git");
            initBare(fetchRemote);
            initBare(pushRemote);

            const source = initRepo(join(base, "source"));
            runGit(source, ["remote", "add", "origin", fetchRemote]);
            runGit(source, ["remote", "set-url", "--push", "origin", pushRemote]);
            runGit(source, ["push", "origin", "HEAD"]);

            const target = cloneWithIdentity(base, source, "clone");
            syncGitRemotes(source, target);

            assert.equal(runGit(target, ["remote", "get-url", "origin"]), fetchRemote);
            assert.equal(runGit(target, ["remote", "get-url", "--push", "origin"]), pushRemote);

            runGit(target, ["checkout", "-b", "ws-proof"]);
            writeFileSync(join(target, "proof.txt"), "proof\n");
            runGit(target, ["add", "proof.txt"]);
            runGit(target, ["commit", "-m", "ws-proof"]);
            runGit(target, ["push", "-u", "origin", "ws-proof"]);
            assert.match(branchList(pushRemote, "ws-proof"), /ws-proof/);
            assert.equal(branchList(fetchRemote, "ws-proof"), "");
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });
});

/**
 * Configure a push-only remote via `git config` (Git has no `remote add` form
 * without a fetch URL). Optionally sets the standard fetch refspec so the remote
 * remains listed by `git remote`.
 */
function configurePushOnlyRemote(dir, name, pushUrls) {
    if (!Array.isArray(pushUrls) || pushUrls.length === 0) {
        throw new Error("configurePushOnlyRemote requires at least one pushurl");
    }
    // Ensure no leftover url/pushurl keys for this name.
    try {
        runGit(dir, ["config", "--unset-all", `remote.${name}.url`]);
    } catch {
        /* absent */
    }
    try {
        runGit(dir, ["config", "--unset-all", `remote.${name}.pushurl`]);
    } catch {
        /* absent */
    }
    for (const url of pushUrls) {
        runGit(dir, ["config", "--add", `remote.${name}.pushurl`, url]);
    }
    // Fetch refspec keeps the remote named even with zero url keys.
    try {
        runGit(dir, ["config", "--get", `remote.${name}.fetch`]);
    } catch {
        runGit(dir, [
            "config",
            `remote.${name}.fetch`,
            `+refs/heads/*:refs/remotes/${name}/*`,
        ]);
    }
}

describe("git_remotes.read (#109 push-only + read-failure)", () => {
    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("models push-only remotes with empty urls and every configured pushurl (no invented fetch URL)", () => {
        const base = mkdtempSync(join(tmpdir(), "pi-remotes-push-only-read-"));
        try {
            const push1 = join(base, "push one.git");
            const push2 = join(base, "push two.git");
            initBare(push1);
            initBare(push2);

            const repo = initRepo(join(base, "repo"));
            configurePushOnlyRemote(repo, "origin", [push1, push2]);

            // Fixture sanity: Git itself has no fetch URL key and two pushurls.
            let urlExit = 0;
            try {
                runGit(repo, ["config", "--get-all", "remote.origin.url"]);
            } catch {
                urlExit = 1;
            }
            assert.equal(urlExit, 1, "fixture must have zero remote.origin.url keys");
            assert.deepEqual(
                pushUrlsAll(repo, "origin").map(real).sort(),
                [real(push1), real(push2)].sort(),
            );

            const model = readGitRemotes(repo);
            const origin = model.find((r) => r.name === "origin");
            assert.ok(origin, "push-only origin must be present in the model");
            assert.ok(Array.isArray(origin.urls), "urls must be an ordered array");
            assert.deepEqual(
                origin.urls,
                [],
                "push-only remote must not invent a fetch URL — urls must be empty",
            );
            assert.equal(
                origin.pushUrls.length,
                2,
                "must keep BOTH pushurls on a push-only remote",
            );
            assert.deepEqual(
                origin.pushUrls.map(real).sort(),
                [real(push1), real(push2)].sort(),
                "must not drop, collapse, or rewrite push-only multi-pushurl entries",
            );
            // Explicit regression against the #103 interim fallback (first pushurl as fetch).
            for (const u of origin.pushUrls) {
                assert.ok(
                    !origin.urls.map(real).includes(real(u)),
                    "no pushurl may appear as an invented fetch URL",
                );
            }
        } finally {
            rmSync(base, { recursive: true, force: true });
        }
    });

    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("returns [] for a valid Git repo with no remote keys",
        () => {
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-empty-valid-"));
            try {
                const repo = initRepo(join(base, "repo"));
                // No remotes configured.
                assert.deepEqual(
                    readGitRemotes(repo),
                    [],
                    "valid empty remote set must be [] (not an error)",
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );

    // @covers git_remotes.read
    // @level unit
    // @fails-without-fix git_remotes.read
    it("throws a useful error when the path is missing or not a Git repository",
        () => {
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-read-fail-"));
            try {
                const missing = join(base, "does-not-exist");
                const notRepo = join(base, "not-a-repo");
                mkdirSync(notRepo, { recursive: true });
                writeFileSync(join(notRepo, "readme.txt"), "no git here\n");

                assert.throws(
                    () => readGitRemotes(missing),
                    (err) => {
                        assert.ok(err instanceof Error);
                        assert.match(
                            err.message,
                            /remote|git|not a git repository|ENOENT|no such file|cannot change|failed/i,
                            "missing path must surface a useful error",
                        );
                        return true;
                    },
                    "missing source path must throw (not return [])",
                );

                assert.throws(
                    () => readGitRemotes(notRepo),
                    (err) => {
                        assert.ok(err instanceof Error);
                        assert.match(
                            err.message,
                            /remote|git|not a git repository|failed/i,
                            "non-git directory must surface a useful error",
                        );
                        return true;
                    },
                    "non-git directory must throw (not return [])",
                );

                // Unreadable source remote config (adjacent AC4/AC5 member).
                // Making `.git/config` a directory is a privilege-safe way to force
                // Git's config-read path to fail on every platform (including when
                // tests run as a privileged user where chmod 000 is ineffective).
                // This exercises the same assertGitRepository / config-read failure
                // path as a permission-denied config without relying on chmod.
                const unreadable = initRepo(join(base, "unreadable-config"));
                runGit(unreadable, ["remote", "add", "origin", join(base, "somewhere.git")]);
                rmSync(join(unreadable, ".git", "config"));
                mkdirSync(join(unreadable, ".git", "config"));

                assert.throws(
                    () => readGitRemotes(unreadable),
                    (err) => {
                        assert.ok(err instanceof Error);
                        assert.match(
                            err.message,
                            /remote|git|not a readable|configuration|permission|directory|failed/i,
                            "unreadable source config must surface a useful error",
                        );
                        return true;
                    },
                    "unreadable source remote config must throw (not return [])",
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );
});

describe("git_remotes.sync (#109 push-only + read-failure non-mutation)", () => {
    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("syncs push-only multi-pushurl remotes without inventing a fetch URL and pushes to every destination",
        () => {
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-push-only-sync-"));
            try {
                const push1 = join(base, "push-a.git");
                const push2 = join(base, "push-b.git");
                initBare(push1);
                initBare(push2);

                const source = initRepo(join(base, "source"));
                configurePushOnlyRemote(source, "origin", [push1, push2]);
                // Seed both push destinations from the source (push-only topology).
                runGit(source, ["push", "origin", "HEAD"]);

                // Path-style clone invents origin → source working tree (has a fetch URL).
                // Sync must rewrite to push-only: zero url, both pushurls.
                const target = cloneWithIdentity(base, source, "clone");
                // Also leave a stale second remote and a wrong pushurl so sync rebuilds fully.
                runGit(target, ["remote", "add", "stale-only", join(base, "nowhere.git")]);
                runGit(target, ["remote", "set-url", "--push", "origin", join(base, "wrong.git")]);

                syncGitRemotes(source, target);

                const cloneModel = readGitRemotes(target);
                assert.deepEqual(
                    cloneModel.map((r) => r.name).sort(),
                    ["origin"],
                    "stale clone-only remotes must be removed",
                );
                const origin = cloneModel.find((r) => r.name === "origin");
                assert.ok(origin, "origin must remain after sync");
                assert.deepEqual(
                    origin.urls,
                    [],
                    "synced push-only remote must not invent a fetch URL",
                );
                assert.equal(origin.pushUrls.length, 2, "both pushurls must be preserved");
                assert.deepEqual(
                    origin.pushUrls.map(real).sort(),
                    [real(push1), real(push2)].sort(),
                );

                // Structured config: zero url keys, two pushurl keys.
                let urlKeys = 0;
                try {
                    const out = runGit(target, ["config", "--get-all", "remote.origin.url"]);
                    urlKeys = out.split("\n").filter(Boolean).length;
                } catch {
                    urlKeys = 0;
                }
                assert.equal(urlKeys, 0, "target must have zero remote.origin.url config keys");
                assert.deepEqual(
                    pushUrlsAll(target, "origin").map(real).sort(),
                    [real(push1), real(push2)].sort(),
                    "git remote get-url --push --all must list both push-only destinations",
                );

                // Behavioral proof: one push reaches EVERY configured push destination.
                runGit(target, ["checkout", "-b", "push-only-proof"]);
                writeFileSync(join(target, "proof.txt"), "push-only-proof\n");
                runGit(target, ["add", "proof.txt"]);
                runGit(target, ["commit", "-m", "push-only-proof"]);
                runGit(target, ["push", "-u", "origin", "push-only-proof"]);

                assert.match(
                    branchList(push1, "push-only-proof"),
                    /push-only-proof/,
                    "push must land on first push-only destination",
                );
                assert.match(
                    branchList(push2, "push-only-proof"),
                    /push-only-proof/,
                    "push must land on second push-only destination",
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("creates an absent push-only multi-pushurl remote on the target (ensureRemoteExists create path)",
        () => {
            // Adjacent member of push-only-remote-preservation: the existing rewrite
            // case above starts from a path-style clone where origin already exists.
            // This case drives the ensureRemoteExists push-only create branch where
            // the remote name is absent from the target entirely.
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-push-only-create-"));
            try {
                const push1 = join(base, "create-a.git");
                const push2 = join(base, "create-b.git");
                initBare(push1);
                initBare(push2);

                const source = initRepo(join(base, "source"));
                // Use a non-origin name so target cannot inherit it from a clone.
                configurePushOnlyRemote(source, "deploy", [push1, push2]);
                runGit(source, ["push", "deploy", "HEAD"]);

                // Independent target repo: no `deploy` remote at all. Keep a stale
                // remote that must be removed so sync still does full set reconcile.
                const target = initRepo(join(base, "target"));
                const staleBare = join(base, "stale.git");
                initBare(staleBare);
                runGit(target, ["remote", "add", "stale-only", staleBare]);
                assert.equal(
                    runGit(target, ["remote"]).split("\n").filter(Boolean).includes("deploy"),
                    false,
                    "fixture must start without the push-only remote name",
                );

                syncGitRemotes(source, target);

                const model = readGitRemotes(target);
                assert.deepEqual(
                    model.map((r) => r.name).sort(),
                    ["deploy"],
                    "sync must create the absent push-only remote and drop stale ones",
                );
                const deploy = model.find((r) => r.name === "deploy");
                assert.ok(deploy, "deploy must exist after create-path sync");
                assert.deepEqual(
                    deploy.urls,
                    [],
                    "created push-only remote must not invent a fetch URL",
                );
                assert.equal(deploy.pushUrls.length, 2, "both pushurls must be created");
                assert.deepEqual(
                    deploy.pushUrls.map(real).sort(),
                    [real(push1), real(push2)].sort(),
                );

                // Structured config proof: zero remote.deploy.url keys, both pushurls.
                let urlKeys = 0;
                try {
                    const out = runGit(target, ["config", "--get-all", "remote.deploy.url"]);
                    urlKeys = out.split("\n").filter(Boolean).length;
                } catch {
                    urlKeys = 0;
                }
                assert.equal(
                    urlKeys,
                    0,
                    "created push-only remote must have zero remote.deploy.url config keys",
                );
                assert.deepEqual(
                    pushUrlsAll(target, "deploy").map(real).sort(),
                    [real(push1), real(push2)].sort(),
                    "git remote get-url --push --all must list both created push destinations",
                );

                // Behavioral proof: push from the newly created remote reaches both destinations.
                runGit(target, ["checkout", "-b", "push-only-create-proof"]);
                writeFileSync(join(target, "create-proof.txt"), "push-only-create-proof\n");
                runGit(target, ["add", "create-proof.txt"]);
                runGit(target, ["commit", "-m", "push-only-create-proof"]);
                runGit(target, ["push", "-u", "deploy", "push-only-create-proof"]);

                assert.match(
                    branchList(push1, "push-only-create-proof"),
                    /push-only-create-proof/,
                    "create-path push must land on first push-only destination",
                );
                assert.match(
                    branchList(push2, "push-only-create-proof"),
                    /push-only-create-proof/,
                    "create-path push must land on second push-only destination",
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("aborts before mutating target remotes when the source path is missing",
        () => {
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-sync-missing-src-"));
            try {
                const originBare = join(base, "origin.git");
                const mirrorBare = join(base, "mirror.git");
                initBare(originBare);
                initBare(mirrorBare);

                // Target starts with a deliberate remote set that must survive a failed sync.
                const target = initRepo(join(base, "target"));
                const pushDest = join(base, "push-dest.git");
                initBare(pushDest);
                runGit(target, ["remote", "add", "origin", originBare]);
                runGit(target, ["remote", "add", "mirror", mirrorBare]);
                runGit(target, ["remote", "set-url", "--push", "origin", pushDest]);

                const before = readGitRemotes(target).map((r) => ({
                    name: r.name,
                    urls: r.urls.map(real),
                    pushUrls: r.pushUrls.map(real),
                }));
                assert.equal(before.length, 2, "fixture must start with two remotes");

                const missing = join(base, "missing-source");
                assert.throws(
                    () => syncGitRemotes(missing, target),
                    (err) => {
                        assert.ok(err instanceof Error);
                        assert.match(err.message, /remote|git|failed|ENOENT|no such file|cannot change/i);
                        return true;
                    },
                    "sync must throw when source is missing",
                );

                const after = readGitRemotes(target).map((r) => ({
                    name: r.name,
                    urls: r.urls.map(real),
                    pushUrls: r.pushUrls.map(real),
                }));
                assert.deepEqual(
                    after,
                    before,
                    "failed sync must not remove or rewrite existing target remotes",
                );
                // Also check Git's own view (not just the model).
                assert.deepEqual(
                    runGit(target, ["remote"]).split("\n").filter(Boolean).sort(),
                    ["mirror", "origin"],
                );
                assert.equal(real(runGit(target, ["remote", "get-url", "origin"])), real(originBare));
                assert.equal(real(runGit(target, ["remote", "get-url", "mirror"])), real(mirrorBare));
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("aborts before mutating target remotes when the source is not a Git repository",
        () => {
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-sync-nongit-src-"));
            try {
                const originBare = join(base, "origin.git");
                initBare(originBare);
                const target = initRepo(join(base, "target"));
                runGit(target, ["remote", "add", "origin", originBare]);
                // Distinct pushurl so any rewrite is observable.
                const pushDest = join(base, "push-dest.git");
                initBare(pushDest);
                runGit(target, ["remote", "set-url", "--push", "origin", pushDest]);

                const before = {
                    names: runGit(target, ["remote"]).split("\n").filter(Boolean).sort(),
                    fetch: fetchUrlsAll(target, "origin").map(real),
                    push: pushUrlsAll(target, "origin").map(real),
                    model: readGitRemotes(target).map((r) => ({
                        name: r.name,
                        urls: r.urls.map(real),
                        pushUrls: r.pushUrls.map(real),
                    })),
                };

                const notRepo = join(base, "not-a-repo");
                mkdirSync(notRepo, { recursive: true });
                writeFileSync(join(notRepo, "file.txt"), "x\n");

                assert.throws(
                    () => syncGitRemotes(notRepo, target),
                    (err) => {
                        assert.ok(err instanceof Error);
                        assert.match(err.message, /remote|git|not a git repository|failed/i);
                        return true;
                    },
                );

                const after = {
                    names: runGit(target, ["remote"]).split("\n").filter(Boolean).sort(),
                    fetch: fetchUrlsAll(target, "origin").map(real),
                    push: pushUrlsAll(target, "origin").map(real),
                    model: readGitRemotes(target).map((r) => ({
                        name: r.name,
                        urls: r.urls.map(real),
                        pushUrls: r.pushUrls.map(real),
                    })),
                };
                assert.deepEqual(after, before, "non-git source must leave target remotes untouched");
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );

    // @covers git_remotes.sync
    // @level unit
    // @fails-without-fix git_remotes.sync
    it("aborts before mutating target remotes when source remote config is unreadable",
        () => {
            // Adjacent member of source-read-failure-non-mutation: missing and
            // non-git sources are covered above; this drives the unreadable config
            // path. `.git/config` as a directory forces Git config reads to fail
            // deterministically without chmod (works under privileged CI users).
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-sync-unreadable-src-"));
            try {
                const originBare = join(base, "origin.git");
                const mirrorBare = join(base, "mirror.git");
                initBare(originBare);
                initBare(mirrorBare);

                const target = initRepo(join(base, "target"));
                const pushDest = join(base, "push-dest.git");
                initBare(pushDest);
                runGit(target, ["remote", "add", "origin", originBare]);
                runGit(target, ["remote", "add", "mirror", mirrorBare]);
                runGit(target, ["remote", "set-url", "--push", "origin", pushDest]);

                const before = {
                    names: runGit(target, ["remote"]).split("\n").filter(Boolean).sort(),
                    fetchOrigin: fetchUrlsAll(target, "origin").map(real),
                    pushOrigin: pushUrlsAll(target, "origin").map(real),
                    fetchMirror: fetchUrlsAll(target, "mirror").map(real),
                    model: readGitRemotes(target).map((r) => ({
                        name: r.name,
                        urls: r.urls.map(real),
                        pushUrls: r.pushUrls.map(real),
                    })),
                };
                assert.equal(before.names.length, 2, "fixture must start with two remotes");

                const unreadableSource = initRepo(join(base, "unreadable-source"));
                // Give the source a remote that WOULD mutate the target if read succeeded
                // and emptied/rewrote the set — then break its config so read fails first.
                runGit(unreadableSource, [
                    "remote",
                    "add",
                    "would-overwrite",
                    join(base, "would-overwrite.git"),
                ]);
                rmSync(join(unreadableSource, ".git", "config"));
                mkdirSync(join(unreadableSource, ".git", "config"));

                assert.throws(
                    () => syncGitRemotes(unreadableSource, target),
                    (err) => {
                        assert.ok(err instanceof Error);
                        assert.match(
                            err.message,
                            /remote|git|not a readable|configuration|permission|directory|failed/i,
                        );
                        return true;
                    },
                    "sync must throw when source remote config is unreadable",
                );

                const after = {
                    names: runGit(target, ["remote"]).split("\n").filter(Boolean).sort(),
                    fetchOrigin: fetchUrlsAll(target, "origin").map(real),
                    pushOrigin: pushUrlsAll(target, "origin").map(real),
                    fetchMirror: fetchUrlsAll(target, "mirror").map(real),
                    model: readGitRemotes(target).map((r) => ({
                        name: r.name,
                        urls: r.urls.map(real),
                        pushUrls: r.pushUrls.map(real),
                    })),
                };
                assert.deepEqual(
                    after,
                    before,
                    "unreadable source must leave target remotes completely untouched",
                );
                // Git's own view (not just the model): names + exact URL keys.
                assert.deepEqual(after.names, ["mirror", "origin"]);
                assert.equal(after.fetchOrigin[0], real(originBare));
                assert.equal(after.pushOrigin[0], real(pushDest));
                assert.equal(after.fetchMirror[0], real(mirrorBare));
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );

    // @covers git_remotes.sync
    // @level unit
    it("still clears target remotes when the source is a valid Git repo with no remote keys",
        () => {
            // Distinguishes empty-valid from read-failure: empty source is a real
            // remote set of [], so sync may remove target remotes (existing #103 behavior).
            const base = mkdtempSync(join(tmpdir(), "pi-remotes-sync-empty-src-"));
            try {
                const emptySource = initRepo(join(base, "empty-source"));
                assert.deepEqual(readGitRemotes(emptySource), []);

                const originBare = join(base, "origin.git");
                initBare(originBare);
                const target = initRepo(join(base, "target"));
                runGit(target, ["remote", "add", "origin", originBare]);

                syncGitRemotes(emptySource, target);

                assert.deepEqual(
                    readGitRemotes(target),
                    [],
                    "valid empty source may clear target remotes (not a read-failure)",
                );
            } finally {
                rmSync(base, { recursive: true, force: true });
            }
        },
    );
});

// Sanity: module file is the surface under test (exists once implemented).
describe("git_remotes module surface", () => {
    it("exports readGitRemotes and syncGitRemotes from git-remotes.ts", () => {
        assert.ok(existsSync(new URL("../git-remotes.ts", import.meta.url)));
        assert.equal(typeof readGitRemotes, "function");
        assert.equal(typeof syncGitRemotes, "function");
    });
});
