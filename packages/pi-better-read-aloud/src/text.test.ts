import { describe, expect, it } from "vitest";
import { latestAssistantText, normalizeTextForSpeech } from "./text.js";

describe("read-aloud text extraction", () => {
  it("removes markdown links and code by default", () => {
    expect(normalizeTextForSpeech("# Title\nRead [docs](https://example.com).\n```ts\nconst x = 1\n```\nUse `pi`.")).toBe("Title Read docs. Use pi.");
  });

  it("extracts the latest assistant text from session entries", () => {
    const entries = [
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "older" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "question" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "latest answer" }] } },
    ];

    expect(latestAssistantText(entries)).toBe("latest answer");
  });

  it("honors max character truncation after cleanup", () => {
    expect(normalizeTextForSpeech("one two three", { maxChars: 7 })).toBe("one two");
  });
});