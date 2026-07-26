# Test Criteria — Issue #103: Complete Git remote semantics

Source: https://github.com/1aboveio/pi-better-subagents/issues/103
Related: blocks #78 / PR #89 (`git-remote-preservation` theme)

## Scope

Reusable library module that reads and syncs first-class Git remote
configuration for disposable clone workspaces under **normal fetch-URL +
pushurl topologies** (one or more `remote.<name>.url`, zero or more
`remote.<name>.pushurl`). Out of scope: full disposable clone preparation
(issue #78), sandboxing, merge queue, and the edge cases deferred to #109
(see below).

## Deferred to #109 (accepted descope from #103)

Human breaker descope after the class-complete round on PR #105. These are
**not** acceptance criteria for #103 and must not be claimed as covered here:

1. **Push-only remotes** — zero `remote.<name>.url` entries with one or more
   `remote.<name>.pushurl` entries (do not invent a fetch URL; preserve
   push-only topology).
2. **Source remote read-failure safety** — if source remote config cannot be
   read (missing/unreadable/not a Git repo), `syncGitRemotes` must abort
   **before** mutating the target. Returning `[]` must not conflate operational
   failure with a valid source that has no remotes.

Tracked: https://github.com/1aboveio/pi-better-subagents/issues/109

## Surfaces

| Surface id | Kind | Floor |
|---|---|---|
| `git_remotes.read` | library | unit / integration (real `git`) |
| `git_remotes.sync` | library | unit / integration (real `git`) |

## Acceptance Criteria → tests

| AC | Behavior | Required level | Proving test |
|---|---|---|---|
| AC1 | `readGitRemotes` reads from structured null-delimited `git config`, not `git remote -v` text parsing | unit | structured config + whitespace URLs |
| AC2 | Remote representation supports **all** configured `remote.<name>.pushurl` values (array), not a single value | unit | multi-pushurl model |
| AC2b | Remote representation supports **all** configured `remote.<name>.url` values (ordered array), not a single value | unit | multi-url model |
| AC3 | Syncing remotes into a target preserves multiple push URLs and fetch URLs exactly | integration | sync multi-pushurl + multi-url |
| AC4 | A source remote with no explicit push URL remains semantically equivalent (no invented pushurl; push uses every fetch URL) | integration | fetch-only + multi-url/no-pushurl |
| AC5 | Multiple remotes are preserved independently | integration | multi-remote |
| AC6 | Local path remote URLs containing spaces (and regex metacharacters) are preserved | unit + integration | whitespace + metachar paths |
| AC7 | Stale clone-only remotes and stale url/pushurl values are removed as complete config sets | integration | stale removal + multi-stale clear |
| AC8 | Behavioral: pushes from the prepared target reach **every** configured push destination (explicit pushurls, or all fetch URLs when none) | integration | multi-pushurl + multi-url push proof |
| AC9 | Regression: multiple url/pushurl values are not collapsed, dropped, or rewritten | unit + integration | multi-url + multi-pushurl regression |

## Invariant class: `git-remote-preservation`

Class-complete adjacent members (all must hold):

1. Multi-url / no-pushurl — ordered `remote.<name>.url` list; default push = all urls
2. Multi-url + explicit pushurl(s) — urls and pushUrls independent; push uses pushurls only
3. Multi-pushurl only (single fetch URL) — every pushurl preserved
4. Fetch-only single URL — empty pushUrls; push uses that fetch URL
5. Multiple independent remotes — no cross-remote bleed; stale clone-only removed
6. Whitespace local-path URLs — structured config read + sync
7. Regex-metacharacter local paths in url and pushurl — clear via unset-all, never regex --delete
8. Stale multi-valued url/pushurl sets on target — complete-set clear then ordered rebuild

Not in this class for #103 (deferred to #109):
- Push-only remote (urls empty, pushUrls non-empty)
- Source read failure must not mutate target remotes

## Mock / fake policy

- Real `git` subprocesses for all Git operations. Git is not mocked.
- No first-party internal seams are mocked.
- Temp bare repositories are real filesystem fixtures.

## Evidence expectations

- RED/GREEN for multi-url and multi-pushurl cases (the recurring PR #89 blockers).
- Behavioral push proof that every effective destination receives the branch.
- Lint/screens: `lint-tests`, `scope-class`, `coverage-checklist validate`, `scan-diff`.
