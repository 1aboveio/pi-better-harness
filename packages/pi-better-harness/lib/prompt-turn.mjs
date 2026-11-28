import { isDeepStrictEqual } from "node:util";

// Use the provider's representation so images, errors and tool-call IDs survive
// capture exactly as they reached the next generation.
export function recordedTools(messages, start) {
  const calls = new Map();
  const records = [];
  for (const message of messages.slice(start)) {
    for (const call of message.tool_calls ?? []) calls.set(call.id, call.function);
    if (message.role !== "tool") continue;
    const call = calls.get(message.tool_call_id);
    if (call) records.push({ name: call.name, args: JSON.parse(call.arguments), content: message.content });
  }
  return records;
}

export async function replayTurn(body, { generate, dispatch, budget, signal }) {
  const trace = [];
  for (let step = 0; step < budget; step++) {
    if (signal?.aborted) return { status: "cancelled", trace, budget };
    try {
      const answer = await generate(body);
      const calls = answer.calls ?? [];
      trace.push({ assistant: answer.text, calls, finish: answer.finish });
      if (signal?.aborted) return { status: "cancelled", trace, budget };
      body.messages.push({ role: "assistant", content: answer.text || null, ...(calls.length && { tool_calls: calls }) });
      if (!calls.length) return { status: answer.finish === "stop" ? "completed" : "incomplete", trace, budget };
      for (const call of calls) {
        if (signal?.aborted) return { status: "cancelled", trace, budget };
        const name = call.function.name;
        const args = JSON.parse(call.function.arguments);
        const result = await dispatch(name, args);
        trace.push({ name, args, ...result });
        if (!Object.hasOwn(result, "content")) return { status: "diverged", trace, budget };
        body.messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
      }
    } catch (error) {
      return { status: signal?.aborted ? "cancelled" : "error", error: error.message, trace, budget };
    }
  }
  return { status: "budget", trace, budget };
}

export function recordedDispatch(records) {
  let position = 0;
  return (name, args) => {
    const next = records[position];
    if (!next || name !== next.name || !isDeepStrictEqual(args, next.args))
      return { reason: "No matching recorded result at this step", position, expected: next && { name: next.name, args: next.args } };
    position++;
    return { content: structuredClone(next.content) };
  };
}
