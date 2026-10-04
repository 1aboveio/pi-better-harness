// @covers background-callback.batch
// @level unit
// @fails-without-fix background-callback.batch
import assert from "node:assert/strict";
import test from "node:test";

import {
  CALLBACK_BATCH_BUDGET_BYTES,
  CALLBACK_BATCH_MAX_BYTES,
  callbackBatchBudget,
  createCallbackBatcher,
  formatCallbackBatch,
  formatUrgentCallback,
  packCallbackBatch,
  utf8ByteLength,
  type CallbackBatchEvent,
  type CallbackBatchHost,
} from "./index.ts";

function event(
  id: string,
  overrides: Partial<CallbackBatchEvent> = {},
): CallbackBatchEvent {
  return {
    source: "subagent",
    id,
    label: `worker ${id}`,
    status: "completed",
    detailTool: "subagent_result",
    callback: true,
    ...overrides,
  };
}

function recordingHost() {
  const messages: Array<{
    message: { customType: string; content: string; display: boolean };
    options: Record<string, unknown>;
  }> = [];
  const host: CallbackBatchHost = {
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  return { host, messages };
}

test("successful handoffs retry failed receipt hooks without sending again", async () => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10000 });
  let writable = false;
  let receipts = 0;
  const onDelivered = () => { if (!writable) throw new Error("receipt write failed"); receipts++; };
  batcher.enqueue(event("ordinary", { onDelivered }));
  assert.equal(await batcher.flush(), false);
  assert.equal(await batcher.flush(), false);
  assert.equal(messages.length, 1);
  writable = true;
  assert.equal(await batcher.flush(), true);
  assert.equal(receipts, 1);
  assert.equal(messages.length, 1);
  writable = false;
  const urgent = { source: "subagent" as const, id: "urgent", label: "urgent", status: "failure", customType: "failure", content: "failure", onDelivered };
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.equal(messages.length, 2);
  writable = true;
  assert.equal(await batcher.deliverUrgent(urgent), true);
  assert.equal(receipts, 2, "the urgent receipt is persisted after storage recovers");
  assert.equal(messages.length, 2);
  batcher.cancel();
});

test("coalesces callback-enabled completions in stable enqueue order", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_2", { onDelivered: () => delivered.push("sa_2") }));
  batcher.enqueue(event("bg_1", {
    source: "background-task",
    label: "build",
    status: "failed",
    detailTool: "bg_task_status",
    onDelivered: () => delivered.push("bg_1"),
  }));
  batcher.enqueue(event("sa_3", { status: "failed", onDelivered: () => delivered.push("sa_3") }));

  assert.equal(await batcher.flush(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message.content, /^3 background completions are ready:/);
  for (const id of ["sa_2", "bg_1", "sa_3"]) assert.match(messages[0]!.message.content, new RegExp(`id=${id} \\|`));
  assert.ok(messages[0]!.message.content.indexOf("sa_2") < messages[0]!.message.content.indexOf("bg_1"));
  assert.ok(messages[0]!.message.content.indexOf("bg_1") < messages[0]!.message.content.indexOf("sa_3"));
  assert.deepEqual(delivered, ["sa_2", "bg_1", "sa_3"]);
  assert.deepEqual(messages[0]!.options, { deliverAs: "followUp", triggerTurn: true });
});

test("debounces a single completion and flushes it after the bounded window", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_single", { onDelivered: () => delivered.push("sa_single") }));
  t.mock.timers.tick(24);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 0);

  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message.content, /^1 background completion is ready:/);
  assert.deepEqual(delivered, ["sa_single"]);
});

test("busy completions wait for availability and aggregate across debounce windows (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = false;
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, isAvailable: () => idle });
  try {
    for (const id of ["sa_first", "sa_second", "sa_third"]) {
      batcher.enqueue(event(id, { onDelivered: () => delivered.push(id) }));
      t.mock.timers.tick(100);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(await batcher.flush(), false, "explicit flush cannot bypass foreground availability");
    assert.equal(messages.length, 0);
    assert.deepEqual(delivered, []);
    assert.equal(batcher.pendingCount(), 3);

    idle = true;
    batcher.setAvailability(() => idle);
    assert.equal(messages.length, 0, "availability notification must not start a reentrant model run");
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.match(messages[0]!.message.content, /^3 background completions are ready:/);
    assert.deepEqual(delivered, ["sa_first", "sa_second", "sa_third"]);
    assert.equal(batcher.pendingCount(), 0);
  } finally { batcher.cancel(); }
});

test("arrivals and overflow during a completion-driven run wait for the next availability (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = false;
  const messages: string[] = [];
  const delivered: string[] = [];
  const batcher = createCallbackBatcher({ sendMessage(message) {
    messages.push(message.content);
    idle = false;
  } }, { windowMs: 25, maxBytes: 700, isAvailable: () => idle });
  try {
    for (const id of ["sa_a", "sa_b", "sa_c", "sa_d"]) {
      batcher.enqueue(event(id, { label: "x".repeat(160), onDelivered: () => delivered.push(id) }));
    }
    idle = true;
    batcher.setAvailability(() => idle);
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.ok(batcher.pendingCount() > 0, "bounded overflow stays queued");
    batcher.enqueue(event("sa_during_run"));
    t.mock.timers.tick(1000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1, "neither overflow nor concurrent arrivals preload future turns");
    while (batcher.pendingCount() > 0) {
      const before: number = messages.length;
      idle = true;
      batcher.setAvailability(() => idle);
      t.mock.timers.tick(25);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(messages.length, before + 1);
    }
    assert.equal(new Set(delivered).size, 4);
    assert.equal(delivered.length, 4);
    assert.equal(messages.filter((message) => message.includes("id=sa_during_run |")).length, 1);
  } finally { batcher.cancel(); }
});

test("availability errors defer sends and suppression is rechecked after the busy run (#409)", async () => {
  const { host, messages } = recordingHost();
  let unreadable = true;
  let cancelled = false;
  const suppressed: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, isAvailable: () => {
    if (unreadable) throw new Error("session availability unavailable");
    return true;
  } });
  try {
    batcher.enqueue(event("sa_cancelled", {
      getSuppressionReason: () => cancelled ? "cancelled while foreground was busy" : undefined,
      onSuppressed: (reason) => suppressed.push(reason),
    }));
    batcher.enqueue(event("sa_remaining"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 0);
    cancelled = true;
    unreadable = false;
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0]!.message.content, /sa_cancelled/);
    assert.deepEqual(suppressed, ["cancelled while foreground was busy"]);
  } finally { batcher.cancel(); }
});

test("a foreground run starting inside the debounce window prevents the scheduled handoff (#409)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let idle = true;
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 25, isAvailable: () => idle });
  try {
    batcher.enqueue(event("sa_before_foreground"));
    idle = false;
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 0);
    assert.equal(batcher.pendingCount(), 1);
    idle = true;
    batcher.setAvailability(() => idle);
    t.mock.timers.tick(25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(messages.length, 1);
    assert.equal(batcher.pendingCount(), 0);
  } finally { batcher.cancel(); }
});

test("bounds event text and excludes caller-supplied result and log payloads", () => {
  const resultSentinel = "FULL_RESULT_SENTINEL";
  const logSentinel = "RAW_LOG_SENTINEL";
  const content = formatCallbackBatch([
    {
      ...event("sa_bounded", { label: `label-${"x".repeat(10_000)}` }),
      result: resultSentinel,
      log: logSentinel,
    } as CallbackBatchEvent,
  ]);

  assert.ok(content.length < 700, `single-event callback must stay bounded; got ${content.length}`);
  assert.match(content, /source=subagent/);
  assert.match(content, /id=sa_bounded/);
  assert.match(content, /status=completed/);
  assert.match(content, /subagent_result id="sa_bounded"/);
  assert.doesNotMatch(content, new RegExp(`${resultSentinel}|${logSentinel}`));
  assert.match(content, /Full results and logs are intentionally omitted/);
  assert.match(content, /cursor\/limit/);
  assert.doesNotMatch(content, /tools used:| · tools: |read,bash,write/);
});

test("keeps failed snapshots retryable and merges concurrent arrivals exactly once", async () => {
  let rejectFirst!: (reason: Error) => void;
  let attempt = 0;
  const contents: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    sendMessage(message) {
      contents.push(message.content);
      attempt += 1;
      if (attempt === 1) return new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    },
  };
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_a", { onDelivered: () => delivered.push("sa_a") }));
  batcher.enqueue(event("sa_b", { onDelivered: () => delivered.push("sa_b") }));
  const failedFlush = batcher.flush();
  batcher.enqueue(event("sa_c", { onDelivered: () => delivered.push("sa_c") }));
  batcher.enqueue(event("sa_a", { onDelivered: () => delivered.push("duplicate") }));
  rejectFirst(new Error("simulated handoff failure"));

  assert.equal(await failedFlush, false);
  assert.deepEqual(delivered, [], "failed handoff must not mark any event delivered");
  assert.equal(batcher.pendingCount(), 3);

  assert.equal(await batcher.flush(), true);
  assert.equal(contents.length, 2);
  assert.ok(contents[1]!.indexOf("sa_a") < contents[1]!.indexOf("sa_b"));
  assert.ok(contents[1]!.indexOf("sa_b") < contents[1]!.indexOf("sa_c"));
  assert.equal((contents[1]!.match(/id=sa_a/g) ?? []).length, 1);
  assert.deepEqual(delivered, ["sa_a", "sa_b", "sa_c"]);
});

test("filters callback:false and ownership-suppressed events out of a mixed batch", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const suppressed: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });

  batcher.enqueue(event("sa_active", { onDelivered: () => delivered.push("sa_active") }));
  batcher.enqueue(event("sa_quiet", {
    callback: false,
    onDelivered: () => delivered.push("sa_quiet"),
  }));
  batcher.enqueue(event("bg_foreign", {
    source: "background-task",
    detailTool: "bg_task_status",
    getSuppressionReason: () => "origin session-a does not match active session-b",
    onSuppressed: (reason) => suppressed.push(reason),
  }));

  assert.equal(await batcher.flush(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.message.content, /sa_active/);
  assert.doesNotMatch(messages[0]!.message.content, /sa_quiet|bg_foreign/);
  assert.deepEqual(delivered, ["sa_active"]);
  assert.deepEqual(suppressed, ["origin session-a does not match active session-b"]);
});

test("delivery-state read errors defer a batch instead of permanently suppressing it", async () => {
  let unreadable = true;
  let sent = 0;
  let suppressed = 0;
  const batcher = createCallbackBatcher({ sendMessage() { sent++; } }, { windowMs: 10_000, retryMs: 10_000 });
  try {
    batcher.enqueue({ ...event("sa_read_error"),
      isDelivered: () => { if (unreadable) throw new Error("temporary metadata read error"); return false; },
      onSuppressed: () => { suppressed++; },
    });
    assert.equal(await batcher.flush(), false);
    assert.equal(batcher.pendingCount(), 1);
    assert.equal(suppressed, 0);
    assert.equal(sent, 0);
    unreadable = false;
    assert.equal(await batcher.flush(), true);
    assert.equal(sent, 1);
  } finally { batcher.cancel(); }
});

test("one unreadable receipt does not block unrelated deliverable completions", async () => {
  const messages: string[] = [];
  const batcher = createCallbackBatcher({ sendMessage(message) { messages.push(message.content); } }, { windowMs: 10_000, retryMs: 10_000 });
  try {
    batcher.enqueue({ ...event("sa_unreadable"), isDelivered: () => { throw new Error("unreadable receipt"); } });
    batcher.enqueue(event("sa_ready"));
    assert.equal(await batcher.flush(), false);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /sa_ready/);
    assert.doesNotMatch(messages[0]!, /sa_unreadable/);
    assert.equal(batcher.pendingCount(), 1);
  } finally { batcher.cancel(); }
});

test("urgent ownership read errors remain retryable and do not acknowledge suppression", async () => {
  let unreadable = true;
  let sent = 0;
  let suppressed = 0;
  const batcher = createCallbackBatcher({ sendMessage() { sent++; } });
  const urgent = { ...event("sa_unverified"), customType: "failure-attention", content: "Failure needs attention",
    getSuppressionReason: () => { if (unreadable) throw new Error("temporary ownership read error"); return undefined; },
    onSuppressed: () => { suppressed++; },
  };
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.equal(suppressed, 0);
  assert.equal(sent, 0);
  unreadable = false;
  assert.equal(await batcher.deliverUrgent(urgent), true);
  assert.equal(sent, 1);
});

test("urgent health signals bypass an ordinary batch and retry without early markers", async () => {
  let failUrgent = true;
  const sends: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    sendMessage(message) {
      sends.push(message.content);
      if (message.customType === "subagent-health" && failUrgent) {
        failUrgent = false;
        throw new Error("simulated urgent handoff failure");
      }
    },
  };
  const batcher = createCallbackBatcher(host, { windowMs: 25, retryMs: 50 });
  batcher.enqueue(event("sa_ordinary"));

  const urgent = {
    source: "subagent" as const,
    id: "sa_orphaned",
    label: "reviewer",
    status: "orphaned",
    customType: "subagent-health",
    content: "ATTENTION: subagent sa_orphaned is orphaned; inspect subagent_result.",
    onDelivered: () => delivered.push("sa_orphaned"),
  };
  assert.equal(await batcher.deliverUrgent(urgent), false);
  assert.deepEqual(delivered, []);
  assert.equal(batcher.pendingCount(), 1, "ordinary completion remains queued");

  assert.equal(await batcher.deliverUrgent(urgent), true);
  assert.deepEqual(delivered, ["sa_orphaned"]);
  assert.equal(sends.length, 2, "urgent retries immediately and never waits for the ordinary flush");
  assert.match(sends[1]!, /orphaned/);

  assert.equal(await batcher.flush(), true);
  assert.equal(sends.length, 3);
  assert.match(sends[2]!, /sa_ordinary/);
});


test("callback batch default budget is 2 KiB and explicit pages clamp to 8 KiB", () => {
  assert.equal(CALLBACK_BATCH_BUDGET_BYTES, 2 * 1024);
  assert.equal(CALLBACK_BATCH_MAX_BYTES, 8 * 1024);
  assert.equal(callbackBatchBudget(), 2 * 1024);
  assert.equal(callbackBatchBudget(512), 512);
  assert.equal(callbackBatchBudget(99_999), 8 * 1024);
  assert.equal(callbackBatchBudget(0), 2 * 1024);
  assert.equal(callbackBatchBudget(Number.NaN), 2 * 1024);
});

test("large batches stay within 2 KiB, count omitted rows, and receipt only represented events", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  try {
    for (let i = 0; i < 80; i++) {
      const failed = i % 7 === 0;
      batcher.enqueue(event(`sa_${String(i).padStart(3, "0")}`, {
        status: failed ? "failed; unresolved failure observations" : "completed",
        outcome: failed ? "failed" : "completed",
        failure: failed ? `Unresolved failure · incident ${i} · poll exploded` : undefined,
        omittedIncidents: failed ? 3 : undefined,
        incidentCount: failed ? 4 : undefined,
        onDelivered: () => delivered.push(`sa_${String(i).padStart(3, "0")}`),
      }));
    }
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 1);
    const content = messages[0]!.message.content;
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `batch was ${utf8ByteLength(content)} bytes`);
    assert.match(content, /omitted from this batch \(not receipted; still queued\)/);
    assert.match(content, /cursor\/limit/);
    assert.match(content, /failure:/);
    assert.match(content, /omittedIncidents=3/);
    assert.doesNotMatch(content, /tools used:/);
    assert.ok(delivered.length >= 1);
    assert.ok(delivered.length < 80);
    assert.equal(batcher.pendingCount(), 80 - delivered.length);
    assert.match(content, /status=failed/);
    const first = [...delivered];
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 2);
    assert.ok(utf8ByteLength(messages[1]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
    assert.ok(delivered.length > first.length);
    for (const id of first) {
      assert.equal(delivered.filter((item) => item === id).length, 1, `${id} was receipted twice`);
      assert.doesNotMatch(messages[1]!.message.content, new RegExp(`id=${id} \\|`));
    }
  } finally {
    batcher.cancel();
  }
});

test("Unicode long labels stay inside the UTF-8 budget without splitting a code point", async () => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host, { windowMs: 10_000 });
  try {
    const label = "日本語🔥".repeat(400);
    batcher.enqueue(event("sa_unicode", { label, status: "completed" }));
    assert.equal(await batcher.flush(), true);
    const content = messages[0]!.message.content;
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `unicode batch was ${utf8ByteLength(content)} bytes`);
    assert.doesNotMatch(content, /\uFFFD/);
    assert.match(content, /日本語|🔥/);
    assert.match(content, /id=sa_unicode/);
  } finally {
    batcher.cancel();
  }
});

test("many failures keep decisive facts and omitted incident counts before routine completions", () => {
  const events = [
    event("sa_ok", { status: "completed", outcome: "completed" }),
    event("sa_fail", {
      status: "failed; unresolved failure observations",
      outcome: "failed",
      failure: "Unresolved failure · poll exploded · evidence: ref=e42",
      decision: "Condition matched: $.terminalFailure = true",
      incidentCount: 12,
      omittedIncidents: 7,
    }),
    event("bg_gap", {
      source: "background-task",
      detailTool: "bg_task_status",
      status: "failed",
      outcome: "failed",
      decision: "Permission denied while terminating process tree. The task may still be executing.",
    }),
  ];
  const packed = packCallbackBatch(events);
  assert.ok(utf8ByteLength(packed.text) <= CALLBACK_BATCH_BUDGET_BYTES);
  assert.match(packed.text, /failure: Unresolved failure/);
  assert.match(packed.text, /omittedIncidents=7 retrieve: subagent_result id="sa_fail"/);
  assert.match(packed.text, /Condition matched: \$\.terminalFailure = true/);
  assert.match(packed.text, /Permission denied while terminating process tree/);
  assert.match(packed.text, /subagent_result id="sa_fail"/);
  assert.match(packed.text, /bg_task_status id=bg_gap/);
  assert.doesNotMatch(packed.text, /tools used:|FULL_LOG|environment/);
  assert.equal(packed.omitted, 0);
});

test("a failed sendMessage receipts nobody and retries the same represented plus overflow rows", async () => {
  let failNext = true;
  const contents: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    sendMessage(message) {
      if (failNext) {
        failNext = false;
        throw new Error("simulated handoff failure");
      }
      contents.push(message.content);
    },
  };
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  try {
    for (let i = 0; i < 40; i++) {
      batcher.enqueue(event(`row_${i}`, {
        label: `long-label-${"🔥".repeat(20)}-${i}`,
        status: i === 39 ? "failed" : "completed",
        failure: i === 39 ? "Unresolved failure · last row" : undefined,
        onDelivered: () => delivered.push(`row_${i}`),
      }));
    }
    assert.equal(await batcher.flush(), false);
    assert.deepEqual(delivered, []);
    assert.equal(batcher.pendingCount(), 40);
    assert.equal(await batcher.flush(), true);
    assert.equal(contents.length, 1);
    assert.ok(utf8ByteLength(contents[0]!) <= CALLBACK_BATCH_BUDGET_BYTES);
    assert.ok(delivered.length >= 1);
    assert.ok(delivered.length < 40);
    assert.match(contents[0]!, /failure:/);
    assert.equal(batcher.pendingCount(), 40 - delivered.length);
  } finally {
    batcher.cancel();
  }
});

test("origin isolation, callback:false, and pending overflow do not receipt omitted rows", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const suppressed: string[] = [];
  const batcher = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  try {
    batcher.enqueue(event("sa_quiet", {
      callback: false,
      onDelivered: () => delivered.push("sa_quiet"),
    }));
    batcher.enqueue(event("sa_foreign", {
      getSuppressionReason: () => "origin session-a does not match active session-b",
      onSuppressed: (reason) => suppressed.push(reason),
      onDelivered: () => delivered.push("sa_foreign"),
    }));
    for (let i = 0; i < 30; i++) {
      batcher.enqueue(event(`sa_keep_${i}`, {
        label: `worker ${"x".repeat(80)} ${i}`,
        onDelivered: () => delivered.push(`sa_keep_${i}`),
      }));
    }
    assert.equal(await batcher.flush(), true);
    assert.equal(messages.length, 1);
    assert.doesNotMatch(messages[0]!.message.content, /sa_quiet|sa_foreign/);
    assert.deepEqual(suppressed, ["origin session-a does not match active session-b"]);
    assert.ok(!delivered.includes("sa_quiet"));
    assert.ok(!delivered.includes("sa_foreign"));
    assert.ok(utf8ByteLength(messages[0]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
    if (batcher.pendingCount() > 0) {
      assert.match(messages[0]!.message.content, /not receipted; still queued/);
    }
  } finally {
    batcher.cancel();
  }
});

test("urgent callback content is bounded to 2 KiB with receipts, counts, and retrieval", async () => {
  const { host, messages } = recordingHost();
  const batcher = createCallbackBatcher(host);
  try {
    const huge = `URGENT_BODY ${"你".repeat(3_000)} ${"x".repeat(4_000)}`;
    assert.ok(utf8ByteLength(huge) > CALLBACK_BATCH_BUDGET_BYTES);
    let receipts = 0;
    assert.equal(await batcher.deliverUrgent({
      source: "subagent",
      id: "sa_urgent_bound",
      label: "reviewer",
      status: "failure",
      customType: "subagent-failure",
      content: huge,
      detailTool: "subagent_result",
      incidentCount: 12,
      omittedIncidents: 7,
      onDelivered: () => { receipts += 1; },
    }), true);
    assert.equal(messages.length, 1);
    const content = messages[0]!.message.content;
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `urgent was ${utf8ByteLength(content)} bytes`);
    assert.doesNotMatch(content, /\uFFFD/);
    assert.match(content, /sa_urgent_bound/);
    assert.match(content, /incidents=12 omittedIncidents=7 retrieve: subagent_result id="sa_urgent_bound"/);
    assert.match(content, /Inspect: subagent_result id="sa_urgent_bound"/);
    assert.match(content, /omittedBytes=\d+/);
    assert.equal(receipts, 1);
    assert.equal(content.includes(huge), false);
  } finally {
    batcher.cancel();
  }
});

test("callback overflow stays queued across a recreated batcher and is receipted once", async () => {
  const { host, messages } = recordingHost();
  const delivered: string[] = [];
  const first = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
  const events = Array.from({ length: 40 }, (_, i) => event(`sa_overflow_${String(i).padStart(2, "0")}`, {
    label: `overflow-${"文".repeat(30)}-${i}`,
    onDelivered: () => delivered.push(`sa_overflow_${String(i).padStart(2, "0")}`),
  }));
  try {
    for (const item of events) first.enqueue(item);
    assert.equal(await first.flush(), true);
    assert.equal(messages.length, 1);
    assert.ok(utf8ByteLength(messages[0]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
    const firstDelivered = [...delivered];
    assert.ok(firstDelivered.length >= 1);
    assert.ok(firstDelivered.length < 40);
    assert.equal(first.pendingCount(), 40 - firstDelivered.length);
    first.cancel();

    const second = createCallbackBatcher(host, { windowMs: 10_000, retryMs: 10_000 });
    try {
      for (const item of events) {
        second.enqueue({
          ...item,
          isDelivered: () => delivered.includes(item.id),
        });
      }
      assert.equal(await second.flush(), true);
      assert.equal(messages.length, 2);
      assert.ok(utf8ByteLength(messages[1]!.message.content) <= CALLBACK_BATCH_BUDGET_BYTES);
      for (const id of firstDelivered) {
        assert.equal(delivered.filter((item) => item === id).length, 1, `${id} receipted twice after reload`);
        assert.doesNotMatch(messages[1]!.message.content, new RegExp(`id=${id} \\|`));
      }
      assert.ok(delivered.length > firstDelivered.length);
      assert.equal(await second.flush(), true);
      const unique = new Set(delivered);
      assert.equal(unique.size, delivered.length, "no event was receipted twice while draining overflow");
    } finally {
      second.cancel();
    }
  } finally {
    first.cancel();
  }
});

function incidentRows(count: number, filler: string): string[] {
  return Array.from({ length: count }, (_, i) => `Unresolved failure · observed 2026-09-27T00:00:0${i % 10}Z · incident-${i} ${filler}`);
}

test("batch rows count exactly which incident rows they show and never claim clipped ones", () => {
  const rows = incidentRows(12, "界".repeat(150));
  const packed = packCallbackBatch([
    event("bg_many", { source: "background-task", detailTool: "bg_task_status", status: "failed", failureRows: rows }),
  ]);
  assert.ok(utf8ByteLength(packed.text) <= CALLBACK_BATCH_BUDGET_BYTES);
  const shown = rows.filter((row) => packed.text.includes(row)).length;
  assert.match(packed.text, new RegExp(`incidents=12 shown=${shown} omittedIncidents=${12 - shown} retrieve: bg_task_status id=bg_many`));
  assert.doesNotMatch(packed.text, /\uFFFD/);
});

test("a single oversized row shrinks its detail but keeps its incident counts and retrieval", () => {
  const rows = incidentRows(30, "x".repeat(380));
  const packed = packCallbackBatch([
    event("sa_huge", { label: "L".repeat(500), status: "failed", failureRows: rows, decision: "D".repeat(2_000) }),
    event("sa_next"),
  ], { maxBytes: 1_024 });
  assert.ok(utf8ByteLength(packed.text) <= 1_024, `${utf8ByteLength(packed.text)} bytes`);
  assert.deepEqual(packed.represented.map((item) => item.id), ["sa_huge"]);
  assert.match(packed.text, /incidents=30 shown=0 omittedIncidents=30 retrieve: subagent_result id="sa_huge"/);
  assert.match(packed.text, /1 more completion omitted from this batch \(not receipted; still queued\)/);
});

test("urgent callbacks keep the explanation, whole incident rows, exact counts, and one real inspect target", () => {
  for (const filler of ["x".repeat(4_000), "界".repeat(3_000)]) {
    const rows = incidentRows(12, filler.slice(0, 120));
    const content = formatUrgentCallback({
      source: "background-task",
      id: "failure:bg_task_1:deadbeef",
      inspectId: "bg_task_1",
      label: "deploy",
      status: "failure",
      customType: "background-task-failure",
      content: `Background task bg_task_1 needs attention. ${filler}`,
      detailTool: "bg_task_status",
      failureRows: rows,
    });
    assert.ok(utf8ByteLength(content) <= CALLBACK_BATCH_BUDGET_BYTES, `${utf8ByteLength(content)} bytes`);
    assert.doesNotMatch(content, /failure:bg_task_1:deadbeef/);
    assert.match(content, /^background-task id=bg_task_1 /);
    assert.match(content, /Background task bg_task_1 needs attention/);
    assert.match(content, /omittedBytes=\d+ retrieve: bg_task_status id=bg_task_1/);
    const shown = rows.filter((row) => content.includes(row)).length;
    assert.ok(shown >= 1, "at least one whole incident row fits beside the explanation");
    assert.match(content, new RegExp(`incidents=12 shown=${shown} omittedIncidents=${12 - shown} retrieve: bg_task_status id=bg_task_1`));
    assert.equal(content.match(/Inspect: bg_task_status id=bg_task_1/g)?.length, 1);
  }
});

test("urgent callbacks under a tiny budget still keep the counts ahead of any body", () => {
  const content = formatUrgentCallback({
    source: "subagent", id: "sa_tiny", label: "w", status: "lost", customType: "subagent-health",
    content: "ATTENTION ".repeat(200), failureRows: incidentRows(4, "y".repeat(100)),
  }, { maxBytes: 400 });
  assert.ok(utf8ByteLength(content) <= 400);
  assert.match(content, /incidents=4 shown=0 omittedIncidents=4/);
});

test("long completion statuses keep whole notes and name omissions instead of an ellipsis (#323)", () => {
  const notes = ["failed", "action required", "observation incomplete", ...Array.from({ length: 8 }, (_, i) => `note-${i}-${"q".repeat(20)}`)];
  const status = notes.join("; ");
  assert.ok(utf8ByteLength(status) > 160);
  const content = formatCallbackBatch([event("bg_long_status", { source: "background-task", status, detailTool: "bg_task_status", incidentCount: 3 })]);
  const field = content.match(/status=(.*?) \| inspect:/)?.[1];
  assert.ok(field, content);
  assert.ok(utf8ByteLength(field) <= 160, field);
  assert.doesNotMatch(field, /\.\.\.|…/);
  assert.match(field, /^failed; action required; observation incomplete; /);
  const kept = field.replace(/ \(\+\d+ more status notes?; see inspect\)$/, "").split("; ");
  for (const note of kept) assert.ok(notes.includes(note), `kept note ${note} must be whole`);
  const omitted = Number(field.match(/\(\+(\d+) more status notes?; see inspect\)$/)?.[1]);
  assert.equal(kept.length + omitted, notes.length);
  assert.match(content, /incidents=3 shown=0/);

  const short = formatCallbackBatch([event("bg_short_status", { status: "failed; 2 incidents need attention" })]);
  assert.match(short, /status=failed; 2 incidents need attention \| inspect:/);

  const urgent = formatUrgentCallback({
    source: "subagent", id: "sa_status", label: "w", status, customType: "subagent-health", content: "lost",
  });
  const header = urgent.split("\n")[0]!;
  assert.doesNotMatch(header, /\.\.\.|…/);
  assert.match(header, /status=failed; action required; .* \(\+\d+ more status notes?; see inspect\)$/);

  const single = formatCallbackBatch([event("sa_single_note", { status: `failed:${"z".repeat(400)}` })]);
  assert.match(single, /status=failed:z+ \(clipped; see inspect\) \| inspect:/);
});
