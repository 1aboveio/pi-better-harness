---
status: accepted
date: 2026-10-30
---

# Skills consume one agent catalog across hosts

Session `01a18b68-24da-78c2-a297-8a5f2d198400` launched implementation workers
using the skill's GPT recommendation rather than the personal Developer role's
DeepSeek default. Calls supplied a run name and explicit model, but no role.
The launcher obeyed its precedence rules; duplicate selection policy bypassed
the user's definitions.

We keep role definitions, inheritance, and model resolution in pi-better-harness.
Skills choose worker responsibilities and explicit task overrides, not independent
model-ranking ladders. A standalone JSON worker-plan CLI and portable TypeScript
API let Pi and Codex consume the same catalog without requiring a Pi session.

This extends ADR 0003's local catalog boundary with host adapters. It does not
change the stored `pi-agent/v1` schema, source precedence, or Pi launch semantics.
The model-resolution core no longer imports Pi. The existing Pi entrypoint wraps
it with Pi's effort-support helper; other hosts supply their actual capabilities.

Canonical model identities remain provider-qualified. Non-Pi native identifiers
require explicit mapping and verified model, effort, and instruction controls.
Host preferences may override role defaults without copying role instructions.
Task choices win over host preferences. Unsupported explicit choices block.
Codex does not inherit Pi's foreground fallback unless explicitly configured.

Default Pi launch payloads select the role and omit model/effort, so saved and
branch-local defaults remain effective. The live launcher is authoritative; the
CLI does not claim to observe Pi's in-memory session preferences. Non-Pi adapters
must apply resolved instructions and preferences through actual host controls,
never through a prompt-only model declaration.

Every workflow preflight retains one snapshot, records selection provenance, and
requires distinct implementation and review models. A blocked preflight returns
no executable worker payloads. Runtime launch permissions, trust, provider
initialization, and post-start failure handling remain host responsibilities.

Rejected: synchronizing a second skill catalog, hard-coding provider substitutions,
or making Codex skills call Pi workers implicitly. Those approaches either retain
the duplicated policy or change the execution host without user authorization.