# Scheduler Contract Fixture

These test-only sources come from `1aboveio/ai`, resolve-issues 0.36.0 and
its engineering-runtime companion, installed on 2026-10-18. The installed
resolve-issues folder hash was `8e783f62b3f02d069f09eb4d7cebe85fa62cf29d`.
Copyright (c) 2026 1AboveIO, MIT License (same owner/license as this repository).

`next-actions.mjs`, `plan-sync.mjs`, `issue-tree.mjs`, and `main-module.mjs`
are unmodified copies. `ready-check.mjs` and `review-verdict.mjs` contain only
the unchanged exports those modules import, avoiding unrelated review and
Git commands and their transitive dependencies.

The tests execute the real CLI, tree fetcher, snapshot synchronization, and
scheduling decisions in private run directories. Only the external `gh`
process is replaced with deterministic GraphQL responses. There is no live
GitHub access or dependency on an installed skill in CI. In particular,
`--peek --sync` really writes `issue-tree.json`, while cached calls really
lose the `live` source classification, even after a successful live call.
