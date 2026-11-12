# Context

## Delegated Assignment Authority

An automatically resumed assignment keeps its captured parent recipient, saved
conversation, scope and permissions. Parent Goal pause/completion/clearing or
replacement and parent session/branch inactivity do not gate worker execution.
The active runtime is a compatible supervisor, not a replacement recipient.
Observed-waits service v2 advertises `assignmentContinuation: 1`; unsupported
hosts refuse continuation explicitly. Storage remains compatible: pending records
with captured policy migrate without changing it, and missing policy is refused.
Current mandatory authority, cancellation, writer/launch fences and capacity still
apply. No compatible host means queued work, with no reserved idle capacity.

The real SDK replay uses `WORKER_SDK_ONLY=1` with
`tests/worker-waits-kernel.test.mjs`. The default lane additionally proves kernel
denials; `PI_WORKER_KERNEL_REQUIRE=1` makes unsupported kernel execution fail.

## Bounded Assignment Repair

Coordinator outages retain version-1 reports in the existing durable conversation
root (`observations-v1`). They preserve the published claim, original checkpoint,
assignment binding and last observed coordinator evidence. Reports are not wait
authority. Compatible service hosts advertise `outageReconciliation: 1`; replay
reads current generations and uses ordinary fenced repair and saved-conversation
admission. Exact cancellation/consumption wins over stale reports. A report receipt
releases neither evidence pins nor writer fences. Conversation storage refusal
reports degraded supervision and refuses new park checkpoints. Legacy hosts cannot
claim outage replay support. No Harness or Goal installation is required.

Coordinator storage v4 owns one repair allowance per assignment/wait generation
and structured unacknowledged-exit fault. The key includes the original park
checkpoint and exact dependency revisions, never attempt IDs, timestamps or prose.
`repairFailedResume` fences the exact publication and persists accounting before
returning `ready`; a repeated notification is idempotent. A new published attempt
that repeats the fault commits the ordinary retained #710 failure and parent
event. Background exposes `repairFailedResumeForWorker` with ownership checks.
Subagents verifies native checkpoint bytes and writer/lease exit before calling
it, then reuses ordinary continuation admission and capacity. Missing capability,
history, authority or an expired assignment deadline fails closed; uncertain
writer fences remain. No command is rerun and no parent Goal gate is added.
The SDK fixture also covers failed-test interpretation and real unacknowledged
exits followed by repair success or recurring-fault failure.

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

### Attempt

A run's identity as one detached execution. A continuation allocates a new
attempt (new run id, log, result, callback markers, timing record, and capacity
slot) while keeping the conversation it continues. Attempt identity and
conversation identity are separate throughout the registry and cleanup.

### Conversation

The native Pi session a run's child process writes. A fresh launch uses the
attempt id as its conversation id. A continuation keeps the prior conversation
id and its saved history, and records `resumedFrom` plus a stable `rootRunId`
lineage. The launch recipe captured at the first attempt (tools, exclusions,
clean/nesting and approval intent, confinement, effective model and effort,
workspace) describes how that conversation is reconstructed. New conversations
and their completed launch recipes are saved durably in the Pi agent directory,
independent of temporary event logs and the foreground session that launched them.
A later foreground session may continue the same conversation; the new attempt's
callback belongs to that caller. A stopped (`killed`) attempt is still a saved
conversation: the next attempt keeps the same history, records `resumedFrom`,
and leaves the stopped attempt's own record unchanged.

### Saved Conversation

A native Pi conversation and its completed launch recipe persisted for later
follow-up. Its session id stays the same across attempts. Spawn can select it
by session id or by an unambiguous name in the current folder, independently of
the foreground session that launched it. A saved conversation keeps no process
alive and occupies no concurrency slot.

### Skill Exposure

Which skills a child can see, chosen once per attempt. The three observable
states are discovery of the user-level catalog (an absent choice), none, and
exactly a list of skill paths. It is a launch value, not a permission: a list
narrows the prompt and grants nothing.

A launch option wins over the catalog definition's choice, which wins over the
current session's default, which wins over the saved global default; with none of
them the child discovers the catalog as before. `/subagents settings` edits the
session default immediately, and Ctrl+S saves it globally. The session choice
applies to the next launch even before it is saved. It saves discovery as
`null`, so choosing discovery overrides an older path list instead of reading as
"not set". Both Selected skills screens use one checkbox picker over the skills
Pi already loaded for the session; saved paths absent from discovery stay
visible as unavailable, and zero checked applies to No skill catalog rather
than becoming discovery or an empty explicit draft. The effective choice is
frozen in the launch recipe, so a later catalog or config edit cannot change a
saved conversation's exposure, and
a recipe written before the choice existed keeps discovery. Catalog inspection
reads the same live session-or-config default, so `/agents` and `agents_catalog`
name the source a launch would actually use; an invalid draft or saved value is
reported as an error instead of falling back to discovery.

Discovery and "none" are distinct: an absent choice means the child advertises
the user catalog, an empty list means it advertises nothing. A continuation
repeats the frozen choice, and refuses an explicit list that would differ from
it — including an empty list offered to a conversation launched with discovery.

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