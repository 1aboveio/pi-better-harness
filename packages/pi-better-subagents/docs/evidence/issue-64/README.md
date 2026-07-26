# Issue #64 — Child event signature discovery

Parent epic: #60 (periodic subagent health checks).

This directory captures **representative `--mode json` child event signatures** so
later health classification is evidence-based rather than guessed. **No production
behavior changes** ship with this ticket.

## Layout

| Path | Purpose |
|------|---------|
| `NOTES.md` | Classification guidance: meaningful activity, compaction, model-call lifecycle, limitations |
| `event-catalog.json` | Machine-readable counts + sample shapes from the capture runs |
| `fixtures/*.ndjson` | Bounded, redacted representative event streams (validated by unit test) |
| `redacted/*` | Human-browsable redacted copies + raw-noise samples + compaction attempt skeleton |
| `raw/*` | Local capture workspace only (`*.log` is gitignored). Canonical committed evidence is `fixtures/` + `redacted/` + attempt NOTES |

## Capture method

Controlled children were driven the same way product `subagent_spawn` builds them
where practical (`pi -p --mode json`, stdin closed, tool allowlist / extension
isolation via `tests/lib.sh` `run_child`), plus targeted direct `pi` invocations
for error and compaction probes.

Default capture model: `minimax-cn/MiniMax-M3` (`PI_SUBAGENT_TEST_MODEL` override
supported by the test harness).

## AC map

| Acceptance criterion | Artifact |
|----------------------|----------|
| Normal model response | `fixtures/normal-model-response.ndjson` |
| Tool start / tool end | `fixtures/tool-start-end.ndjson` |
| Usage / cost events | `fixtures/usage-cost-events.ndjson` |
| Terminal agent events | present in normal + tool fixtures (`agent_end`, `agent_settled`) |
| Model / network errors | `fixtures/model-error-bad-model.ndjson`, `fixtures/model-error-network.ndjson` |
| Compaction | `fixtures/compaction-rpc-manual.ndjson` + attempt notes (auto-compact not reproduced; no-event cause unverified — see NOTES) |
| Raw non-JSON noise | `redacted/raw-noise-samples.txt` |
| Meaningful-activity guidance | `NOTES.md` |
| Compaction / model-call detectability | `NOTES.md` |
