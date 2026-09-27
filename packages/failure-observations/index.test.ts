import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFailureState, reduceFailure, activeFailures, formatFailureSummary, formatFailureLines, pageFailureIncidents, isIncidentCursor, incidentCursorAt, pendingFailureAttention,
  formatIncidentSummary, failureRevision,
  observeFailures, readFailureState, markFailureAttentionDelivered, failureAttentionHandled, type FailureEvent } from "./index.ts";

const failed: FailureEvent = { id: "call-1:end", operation: "cwd:project:tsc", kind: "failure",
  summary: "TypeScript exited 2", category: "tool", evidence: "output.log#call-1" };

test("failed writes retain all evidence and receipts, retry persistence, and avoid repeat attention", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "failure-write-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const blocker = join(dir, "blocked");
  writeFileSync(blocker, "not a directory");
  const path = join(blocker, "failures.jsonl");
  observeFailures(path, [failed, { ...failed, id: "second", operation: "another-check" }], 1000);
  const state = readFailureState(path);
  assert.match(formatFailureSummary(state), /could not be persisted/);
  assert.equal(activeFailures(state).filter((x) => x.category === "tool").length, 2);
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
  assert.match(formatFailureSummary(state), /Unresolved failure.*TypeScript exited 2.*output.log#call-1/);
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
