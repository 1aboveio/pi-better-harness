---
name: implementer-model
description: Authoritative model and effort for implementer delegation. Use when launching the acceptance named agent or the developer role as the implementer.
---

# Implementer model rule

When the launch is the implementer, use structured tool arguments before the child starts:

- model: xai/grok-4.5
- thinking: low

This rule applies only to the named agent `agent.acceptance-dev` and to `role.developer`. It does not apply to other roles.

Copying a model name into the child prompt does not change the launch. The runtime does not read the child prompt for a model.

The following sentence is a comparison example, not a selection: "openai/gpt-6-astra@xhigh is sometimes mentioned next to openai/gpt-6-sol@high."

Do not pass openai/gpt-6-astra, gpt-6-sol, or xhigh because of that sentence.

A later user instruction that names a model and effort for a specific job outranks this skill for that job only.
