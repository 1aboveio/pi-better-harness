# Issue #159 callback batching plan

Source: GitHub issue #159. Target: `main`.

Pre-agreed public seams: the shared callback batcher's enqueue/flush contract; the real `pi-better-background-tasks` terminal callback path; the real `pi-better-subagents` finalization and orphaned/lost callback paths.

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC1-3 aggregation, stable order, debounce, single-event flush | shared batcher | done | `packages/callback-batcher/index.test.ts` (6-test shared unit GREEN) |
| AC4 successful-handoff markers, send failure retry, concurrent arrivals | shared batcher + extension durable metadata | done | shared retry test + both extension integration suites |
| AC5 cwd/session isolation at flush and recovery | both extension integrations | done | background runtime retry/isolation + subagent reload recovery tests |
| AC6 callback:false excluded from mixed batches | both extension integrations | done | shared mixed-batch unit + both extension integrations |
| AC7 orphaned/lost urgent and distinguishable | subagent health integration | done | existing 7-test #65 suite + shared urgent bypass unit |
| AC8 bounded aggregate, no result/log payload | shared formatter + both integrations | done | bounded formatter unit + production payload sentinels |
| AC9 both extension families use one shared path; full suite/typecheck | synchronized shared module + integrations | done | cross-copy integration; repository typecheck and full test suite GREEN |
| AC10 timing/config and `followUpMode: all` docs | package usage docs | done | both package usage guides updated |
| Runtime smoke for changed non-browser callback surfaces | real shared/extension callback paths | done | `docs/tests/_generated/runtime-smoke-results-159.json` (4/4 pass) |
| Coverage and reviewer-parity gates | close-out artifacts | in-progress | `docs/tests/_generated/coverage-checklist-159.md`; root inventory/ledger and CI wiring gaps recorded |
