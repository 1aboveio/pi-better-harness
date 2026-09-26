import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFailureState, reduceFailure, activeFailures, formatFailureSummary, pendingFailureAttention,
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
  assert.match(readFileSync(path, "utf8"), /delivered:/);
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
  assert.strictEqual(reduceFailure(state, failed, 5000), state, "replayed old failure does not reopen the incident");
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

function fixture(run: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "failure-contract-"));
  try { run(join(dir, "failures.jsonl")); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("restart preserves observations, failed delivery remains pending, and successful handoff deduplicates", () => fixture((path) => {
  observeFailures(path, [failed], 1000);
  const pending = pendingFailureAttention(readFailureState(path), 100_000)!;
  assert.ok(pending);
  // No delivery receipt: a thrown/rejected handoff or reload must retry.
  assert.deepEqual(pendingFailureAttention(readFailureState(path), 100_000), pending);
  markFailureAttentionDelivered(path, pending, 100_001);
  assert.equal(pendingFailureAttention(readFailureState(path), 100_002), undefined);
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

test("special event IDs cannot suppress delivery through Object.prototype", () => {
  const state = reduceFailure(emptyFailureState(), { ...failed, id: "constructor" }, 1);
  assert.ok(pendingFailureAttention(state, 2, { terminal: true }));
});
