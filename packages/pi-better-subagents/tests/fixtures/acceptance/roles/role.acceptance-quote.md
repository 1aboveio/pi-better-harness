---
schema: pi-agent/v1
kind: role
id: role.acceptance-quote
name: Acceptance Quote
description: Direct role whose default must survive a quoted model comparison.
defaults:
  model: xai/grok-4.3
  effort: low
  tier: efficient
---
Reply with the single word DONE.
