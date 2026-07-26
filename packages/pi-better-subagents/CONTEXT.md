# Context

## Glossary

### Related Work

Work launched for a subagent run that Pi can still credibly associate with that
run after direct supervision is interrupted.

For issue #63, related work is limited to live process-group evidence captured
from the spawned child. Descendants that daemonize, call `setsid`, leave the
captured process group/session, or become unobservable after reparenting are not
related work for this slice.

### Orphaned Run

A subagent run whose foreground Pi process can no longer directly supervise the
original child process, while credible evidence remains that related work may
still be alive.

An orphaned run is non-terminal and non-final. It does not promise useful
progress; it only means Pi should not yet treat the run as completed, failed, or
lost.

An orphaned run is operationally unhealthy as soon as it is observed. It is not
expected to become healthy again on its own; the appropriate user action is to
restart the work or stop the old unhealthy work.

### Restart

A user action that creates a new subagent run from the same task inputs as an
unhealthy run. Restart does not make the old run healthy and does not erase its
evidence.

### Stop

A user action that stops an unhealthy run's related work and closes it from
active tracking. Stop is separate from restart: restart creates replacement
work; stop ends the old unhealthy work.

Stop preserves run artifacts such as logs and metadata for investigation. It is
not deletion.

### Lost Run

A subagent run for which Pi has no credible process evidence for the launched
work and no normal completion record was captured.

A lost run is terminal with unknown outcome. It is not the same as a failed run:
failure means the subagent produced or exited with failure evidence, while lost
means supervision evidence ran out.