// @covers background-callback.batch
// @level unit
// @fails-without-fix background-callback.batch
import assert from "node:assert/strict";
import test from "node:test";

import {
  createCallbackBatcher,
  formatCallbackBatch,
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
