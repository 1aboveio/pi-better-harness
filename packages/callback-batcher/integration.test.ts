// @covers background-callback.batch
// @level integration
// @fails-without-fix background-callback.batch
import assert from "node:assert/strict";
import test from "node:test";

import {
  getCallbackBatcher as getSubagentCallbackBatcher,
  type CallbackBatchHost,
} from "../pi-better-subagents/shared-callback-batcher.ts";
import { getCallbackBatcher as getBackgroundTaskCallbackBatcher } from "../pi-better-background-tasks/src/shared-callback-batcher.ts";

test("subagents and background tasks share one host callback batch", async () => {
  const messages: string[] = [];
  const delivered: string[] = [];
  const host: CallbackBatchHost = {
    sendMessage(message) {
      messages.push(message.content);
    },
  };

  const subagents = getSubagentCallbackBatcher(host, { windowMs: 25, retryMs: 50 });
  const backgroundTasks = getBackgroundTaskCallbackBatcher(host, { windowMs: 25, retryMs: 50 });
  assert.equal(subagents, backgroundTasks, "synchronized package copies must resolve one host singleton");

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

  assert.equal(await subagents.flush(), true);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /^2 background completions are ready:/);
  assert.match(messages[0]!, /source=subagent.*id=sa_shared.*subagent_result/s);
  assert.match(messages[0]!, /source=background-task.*id=bg_shared.*bg_task_status/s);
  assert.deepEqual(delivered, ["sa_shared", "bg_shared"]);
});
