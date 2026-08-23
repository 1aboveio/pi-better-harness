# pi-better-sandbox

A default-on write sandbox for Pi's foreground shell.

Install the package and keep starting Pi the way you always have — `pi`. There is
no launcher, no wrapper command, and nothing to configure. From the first
session start, Pi's built-in `bash` tool and the `!` / `!!` commands you type
yourself run inside an OS sandbox that lets them write only under the directory
you launched Pi from.

```
Read:       every filesystem path
Write:      the canonical launch directory and everything under it
Exceptions: .git/hooks, .env, .env.local
Network:    unchanged
```

The denial is done by the kernel, not by inspecting command text: macOS uses
Seatbelt (`sandbox-exec`) and Linux uses Bubblewrap (`bwrap`). A crafted command
cannot talk its way past it, because the write syscall itself is refused.

## What is confined, and what is not

Confined while the sandbox is on:

- Pi's built-in `bash` tool.
- User-entered `!` and `!!` commands.

**Not** confined:

- Pi's own process.
- `pi.exec` calls made by extensions.
- Unrelated third-party extension code.

This is a tool-execution sandbox. It limits accidental damage from commands the
model or you run through Pi's shell; it is not a boundary around Pi itself.

## Commands

```text
/sandbox        show the effective status
/sandbox on     re-arm protection for operations started from now on
/sandbox off    turn protection off for this session (interactive confirmation)
```

The footer shows `sandbox · on · <project>` while protection is active, and a
prominent `sandbox · OFF`, `sandbox · UNAVAILABLE`, or `sandbox · FAILED`
otherwise. Both surfaces report what the runtime actually resolved — which
backend, which executable — never what was merely configured.

`/sandbox off` needs an interactive confirmation and is refused outright when
there is no interactive UI. There is no tool for changing sandbox state, so the
model cannot disable its own confinement.

## Lifecycle

The sandbox is enabled again at every session start: startup, new session,
resume, fork, and reload. An off state is never written anywhere, so it cannot
outlive the session you switched it off in.

Toggles apply to operations launched after the change. A command already running
keeps the policy it launched with.

## Fail-closed behaviour

While the sandbox is enabled and a backend cannot be applied, protected commands
are **blocked** rather than run unprotected:

- No backend on this platform (`unavailable`).
- A launch directory too broad to confine — `/` or your home directory
  (`failed`). Relaunch Pi from the directory you are actually working in, or
  turn the sandbox off on purpose.
- A backend that was selected but failed to start. It is never retried directly.

## Paths, symlinks and denied files

The launch directory is canonicalized at session start, so reaching a project
through a symlink does not widen what is writable. Denied entries are
canonicalized the same way: a directory denies its whole subtree, a file denies
that exact file, and an alias pointing at a denied file is denied too.

## Platform support

| Platform | Backend                     | Requirement                  |
| -------- | --------------------------- | ---------------------------- |
| macOS    | Seatbelt (`sandbox-exec`)   | ships with the OS            |
| Linux    | Bubblewrap (`bwrap`)        | install `bubblewrap`         |
| Other    | none                        | protected commands are blocked |

## For other extensions

The effective policy is published as a frozen snapshot on Pi's extension event
bus. It carries policy and status only — never a way to run anything.

```ts
import {
  FOREGROUND_SANDBOX_POLICY_CHANNEL,
  FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL,
  type ForegroundSandboxPolicyEvent,
} from "pi-better-sandbox";

pi.events.on(FOREGROUND_SANDBOX_POLICY_CHANNEL, (policy) => {
  // Snapshot it at launch time; a running operation keeps its launch policy.
});

// Loaded late and missed the last publication? Ask for the current one.
pi.events.emit(FOREGROUND_SANDBOX_POLICY_REQUEST_CHANNEL, undefined);
```
