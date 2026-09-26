# pi-better-sandbox

Sandbox permissions for Pi's foreground tools and detached subagents.

It is installed by default with [`pi-better-harness`](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-harness#readme), and can be installed on its own:

```sh
pi install npm:pi-better-sandbox
```

Either way you keep starting Pi the way you always have — `pi`. There is
no launcher or wrapper command. Main starts inactive; Subagents start confined.
Open `/sandbox` to change either column, or use `/sandbox on` for the current
Main session. **Save as defaults** persists both profiles.

```text
Sandbox permissions               Main             Subagents

Sandbox                           Off              On

Project files                     -                Read / write
Outside project                   -                Read
Stored credentials                -                Read
Run commands & applications       -                On
Network access                    -                On

↑↓ Select row   ←→ Select column   Space Change
Save as defaults
```

File permissions cycle through Off, Read, and Read / write. Other rows toggle
Off/On. Detail cells under an Off sandbox display a dimmed `-` and cannot be
changed; their values return when the sandbox is enabled again. Outside project
covers paths outside the assigned root without custom folder lists. Protected
paths remain write-denied regardless of the broad file settings.

**Stored credentials currently means known credential files.** It covers SSH,
AWS, GitHub CLI, Google Cloud CLI, Azure, Kubernetes, Docker, npm, netrc, Git
credentials, and Pi's file-based auth. These rules override ordinary file access.
OS vault services such as Keychain and Secret Service, and tokens inherited in
environment variables, are excluded. Read / write may be needed by a CLI that
refreshes a token or updates its credential database.

File and shell operations use the kernel: macOS uses Seatbelt (`sandbox-exec`)
and Linux uses Bubblewrap (`bwrap`). `read`, `write`, and `edit` keep Pi's normal
tool behavior and mutation queues, while a fixed worker performs filesystem
syscalls under the selected policy. Canonical checks explain denials; kernel
enforcement also protects against a symlink changing between checking and use.
The confined file worker rejects files over 8 MiB instead of silently truncating
them; larger-file processing can use a confined command when commands are On.

## What is confined, and what is not

Pi is the trusted runtime. It can lock configuration/authentication files,
connect to its provider, and persist sessions. Main and Subagents permissions
apply to task operations. Subagents can start with task Network access or Run
commands & applications Off. The fixed file worker remains available according
to the file permissions even when task commands are Off.

The task executor provides private scratch through `TMPDIR`, `TMP`, and `TEMP`.
Outside Read and Read/write also retain explicit runtime write exceptions for
`/tmp` (canonical `/private/tmp` on macOS), the current user's macOS temporary
directory, and that user's Security.framework MDS cache. MDS access lets CLI
Keychain retrieval initialize and refresh its cache; it does not restrict the
Keychain API to reads. Other users' caches and arbitrary outside `*.lock` files
are not writable. Credential-file and Pi control-path protections still win.
Outside Off does not expose these host runtime directories.

The currently admitted model-tool implementations are `read`, `write`, `edit`,
and `bash`. User-entered `!` and `!!` commands use the same shell policy. Other
model-callable tools require a verified execution adapter and are refused while
that actor's sandbox is enabled; enabling network alone does not admit them.
Subagent launch output identifies requested tools that are unavailable. Main
remains Off by default, so its ordinary orchestration tools remain available
unless the user enables Main confinement.

Pi and installed runtime extensions remain trusted code, including their
initialization, provider hooks, and internal `pi.exec` calls. The tool gate is
not a sandbox around malicious runtime extensions. Loaded runtime code,
configuration, and policy/control files are protected from task writes, even
under broader file grants. Task access to `~/.pi` does not receive a blanket
write allowance or lock-file exception.

Local confinement cannot govern a remote host's filesystem. Dedicated SSH,
MCP, scripting, background, and nested-agent tools currently lack admission
adapters and fail closed under an enabled actor profile. SSH through confined
`bash` receives local file, credential, and network restrictions; remote effects
remain outside the local filesystem policy.

Overriding `write` and `edit` changes nothing you can see: the parameter
schemas, prompt guidance, call rendering, write previews, edit diffs, result
details, mutation queueing, and cancellation are Pi's own. Only the filesystem
operations underneath them are replaced.

## Commands

```text
/sandbox                     open the permission table (text status outside TUI)
/sandbox on                  enable protection for operations started from now on
/sandbox off                 turn protection off for this session (interactive confirmation)
/sandbox default on          persist opt-in and enable it now
/sandbox default off         persist opt-out (interactive confirmation)
/sandbox deny list           show the write-denied paths
/sandbox deny add <path>     stop allowing writes to a path
/sandbox deny remove <path>  allow writes to a path again
/sandbox deny reset          drop your changes and restore the packaged defaults
/sandbox rules               open the write-denied paths editor
```

The footer shows `sandbox · available` when a backend is available but inactive,
`sandbox · inactive` when inactive without a backend, and
`sandbox · on · <project>` while protection is active. Explicitly enabled
sessions report `UNAVAILABLE` or `FAILED` when protection cannot be applied.
Both surfaces report what the runtime actually resolved — which backend, which
executable — never what was merely configured.

`/sandbox off` and `/sandbox default off` need interactive confirmation and are
refused outright when there is no interactive UI. There is no tool for changing
sandbox state or its rules, so the model cannot change confinement or edit the
paths it is confined away from.

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

The foreground sandbox is inactive by default. Session overrides do not survive
startup, new session, resume, fork, or reload. Save as defaults writes both
profiles to `~/.pi/agent/extensions/pi-better-sandbox-permissions.json` (or the
corresponding `$PI_CODING_AGENT_DIR`). Existing activation preferences in
`pi-better-sandbox-preferences.json` migrate when no profile file exists.
`/sandbox default on|off` remains available and updates Main's saved switch.

Toggles apply to operations launched after the change. A command already running
keeps the policy it launched with.

## Fail-closed behaviour

While the sandbox is explicitly or persistently enabled and a backend cannot be
applied, protected commands and file mutations are **blocked** rather than run
unprotected:

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

A detached subagent gets a private session/temp directory for Pi's runtime
state. This directory stays writable even with Outside project set to Read or
Off; other runs' state and the parent's launch metadata are not included.
Read access to system executable and library directories, device I/O, and root
directory metadata/listing remains available so a process can start. On macOS,
the allowance excludes the broad `/System/Volumes` tree.

Linux currently refuses combinations it cannot safely mount: hiding the
project or credential files inside a visible whole-filesystem bind, writing
credential stores under a read-only outside root, and a writable outside root
with protected paths. These launch errors preserve the selected restrictions.
The macOS permission combinations are covered by real-kernel tests; Linux
mount behavior requires a Linux runner with Bubblewrap and user namespaces.

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
