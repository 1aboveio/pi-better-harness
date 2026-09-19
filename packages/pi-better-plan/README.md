# pi-better-plan

`pi-better-plan` keeps a structured execution plan visible while Pi works.

## What It Does

- Gives models `update_plan` and `get_plan` tools for atomic, explicit progress updates.
- Shows the complete checklist of completed, active, pending, and blocked steps above the editor.
- Persists plan state and display preferences on the active Pi session branch.
- Keeps a completed plan visible for 30 seconds, then clears it automatically.
- Opens the complete plan with `/plan`.

Plan progress is checklist progress, not an estimate of effort. The extension never infers completion from prose or successful tool calls.

## Coordinating Delegated Work

Use the plan as the foreground coordinator's milestone ledger. Delegate independent, sufficiently substantial work early with subagents, and use background tasks for long-running processes or repeated checks. Keep doing unblocked foreground work after launch; do not poll workers.

Before the first implementation milestone, check for an independent task that can run alongside foreground work. Launch a bounded subagent task when available; otherwise state the specific dependency or shared-worktree constraint that rules delegation out. The plan records milestones, not worker scheduling.

Independent foreground and delegated milestones may both be `in_progress`. Use steps for distinct deliverables, not individual worker processes; worker tools and the background-work navigator own run status. Complete verification and the plan only after every relevant delegated task is terminal and its result or failure has been inspected and integrated.

## Install

```sh
pi install npm:pi-better-plan
```

## Commands

```text
/plan
/plan clear
/plan hide
/plan show
/plan pin auto
/plan pin on
/plan pin off
```

`pin auto` and `pin on` currently use the compact widget until Pi exposes a reserved right-rail extension interface. A floating overlay is intentionally not used as a substitute because it would cover transcript content.

## Development

```sh
npm run verify
```