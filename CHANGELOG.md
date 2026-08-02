# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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