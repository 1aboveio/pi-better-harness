# pi-better-sandbox

A default-on write sandbox for Pi's foreground tools.

Install the package and keep starting Pi the way you always have — `pi`. There is
no launcher, no wrapper command, and nothing to configure. From the first
session start, Pi's built-in `bash` tool and the `!` / `!!` commands you type
yourself run inside an OS sandbox that lets them write only under the directory
you launched Pi from, and the built-in `write` and `edit` tools are held to the
same policy.

```
Read:       every filesystem path
Write:      the canonical launch directory and everything under it
Exceptions: .git/hooks, .env, .env.local
Network:    unchanged
```

For shell commands the denial is done by the kernel, not by inspecting command
text: macOS uses Seatbelt (`sandbox-exec`) and Linux uses Bubblewrap (`bwrap`).
A crafted command cannot talk its way past it, because the write syscall itself
is refused.

`write` and `edit` never start a child process — they change files inside Pi's
own process — so there is no child to wrap. They are confined by a containment
check on the canonical target instead, run inside Pi's own file-mutation queue,
immediately before the filesystem call it guards. A refused mutation leaves
nothing behind on disk.

## What is confined, and what is not

Confined while the sandbox is on:

- Pi's built-in `bash` tool.
- User-entered `!` and `!!` commands.
- Pi's built-in `write` and `edit` tools.

**Not** confined:

- Pi's own process.
- `pi.exec` calls made by extensions.
- Unrelated third-party extension code.

This is a tool-execution sandbox. It limits accidental damage from commands the
model or you run through Pi's shell; it is not a boundary around Pi itself.

Overriding `write` and `edit` changes nothing you can see: the parameter
schemas, prompt guidance, call rendering, write previews, edit diffs, result
details, mutation queueing, and cancellation are Pi's own. Only the filesystem
operations underneath them are replaced.

## Commands

```text
/sandbox                     show the effective status
/sandbox on                  re-arm protection for operations started from now on
/sandbox off                 turn protection off for this session (interactive confirmation)
/sandbox deny list           show the write-denied paths
/sandbox deny add <path>     stop allowing writes to a path
/sandbox deny remove <path>  allow writes to a path again
/sandbox deny reset          drop your changes and restore the packaged defaults
/sandbox rules               open the write-denied paths editor
```

The footer shows `sandbox · on · <project>` while protection is active, and a
prominent `sandbox · OFF`, `sandbox · UNAVAILABLE`, or `sandbox · FAILED`
otherwise. Both surfaces report what the runtime actually resolved — which
backend, which executable — never what was merely configured.

`/sandbox off` needs an interactive confirmation and is refused outright when
there is no interactive UI. There is no tool for changing sandbox state or its
rules, so the model can neither disable its own confinement nor edit the paths
it is confined away from.

## Write-denied paths

Three paths are denied out of the box — `.git/hooks`, `.env`, and `.env.local`,
relative to whichever project you are in. They live in the package's source, so
installing writes no settings file anywhere.

Rules are paths, not patterns. Write one of three ways:

| You type            | It means                                            |
| ------------------- | --------------------------------------------------- |
| `build/artifacts`   | that path inside **every** project you open          |
| `~/.aws`            | that path under your home directory                  |
| `/etc/hosts`        | exactly that path                                     |

A relative rule is stored as a template and resolved against each project, which
is why one global rule set is enough — there is no per-project database. Lists
and the editor always show the canonical absolute path a rule currently resolves
to. A directory denies its whole subtree; a file denies that exact file, whether
or not it exists yet.

`/sandbox rules` opens a compact keyboard-driven editor over the same rules:
arrow keys to move, enter to remove the highlighted rule, or pick *Add* to type
a new one and *Restore the packaged defaults* to start over. The slash commands
and the editor are two front ends over one validation and persistence module, so
they cannot disagree.

Changes take effect for shell commands and file mutations started after them.
A command already running keeps the rules it launched with.

### Where your rules live

Your changes are written to `~/.pi/agent/extensions/pi-better-sandbox.json`
(under `$PI_CODING_AGENT_DIR` when you set one):

```json
{
  "version": 1,
  "denyWrite": [".env", ".env.local", ".git/hooks", "build/artifacts"]
}
```

That file appears the first time you add or remove a rule, never at install
time. `/sandbox deny reset` deletes it and puts the defaults shipped by the
installed package version back in force — so an upgrade that changes the
defaults is picked up by a reset rather than being masked by a stale copy.

If the file cannot be read, the packaged defaults stay in force, the problem is
reported, and rule changes are refused until you fix the file or reset it —
a typo is never quietly turned into a lost rule set.

### What is refused, and why

- **Empty entries and patterns** (`*.pem`, `src/**/x`) — rules are concrete
  paths; a pattern would silently match nothing.
- **Duplicates**, however they are spelled: `.env`, `./.env`, the absolute path,
  or a symlink pointing at the same file all resolve to one canonical path.
- **Overlaps**, in both directions. A path already inside a denied directory
  would change nothing; a directory that would swallow a narrower rule names
  that rule so you can remove it deliberately instead of losing it silently.
- **A rule that contains the project root** — `.`, `..`, `/`, or `~` when your
  project lives under home. Denying it would make every write in the project
  fail. `/sandbox off` is the thing you actually want there.

A global rule that turns out to contain the root of a *different* project stays
in your rule set but is held out in that project, with a message saying so.

## Lifecycle

The sandbox is enabled again at every session start: startup, new session,
resume, fork, and reload. An off state is never written anywhere, so it cannot
outlive the session you switched it off in.

Toggles apply to operations launched after the change. A command already running
keeps the policy it launched with.

## Fail-closed behaviour

While the sandbox is enabled and a backend cannot be applied, protected commands
and file mutations are **blocked** rather than run unprotected:

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
