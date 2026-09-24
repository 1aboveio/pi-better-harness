---
schema: pi-agent/v1
kind: role
id: role.acceptance-foreground
name: Acceptance Foreground
description: Preferred model is unavailable and the tier is not configured.
defaults:
  model: openai/gpt-6-missing
  effort: low
  tier: unmapped-acceptance
---
Reply with the single word DONE.
