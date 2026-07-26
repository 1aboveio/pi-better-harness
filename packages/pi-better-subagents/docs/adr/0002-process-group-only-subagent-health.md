# Process-group-only subagent health reconciliation

Status: accepted

Refs #63 and #60.

## Context

Subagent health reconciliation needs to distinguish three user-visible facts:
the original child is still supervised, supervision is broken but launched work
may still be alive, or Pi has lost all credible process evidence for the run.
The hard boundary is descendant tracking: once a child daemonizes, calls
`setsid`, changes process group/session, or is reparented after the leader PID
dies, a later process-tree scan cannot safely prove that the surviving process
belongs to the run.

## Decision

For #63, related work is limited to live process-group evidence captured from
the spawned child. #63 does not track descendants as related work and does not
promise to follow escaped or reparented descendants.

`orphaned` means direct supervision is broken while credible process-group
evidence says launched work may still be alive. It is non-terminal and
non-final, but operationally unhealthy immediately; users should restart the
work or stop the old unhealthy work rather than expect it to become healthy.

`lost` means Pi has no credible process evidence for the launched work and no
normal completion record was captured. It is terminal with unknown outcome, not
the same as subagent failure.

Stop and restart behavior are out of scope for #63. #63 records truthful health
states; later issues own the actions and richer surfacing.

## Considered options

- **Persist known descendant identities** — would let an escaped descendant keep
  a run non-lost after reparenting, but requires a new descendant observation
  model, PID/start-token snapshots for grandchildren, and ongoing false-positive
  controls. Rejected for #63 to keep the supervision contract narrow and
  truthful.
- **Best-effort descendant scans from the leader PID** — easy to add, but it
  looks stronger than it is. After the leader dies and descendants reparent, the
  scan can no longer prove related work. Rejected to avoid a misleading health
  guarantee.
- **Keep ambiguous cases orphaned indefinitely** — avoids false `lost`, but
  turns unknown evidence into a permanent unhealthy state with no clearer user
  truth. Rejected; `orphaned` requires credible process-group evidence.

## Consequences

- The #63 contract should remove descendant evidence entirely from production
  code, tests, and review expectations.
- Legacy metadata may still infer process group as `pid`, because detached
  subagent children are expected to be process-group leaders. That inference is
  conservative: it may delay `lost`, but it must not manufacture completion or
  failure.
- Metadata with no durable process identity uses conservative lost confirmation
  based on evidence quality rather than file age.
- Later Stop/Restart work should use these domain meanings: Restart creates
  replacement work; Stop ends unhealthy related work while preserving logs and
  metadata for investigation.