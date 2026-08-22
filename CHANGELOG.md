# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [pi-better-harness@0.1.25] - 2026-08-22

### Changed

- **harness**: bundle goal 0.1.22 (multiline objective rail flattening)

## [pi-better-goal@0.1.22] - 2026-08-22

### Fixed

- **goal**: flatten multiline objectives on the above-editor rail so dock height stays stable and Working... / Elapsed no longer stack into scrollback

## [pi-better-harness@0.1.24] - 2026-08-21

### Changed

- **harness**: bundle background-tasks 0.2.5 (default `bg_task_log` tail 5 lines)

## [pi-better-background-tasks@0.2.5] - 2026-08-21

### Changed

- **background-tasks**: default `bg_task_log` / compact log tails to 5 lines instead of 20

## [pi-better-harness@0.1.23] - 2026-08-21

### Changed

- **harness**: bundle background-tasks 0.2.4 (SSH tmux probe MOTD hardening)

## [pi-better-background-tasks@0.2.4] - 2026-08-21

### Fixed

- **background-tasks**: parse remote tmux probe path/version via protocol markers so SSH login MOTD/banners cannot be mistaken for the tmux binary

## [pi-better-harness@0.1.22] - 2026-08-18

### Changed

- **harness**: bundle subagents 0.1.21 and background-tasks 0.2.3 (aligned focused background-work detail rendering)

## [pi-better-background-tasks@0.2.3] - 2026-08-18

### Fixed

- **background-tasks**: keep focused background-work detail rendering aligned with the main rail height by removing the duplicate detail footer above the persistent navigator

## [pi-better-subagents@0.1.21] - 2026-08-18

### Fixed

- **subagents**: keep focused background-work detail rendering aligned with the main rail height and show subagent transcripts as a latest-10-row tail by default, with `l` cycling to 25 rows

## [pi-better-harness@0.1.21] - 2026-08-17

### Changed

- **harness**: bundle subagents 0.1.20 and background-tasks 0.2.2 (quiet background-work navigator repainting)

## [pi-better-background-tasks@0.2.2] - 2026-08-17

### Fixed

- **background-tasks**: stop repainting the shared background-work rail for volatile elapsed/deadline-only updates, making terminal copy/paste stable while tasks run

## [pi-better-subagents@0.1.20] - 2026-08-17

### Fixed

- **subagents**: stop repainting the shared background-work rail for elapsed-only running updates and replace the animated running dot with a stable indicator

## [pi-better-harness@0.1.20] - 2026-08-17

### Changed

- **harness**: bundle background-tasks 0.2.1 (clearer SSH background-task schema guidance)

## [pi-better-background-tasks@0.2.1] - 2026-08-17

### Fixed

- **background-tasks**: make the structured SSH remote-task path explicit on the `ssh` and `remote` parameter schemas, steering agents away from hand-written outer `ssh` commands and toward tmux-backed remote spawns

## [pi-better-harness@0.1.19] - 2026-08-17

### Changed

- **harness**: bundle goal 0.1.21 (mid-stream `/goal` no longer stacks `Working...` / bash `Elapsed` into scrollback)

## [pi-better-goal@0.1.21] - 2026-08-17

### Fixed

- **goal**: stop `Working...` / bash `Elapsed` stacking when setting a goal mid-stream — mid-stream feedback uses footer status (not chat notify), skip replace confirm while busy, and force a full TUI redraw when the goal clock appears or disappears

## [pi-better-harness@0.1.18] - 2026-08-17

### Changed

- **harness**: bundle background-tasks 0.2.0 (SSH remote-task preset: structured ssh fields, tmux lifecycle, watch polls, resume/timeouts)

## [pi-better-background-tasks@0.2.0] - 2026-08-17

### Added

- **background-tasks**: first-class SSH remote-task preset — structured `ssh` / `remote` fields on spawn/watch, agent-safe argv (`BatchMode`, connect timeout, `-T`, shell:false), injectable fake remote runner for tests
- **background-tasks**: remote tmux bootstrap (probe / non-interactive package-manager install / fail-closed needs-user with copy-pasteable commands)
- **background-tasks**: SSH watch as direct one-shot remote polls with existing success/failure conditions
- **background-tasks**: SSH spawn defaults to durable remote tmux sessions with log capture and real remote stop (`tmux kill-session`); explicit `remote.session=direct` escape hatch with weak-stop warning
- **background-tasks**: resume after reload for tmux-backed and direct-watch remote tasks; `timeout_seconds` yields `timed_out` (including deadline-bounded supervision polls)
- **background-tasks**: Remote SSH usage docs and tool descriptions steering models to structured `ssh` fields

## [pi-better-harness@0.1.17] - 2026-08-14

### Changed

- **harness**: bundle goal 0.1.20 (the active goal pauses when a running turn is interrupted; the reserved `escape` shortcut conflict is gone), background-tasks 0.1.18, and subagents 0.1.19

## [pi-better-goal@0.1.20] - 2026-08-14

### Fixed

- **goal**: pause the active goal when a running turn is interrupted (escape / ctrl+c), replacing an `escape` shortcut that pi's reserved built-in `app.interrupt` always skipped

## [pi-better-harness@0.1.16] - 2026-08-14

### Changed

- **harness**: bundle goal 0.1.19, background-tasks 0.1.18, and subagents 0.1.19

## [pi-better-background-tasks@0.1.18] - 2026-08-14

### Fixed

- **background-tasks**: cancelled tasks record a durable callback suppression instead of queueing a completion follow-up, so an explicit stop never wakes the agent and stays silent across session restarts

## [pi-better-goal@0.1.19] - 2026-08-13

### Added

- **goal**: pause the active goal on `escape` (preserving the interrupt of a running agent turn) and never poke paused goals

## [pi-better-harness@0.1.15] - 2026-08-13

### Changed

- **harness**: bundle goal 0.1.19, background-tasks 0.1.17, and subagents 0.1.19

## [pi-better-subagents@0.1.19] - 2026-08-12

### Changed

- **subagents**: render bounded Pi-style structured transcripts and keep the shared navigator, input box, and full-height detail view stable while switching between the foreground and active subagents

## [pi-better-background-tasks@0.1.17] - 2026-08-12

### Changed

- **background-tasks**: use the persistent shared activity navigator with stable selection gutters and input geometry in detail views

## [pi-better-goal@0.1.18] - 2026-08-12

### Changed

- **goal**: align the goal clock with the flattened shared activity-rail section and row layout

## [pi-better-background-tasks@0.1.16] - 2026-08-11

### Changed

- **background-tasks**: batch completion callbacks into one bounded follow-up while preserving retry, session isolation, and urgent health notifications

## [pi-better-subagents@0.1.18] - 2026-08-11

### Changed

- **subagents**: batch completion callbacks across subagent and background-task sources while preserving durable retries and urgent health notifications

## [pi-better-subagents@0.1.17] - 2026-08-04

### Added

- **subagents**: show the foreground `main` agent above child runs with live model, effort, tool, context-token, status, and elapsed metadata

### Changed

- **subagents**: wrap detail tool-call logs at readable path and JSON boundaries instead of truncating long rows

## [pi-better-subagents@0.1.16] - 2026-08-04

### Fixed

- **subagents**: keep completion callbacks focused on outcome metadata while preserving full execution evidence in `subagent_result`

## [pi-better-background-tasks@0.1.15] - 2026-08-04

### Added

- **background-tasks**: report quiet and stalled running tasks from observable process output or completed watcher polls; stalled tasks remain advisory and never trigger automatic termination

## [pi-better-goal@0.1.17] - 2026-08-04

### Added

- **goal**: report observable goal progress and stalled state while preserving foreground and active-background exemptions

## [pi-better-subagents@0.1.15] - 2026-08-04

### Changed

- **subagents**: use shared observable-progress stall thresholds while preserving model, tool, compaction, and terminal health semantics

## [pi-better-goal@0.1.16] - 2026-08-04

### Fixed

- **goal**: bound self-sustaining continuation loops after repeated identical tool outcomes while preserving retries for changed evidence, interactive input, and background-drain events

## [pi-better-goal@0.1.15] - 2026-08-02

### Changed

- **goal**: establish package-scoped releases for the Goal spacing and 30-second completion-retention behavior

## [0.1.14] - 2026-08-02

### Fixed

- **goal**: keep equal spacing between Goal and navigator sections, and hide completed goals after the shared 30-second terminal retention window

## [0.1.13] - 2026-08-02

### Added

- **subagents**: configure child reasoning effort with `thinking` or a validated `model@effort` shorthand, including shared and per-job batch options

## [0.1.12] - 2026-08-02

### Added

- **subagents**: show a shared, rolling 10- or 25-row live log tail in the detail view while it is open

## [0.1.11] - 2026-07-31

### Added

- add `npx pi-better-harness install` and `uninstall` shortcuts for managing all three standalone component packages, with optional project-local scope

## [0.1.10] - 2026-07-31

### Changed

- expose clean harness extension entry points so Pi displays `pi-better-harness:subagents`, `pi-better-harness:background-tasks`, and `pi-better-harness:goal`

## [0.1.9] - 2026-07-31

### Fixed

- bundle the subagents, background-tasks, and goal extension entry points inside `pi-better-harness` so Pi can load all three from one install

## [0.1.8] - 2026-07-31

### Changed

- show both package-gallery images in every published package README ([#118](https://github.com/1aboveio/pi-better-harness/pull/118))

## [0.1.7] - 2026-07-31

### Added

- **background-tasks**: retain task logs within a bounded size and expose terminal-aware bounded log tails ([#114](https://github.com/1aboveio/pi-better-harness/pull/114))

### Changed

- **background-tasks**: expand task commands by default and limit evidence-tail controls to 10 or 25 rows ([#114](https://github.com/1aboveio/pi-better-harness/pull/114))
- **subagents**: share bounded raw log-tail reading with background tasks while preserving incremental lifecycle parsing ([#114](https://github.com/1aboveio/pi-better-harness/pull/114))

## [0.1.6] - 2026-07-30

### Changed

- **subagents**: fold parseRun incrementally instead of re-reading a tail ([#110](https://github.com/1aboveio/pi-better-harness/pull/110))

### Fixed

- **subagents**: read run logs incrementally on the UI hot path ([#100](https://github.com/1aboveio/pi-better-harness/pull/100))
- clean up subagent runtime ownership ([#102](https://github.com/1aboveio/pi-better-harness/pull/102))
- **subagents**: bound the run registry by size, and scan it once per rebuild ([#104](https://github.com/1aboveio/pi-better-harness/pull/104))
- **subagents**: reconcile runs whose spawning pi is gone ([#106](https://github.com/1aboveio/pi-better-harness/pull/106))