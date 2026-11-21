# Product

<!-- impeccable:product-schema 1 -->

## Users

Pi users who delegate work or supervise long-running commands from a terminal session. They need to keep their foreground work moving, see which parallel tasks need attention, and inspect, pause, or stop work without losing their place in the conversation.

## Product Purpose

Pi Better Harness keeps the foreground session responsive while related work runs in parallel. Success means operators can tell what is running and what needs attention, see what happened, and decide how to proceed with the evidence at hand.

## Positioning

Harness brings separately installable Pi extensions into one work-management flow. The shared Navigator shows background tasks, subagents, and Goals in the active Pi session. Each supervised task keeps status, logs, and results available for inspection. [Package overview](README.md)

## Operating Context

The interactive interface runs inside Pi’s terminal UI. Operators launch a task or delegate work, continue in the foreground, and use the Navigator to inspect status, logs, and controls. `/harness-settings` exposes shared controls and opens the settings of loaded extensions. Goal tracks an explicit objective and can continue work as background results arrive. [Harness usage](packages/pi-better-harness/README.md)

People can install the full Harness or use individual Pi extensions. Commands and tool results also have headless use cases, while the Navigator and settings hub rely on the interactive host. [Installation and packages](README.md#install-the-whole-harness)

## Capabilities and Constraints

- Core capabilities include an opt-in foreground write sandbox, delegated subagents, durable background commands and watches, synchronous SSH commands, Goal continuation, and model routing. Outcome & Todo adds optional session and checklist tracking.
- A supervised wait has an observer and an owner. The observer reports evidence. The owner interprets it and decides whether to continue waiting or take action. [Observed wait ownership](docs/adr/0020-observed-waits-retain-an-owner.md)
- The Navigator supports inspecting and controlling tasks from the active conversation. Task status and recent evidence are available before an operator chooses an action.
- Pi provides the terminal theme, keyboard conventions, and extension capabilities. Keep settings and navigation consistent across extensions that share those surfaces.

## Brand Commitments

Compact, precise, composed. Use Raycast as a reference for dense, immediate, keyboard-first interaction and express those qualities through Pi’s terminal conventions. Use direct wording for statuses, settings, and actions. [Pi Better Harness logo](docs/images/brand/logo.png)

## Evidence on Hand

The package documentation records the available commands, settings, and workflows. The repository also includes a real Pi session capture and previews of package surfaces. [Harness usage](packages/pi-better-harness/README.md) · [Real Pi session capture](docs/images/package-gallery/real-session/pi-better-harness.png) · [Package previews](docs/images/package-gallery/)

## Product Principles

1. Keep the foreground session responsive while the operator monitors parallel work.
2. Show status, task identity, elapsed time, and the next available action before exposing detailed logs and process metadata.
3. Report sustained waits with elapsed time and the latest evidence so the owner can decide what to do next.
4. Make stop and other interrupting actions explicit. Confirm consequential actions and keep the interaction keyboard-friendly.
5. Give shared concepts consistent names and controls across the Navigator, settings, and individual extensions.

## Accessibility & Inclusion

Support keyboard-only use and make focus visible. Use status text and grouping alongside semantic color. Target WCAG AA contrast where the host theme allows it. Keep state changes stable and predictable, and support reduced-motion preferences.
