# Explicit sandbox Off disables profile enforcement

> Historical decision. The current sandbox contract is in [ADR 0027](0027-sandbox-tools-and-permissions.md#permission-to-use-a-tool).

## Status

Accepted decision for #847. This records the intended contract, not a claim that
current implementations satisfy it or that the contract has been verified.

## Decision

When an operator explicitly switches a scope's sandbox Off, none of that scope's
sandbox profile settings may deny an operation. This applies independently to
Main, Subagents, and Background tasks. Off is an effective enforcement state,
not a rewrite of the stored profile: detail settings are retained for
re-enabling, and their restrictions apply again when that profile is On. This
preserves the operator's choices without letting inactive settings contradict
the explicit Off switch.

Each scope's switch affects only that scope's profile. Switching one Off does
not switch another Off or weaken any other active enclosing boundary. A launch
or operation must still satisfy every independent boundary that actually applies
to it. Off also does not override operating-system permissions or intrinsic tool
contracts, including output limits and privacy protections; it only removes
denials derived from the disabled sandbox profile.

The new effective state applies to the next eligible operation or launch.
Already running processes retain their launch-time confinement; switching Off
does not remove inherited kernel restrictions from them. Re-enabling likewise
does not retroactively change their launch-time confinement.

## Relationship to earlier decisions

This decision clarifies ADR 0004's inactive mode and ADR 0005's retained detail
values: no inactive profile detail is an independent denial gate. In particular,
the Process access gate in [ADR 0011](0011-fixed-read-only-process-inventory.md)
and the Process Off installation rule in [ADR 0024](0024-sandbox-process-identity-compatibility.md)
apply as profile restrictions only while the relevant sandbox is On. The
application, shell, and command-timeout profile controls in
[ADR 0019](0019-application-and-shell-controls.md) likewise do not deny an
operation when their scope is Off. Fixed tool output and privacy contracts
remain in force.

To the extent that ADR 0011's Process Off gating, ADR 0024's Process Off helper
installation restriction, or ADR 0019's application, shell, and timeout controls
were read as applying when their own sandbox switch is Off, this decision
supersedes those clauses. [ADR 0017](0017-background-adapter-admission.md)'s
verified admission requirement when Main is Off and Background is On remains an
active Background boundary. ADR 0004's rule that `sandbox:false` cannot bypass a
human-enabled profile also remains: a caller's request is not the operator
switching that profile Off.

## Verification

Implementation and verification are separate work. They must establish that
each scope ignores its own retained profile restrictions while Off, restores
them on re-enable, preserves independent active boundaries and intrinsic tool
limits, and leaves already running confinement intact. No such verification is
claimed by this record.
