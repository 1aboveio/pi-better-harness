# Context

## Glossary

### Role

A reusable specialist template describing a kind of work and its default
instructions, model, and reasoning effort. A role can be selected directly for a
task or serve as the base of a named agent.

### Base Role

The single role from which a named agent inherits defaults. This inheritance
relationship is distinct from Agentier's executable-role memberships, which
describe eligibility for work.

### Named Agent

A reusable specialist with a stable identity, one base role, and agent-specific
customizations. Its identity is distinct from its display name and from any
individual execution.

### Role Inheritance

The continuing relationship through which an agent receives its base role's
current defaults for settings it has not explicitly overridden.

### Instruction Mode

An agent's choice to add its instructions to the base role's instructions or
replace that instruction text. Replacement does not sever inheritance of other
defaults.

### Agent Override

A setting deliberately supplied on a named agent instead of inherited from its
base role. Removing an override restores inheritance for that setting.

### Run

One execution of a task, with its own identity and the effective configuration
selected when it started. Repeated executions of the same named agent are separate
runs.

### Run Alias

A user-supplied label for an individual run, rather than a reusable agent
identity.

### Catalog Snapshot

The set of role and agent definitions used to resolve a launch or a batch of
launches. A batch shares one snapshot even if the underlying definitions change.

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