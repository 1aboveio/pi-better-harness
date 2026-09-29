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

Project files                     -                Write & delete
Outside project                   -                Write
Stored credentials                -                Read
Run commands & applications       -                On
Network access                    -                On

  Subagents · Tools
    Guarded (follows the file rules)
    [x] apply_patch  harness adapter
    Trusted (runs outside the file rules)
    [x] web_fetch    @juicesharp/rpiv-web-tools · needs Network On
    [x] web_search   @juicesharp/rpiv-web-tools · needs Network On
    [ ] <other installed tool>  <its package>

↑↓ Select row   ←→ Select column   Space Change
Save as defaults
```

**Subagents · Tools** picks the extension tools a confined subagent may use:

- **Guarded** tools go through the same guarded file operations as `write` and
  `edit`, so the rows above govern them. `apply_patch` applies Codex-style
  patches; deletes and moves follow the removal rules, and a patch is checked in
  full before any file changes.
- **Trusted** tools are the other tools your Pi has loaded, listed with their
  package. A ticked one is loaded into the subagent and runs in its Pi process,
  **outside the file rules**. Ticking one needs a second Space. It is admitted
  only from the package you ticked. Known network tool names are refused while
  Network access is Off: `web_fetch`, `web_search`, `firecrawl_scrape`, `firecrawl_extract`, `mcp`, `mcpScript`, `remote_bash`, and any `mcp__*` name. That is a name list, not a network sandbox.

Defaults: `apply_patch`, `web_fetch`, and `web_search` on; everything else off.
See [ADR 0009](../../docs/adr/0009-guarded-and-trusted-subagent-tools.md).

Project files and Outside project cycle through four levels:

| Level | Meaning |
| ----- | ------- |
| Off | No access. |
| Read | Read only. |
| Write | Read, create, and overwrite in place. Nothing can be removed or renamed away. |
| Write & delete | Full access, including removal. This was called "Read / write"; saved settings keep it. |

Whatever these rows say, removal is always allowed in **temp**, **hidden
directories and files directly under your home** (`~/.cache`, `~/.gradle`,
`~/.npm`, …), and **git worktree folders** (`.worktrees/`, `*-worktrees/`). The
deny list below still wins there.

**Write blocks rename-based saves.** The kernel treats "rename a temp file over
an existing file" as removing that file. Under Write, git commits and editors or
package managers that save atomically fail outside those disposable places. Pi's
own `write` and `edit` tools write in place and keep working. Choose Write &
delete for a place where that matters. The table shows this hint when you
select the row.

**Outside project = Write** (the Subagents default) lets tasks write across your
home directory and temp, so tool caches just work with no per-tool setup. It
retains fixed protections that are not configurable per tool:

- **Credentials** follow the independent Stored credentials row. The default
  `Read` setting exposes the files listed below plus `~/Library/Keychains`,
  `~/.claude/.credentials.json`, `~/.claude.json`, `~/.gnupg`,
  `~/.codex/auth.json`, `~/.cargo/credentials(.toml)`, `~/.pgpass`, and
  `~/.config/rclone` to confined subagents, while denying writes. Set the row to
  Off to hide them or Read / write when a CLI must refresh credential state.
- **Code that runs later** cannot be written, removed, or renamed: shell startup
  files (`.bashrc`, `.zshrc`, `.profile`, and the rest), `~/.config/fish`,
  `~/.gitconfig`, `~/.config/git`, `~/.config/systemd/user`,
  `~/.config/autostart`, `~/.pi` (or `$PI_CODING_AGENT_DIR`), `~/.claude`,
  `~/.agents`, `~/Library/LaunchAgents`, `~/.local/bin`, `~/bin`,
  `~/.git-templates`, `~/.oh-my-zsh/custom`, `~/.gradle/init.d`,
  and `~/.cargo/config(.toml)`. These stay readable, because subagents read skills from them.
  Their parent folders can't be removed or renamed either, so you can clean
  inside `~/.gradle` but not delete `~/.gradle` itself.
- **Harness state** (the subagent and background-task registries, run and
  control directories, and task-runtime provenance) cannot be written, removed,
  or renamed.

Every entry is protected under the literal path under home, every symlink hop
on the way to its target, and the target itself. So a dotfiles manager's links
(stow, chezmoi), including chains of links, can't be swapped or retargeted. A
link whose target is missing protects that target too: it can't be created.

**Git config and hooks under home are not protected**, so git keeps working:
`git init`, `git clone` and `git worktree add` copy hook samples into `.git/hooks`.
A task can therefore plant code that a later git command runs, through any
repository's `.git/hooks` or `.git/config` (`core.hooksPath`, `core.fsmonitor`,
`diff.external`, filters, aliases), submodule hooks in `.git/modules/*/hooks`,
`gitdir:` redirects, or files that `~/.gitconfig` pulls in with `[include]`.
`~/.gitconfig`, `~/.config/git`, and `~/.git-templates` themselves stay protected. Add your own paths to the deny list with `/sandbox deny add <path>`. Under
Write, those paths are also protected from removal and renaming.

A looser value (a higher level, a capability switched on, or a sandbox switched
off) takes effect only on a second Space, and saving looser defaults needs a
second Enter. Each prompt lists what would loosen. No model
tool can change these settings. Other rows toggle Off/On. Detail cells under an
Off sandbox display a dimmed `-` and cannot be changed; their values return when
the sandbox is enabled again.

### Platforms

| | macOS (Seatbelt) | Linux (Bubblewrap) | Windows |
| - | - | - | - |
| Outside project = Write | Writes across home and temp. Removal and renaming refused outside the disposable places. | Fallback: ordinary top-level home folders (`~/projects`, `~/Documents`, …) and home itself are **read-only**. Dot entries, temp, worktree folders (found within three levels of home), and the workspace are writable, removal included. A directory holding a protected symlink (typically `~/.config` with a stow link such as `~/.config/git`) keeps its existing entries writable but refuses new top-level entries. A protected symlink pointing at nothing can get an empty read-only placeholder that stays on disk; the launch says so, and you remove the placeholder before creating the real target. | No backend: confined launches fail closed. |
| Project files = Write | Enforced. | **Refused at launch** (bind mounts cannot separate removal from writing). Use Write & delete or Read. | No backend. |
| Deny list | Path rules, matched ignoring case on every volume (as Seatbelt does). | Credentials masked by empty mode-000 mounts. Code that runs later is bound read-only. | No backend. |

Linux could separate removal from writing with Landlock (5.19+), but nothing
here can apply it: Node has no binding and `bwrap` does not expose it. Windows
could use NTFS `DELETE` rights with a restricted token or AppContainer, which
would need a native launcher. Both are tracked as follow-ups; see
[ADR 0008](../../docs/adr/0008-write-without-delete.md).

### Recovery snapshot (macOS)

When a confined subagent or background task starts with Outside project =
Write or Write & delete, the harness starts `tmutil localsnapshot` in the
background. That is an APFS local snapshot and needs no administrator rights.
Write can still empty or re-permission files in place, and Write & delete can
remove them. It takes at most one per 15 minutes per Pi process. The run never
waits for it. A failure shows as a warning (subagents) or a task-log line
(background tasks). Set `PI_SANDBOX_RECOVERY_SNAPSHOT=off` to turn it off.

Local snapshots are purgeable, so treat them as a recovery aid, not a backup.
The Seatbelt profile leaves Mach IPC to system daemons open, which is why
`security` and `tmutil` work inside the sandbox. It also means a hostile task
could likely delete these snapshots. Restore from one with Time Machine or
`tmutil restore`.

**Stored credentials currently means known credential files.** It covers SSH,
AWS, GitHub CLI, Google Cloud CLI, Azure, Kubernetes, Docker, npm, netrc, Git
credentials, and Pi's file-based auth. These rules override ordinary file access.
OS vault services such as Keychain and Secret Service, and tokens inherited in
environment variables, are excluded. Read / write may be needed by a CLI that
refreshes a token or updates its credential database. This row applies
independently of Project files and Outside project.

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
and `bash`, plus, for Subagents, the guarded `apply_patch` and the trusted tools
ticked under Subagents · Tools. User-entered `!` and `!!` commands use the same
shell policy. Other model-callable tools require a verified execution adapter
and are refused while that actor's sandbox is enabled; enabling network alone
does not admit them. Subagent launch output identifies requested tools that are
unavailable, with the reason. Main
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

### Upgrading

Nothing is migrated on disk. A saved `pi-better-sandbox-permissions.json` keeps
its values: a saved `read-write` is now shown as Write & delete, and a saved
Subagents Outside project = Read stays Read. Only a fresh configuration, or
**Save as defaults** after you choose Write, uses the new Subagents default. To
adopt it, open `/sandbox`, set Subagents → Outside project to Write, and save.

`~/.pi/agent/sandbox.json` (`filesystem.allowWrite`, `allowRead`,
`network.allowedDomains`) is the format of Pi's example sandbox extension. This
package never reads it, and it has no effect on the harness.

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
credential stores under a read-only outside root, a writable outside root
(Write & delete) with protected paths, and Project files = Write. These launch errors preserve the selected restrictions.
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
