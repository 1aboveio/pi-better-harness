// @covers background-callback.batch
// @level integration
// @fails-without-fix background-callback.batch
import assert from "node:assert/strict";
import test from "node:test";

import {
  getCallbackBatcher as getSubagentCallbackBatcher,
  setCallbackBatchContext as setSubagentCallbackContext,
  type CallbackBatchHost,
} from "../pi-better-subagents/shared-callback-batcher.ts";
import {
  getCallbackBatcher as getBackgroundTaskCallbackBatcher,
  setCallbackBatchContext as setBackgroundTaskCallbackContext,
} from "../pi-better-background-tasks/src/shared-callback-batcher.ts";

test("#409 subagents and background tasks share one host availability gate and callback batch", async () => {
  const messages: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    events: {},
    sendMessage(message) {
      messages.push(message.content);
    },
  };

  const subagents = getSubagentCallbackBatcher(host, { windowMs: 25, retryMs: 50 });
  const backgroundHost: CallbackBatchHost = { ...host };
  assert.notEqual(host, backgroundHost, "Pi supplies a distinct API wrapper to each extension");
  const backgroundTasks = getBackgroundTaskCallbackBatcher(backgroundHost, { windowMs: 25, retryMs: 50 });
  assert.equal(subagents, backgroundTasks, "synchronized package copies must resolve one host singleton");
  let idle = false;
  setSubagentCallbackContext(host, { isIdle: () => idle });

  subagents.enqueue({
    source: "subagent",
    id: "sa_shared",
    label: "reviewer",
    status: "completed",
    detailTool: "subagent_result",
    onDelivered: () => delivered.push("sa_shared"),
  });
  backgroundTasks.enqueue({
    source: "background-task",
    id: "bg_shared",
    label: "build",
    status: "succeeded",
    detailTool: "bg_task_status",
    onDelivered: () => delivered.push("bg_shared"),
  });

  assert.equal(await backgroundTasks.flush(), false);
  assert.equal(messages.length, 0);
  assert.deepEqual(delivered, []);
  idle = true;
  setBackgroundTaskCallbackContext(backgroundHost, { isIdle: () => idle });
  assert.equal(await subagents.flush(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^2 background completions are ready:/);
  assert.match(messages[0]!, /source=subagent.*id=sa_shared.*subagent_result/s);
  assert.match(messages[0]!, /source=background-task.*id=bg_shared.*bg_task_status/s);
  assert.deepEqual(delivered, ["sa_shared", "bg_shared"]);
});
