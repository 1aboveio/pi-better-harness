import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFailureState, reduceFailure, activeFailures, formatFailureSummary, formatFailureLines, pageFailureIncidents, isIncidentCursor, incidentCursorAt, pendingFailureAttention,
  formatIncidentSummary, failureRevision, incidentVerbatimPage, incidentPageHeading, incidentResource, failureJournalFingerprint,
  observeFailures, readFailureState, markFailureAttentionDelivered, failureAttentionHandled, type FailureEvent,
  disposeIncidents, failureCounts, failureHistory, formatPendingAttention, formatTerminalFailureFacts, validateDisposition,
  formatTerminalIncidentSummary, CORRECTNESS_NOTE, readCommandIntent } from "./index.ts";

const failed: FailureEvent = { id: "call-1:end", operation: "cwd:project:tsc", kind: "failure",
  summary: "TypeScript exited 2", category: "exit", evidence: "output.log#call-1" };

test("failed writes retain all evidence and receipts, retry persistence, and avoid repeat attention", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "failure-write-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocker = join(dir, "blocked");
  writeFileSync(blocker, "not a directory");
  const path = join(blocker, "failures.jsonl");
  observeFailures(path, [failed, { ...failed, id: "second", operation: "another-check" }], 1000);
  const state = readFailureState(path);
  assert.match(formatFailureSummary(state), /could not be persisted/);
  assert.equal(activeFailures(state).filter((x) => x.category === "exit").length, 2);
  const pending = pendingFailureAttention(state, 61_000, { terminal: true })!;
  markFailureAttentionDelivered(path, pending, 61_000);
  assert.equal(pendingFailureAttention(readFailureState(path), 62_000, { terminal: true }), undefined);
  rmSync(blocker);
  const persisted = readFailureState(path);
  assert.equal(activeFailures(persisted).length, 2);
  assert.equal(pendingFailureAttention(persisted, 63_000, { terminal: true }), undefined);
  const restarted = freshState(path);
  assert.equal(activeFailures(restarted).length, 2);
  assert.equal(pendingFailureAttention(restarted, 63_000, { terminal: true }), undefined);
});

test("a fresh process recognizes a missing journal that previously held evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "failure-missing-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "failures.jsonl");
  observeFailures(path, [failed]);
  rmSync(path);
  const program = `import {readFailureState,formatFailureSummary} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}; console.log(formatFailureSummary(readFailureState(process.argv[1])));`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, path], { encoding: "utf8" });
  assert.match(output, /Observation incomplete.*could not be read/);
});

test("detected journal truncation remains visible on later reads", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "failure-truncation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "failures.jsonl");
  observeFailures(path, [failed]);
  readFailureState(path);
  writeFileSync(path, "");
  assert.match(formatFailureSummary(readFailureState(path)), /journal was truncated/);
  assert.match(formatFailureSummary(readFailureState(path)), /journal was truncated/);
});

test("unknown incident evidence defers delivery, while explicit old recovery remains known", () => {
  assert.throws(() => failureAttentionHandled(emptyFailureState(), [failed.id]), /unavailable/);
  let state = reduceFailure(emptyFailureState(), failed, 1000);
  state = reduceFailure(state, { id: "retry", operation: failed.operation, kind: "recovered", incidents: [failed.id] }, 2000);
  state = reduceFailure(state, { ...failed, id: "new-failure" }, 3000);
  assert.equal(failureAttentionHandled(state, [failed.id]), true);
  assert.equal(failureAttentionHandled(state, ["new-failure"]), false);
});

test("failure evidence is visible independently of lifecycle and prose", () => {
  const state = reduceFailure(emptyFailureState(), failed, 1000);
  assert.match(formatFailureSummary(state), /^Action required.*TypeScript exited 2.*output.log#call-1/);
  assert.equal(activeFailures(state).length, 1);
  assert.equal(pendingFailureAttention(state, 1001), undefined);
  assert.ok(pendingFailureAttention(state, 61_000));
  assert.ok(pendingFailureAttention(state, 1001, { terminal: true }));
});

test("unrelated successes and unreferenced recoveries cannot erase failure", () => {
  let state = reduceFailure(emptyFailureState(), failed, 1000);
  state = reduceFailure(state, { id: "git-success", operation: "git-status", kind: "recovered", incidents: [failed.id] }, 2000);
  state = reduceFailure(state, { id: "unreferenced", operation: failed.operation, kind: "recovered" }, 3000);
  assert.equal(activeFailures(state).length, 1);
  state = reduceFailure(state, { id: "retry-success", operation: failed.operation, kind: "recovered", incidents: [failed.id] }, 4000);
  assert.equal(activeFailures(state).length, 0);
  assert.equal(formatFailureSummary(state), "");
  assert.equal(Object.values(state.observations)[0]!.resolvedAt, 4000);
  const beforeReplay = structuredClone(state);
  assert.deepEqual(reduceFailure(state, failed, 5000), beforeReplay, "replayed old failure does not reopen the incident");
});

test("repeated failures group into one incident; recovery then failure starts a new one", () => {
  let state = reduceFailure(emptyFailureState(), failed, 1000);
  state = reduceFailure(state, { ...failed, id: "call-2:end" }, 2000);
  assert.equal(activeFailures(state)[0]!.id, failed.id);
  assert.equal(activeFailures(state)[0]!.count, 2);
  const attention = pendingFailureAttention(state, 100_000)!;
  state = reduceFailure(state, { id: "delivery", operation: "notification", kind: "delivered", incidents: attention.incidents }, 100_000);
  state = reduceFailure(state, { ...failed, id: "call-3:end" }, 101_000);
  assert.equal(pendingFailureAttention(state, 200_000), undefined);
  state = reduceFailure(state, { id: "recovery", operation: failed.operation, kind: "recovered", incidents: [failed.id] }, 201_000);
  state = reduceFailure(state, { ...failed, id: "call-4:end" }, 202_000);
  assert.deepEqual(pendingFailureAttention(state, 300_000)!.incidents, ["call-4:end"]);
});

test("explicitly expected errors stay visible without attention; expected label cannot excuse an existing unexpected failure", () => {
  const expected = reduceFailure(emptyFailureState(), { ...failed, expected: true }, 1000);
  assert.match(formatFailureSummary(expected), /Expected failure/);
  assert.equal(pendingFailureAttention(expected, 999_999, { terminal: true }), undefined);
  const unexpectedRetry = reduceFailure(expected, { ...failed, id: "unexpected-retry" }, 2000);
  assert.ok(pendingFailureAttention(unexpectedRetry, 999_999));
  let unexpected = reduceFailure(emptyFailureState(), failed, 1000);
  unexpected = reduceFailure(unexpected, { ...failed, id: "later", expected: true }, 2000);
  assert.ok(pendingFailureAttention(unexpected, 999_999));
});

function freshState(path: string) {
  const program = `import {readFailureState} from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)}; console.log(JSON.stringify(readFailureState(process.argv[1])));`;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", program, path], { encoding: "utf8" }));
}

function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "failure-contract-"));
  try { run(join(dir, "failures.jsonl")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("restart preserves observations, failed delivery remains pending, and successful handoff deduplicates", () => fixture((path) => {
  observeFailures(path, [failed], 1000);
  const pending = pendingFailureAttention(readFailureState(path), 100_000)!;
  assert.ok(pending);
  // No delivery receipt: a thrown/rejected handoff or reload must retry.
  const restored = freshState(path);
  assert.deepEqual(activeFailures(restored).map(({ id, summary }) => ({ id, summary })), [
    { id: failed.id, summary: failed.summary },
  ]);
  assert.deepEqual(pendingFailureAttention(restored, 100_000), pending);
  markFailureAttentionDelivered(path, pending, 100_001);
  assert.equal(pendingFailureAttention(freshState(path), 100_002), undefined);
  const before = readFileSync(path, "utf8");
  observeFailures(path, [failed], 200_000);
  assert.equal(readFileSync(path, "utf8"), before, "replay must not grow the journal");
}));

test("corrupt or truncated journals preserve known failures and expose incomplete observation", () => fixture((path) => {
  observeFailures(path, [failed], 1000);
  writeFileSync(path, readFileSync(path, "utf8") + '{"event":');
  const state = readFailureState(path);
  assert.match(formatFailureSummary(state), /TypeScript exited 2/);
  assert.match(formatFailureSummary(state), /Observation incomplete/);
  assert.ok(pendingFailureAttention(state, Date.now()), "broken observation must not wait for a fabricated event timestamp");
  observeFailures(path, [{ ...failed, id: "new-failure", operation: "tests", summary: "Tests exited 1" }], 2000);
  assert.match(formatFailureSummary(readFailureState(path)), /Tests exited 1/,
    "a new record must survive even when the previous last record was cut mid-write");
}));

test("invalid journal record shapes fail visibly without crashing rendering", () => fixture((path) => {
  writeFileSync(path, JSON.stringify({ observedAt: 1, event: { ...failed, summary: {} } }) + "\n");
  assert.match(formatFailureSummary(readFailureState(path)), /Observation incomplete/);
}));

test("storage errors expose both the observed failure and the loss of persistence", () => fixture((path) => {
  writeFileSync(path, "not a directory");
  const state = observeFailures(join(path, "blocked.jsonl"), [failed], 1000);
  assert.match(formatFailureSummary(state), /TypeScript exited 2/);
  assert.match(formatFailureSummary(state), /could not be persisted/);
  assert.ok(pendingFailureAttention(state, Date.now()));
}));

test("latest observed failures remain first when timestamps are equal or clocks move backwards", () => {
  let state = reduceFailure(emptyFailureState(), failed, 1000);
  state = reduceFailure(state, { ...failed, id: "second", operation: "second-check", summary: "Second failure" }, 1000);
  state = reduceFailure(state, { ...failed, id: "latest", operation: "latest-check", summary: "Latest failure" }, 999);
  assert.deepEqual(activeFailures(state).map((x) => x.summary), ["Latest failure", "Second failure", "TypeScript exited 2"]);
});

test("bounded summaries prioritize unexpected failures over newer expected failures", () => {
  let state = reduceFailure(emptyFailureState(), failed, 1000);
  for (let i = 0; i < 8; i++) state = reduceFailure(state, { ...failed, id: `expected-${i}`,
    operation: `red-test-${i}`, expected: true, summary: "Expected red test" }, 2000 + i);
  const summary = formatFailureSummary(state);
  assert.match(summary.split("\n")[0]!, /TypeScript exited 2/);
  assert.match(summary, /4 additional active failure observations/);
});

test("omitted incidents reconstruct through caller-owned incident pages", () => {
  let state = reduceFailure(emptyFailureState(), failed, 1000);
  for (let i = 0; i < 11; i++) {
    state = reduceFailure(state, {
      ...failed,
      id: `incident-${i}`,
      operation: `op-${i}`,
      summary: `synthetic-incident-${i}`,
    }, 2000 + i);
  }
  const lines = formatFailureLines(state);
  assert.equal(lines.length, 12);
  const first = pageFailureIncidents(state, { maxBytes: 400 });
  assert.ok(first.represented >= 1);
  assert.ok(first.hasMore);
  assert.equal(first.omitted, lines.length - first.represented);
  assert.equal(isIncidentCursor(first.nextCursor), true);
  let cursor = first.cursor;
  let rebuilt = "";
  for (let pages = 0; pages < 50; pages += 1) {
    const page = pageFailureIncidents(state, { cursor, maxBytes: 400 });
    rebuilt += (rebuilt && page.text ? "\n" : "") + page.text;
    if (!page.hasMore) break;
    cursor = page.nextCursor;
  }
  assert.equal(rebuilt, lines.join("\n"));
  const rest = pageFailureIncidents(state, { cursor: incidentCursorAt(state, 5), maxBytes: 8 * 1024 });
  assert.equal(rest.text, lines.slice(5).join("\n"));
  assert.equal(rest.omitted, 0);
});

function manyIncidents(count: number, summary: (i: number) => string): ReturnType<typeof emptyFailureState> {
  let state = emptyFailureState();
  for (let i = 0; i < count; i++) {
    state = reduceFailure(state, { ...failed, id: `incident-${i}`, operation: `op-${i}`, summary: summary(i), evidence: `evidence-${i}` }, 1000 + i);
  }
  return state;
}

/** Concatenate incident pages exactly: rows are newline-joined except where a row continues. */
function reconstructIncidents(state: ReturnType<typeof emptyFailureState>, maxBytes: number, cursor?: string, resource?: string): string {
  let rebuilt = "";
  let previousPartial = cursor ? pageFailureIncidents(state, { cursor, maxBytes: 0, resource }).startsPartial : false;
  for (let pages = 0; pages < 500; pages += 1) {
    const page = pageFailureIncidents(state, { cursor, maxBytes, resource });
    assert.equal(page.reset, undefined);
    assert.ok(Buffer.byteLength(page.text) <= maxBytes, `page of ${Buffer.byteLength(page.text)} bytes exceeds ${maxBytes}`);
    assert.equal(page.startsPartial, previousPartial);
    rebuilt += (rebuilt && page.text && !previousPartial ? "\n" : "") + page.text;
    previousPartial = page.endsPartial;
    if (!page.hasMore) return rebuilt;
    cursor = page.nextCursor;
  }
  throw new Error("incident paging did not terminate");
}

test("rows larger than the page split at a code point and resume at that byte", () => {
  const state = manyIncidents(8, (i) => `incident-${i} ${"界".repeat(150)}`);
  const lines = formatFailureLines(state);
  assert.ok(Buffer.byteLength(lines[0]!) > 300);
  assert.equal(reconstructIncidents(state, 300), lines.join("\n"));
  const first = pageFailureIncidents(state, { maxBytes: 300 });
  assert.equal(first.represented, 0, "a clipped row is not counted as shown");
  assert.equal(first.omitted, 8);
  assert.equal(first.endsPartial, true);
  assert.doesNotMatch(first.text, /\uFFFD/);
});

test("the incident summary counts shown and omitted rows exactly and its cursor resumes at the first unshown byte", () => {
  const state = manyIncidents(8, (i) => `incident-${i} ${"界".repeat(150)}`);
  const lines = formatFailureLines(state);
  for (const budget of [200, 700, 1_200, 2_000]) {
    const summary = formatIncidentSummary(state, { maxBytes: budget, resource: "incidents:s:bg_1" });
    assert.ok(Buffer.byteLength(summary.text) <= budget, `summary ${Buffer.byteLength(summary.text)} > ${budget}`);
    assert.equal(summary.total, 8);
    assert.equal(summary.represented + summary.omitted, 8);
    assert.match(summary.text, new RegExp(`8 active failure observations · ${summary.represented} shown · ${summary.omitted} omitted`));
    const body = summary.text.split("\n").slice(1).join("\n");
    const rest = reconstructIncidents(state, 900, summary.nextCursor, "incidents:s:bg_1");
    const partial = body && !lines.slice(0, summary.represented).join("\n").endsWith(body);
    const shownPlusRest = partial ? body + rest : [body, rest].filter(Boolean).join("\n");
    assert.equal(shownPlusRest, lines.join("\n"), `budget ${budget}`);
  }
  const all = formatIncidentSummary(manyIncidents(2, (i) => `small-${i}`), { maxBytes: 1_024 });
  assert.equal(all.omitted, 0);
  assert.doesNotMatch(all.text, /incidentCursor/);
});

test("a summary too small for its cursor drops the whole cursor token instead of clipping it", () => {
  const state = manyIncidents(8, (i) => `incident-${i} ${"x".repeat(200)}`);
  const full = formatIncidentSummary(state, { maxBytes: 0, resource: "incidents:session-a:bg_1" });
  for (let budget = 0; budget <= 400; budget += 7) {
    const summary = formatIncidentSummary(state, { maxBytes: budget, resource: "incidents:session-a:bg_1", retrieval: "pass as cursor to bg_task_status id=bg_1" });
    assert.ok(Buffer.byteLength(summary.text) <= budget, `budget ${budget}: ${Buffer.byteLength(summary.text)} bytes`);
    const cursor = summary.text.match(/incidentCursor=(\S+)/)?.[1];
    if (cursor) {
      assert.equal(cursor, summary.nextCursor, `budget ${budget}: cursor must be whole`);
      assert.equal(pageFailureIncidents(state, { cursor, maxBytes: 4_096, resource: "incidents:session-a:bg_1" }).reset, undefined);
    } else if (summary.text) {
      assert.match(summary.text, /8 active failure observations/);
      assert.equal(summary.nextCursor, undefined);
    }
  }
  assert.equal(full.text, "");
});

test("incident cursors are bound to their resource scope", () => {
  const state = manyIncidents(6, (i) => `incident-${i} ${"x".repeat(200)}`);
  const first = pageFailureIncidents(state, { maxBytes: 300, resource: "incidents:session-a:bg_1" });
  const other = pageFailureIncidents(state, { cursor: first.nextCursor, maxBytes: 300, resource: "incidents:all:bg_1" });
  assert.equal(other.reset, "stale-cursor");
  const same = pageFailureIncidents(state, { cursor: first.nextCursor, maxBytes: 300, resource: "incidents:session-a:bg_1" });
  assert.equal(same.reset, undefined);
});

test("failure revision changes on a repeated failure of the same operation, not on receipts", () => {
  let state = reduceFailure(emptyFailureState(), failed, 1000);
  const before = failureRevision(state);
  state = reduceFailure(state, { ...failed, id: "call-2:end", summary: "again" }, 2000);
  assert.equal(activeFailures(state).length, 1);
  const repeated = failureRevision(state);
  assert.notEqual(repeated, before);
  state = reduceFailure(state, { id: "delivered:x", operation: "attention-delivery", kind: "delivered", incidents: [activeFailures(state)[0]!.id] }, 3000);
  assert.equal(failureRevision(state), repeated);
});

test("special event IDs cannot suppress delivery through Object.prototype", () => {
  const state = reduceFailure(emptyFailureState(), { ...failed, id: "constructor" }, 1);
  assert.ok(pendingFailureAttention(state, 2, { terminal: true }));
});

// ---- #315: incident lifecycle, explicit disposition, pending-only attention -------------

const toolFailure = (id: string, operation = "bash:npm test", summary = "bash failed: tests failed"): FailureEvent =>
  ({ id, operation, kind: "failure", category: "tool", summary, evidence: `output.log#${id}` });

test("a single agent tool failure is retained but is not running attention; the same operation failing three times is", () => {
  let state = reduceFailure(emptyFailureState(), toolFailure("t1"), 1000);
  assert.match(formatFailureSummary(state), /^Unclassified failure observation · .*tests failed/);
  assert.equal(pendingFailureAttention(state, 999_999), undefined, "the child owns its own tool errors while alive");
  assert.deepEqual(pendingFailureAttention(state, 1001, { terminal: true })?.incidents, ["t1"], "terminal delivery still reports it once");
  state = reduceFailure(state, toolFailure("t2"), 2000);
  assert.equal(pendingFailureAttention(state, 999_999), undefined);
  state = reduceFailure(state, toolFailure("t3"), 3000);
  assert.match(formatFailureSummary(state), /^Action required · .*\(3 occurrences\)/);
  const stuck = pendingFailureAttention(state, 999_999)!;
  assert.deepEqual(stuck.incidents, ["t1"]);
  state = reduceFailure(state, { id: "d1", operation: "notification", kind: "delivered", incidents: stuck.incidents }, 999_999);
  state = reduceFailure(state, toolFailure("t4"), 1_000_000);
  assert.equal(pendingFailureAttention(state, 2_000_000), undefined, "a stuck incident escalates once");
  assert.equal(pendingFailureAttention(state, 2_000_000, { terminal: true }), undefined, "and is not re-reported at completion");
});

test("attention renders only pending incidents and counts earlier ones without repeating them", () => {
  let state = emptyFailureState();
  for (const id of ["old-1", "old-2"]) state = reduceFailure(state, { ...failed, id, operation: id, summary: `summary of ${id}` }, 1000);
  const first = pendingFailureAttention(state, 100_000)!;
  state = reduceFailure(state, { id: "receipt-1", operation: "notification", kind: "delivered", incidents: first.incidents }, 100_000);
  state = reduceFailure(state, { ...failed, id: "new", operation: "new", summary: "summary of new" }, 100_001);
  const second = pendingFailureAttention(state, 200_000)!;
  assert.deepEqual(second.incidents, ["new"]);
  const text = formatPendingAttention(state, second.incidents);
  assert.match(text, /summary of new/);
  assert.doesNotMatch(text, /summary of old/);
  assert.match(text, /2 other active failure observations were reported earlier or not actionable; not repeated here/);
  assert.throws(() => formatPendingAttention(state, ["missing"]), /unavailable/);
});

test("explicit supersession closes a modified-retry incident with evidence and keeps its history", () => fixture((path) => {
  observeFailures(path, [toolFailure("full-timeout", "bash:npm test (timeout 60)", "bash failed: Command timed out after 60 seconds")], 1000);
  const request: FailureEvent = { id: "disp-1", operation: "incident-disposition", kind: "disposition", disposition: "superseded",
    incidents: ["full-timeout"], reason: "scoped retry passed", evidence: "attempt scoped-tests (output.log#byte=900)" };
  const result = disposeIncidents(path, request, 2000);
  assert.equal(result.accepted, true);
  const state = readFailureState(path);
  assert.equal(activeFailures(state).length, 0);
  assert.equal(formatFailureSummary(state), "", "closed incidents leave active summaries");
  assert.equal(failureCounts(state).superseded, 1);
  assert.equal(failureHistory(state).length, 1);
  assert.equal(failureHistory(state)[0]!.disposition?.evidence, "attempt scoped-tests (output.log#byte=900)");
  assert.equal(failureAttentionHandled(state, ["full-timeout"]), true);
  assert.deepEqual(disposeIncidents(path, request, 3000).accepted, true, "replaying the accepted event is idempotent");
  assert.match(disposeIncidents(path, { ...request, id: "disp-2" }, 3000).error!, /already disposed/);
  // Reload in a fresh process: the disposition is append-only and replayed.
  const restored = freshState(path);
  assert.equal(activeFailures(restored).length, 0);
  assert.equal(restored.dispositions.length, 1);
  // A later failure of the same operation is a new incident; the old one stays in history.
  observeFailures(path, [toolFailure("full-timeout-again", "bash:npm test (timeout 60)", "bash failed: timed out again")], 4000);
  const reopened = readFailureState(path);
  assert.deepEqual(activeFailures(reopened).map((x) => x.id), ["full-timeout-again"]);
  assert.equal(reopened.history?.["full-timeout"]?.status, "superseded");
}));

test("invalid, unknown, evidence-free, or partially invalid dispositions fail closed and are not journaled", () => fixture((path) => {
  observeFailures(path, [toolFailure("a", "op-a"), toolFailure("b", "op-b")], 1000);
  const before = readFileSync(path, "utf8");
  const base: FailureEvent = { id: "x", operation: "incident-disposition", kind: "disposition", disposition: "superseded",
    incidents: ["a"], reason: "verified elsewhere", evidence: "attempt z" };
  const rejected: Array<[Partial<FailureEvent>, RegExp]> = [
    [{ incidents: ["nope"] }, /Unknown incident nope/],
    [{ incidents: [] }, /at least one incident/],
    [{ incidents: ["a", "a"] }, /more than once/],
    [{ reason: "  " }, /requires a reason/],
    [{ evidence: undefined }, /requires evidence/],
    [{ disposition: "recovered", evidence: "" }, /requires evidence/],
    [{ disposition: "fixed" as never }, /Unknown disposition/],
    [{ incidents: ["a", "nope"] }, /Unknown incident nope/],
  ];
  for (const [patch, message] of rejected) {
    const outcome = disposeIncidents(path, { ...base, ...patch }, 2000);
    assert.equal(outcome.accepted, false);
    assert.match(outcome.error!, message);
  }
  assert.equal(readFileSync(path, "utf8"), before, "rejected requests write nothing");
  assert.equal(activeFailures(readFailureState(path)).length, 2, "a partially invalid request disposes nothing");
  // The pure reducer is also closed: an invalid event neither changes state nor consumes its id.
  const state = readFailureState(path);
  assert.equal(reduceFailure(state, { ...base, incidents: ["nope"] }, 3000), state);
  assert.ok(validateDisposition(state, { ...base, kind: "failure" }));
}));

test("expected and open dispositions: expected leaves attention, open makes an agent failure actionable", () => {
  let state = reduceFailure(emptyFailureState(), toolFailure("probe", "rg"), 1000);
  state = reduceFailure(state, { id: "e", operation: "incident-disposition", kind: "disposition", disposition: "expected",
    incidents: ["probe"], reason: "rg exit 1 means no match" }, 2000);
  assert.match(formatFailureSummary(state), /^Expected failure · .*expected: rg exit 1 means no match/);
  assert.equal(pendingFailureAttention(state, 999_999, { terminal: true }), undefined);
  state = reduceFailure(state, toolFailure("blocked", "gh auth", "bash failed: HTTP 401"), 3000);
  assert.equal(pendingFailureAttention(state, 999_999), undefined);
  state = reduceFailure(state, { id: "o", operation: "incident-disposition", kind: "disposition", disposition: "open",
    incidents: ["blocked"], reason: "needs parent credentials" }, 4000);
  assert.match(formatFailureSummary(state), /^Action required · .*HTTP 401.*open: needs parent credentials/);
  assert.deepEqual(pendingFailureAttention(state, 999_999)?.incidents, ["blocked"]);
  assert.equal(reduceFailure(state, { id: "o2", operation: "incident-disposition", kind: "disposition", disposition: "open",
    incidents: ["blocked"], reason: "again" }, 5000), state, "an incident is opened once");
});

test("terminal facts separate actionable incidents, unclassified history, and lifecycle-independent correctness", () => {
  let state = emptyFailureState();
  for (let i = 0; i < 8; i++) state = reduceFailure(state, toolFailure(`t${i}`, `op-${i}`, `bash failed: probe ${i}`), 1000 + i);
  state = reduceFailure(state, { id: "exit", operation: "child-exit", kind: "failure", category: "exit", summary: "Child exited with code 1" }, 2000);
  const due = pendingFailureAttention(state, 3000, { terminal: true })!;
  assert.equal(due.incidents.length, 9, "every unresolved incident is receipted once at completion");
  const facts = formatTerminalFailureFacts(state, due.incidents);
  assert.match(facts, /^Action required · .*Child exited with code 1/);
  assert.match(facts, /8 earlier tool failures remain unclassified\./);
  assert.match(facts, /Work correctness was not inferred from lifecycle alone\./);
  assert.doesNotMatch(facts, /probe \d/, "unclassified tool failures are counted, not re-listed");
});

test("exit zero or a success claim never resolves an unrelated incident; only named recovery of the same operation does", () => {
  let state = reduceFailure(emptyFailureState(), toolFailure("t", "op"), 1000);
  state = reduceFailure(state, { id: "unrelated", operation: "other-op", kind: "recovered", incidents: ["t"] }, 2000);
  state = reduceFailure(state, { id: "claim", operation: "op", kind: "recovered" }, 2000);
  assert.equal(activeFailures(state).length, 1);
  state = reduceFailure(state, { id: "retry", operation: "op", kind: "recovered", incidents: ["t"] }, 3000);
  assert.equal(activeFailures(state).length, 0);
  assert.equal(failureCounts(state).recovered, 1);
  assert.match(formatFailureSummary(reduceFailure(state, toolFailure("n", "op2"), 4000)), /Closed incidents retained in history: 1 recovered\./);
});

test("a consumer can defer running observation gaps to its terminal callback without losing them", () => {
  const gap: FailureEvent = { id: "gap", operation: "child-log", kind: "incomplete", summary: "Child log contains an oversized event" };
  const state = reduceFailure(emptyFailureState(), gap, 1000);
  assert.deepEqual(pendingFailureAttention(state, 1000)?.incidents, ["gap"], "default: gaps are due at once");
  assert.equal(pendingFailureAttention(state, 999_999, { deferObservationGaps: true }), undefined);
  assert.deepEqual(pendingFailureAttention(state, 1000, { terminal: true, deferObservationGaps: true })?.incidents, ["gap"]);
  assert.match(formatTerminalFailureFacts(state, ["gap"]), /^Observation incomplete · .*oversized event/);
});

test("an expected-disposed incident keeps its classification when a later exact retry succeeds", () => {
  let state = reduceFailure(emptyFailureState(), toolFailure("p", "probe"), 1000);
  state = reduceFailure(state, { id: "e", operation: "incident-disposition", kind: "disposition", disposition: "expected",
    incidents: ["p"], reason: "intentional probe" }, 2000);
  state = reduceFailure(state, { id: "retry", operation: "probe", kind: "recovered", incidents: ["p"] }, 3000);
  assert.equal(failureCounts(state).expected, 1);
  assert.equal(failureCounts(state).recovered, 0);
  assert.equal(activeFailures(state)[0]!.disposition?.disposition, "expected");
});

test("rejected command intents are agent-owned, visible, and never actionable on their own", () => {
  const state = reduceFailure(emptyFailureState(), { id: "r", operation: "rejected-intent:r", kind: "failure", category: "rejected-intent",
    summary: "bash not run: invalid command intent" }, 1000);
  assert.match(formatFailureSummary(state), /^Unclassified failure observation · .*not run/);
  assert.equal(pendingFailureAttention(state, 999_999), undefined);
});

test("shared incident pages keep row counts, resume by cursor, and bind their scope (#323)", () => {
  let state = emptyFailureState();
  for (let i = 0; i < 6; i += 1) {
    state = reduceFailure(state, { id: `op-${i}`, operation: `op-${i}`, kind: "failure", category: "operation", summary: `failure ${i} ${"x".repeat(60)}` }, 1000 + i);
  }
  assert.equal(incidentPageHeading(6), "Incident page of 6 active failure observations.");
  assert.equal(incidentPageHeading(1), "Incident page of 1 active failure observation.");
  const resource = incidentResource("session:abc", "task-1");
  assert.equal(resource, "incidents:session:abc:task-1");
  const lines: string[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = incidentVerbatimPage(state, { cursor, maxBytes: 200, resource });
    assert.equal(page.omittedBytes, 0);
    assert.ok(Buffer.byteLength(page.text) <= 200);
    lines.push(page.text);
    if (!page.hasMore) { assert.equal(page.omittedRows, 0); break; }
    assert.ok(page.omittedRows > 0);
    cursor = page.nextCursor;
  }
  assert.equal(lines.join("\n").split("\n").filter(Boolean).length >= 6, true);
  const crossed = incidentVerbatimPage(state, { cursor, maxBytes: 200, resource: incidentResource("all", "task-1") });
  assert.equal(crossed.reset, "stale-cursor");
  assert.equal(incidentVerbatimPage(emptyFailureState(), { resource }).text, "No active failure observations.");
});

test("the journal fingerprint changes on every append, deletion, and marker change (#323)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "failure-fingerprint-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "failures.jsonl");
  const missing = failureJournalFingerprint(path);
  assert.match(missing, /^unreadable:ENOENT\|0\|0$/);
  observeFailures(path, [failed], 1000);
  const once = failureJournalFingerprint(path);
  assert.notEqual(once, missing);
  assert.equal(failureJournalFingerprint(path), once, "stable while unchanged");
  observeFailures(path, [{ ...failed, id: "second", operation: "other" }], 2000);
  const twice = failureJournalFingerprint(path);
  assert.notEqual(twice, once);
  rmSync(path);
  assert.match(failureJournalFingerprint(path), /^unreadable:ENOENT\|1\|0$/, "a lost journal keeps its marker");

test("#325 terminal summary under a budget sweep: rows drop first, output never exceeds the budget, notes are never cut", () => {
  let state = emptyFailureState();
  for (let i = 0; i < 6; i++) state = reduceFailure(state, toolFailure(`t${i}`, `op-${i}`, `bash failed: probe ${i}`), 1000 + i);
  for (let i = 0; i < 3; i++) {
    state = reduceFailure(state, { id: `exit-${i}`, operation: `child-exit-${i}`, kind: "failure", category: "exit",
      summary: `Child exited with code ${i + 1}: ${"x".repeat(120)}` }, 2000 + i);
  }
  state = reduceFailure(state, toolFailure("e", "probe-e", "bash exited with declared expected code 1"), 3000);
  state = reduceFailure(state, { id: "ex", operation: "incident-disposition", kind: "disposition", disposition: "expected", incidents: ["e"], reason: "probe" }, 3001);
  state = reduceFailure(state, toolFailure("r", "op-r"), 3002);
  state = reduceFailure(state, { id: "rr", operation: "op-r", kind: "recovered", incidents: ["r"] }, 3003);
  for (const retrieval of [undefined, `pass as cursor to subagent_result id="sa_sweep"`]) {
  const whole = formatTerminalIncidentSummary(state, { maxBytes: Number.MAX_SAFE_INTEGER, resource: "sweep", retrieval });
  const allLines = new Set(whole.text.split("\n"));
  const correctness = Buffer.byteLength(CORRECTNESS_NOTE);
  let sawRowsWithCorrectness = false;
  let sawCorrectnessOnly = false;
  for (let maxBytes = 0; maxBytes <= Buffer.byteLength(whole.text) + 10; maxBytes += 1) {
    const out = formatTerminalIncidentSummary(state, { maxBytes, resource: "sweep", retrieval });
    assert.ok(Buffer.byteLength(out.text) <= maxBytes, `budget ${maxBytes}: ${Buffer.byteLength(out.text)} bytes`);
    const lines = out.text ? out.text.split("\n") : [];
    for (const line of lines) {
      // Every line is whole: either a line of the unbounded summary, or a count line.
      assert.ok(allLines.has(line) || /^\d+ active failure observations · \d+ shown · \d+ omitted · /.test(line), `budget ${maxBytes}: clipped line ${JSON.stringify(line)}`);
    }
    if (maxBytes >= correctness) assert.ok(lines.includes(CORRECTNESS_NOTE), `budget ${maxBytes}: the correctness note is kept whenever it fits`);
    else assert.ok(!out.text.includes("Work correctness"), "the note is never cut mid-sentence");
    const rows = lines.filter((line) => line.startsWith("Action required"));
    if (rows.length && lines.includes(CORRECTNESS_NOTE)) sawRowsWithCorrectness = true;
    if (lines.length === 1 && lines[0] === CORRECTNESS_NOTE) sawCorrectnessOnly = true;
    // Rows are dropped before any note: a row is only present when every note is.
    if (rows.length) for (const note of whole.text.split("\n").filter((x) => !x.startsWith("Action required") && !/active failure observations/.test(x))) {
      assert.ok(lines.includes(note), `budget ${maxBytes}: note ${JSON.stringify(note)} dropped while a row was kept`);
    }
    assert.equal(out.represented + out.omitted, out.total);
    if (out.nextCursor) assert.ok(out.text.includes(`incidentCursor=${out.nextCursor}`), "a returned cursor is always shown whole");
  }
  assert.ok(sawRowsWithCorrectness && sawCorrectnessOnly);
  }
});

test("#325 one command-intent validator for subagents and background tasks, with caller field names", () => {
  assert.deepEqual(readCommandIntent({ operationId: "unit-tests", expectedExitCodes: [1, 2] }).intent, { operationId: "unit-tests", expectedExitCodes: [1, 2] });
  const names = { operationId: "operation_id", expectedExitCodes: "expected_exit_codes" };
  assert.match(readCommandIntent({ expectedExitCodes: [1, 1] }, names).error!, /^expected_exit_codes must be 1-16 distinct integers/);
  assert.match(readCommandIntent({ operationId: "has space" }, names).error!, /^operation_id must match/);
  for (const bad of [[0], [256], [], [1.5], Array.from({ length: 17 }, (_, i) => i + 1)]) {
    assert.ok(readCommandIntent({ expectedExitCodes: bad }).error, JSON.stringify(bad));
  }
});
