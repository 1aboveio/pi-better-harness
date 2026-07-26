# Product

## Register

product

## Users

Pi users acting as agent operators. They launch background work from a coding-agent session, then need to quickly understand which tasks are running, finished, failed, timed out, or need attention without interrupting their current foreground work.

## Product Purpose

pi-better-background-tasks provides durable, nonblocking background task supervision for arbitrary commands and watchers. Its interface should make background work feel observable and controllable: tasks can be launched, monitored, inspected, stopped, and revisited through stable metadata and logs.

## Brand Personality

Quiet, precise, operational. The experience should feel native to Pi's terminal workflow, with enough structure to reduce cognitive load and enough restraint that it does not compete with the user's active coding task.

## Anti-references

Avoid dashboard-like decoration, marketing-style panels, oversized status treatments, modal-first flows, and invented controls that fight terminal expectations. The navigator should not feel like a separate app bolted onto Pi, and it should not make logs or operational status harder to scan for the sake of visual novelty.

## Design Principles

- Foreground stays first: background-task UI must help without stealing attention.
- Match subagent navigation where concepts align, so users learn one Pi background-work pattern.
- Make status legible without relying on color alone.
- Put live evidence close to the decision: task details should lead with status and recent logs.
- Preserve operational trust: actions like stop, dismiss, and inspect must be explicit, reversible where possible, and reflected immediately.

## Accessibility & Inclusion

Target a WCAG AA equivalent within terminal constraints. Use keyboard-only operation, stable layout, clear focus indication, redundant status text or symbols alongside color, restrained motion, and line shapes that remain readable across terminal themes.