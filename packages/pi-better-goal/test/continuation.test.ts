import assert from "node:assert/strict";
import test from "node:test";

import { continuationEvidence } from "../src/continuation.js";

test("continuation evidence ignores ephemeral call metadata but keeps action and result changes", () => {
  const first = continuationEvidence([
    {
      role: "assistant",
      timestamp: 1,
      content: [{ type: "toolCall", id: "call-one", name: "bash", arguments: { command: "git status" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-one",
      toolName: "bash",
      timestamp: 2,
      isError: false,
      content: [{ type: "text", text: "clean" }],
    },
  ]);
  const same = continuationEvidence([
    {
      role: "assistant",
      timestamp: 100,
      content: [{ type: "toolCall", id: "call-two", name: "bash", arguments: { command: "git status" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-two",
      toolName: "bash",
      timestamp: 101,
      isError: false,
      content: [{ type: "text", text: "clean" }],
    },
  ]);
  const changed = continuationEvidence([
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-three", name: "bash", arguments: { command: "git status" } }],
    },
    {
      role: "toolResult",
      toolCallId: "call-three",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "modified: src/index.ts" }],
    },
  ]);

  assert.equal(first.signature, same.signature);
  assert.notEqual(first.signature, changed.signature);
  assert.equal(first.summary, "bash");
});