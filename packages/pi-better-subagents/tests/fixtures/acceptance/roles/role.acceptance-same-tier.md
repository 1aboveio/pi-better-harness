---
schema: pi-agent/v1
kind: role
id: role.acceptance-same-tier
name: Acceptance Same Tier
description: Preferred model is unavailable. Same-tier policy may replace it.
defaults:
  model: openai/gpt-6-missing
  effort: low
  tier: balanced
---
Reply with the single word DONE.
