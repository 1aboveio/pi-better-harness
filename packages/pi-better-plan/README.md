# pi-better-plan

`pi-better-plan` keeps a structured execution plan visible while Pi works.

## What It Does

- Gives models `update_plan` and `get_plan` tools for atomic, explicit progress updates.
- Shows the complete checklist of completed, active, pending, and blocked steps above the editor.
- Persists plan state and display preferences on the active Pi session branch.
- Opens the complete plan with `/plan`.

Plan progress is checklist progress, not an estimate of effort. The extension never infers completion from prose or successful tool calls.

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