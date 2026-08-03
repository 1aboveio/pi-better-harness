import { createHash } from "node:crypto";

export interface ContinuationEvidence {
  signature: string;
  summary: string;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  toolName?: unknown;
  isError?: unknown;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function resultContent(content: unknown): unknown[] {
  if (!Array.isArray(content)) {
    return [content];
  }
  return content.map((block) => {
    if (!isRecord(block)) {
      return block;
    }
    if (block.type === "text") {
      return { type: "text", text: block.text };
    }
    if (block.type === "image") {
      return { type: "image", data: block.data, mimeType: block.mimeType };
    }
    return block;
  });
}

/**
 * Hash stable, observable turn evidence without persisting tool arguments or output.
 * Call IDs, timestamps, thinking, usage, and provider metadata are deliberately excluded.
 */
export function continuationEvidence(messages: readonly unknown[]): ContinuationEvidence {
  const records: unknown[] = [];
  const toolNames: string[] = [];

  for (const candidate of messages) {
    if (!isRecord(candidate)) {
      continue;
    }
    const message = candidate as MessageLike;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      const actions = message.content.flatMap((block) => {
        if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") {
          return [];
        }
        toolNames.push(block.name);
        return [{ name: block.name, arguments: block.arguments }];
      });
      const text = message.content.flatMap((block) =>
        isRecord(block) && block.type === "text" ? [{ text: block.text }] : [],
      );
      if (actions.length > 0 || text.length > 0) {
        records.push({ role: "assistant", actions, text });
      }
      continue;
    }
    if (message.role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : "unknown";
      toolNames.push(toolName);
      records.push({
        role: "toolResult",
        toolName,
        isError: message.isError === true,
        content: resultContent(message.content),
        details: message.details,
      });
    }
  }

  const payload = canonicalJson(records.length > 0 ? records : [{ role: "empty" }]);
  const signature = createHash("sha256").update(payload).digest("hex");
  const distinctTools = [...new Set(toolNames)];
  return {
    signature,
    summary: distinctTools.length > 0 ? distinctTools.join(", ") : "no observable action",
  };
}