# Harness work ownership

This vocabulary describes the proposed observed-wait lifecycle in [ADR 0020](docs/adr/0020-observed-waits-retain-an-owner.md). It complements the existing subagent [context](packages/pi-better-subagents/CONTEXT.md); it does not describe shipped lifecycle states.

## Language

**Execution owner**:
The parent session or worker conversation responsible for interpreting an operation's evidence and continuing its assignment.
_Avoid_: watcher, when referring to the decision-maker.

**Observed wait**:
An unfinished assignment waiting on an identified operation, with a registered observer and an execution owner to receive its result.
_Avoid_: completed work, healthy waiting without supervision evidence.

**Parked worker**:
A worker that retains its assignment and conversation while it has no active execution attempt and awaits a registered dependency.
_Avoid_: idle process, stopped worker, completed assignment.

**Ready continuation**:
A parked worker whose dependency has resolved and whose next execution attempt is awaiting admission.
_Avoid_: running worker, resumed worker before admission.
