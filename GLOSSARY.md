# Harness work ownership

These terms describe who owns an observed wait and who can resume a parked worker. [Wait ownership](docs/adr/0020-observed-waits-retain-an-owner.md) defines the coordinator protocol. The [subagent lifecycle](packages/pi-better-subagents/docs/adr/0007-subagent-lifecycle.md) defines what the parent can recover and inspect.

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
