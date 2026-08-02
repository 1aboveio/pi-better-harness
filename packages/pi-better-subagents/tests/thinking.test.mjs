import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseModelThinking } from "../thinking.ts";

describe("parseModelThinking", () => {
    it("extracts a recognized @effort suffix", () => {
        assert.deepEqual(parseModelThinking("openai/gpt-5.5@high"), {
            model: "openai/gpt-5.5",
            thinking: "high",
        });
    });

    it("lets the explicit thinking field override the model suffix", () => {
        assert.deepEqual(parseModelThinking("gpt-5.5@high", "low"), {
            model: "gpt-5.5",
            thinking: "low",
        });
    });

    it("leaves model names without a suffix unchanged", () => {
        assert.deepEqual(parseModelThinking("openai/gpt-5.5"), {
            model: "openai/gpt-5.5",
            thinking: undefined,
        });
    });

    it("rejects an unsupported suffix", () => {
        assert.throws(
            () => parseModelThinking("gpt-5.5@extreme"),
            /model thinking suffix must be one of: off, minimal, low, medium, high, xhigh, max/,
        );
    });
});