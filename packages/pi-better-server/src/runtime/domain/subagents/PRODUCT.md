# Product

<!-- impeccable:product-schema 1 -->

## Platform

terminal (Pi TUI extension; not a web or native mobile app)

## Users

Agent operators running Pi in a terminal. They delegate work to autonomous subagents, keep their foreground session moving, and need to monitor, inspect, and stop background runs without losing their place in the conversation.

## Product Purpose

pi-better-subagents makes subagent work autonomous, observable, and safe by default. Success means operators can see what is running, spot unhealthy states, inspect evidence, and take action without blocking the foreground session.

## Positioning

Detached subagent runs share a durable lifecycle with logs and results, while a reusable role and named-agent catalog resolves live inheritance into a launch snapshot. The catalog does not grant tools or permissions; those remain explicit spawn controls.

## Operating Context

Operators work inside Pi's terminal conversation. `/agents` discovers and inspects reusable definitions, then `subagent_spawn` or `subagent_spawn_batch` launches work. The shared background-work navigator surfaces live runs, detail, health, and stop or dismiss actions alongside other work providers. Print, JSON, and RPC callers also use the command and tool results without the TUI overlay.

## Capabilities and Constraints

- A named agent has one base role; its effective instructions combine role and agent text in add mode or use the agent text in replace mode. Model, effort, and tier can inherit or be overridden.
- Project, personal, and bundled definitions have explicit precedence. A fresh catalog read precedes launch; each batch uses one snapshot.
- Definition validity is not launchability. Model availability, unsupported restrictions, and sandbox or tool controls must be reported without implying permissions the catalog does not grant.
- The run navigator is shared with other background-work providers. Catalog UI must preserve headless results and avoid persistent transcript-sized widgets.

## Brand Commitments

Quiet, precise, operational language. The command surface must remain distinct from chat transcript content and respect the host terminal theme. Avoid ornamental terminal chrome or status conveyed only by color.

## Evidence on Hand

The implemented command and run surfaces, catalog schema and operations documentation, accepted catalog ADR, and test fixtures in this package are the source of product behavior. No customer claims, performance benchmarks, or external visual assets are supplied.

## Product Principles

1. Preserve foreground flow while background work remains inspectable and controllable.
2. Make identity, inheritance, launchability, and run health legible before deeper diagnostics.
3. Separate reusable agent definitions from individual run identity and evidence.
4. Keep actions explicit and consequential stop or replace paths confirmable.

## Accessibility & Inclusion

Use a high-contrast baseline. Selection and status must remain clear without relying on color alone. Keep wording concise, avoid motion-dependent feedback, and respect the host terminal theme where possible.
