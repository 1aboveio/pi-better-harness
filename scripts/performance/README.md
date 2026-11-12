# Performance Budgets

Run `npm run test:performance` to exercise assignment projection through the real
Navigator and Goal activity entrypoints. All records and coordinator state live in
a disposable directory; the command does not use the user's Pi registry.

The workload combines 200, 1,000 and 2,000 historical records with 1, 20 and 50
displayed rows. Each consumer performs three fresh refreshes. The assertions bound
metadata reads to one global lineage scan per refresh, plus Goal's owner-row reads.
The former per-row scan fails this budget even on a fast machine.

CPU time and wall time are diagnostic metrics, not fixed pass/fail thresholds on
shared runners. Set `PI_PERF_REPORT` to an output file to retain the JSON report.

## CI Selection

The existing `workspace-ci` job runs the budget for PR changes to assignment
projection, Navigator, Goal activity, shared coordinator observation, their
regression tests and package configuration, the performance scripts, or CI
configuration. The exact path rules live in [ci-selection.mjs](ci-selection.mjs).
Docs-only and unrelated PRs skip the performance step. Manual `workflow_dispatch`
runs include it by default; other existing checks keep their current behavior.

Selection uses the base repository's read-only PR files API, including every
page and both names of a renamed file. Fork PRs need no write token or secrets.
An incomplete response, API failure, or changed PR revision conservatively runs
the budget instead of risking a missed regression.

When the performance step runs, CI uploads its report after success or assertion
failure. Skipped runs do not attempt an upload. The step has a two-minute timeout.

This budget covers repeated lineage I/O. Future hotspots need their own observable
budget: for example, no foreign outbox claims during idle reconciliation, no
unchanged-state database writes, or bounded work per timer tick. CPU-only regressions
need repeatable profiling and comparison on a controlled runner; passing an I/O
budget alone cannot rule them out.
