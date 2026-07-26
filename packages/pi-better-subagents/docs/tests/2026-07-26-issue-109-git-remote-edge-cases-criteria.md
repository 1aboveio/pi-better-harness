# Test Criteria — Issue #109: Push-only remotes and source read-failure safety

Source: https://github.com/1aboveio/pi-better-subagents/issues/109
Related: descoped edge cases from #103 / PR #105; consumed by disposable clone workspaces (#78)

## Scope

Extend the reusable `git-remotes.ts` library (introduced for #103) so two deferred
edge cases are first-class:

1. **Push-only remotes** — zero `remote.<name>.url` entries with one or more
   `remote.<name>.pushurl` entries. Model and sync without inventing a fetch URL.
2. **Source remote read-failure safety** — if source remote config cannot be read
   (missing path / unreadable / not a Git repo), `syncGitRemotes` must abort
   **before** mutating the target. A valid Git repo with no remote keys remains `[]`.

Out of scope: sandbox policy, merge queue, disposable clone preparation surface
beyond consuming the fixed remote helper, redesign of the #103 normal
fetch-URL + pushurl contract (must remain intact).

## Surfaces

| Surface id | Kind | Floor |
|---|---|---|
| `git_remotes.read` | library | unit / integration (real `git`) |
| `git_remotes.sync` | library | unit / integration (real `git`) |

## Acceptance Criteria → tests

| AC | Behavior | Required level | Proving test |
|---|---|---|---|
| AC1 | Remote model represents push-only remotes with `urls: []` and ordered `pushUrls` (no invented fetch URL) | unit | push-only multi-pushurl read |
| AC2 | Sync preserves push-only remotes with multiple push URLs (no `remote.<name>.url` on target) | integration | push-only multi-pushurl sync |
| AC3 | Behavioral: pushes from a synced push-only remote reach **every** configured push destination | integration | push-only dual-destination push proof |
| AC4 | `readGitRemotes` distinguishes operational/read failure from a valid repo with no remote keys (`[]`) | unit | empty-valid vs missing/not-a-repo/**unreadable config** |
| AC5 | `syncGitRemotes` aborts before mutating target remotes when source remote config cannot be read | integration | unreadable/missing/non-git source abort |
| AC6 | Regression: unreadable/missing/non-git source does not remove or rewrite existing target remotes | integration | target snapshot unchanged after failed sync (all three failure members) |
| AC7 | #103 normal topologies remain intact (multi-url, multi-pushurl with fetch URL, fetch-only, multi-remote, whitespace/metachar, stale clear) | regression | existing `tests/git_remotes.test.mjs` suite |

## Invariant class additions: `git-remote-preservation` (#109 members)

Adjacent members owned by this issue:

1. **Push-only multi-pushurl** — `urls` empty ordered list; every `pushurl` preserved; push reaches every destination; no invented fetch URL on read or sync.
   - **Rewrite member**: source push-only remote already exists on target (e.g. path-style clone origin) → rebuild zero `url` + all `pushurl`s.
   - **Create member**: source push-only remote is **absent** from target → `ensureRemoteExists` create path builds the remote via `git config` (fetch refspec + pushurls) with zero `remote.<name>.url` keys; behavioral push reaches every destination.
2. **Source read-failure non-mutation** — missing path, non-git directory, **and unreadable source config** all throw before any target remote mutation; valid empty remote set still returns `[]` and may clear target remotes as today.
   - Unreadable config is exercised with a privilege-safe fixture (`.git/config` replaced by a directory) so the same Git config-read failure path runs on every platform, including privileged CI users where `chmod 000` is ineffective.

#103 class members remain in force and must not regress.

## Mock / fake policy

- Real `git` subprocesses for all Git operations. Git is not mocked.
- No first-party internal seams are mocked.
- Temp bare repositories and filesystem permission fixtures are real.

## Evidence expectations

- RED/GREEN for push-only model/sync and source-read-failure non-mutation.
- Behavioral push proof that every push-only destination receives the branch.
- Target remote snapshot equality after a failed sync (names + urls + pushUrls).
- Lint/screens: `lint-tests`, `scope-class`, `coverage-checklist validate`, `scan-diff`.
