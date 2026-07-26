# Product

## Register

product

## Users

Agent operators running Pi in a terminal. They delegate work to autonomous subagents, keep their foreground session moving, and need to monitor, inspect, and stop background runs without losing their place in the conversation.

## Product Purpose

pi-better-subagents makes subagent work autonomous, observable, and safe by default. The interface should make background work feel controllable: users can see what is running, spot unhealthy states, inspect detail, and take action without blocking the main agent flow.

## Brand Personality

Quiet, precise, operational. The product should feel like a focused command surface for expert users: calm under load, direct about state, and careful with attention.

## Anti-references

Do not let tool surfaces blend into chat transcript content. Avoid decorative terminal chrome, app-like ornament that fights the host TUI, and bare text dumps where selection, status, and detail sections are hard to scan.

## Design Principles

1. Preserve foreground flow. Navigation and inspection must support the running conversation, not interrupt it.
2. Separate tool surface from transcript. Subagent overlays should be immediately recognizable as operational UI, distinct from assistant output.
3. Make state legible without noise. Status, health, selection, and available actions should be scannable, with color as reinforcement rather than the only signal.
4. Prefer compact command-surface clarity. Use Raycast-like density: strong focus state, concise metadata, and restrained hierarchy.
5. Keep diagnostics actionable. Detail views should expose enough evidence to decide whether to wait, inspect, stop, or dismiss.

## Accessibility & Inclusion

Use a high-contrast baseline. Selection and status must remain clear without relying on color alone. Keep wording concise, avoid motion-dependent feedback, and respect the host terminal theme where possible.
