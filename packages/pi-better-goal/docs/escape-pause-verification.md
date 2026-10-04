# Escape Pause Verification

## Change

Idle/between-turn Escape previously had no turn abort to observe. The TUI now
observes Escape with `ctx.ui.onTerminalInput`, reuses the interrupt pause path,
and returns `undefined` so Pi receives the original key. No reserved shortcut
is registered or overridden. Goal preference defaults are unchanged.

## Verified

- `npm --ignore-scripts run verify --workspace packages/pi-better-goal` passed
  typechecking and all 102 package tests. Lifecycle scripts were disabled because
  the package pretest regenerates shared modules outside this change's scope.
- Four focused observer tests failed before implementation and passed afterward.
  They exercise idle pause, stopped active-time accounting, cancellation of a
  scheduled continuation, unchanged Escape passthrough, ordinary questions not
  resuming the goal, key-release/paste/modifier filtering, modal/menu ownership,
  no goal, existing manual/interrupt pauses, completed goals, and observer
  replacement/shutdown/non-TUI behavior.
- The in-flight provider audit test also covers Escape: resolving an obsolete
  audit after the pause cannot enqueue a continuation. Existing signal-abort,
  aborted-message, manual-pause, resume-tool/hotkey, and preference tests passed.
- `node --test scripts/goal-pause.tui.e2e.test.mjs` passed using real Pi 0.84.4
  in an isolated tmux server and a scripted provider. The journey interrupts a
  long stream, answers a question without resuming, resumes through
  `goal_resume`, completes, then pauses an idle goal after `/reload`. It also
  cancels completion menus, built-in settings, goal settings, and a confirm
  dialog without pausing the active goal.
- The same TUI journey passed on the installed Pi 1.0.0 using its matching AI
  fixture API:

  ```sh
  PI_GOAL_PAUSE_HOST_CLI=/Users/exoulster/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  PI_GOAL_PAUSE_AI_ENTRY=/Users/exoulster/node_modules/@earendil-works/pi-ai/dist/index.js \
  node --test scripts/goal-pause.tui.e2e.test.mjs
  ```

- Test-quality lint over the two touched test files reported zero gate findings.
  Its leads were existing retry-count assertions and the executable fixture's
  source path; they do not indicate text-only coverage of this change.

## Scope

The idle observer requires public focused-component inspection and a main editor
exposing `CustomEditor.onEscape` and `isShowingAutocomplete`. Blocking UI prompts,
completion menus, non-editor focus, unknown custom editors, and visible overlays
retain Escape ownership. Older hosts without focused-component inspection retain
the existing running-turn abort fallback. An actual turn abort still pauses an
active goal, even if caused through a dialog or another non-keyboard path.

No commits, preference-default changes, sandbox changes, or inventory changes
were made.

## Pause On Esc Follow-Up

The preceding sections record the original Escape observer implementation.
This follow-up adds persisted `pauseOnEscape: boolean` without changing its
default behavior: absent files and older version-1 preferences default to true.
The settings page has an independent **Pause on Esc** row; text commands and
completions accept `/goal settings pause-on-escape on|off`. `/goal`, `get_goal`,
and non-TUI settings inspection report its value.

When Off, idle editor Escape leaves the goal active and its pending wake intact.
Streaming editor Escape still reaches Pi unchanged and interrupts the stream,
but its observed session/run/execution generation exempts both the associated
abort signal and aborted `agent_end` from goal pausing. The exemption expires
after the run and cannot carry across goal replacement or session changes.
Unrelated interrupts, manual pauses, command/workflow safety pauses, native
menu/dialog cancellation, and the other settings retain their behavior.
Obsolete turn/session signal callbacks cannot act on a later run; late aborts
of the current run still cancel pending between-turn wakes.

### Verification

- `npm --ignore-scripts run verify -w packages/pi-better-goal` passed typechecking
  and all 114 package tests. Ignoring lifecycle scripts avoids generated shared
  module changes. Focused coverage includes preference migration, validation,
  persistence, independent settings, Off/On toggling, idle Off with automatic
  continuation, streaming Escape followed by signal abort and aborted
  `agent_end`, unrelated aborts, generation boundaries, and modal ownership.
- `node --test scripts/goal-pause.tui.e2e.test.mjs` passed on real Pi 0.84.4.
  The journey toggles the new row, confirms idle Off stays active, toggles On
  and pauses, and verifies streaming Off yields an actual aborted assistant
  message while the goal remains active. Existing discussion/resume, reload,
  completion-menu, settings-screen, and confirm-dialog checks also passed.
- The same journey passed on installed Pi 1.0.0 with the explicit host/AI paths
  shown above. Both runs used temporary agent preferences, session files, a
  scripted provider, and a private tmux server; cleanup runs after the test.
- Test-quality lint over the three package test files and TUI journey reported
  zero gate findings. Four leads concern existing retry-count checks and the
  executable extension fixture path, not new source-text assertions.
- `git diff --check -- packages/pi-better-goal scripts/goal-pause.tui.e2e.test.mjs`
  passed.

### Compatibility And Scope

Off requires terminal observation and public focused-component inspection of a
standard editor. Non-TUI modes, older hosts missing those APIs, and unknown
custom editors cannot reliably attribute an abort to Escape; their generic
abort fallback still pauses even with Off. Visible overlays and menus retain
key ownership and never create an Escape exemption for an unrelated abort.

Only `packages/pi-better-goal/**` and `scripts/goal-pause.tui.e2e.test.mjs` were
edited. Predecessor Escape work was retained. No commits, generated changes,
sandbox/inventory changes, Android actions, or real user preference changes
were made.
