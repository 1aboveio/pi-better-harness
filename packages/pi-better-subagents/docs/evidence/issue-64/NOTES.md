# Child event signatures for subagent health (#64)

Discovery notes from controlled `pi --mode json` / `pi -p --mode json` runs.
Authoritative event taxonomy also lives in upstream pi docs:

- [`docs/json.md`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/json.md) — print/JSON event stream
- `AgentSessionEvent` in pi-coding-agent (`agent_settled`, `compaction_*`, `auto_retry_*`, …)

Fixtures under `fixtures/` are redacted, bounded NDJSON excerpts. Raw captures
(when retained) live under `raw/`.

---

## 1. Observed event inventory (print / JSON child logs)

### Always / commonly present on a successful short run

| `type` | Role | Seen in |
|--------|------|---------|
| `session` | Header line (`version`, `id`, `timestamp`, `cwd`, …) | all print runs |
| `agent_start` | Agent run begins | all |
| `turn_start` / `turn_end` | Turn boundaries | all |
| `message_start` / `message_end` | User + assistant message lifecycle | all |
| `message_update` | Streaming partial assistant text/thinking (high volume) | successful model streams |
| `agent_end` | One low-level agent run finished; may include `willRetry` | all settled runs |
| `agent_settled` | **Fully settled** — no automatic retry / compaction retry / queued continuation remains | successful + exhausted-retry failures |

### Tool activity

| `type` | Fields (observed) | Notes |
|--------|-------------------|-------|
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | Marks tool begin; safe activity signal |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` | Progress while tool runs (e.g. bash stdout chunks) |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` | Marks tool end; pair with start via `toolCallId` |

Evidence: `fixtures/tool-start-end.ndjson`.

### Usage / cost

Usage is **not** a standalone top-level event type in the captures.

It appears on **assistant** `message_end.message.usage` (and the same shape on the
assistant message inside some `turn_end` / `agent_end` payloads):

```json
"usage": {
  "input": 123,
  "output": 45,
  "cacheRead": 0,
  "cacheWrite": 0,
  "cacheWrite1h": 0,
  "totalTokens": 168,
  "cost": {
    "input": 0.0,
    "output": 0.0,
    "cacheRead": 0.0,
    "cacheWrite": 0.0,
    "total": 0.0
  }
}
```

Evidence: `fixtures/usage-cost-events.ndjson` (extracted from the tool run).
This matches what `parse.ts` already sums from assistant `message_end` only.

### Terminal agent events

| Event | Meaning for health / finalization |
|-------|-----------------------------------|
| `agent_end` | Low-level run ended. Check `willRetry`: `true` means auto-retry will continue — **not** a durable terminal quiet state. |
| `agent_settled` | No further automatic continuation. **Best terminal “run is done streaming” signal** in child logs. |

A child can emit multiple `agent_end` events when retries fire; only the last
stretch ends with `agent_settled` (see model-error fixture).

Evidence: normal + tool fixtures; error fixtures show `willRetry` + retry loop.

### Model / network / API errors (reproduced)

Errors showed up as **assistant messages with `stopReason: "error"`**, not as a
dedicated `type: "model_error"` event.

Observed shapes:

1. **Retryable provider failure** (`fixtures/model-error-bad-model.ndjson`):
   - `message_start` / `message_end` with `message.role === "assistant"`,
     `message.stopReason === "error"`,
     `message.errorMessage` string (e.g. `503: …`).
   - `agent_end` with `willRetry: true|false`.
   - **`auto_retry_start`**: `{ attempt, maxAttempts, delayMs, errorMessage }`.
   - **`auto_retry_end`**: `{ success, attempt, finalError? }` when retries finish
     (failure path observed with `success: false`).
   - Final `agent_settled` after retries exhaust.

2. **Non-retry auth-style failure** (`fixtures/model-error-network.ndjson`):
   - Intended as a network probe (`OPENAI_BASE_URL=https://127.0.0.1:1`); the
     provider returned a fast **401** instead of a connect timeout, so this is
     best treated as **API/auth error evidence**, not a pure transport timeout.
   - Single failed assistant message (`stopReason: "error"`, `errorMessage` set),
     then `agent_end` + `agent_settled` **without** `auto_retry_*` in this capture
     (retry disabled or error class not retried).

**Limitation:** a true TCP hang / DNS failure / mid-stream disconnect was not
separately reproduced. Upstream also documents `auto_retry_*` for overloaded /
rate-limit / server errors; treat those events as first-class when present.

### Compaction (partially reproduced)

Upstream JSON mode documents explicit:

```ts
{ type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
{ type: "compaction_end"; reason; result?; aborted; willRetry; errorMessage? }
```

**Reproduced explicitly** via RPC manual compact against a seeded session
(`fixtures/compaction-rpc-manual.ndjson`):

```json
{"type":"compaction_start","reason":"manual"}
{"type":"compaction_end","reason":"manual","aborted":false,"willRetry":false,
 "errorMessage":"Compaction failed: Nothing to compact (session too small)"}
```

So the **event names and envelope are real and emit on the session event bus**
even when compaction fails early.

**Not reproduced in short print-mode (`-p --mode json`) child runs:**

- Auto threshold compaction: a print run with a ~24.6k-token prompt
  (`totalTokens=24605`) and *claimed* `reserveTokens=1_000_000` produced **no**
  `compaction_*` lines (skeleton retained). The earlier claim that this was
  because the threshold was "impractical" for `contextWindow=512000` is
  **incorrect under those claimed numbers**:
  `shouldCompact` is `enabled && contextTokens > contextWindow - reserveTokens`,
  so with `reserveTokens=1_000_000` the headroom is `-488000` and
  `shouldCompact(24605, 512000, claimed) === true`. Cause of the missing events
  is therefore **unverified** — effective loaded settings, cut-point /
  `prepareCompaction` outcome, and agent version were not retained from the
  original process. Plausible alternatives (settings never applied → default
  reserve keeps `shouldCompact` false; or settings applied but auto path's
  `prepareCompaction` returned undefined and `_runAutoCompaction` returned
  without emitting events) are listed in
  `raw/compaction-attempt-large-prompt.NOTES.txt`.
- Successful compaction with a non-null `result` summary was not captured.

Attempt record: `raw/compaction-attempt-large-prompt.NOTES.txt` and
`redacted/compaction-attempt-large-prompt.skeleton.ndjson`.

Related (documented upstream, not captured here):  
`summarization_retry_scheduled`, `summarization_retry_attempt_start`,  
`summarization_retry_finished` for compaction/branch-summary summarization retries.

### Raw non-JSON / noisy log lines

Child logs are **stdout+stderr merged** (extension `spawnDetached`). Non-JSON
lines appear and must not count as activity.

Observed samples (`redacted/raw-noise-samples.txt`):

- `Warning: No project session found with id '…'; creating a new session with that id.`
- `Warning: Model "…" not found for provider "…". Using custom model id.`
- Occasional host banners (parse.ts comments mention `[pi-warp] …`; not always present)

`parse.ts` already skips lines that do not start with `{` or fail `JSON.parse`.
Health must do the same for “meaningful activity,” while **raw log mtime/size**
can still move because of this noise.

---

## 2. What is safe to treat as meaningful activity

Use **parsed JSON events** only. Prefer sparse, high-signal types over chatty
streams.

### Safe activity signals (recommended)

| Signal | Why |
|--------|-----|
| `tool_execution_start` / `tool_execution_end` | Explicit work boundaries; identify active tool via open start without end |
| Assistant `message_end` with `stopReason !== "error"` and real text/usage | A completed model turn |
| `turn_end` after a non-error assistant message | Turn completed |
| `auto_retry_start` / `auto_retry_end` | Explicit recovery work (model-error dimension, not “healthy progress”) |
| `compaction_start` / `compaction_end` | Explicit compaction dimension when present |
| `agent_settled` | Terminal quiet — useful for finalization, not ongoing liveness |

### Weak / noisy if used alone

| Signal | Risk |
|--------|------|
| `message_update` | Very high volume token deltas; proves the model is streaming **now**, but easy to treat as perpetual health if not rate-limited; huge partial payloads |
| Raw log byte growth / mtime | Includes stderr warnings and banners; **diagnostic only** |
| `session` header | Startup only |
| User `message_end` | Echo of the prompt; not child progress |
| `agent_start` / `turn_start` alone | Lifecycle bookkeeping without progress |

### Error activity (separate dimension)

| Signal | Classification hint |
|--------|---------------------|
| Assistant `stopReason === "error"` + `errorMessage` | Model/API error observation |
| `auto_retry_start` | Retrying after model/API error |
| `auto_retry_end` with `success: false` | Retries exhausted — expect durable failed/settled soon |
| `auto_retry_end` with `success: true` | Recovered; clear transient model-error warning after later good activity |

Do **not** fold error retries into generic “healthy activity” that clears stale
detection without also recording the model-error dimension (epic #60).

---

## 3. Compaction detectability

| Question | Answer |
|----------|--------|
| Can compaction be detected **explicitly**? | **Yes**, when `compaction_start` / `compaction_end` appear in the child JSON stream. |
| Are those events confirmed real? | **Yes** — captured via RPC manual compact (`fixtures/compaction-rpc-manual.ndjson`). Envelope matches upstream `AgentSessionEvent`. |
| Was auto-compact captured in a print-mode subagent log? | **No** in this discovery pass. Cause **unverified** — claimed aggressive `reserveTokens` would have made `shouldCompact` true; see attempt NOTES (not "threshold impractical"). |
| Was a **successful** compact (`result` present, `aborted: false`, no `errorMessage`) captured? | **No**. |
| Inference without events? | **Not recommended** for UI truth. Long silence ≠ compaction. Epic out-of-scope already forbids presenting weak inference as fact. |
| Health implication | Implement **explicit** compaction dimension gated on `compaction_*`. Until a successful auto-compact print-mode fixture exists, still trust the event types; optionally add a follow-up capture later. Between `start` and `end`, surface `compacting`; on `end` with error, record failure detail; on `end` success, clear compacting. |

**Verdict:** compaction is **explicitly detectable** from event signatures.  
Auto-compact frequency in real subagent workloads remains **under-evidenced** but
does not block implementing the explicit detector.

---

## 4. Model-call lifecycle detectability

| Question | Answer |
|----------|--------|
| Is there `model_call_start` / `model_call_end`? | **Not observed** and not in upstream JSON event list. |
| What marks “waiting on the model”? | Soft inference only: after `turn_start` / user `message_end`, before the next assistant `message_start`/`message_update`, with no open tool and no compaction/retry — **gap inference**. |
| What marks streaming model output? | `message_update` (and assistant `message_start` → `message_end`). |
| What marks model failure? | **Explicit:** assistant `stopReason: "error"`, `errorMessage`; plus `auto_retry_*` when retries run. |
| What marks model success for spend? | Assistant `message_end.usage` (+ `cost`). |

**Verdict:**

- **Model errors / retries:** explicit — safe to surface.
- **`long_model_call` / in-flight model wait:** **inference-only** today; epic says
  require discovery evidence before presenting it as fact. This discovery did
  **not** find an explicit lifecycle event pair. Leave `long_model_call`
  **unsupported or clearly inferred/experimental** until upstream adds events or
  a stronger prototype proves acceptable false-positive rates.
- **Streaming activity:** explicit via `message_update`, but prefer coarser
  assistant `message_end` for “meaningful progress” stale detection.

---

## 5. Recommended health parser facts (for later tickets)

Pure facts a future parser can extract per log tail:

```text
lastMeaningfulAt     <- max timestamp/offset among:
                        tool_execution_start/end,
                        assistant message_end (non-error),
                        turn_end (non-error assistant),
                        compaction_*, auto_retry_*, agent_settled
lastRawWriteAt       <- filesystem mtime/size of log (diagnostic)
activeTool           <- toolName from latest start without matching end (by toolCallId)
lastToolAt           <- time of latest tool start/end
compacting           <- seen compaction_start without later compaction_end
lastCompaction       <- latest compaction_end reason/aborted/errorMessage
modelError           <- latest assistant stopReason==error errorMessage, or auto_retry_*
retryingModel        <- auto_retry_start without later auto_retry_end / settled
sawAgentSettled      <- agent_settled present
willRetry            <- latest agent_end.willRetry
usage                <- sum assistant message_end.usage (existing parse.ts)
```

Open tool without end ⇒ **long tool** dimension (not stale).  
Compacting true ⇒ **compacting** dimension (not stale).  
Retrying / recent model error ⇒ **model error** dimension.  
None of the above + no meaningful events past threshold ⇒ residual **stale**.

---

## 6. Limitations & follow-ups

1. **Successful auto-compaction** in a real `-p --mode json` subagent log still
   wanted (multi-turn history that yields a non-empty cut / overflow path),
   with effective `getCompactionSettings()` + cut-point evidence retained so
   the next attempt does not leave the no-event cause unverified.
2. **Pure network timeout / ECONNREFUSED** mid-stream not cleanly captured; 401
   and 503 paths were.
3. **Timestamps:** many events have no top-level `ts`; activity timing may need
   log byte offsets + file mtime, or message-level timestamps when present.
4. **`message_update` volume** can dominate tails — health parsers should skip or
   sample them when building “last meaningful” under bounded tail reads (#73).
5. No production code changed in #64.

---

## 7. Fixture index

| File | Demonstrates |
|------|----------------|
| `fixtures/normal-model-response.ndjson` | session → agent_start → turn → assistant stream → agent_end → agent_settled |
| `fixtures/tool-start-end.ndjson` | tool_execution_start / update / end + multi-turn |
| `fixtures/usage-cost-events.ndjson` | assistant usage + cost on message_end; terminals |
| `fixtures/model-error-bad-model.ndjson` | stopReason error + auto_retry_start/end + willRetry |
| `fixtures/model-error-network.ndjson` | stopReason error + errorMessage (API failure) |
| `fixtures/compaction-rpc-manual.ndjson` | compaction_start / compaction_end envelopes |
