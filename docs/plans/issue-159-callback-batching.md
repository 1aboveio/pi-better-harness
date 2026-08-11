# Issue #159 callback batching plan

Source: GitHub issue #159. Target: `main`.

Pre-agreed public seams: the shared callback batcher's enqueue/flush contract; the real `pi-better-background-tasks` terminal callback path; the real `pi-better-subagents` finalization and orphaned/lost callback paths.

| Obligation | Slice | State | Proof |
| --- | --- | --- | --- |
| AC1-3 aggregation, stable order, debounce, single-event flush | shared batcher | done | `packages/callback-batcher/index.test.ts` (6-test shared unit GREEN) |
| AC4 successful-handoff markers, send failure retry, concurrent arrivals | shared batcher + extension durable metadata | in-progress | shared unit tests + extension integration tests |
| AC5 cwd/session isolation at flush and recovery | both extension integrations | todo | background e2e + subagent extension lifecycle tests |
| AC6 callback:false excluded from mixed batches | both extension integrations | todo | cross-extension integration test |
| AC7 orphaned/lost urgent and distinguishable | subagent health integration | todo | subagent extension lifecycle tests |
| AC8 bounded aggregate, no result/log payload | shared formatter + both integrations | todo | shared unit tests + extension callback tests |
| AC9 both extension families use one shared path; full suite/typecheck | synchronized shared module + integrations | todo | cross-copy integration + `npm run verify` |
| AC10 timing/config and `followUpMode: all` docs | package usage docs | todo | documentation diff |
| Runtime smoke for changed non-browser callback surfaces | real shared/extension callback paths | todo | `docs/tests/_generated/runtime-smoke-results-159.json` |
| Coverage and reviewer-parity gates | close-out artifacts | todo | `docs/tests/_generated/coverage-checklist-159.md` + mandated commands |
