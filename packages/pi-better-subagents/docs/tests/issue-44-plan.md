# Issue #44 — Incremental plan (implement-and-pr step 4)

Unit: #44 Add durable navigator visibility and shared stop semantics
Branch: issue-44-navigator-visibility-stop (rebased on origin/main @ 7ba67e9)
TDD: yes (AC-backed). RED first per slice, then GREEN.

## Slice map (AC → slice → surface → level)

| AC | Slice | Surface (@covers) | Level |
|----|-------|-------------------|-------|
| AC1 durable dismissal timestamp, no migration | S1: `dismissedAt?` on RunMeta + `dismissRun(id)` in registry.ts | registry.dismissal | unit |
| AC2 visible navigator runs = current-parent, not dismissed | S2: `navigatorVisibleRuns(metas, parentPid)` pure helper | registry.navigator-visibility | unit |
| AC3 dismissed excluded from visibility calc + footer count | S2 (+ `navigatorVisibleCount` footer-count seam) | registry.navigator-visibility | unit |
| AC4 dismissed runs still accessible by ID (output/result/stop) | S3: readMeta/listMetas return dismissed runs; stopRun works on dismissed running run | registry.dismissal, stop.shared | unit |
| AC5 subagent_list unchanged (no hiding) | S3: listMetas includes dismissed runs (registry-level pin) | registry.dismissal | unit |
| AC6 shared stop for tool + future navigator close | S4: new `stop.ts` `stopRun(id)`; `subagent_stop` refactored to use it | stop.shared | unit |
| AC7 stop rereads effective status before acting | S4: stopRun reads meta fresh + effectiveStatus; stale-running/dead-pid test | stop.shared | unit |
| AC8 tests | tests/navigator_dismissal.test.mjs | all above | unit |
| Fix round (reviewer finding): AC4/AC5 pinned only at registry level | S5: extract tool definitions to `tools.ts` factories; index.ts registers the exact factory objects; tests invoke the registered handlers against dismissed runs | tools.model-facing | unit |

## Notes

- Footer/overlay UI does NOT exist yet (#45–#48); #44 ships the registry + stop
  seams (`navigatorVisibleRuns` / `navigatorVisibleCount` / `dismissRun` /
  `stopRun`) those units consume. Footer count = `navigatorVisibleCount`.
- Tool compatibility (AC4) for output/result holds by construction (they look
  up by id via readMeta and never filter dismissal); after the S5 fix round it
  is pinned at the REGISTERED-handler level (the exact execute functions
  pi.registerTool receives), not just via readMeta/stopRun.
- stopRun tests use a real detached `sleep` process (external OS process; no
  mock of internal seams).
- Characterization: tool-handler behavior pinned by the relocated logic
  landing verbatim in `tools.ts` + handler-level tests; reply text preserved.
- Browser/E2E: N/A (pi extension, no bootable browser app).
