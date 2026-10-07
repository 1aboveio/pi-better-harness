# pi-better-harness

<img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/brand/logo.png" alt="Pi Better Harness logo" width="128" height="128" />

`pi-better-harness` is a Pi meta package that installs the core Pi Better Harness extensions: an opt-in foreground write sandbox, delegated subagents, durable background tasks, synchronous SSH commands, goal tracking, and structured plans.

## Quick Answer

Use `pi-better-harness` when you want the full working set for Pi. It manages:

- `pi-better-sandbox` for an opt-in write sandbox around Pi's foreground tools.
- `pi-better-subagents` for detached, sandboxed subagent runs.
- `pi-better-background-tasks` for durable shell tasks and watchers.
- `pi-better-ssh` for short remote commands over reusable SSH connections.
- `pi-better-goal` for objective tracking that is aware of background work.
- `pi-better-plan` for persistent structured plans and explicit checklist progress.

`pi-better-read-aloud` is intentionally not included yet.

## Screenshots

<p><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/pi-better-harness.png" alt="pi-better-harness rendered in Pi" width="49%" /><img src="https://raw.githubusercontent.com/1aboveio/pi-better-harness/main/docs/images/package-gallery/overview/pi-better-harness.png" alt="pi-better-harness package overview" width="49%" /></p>

## Install

Install the extensions as standalone Pi packages, so Pi displays and manages each by its own package name:

```sh
npx pi-better-harness install
```

For project-local Pi settings:

```sh
npx pi-better-harness install --local
```

The bundled installation remains available for compatibility:

```sh
pi install npm:pi-better-harness
```

## Ordinary Startup

You keep launching Pi the way you always have:

```sh
pi
```

The foreground write sandbox starts inactive. Use `/sandbox on` for the current
session or `/sandbox default on` to persist opt-in across startup, new session,
resume, fork, and reload. There is no launcher.

While it is on, Pi's built-in `bash`, `write`, and `edit` tools, your own `!` / `!!` commands, local background tasks, and subagents can write only under the directory you launched Pi from, minus the packaged deny paths (`.git/hooks`, `.env`, `.env.local`).

**Reads and network access are unrestricted** — this sandbox limits writes only. Writes are confined for those integrated first-party execution paths; Pi's own process, arbitrary `pi.exec` calls, and unrelated third-party extension code are **not** confined. Confinement is also **per surface**: each integrated surface denies its own control plane, not every other surface's, so with several first-party surfaces installed a confined process on one can still write another's control plane.

Sandbox state is human-only: `/sandbox`, `/sandbox on`, `/sandbox off`,
`/sandbox default on|off`, `/sandbox deny ...`, and `/sandbox rules` are slash
commands with no tool equivalent. `/sandbox off` and `/sandbox default off`
need interactive confirmation. Full policy: [pi-better-sandbox](https://github.com/1aboveio/pi-better-harness/tree/main/packages/pi-better-sandbox#readme).

## Minimal Tool Output

The bundled harness provides **Tool output: Normal / Minimal** in
`/harness-settings`. `/tool-output minimal`, `/tool-output normal`, and
`/tool-output` (toggle) remain compatibility shortcuts to the same preference.
Minimal mode folds each tool call into a single-line header, including running
calls. Each row has a single tool-specific icon: accent-colored while running,
muted when completed, and error-colored when failed. Tool names stay muted;
inline command/path arguments use the theme's distinct dim tone. Running and
failed calls retain text labels so state never depends on color alone. Activity
stays quieter than conversation text. Tool rows are indented two columns past
the assistant text padding. Long
headers are truncated to the terminal width; result bodies,
images, boxes, and tool spacers are hidden. Built-in, extension, and MCP calls
are included. Execution, sandboxing, and agent-facing payloads are unchanged.
When a foreground run ends, each consecutive block of tool calls folds further
into one disclosure row showing the call count and any failures. Only the failure
count uses the error color; the disclosure and total stay muted. Assistant text
stays visible, and restored history uses the same folded view. In newer Pi
fullscreen mode, click a block disclosure to reveal its call rows, then click a
call to expand its original details. Hover highlights compact call and disclosure
rows using the selection background (reverse video for themes without one), and
tool icons sit centered in a three-column gutter. Click the disclosure again to refold the
block; native expanded call/result clicks collapse individual details. Regular
terminals keep mouse input for terminal selection and scrollback; Ctrl+O expands
all original tool details in both modes and folds them again on the next toggle.
`/tool-output normal` restores ordinary rendering. Error result bodies are also
hidden in minimal mode and remain available when expanded.

Normal mode is the initial default. Changing tool output saves the choice in
global `settings.json` under `piBetterHarness.toolOutput`, as well as the current
session. New sessions inherit it; resumed branches retain their own saved choice.
This is a version-sensitive internal TUI adapter,
tested with Pi 0.82.1, 0.99.1, and the bundled Pi 1.0.0 CLI; incompatible APIs
produce a warning and leave ordinary output enabled. Print/RPC output and
exported transcripts are unchanged.

The standalone-package installer does not install this bundled extension.
Load the bundled harness or run it directly from a checkout:

```sh
pi -e ./packages/pi-better-harness/extensions/minimal-output/index.ts
```

## Harness Settings

The bundled harness provides `/harness-settings`, using Pi's native settings
list. It opens the settings screens of loaded Sandbox, Subagents, and Goal
packages without duplicating their configuration. `/sandbox`, `/subagents
settings`, and `/goal settings` remain available in standalone installations.
Packages without a settings screen are not listed. Pi's `/settings` is unchanged.

The hub includes **Tool output** when the bundled renderer extension is loaded.
Changes apply immediately and also save the default for future sessions.
The hub also owns **Completions while busy**, shared by Subagents and Background
Tasks. Choose **Wait until idle** (the default) or **Steer active run**. Changes
apply immediately and autosave to the current session branch, including across
reloads. Press **Ctrl+S** to save the current choice as your default for future
Pi sessions; changing a session afterward does not change that saved default.
Saving a default leaves already-open sessions unchanged, including when
navigating to a branch without a session override.
The user default is stored in
`<agent-dir>/settings.json` under `piBetterHarness.callbacks` and also applies
when either callback package is loaded standalone. The former
`PI_BETTER_CALLBACK_WHILE_BUSY` environment variable is no longer supported.

All Harness-owned defaults use the `piBetterHarness` section of global
`~/.pi/agent/settings.json` (or `PI_CODING_AGENT_DIR/settings.json`): tool output,
Subagents configuration, callback delivery, Goal controls, and Sandbox activation,
permissions, and deny-rule templates. Existing preference files migrate on first
use after validation; global choices take precedence, and old files remain intact.
Updates preserve Pi's own settings and other packages' choices. SSH profiles,
plans, run records, and role/agent definitions remain in their existing stores:
they are session data or reusable definitions, not global UI defaults.

Next-prompt inference is deferred pending safe public auth/header resolution in
Pi's SDK. It is not loaded by the bundle, has no toggle or preference store in
this version, and makes no auxiliary model requests. The integration blocker is
[issue #426](https://github.com/1aboveio/pi-better-harness/issues/426).

The hub is TUI-only. The standalone-package installer does not install
Harness-only extensions; load the bundle or the settings extension from the
checkout to use the hub:

```sh
pi -e ./packages/pi-better-harness/extensions/settings/index.ts
```

## When To Use

Use the installer when you want every core extension with standalone package identities. Install an individual package instead when you only need the sandbox, subagents, shell task supervision, synchronous SSH, goal tracking, or plans.

## Compatibility

| Requirement | Support |
|-------------|---------|
| Pi | Required |
| Recommended install | `npx pi-better-harness install` |
| Write sandbox on macOS | Seatbelt (`sandbox-exec`), ships with the OS |
| Write sandbox on Linux | Bubblewrap — install `bubblewrap` |
| Development runtime | Node.js 22+ |

## Update Or Remove

Remove every standalone package:

```sh
npx pi-better-harness uninstall
```

Add `--local` to remove them from project-local settings.

## More Detail

- Repository: https://github.com/1aboveio/pi-better-harness
- Detailed notes: https://github.com/1aboveio/pi-better-harness/blob/main/packages/pi-better-harness/docs/usage.md
- License: https://github.com/1aboveio/pi-better-harness/blob/main/LICENSE
