# Concurrent Archive Publication

This r9 source/component checkpoint traces original #808 AC4 (source replacement/
deletion, dropped notifications, completeness and progress during observation)
and #796 contracts4/5 (retained pending work and bounded resumable reconciliation).
It is one controlled real-file interleaving, not the full AC4 or native campaign.

## Controlled Boundary

Tests seed actual metadata/logs and use the real reader's captured SQLite snapshot.
After metadata reads and before publication verification, the test atomically
renames a valid archive into place and retires its raw directory. Closing only
this fixture's watcher handles deliberately drops hints. No fabricated source
revision, archive row, completion, execution authority or native lifecycle is used.

The minimized test invokes the existing source observation directly because the
public reconciliation method also captures an earlier coordinator snapshot before
file reads. The initial test hooked that earlier boundary; its first failure is
retained separately and is not presented as proof of the publication-verification
bug. Subsequent recovery uses the existing bounded reconciliation entrypoint.

## RED And Cause

On `20ec9fbf`, publication verification detects actual ENOENT, preserves the last
verified rows and reports degraded. It does not mark this case dirty, unlike
an observed signature mismatch. After eight explicit reconciliation turns with
dropped hints, no new inventory or repair work occurs; the archived task and
sibling update remain undiscovered.
The existing periodic compatibility pass could still recover later; this RED
proves lost immediate pending work, not impossibility of eventual timed repair.

Changing only the dirty flag proves a second missing obligation: exact reobservation
settles raw deletion and sibling progress but the new archive is still undiscovered
without its lost notification. This intermediate failing result is retained.

## Fix And GREEN

Only ENOENT during final metadata-publication verification now marks the invalidated
batch dirty and sets the existing repair-owed flag. The existing catch retains
degradation and requeues attempted paths. The existing bounded discovery finds
actual archive membership; nothing invents an archived row or treats absence as
verified deletion under an unavailable root.

No new scan implementation, timer, blanket retry, timeout, source writer, admission
hook or service is added. An existing historical repair iterator is not reset and
the imported baseline stays imported. Existing 128-path repair batches and shared
resource budgets are unchanged. Recovery may still require multiple ordinary
budgeted turns; this does not promise instantaneous/global snapshot freshness.

Three component cases check lost hints with an available root, last-verified row
retention while the source root is unavailable, and an actual active repair cursor
over 260 records. All guard against publishing staged unverified metadata, require
final archived identity/count and sibling progress, and check the existing repair
budget. R8 missing/unreadable-log, readable-empty, checkpoint, truncation and
replacement behavior remains covered by focused regression tests.

Both-OS actual Pi/Server/guardian/runner/socket coverage, continuous multi-process
initial build/repair, journal gaps, out-of-order completion/crash/watermark cases
and SAME fixed-host >=10-minute EACH before/after workloads remain unqualified.
Native admission refusals and missing lifecycle capabilities remain blockers;
this source/component pass neither replaces them nor resets no-progress history.
