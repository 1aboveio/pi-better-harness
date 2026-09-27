// @covers subagent.failure-observations
// @level unit
/**
 * Every child-facing tool schema must be accepted by model providers. OpenAI rejects
 * `uniqueItems` (and similar keywords) with 400 invalid_function_parameters, which made
 * every confined child fail on its first request after #315.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { intentBashDefinition, failureDispositionTool } from "../child-incidents.ts";
import { findProviderRejectedKeywords } from "../../../scripts/provider-schema-compat.mjs";

test("the confined child's bash and failure_disposition schemas use only provider-accepted keywords", () => {
    const bash = intentBashDefinition(process.cwd(), {});
    const disposition = failureDispositionTool(() => process.cwd());
    assert.deepEqual(findProviderRejectedKeywords(JSON.parse(JSON.stringify(bash.parameters))), []);
    assert.deepEqual(findProviderRejectedKeywords(JSON.parse(JSON.stringify(disposition.parameters))), []);
    assert.ok(bash.parameters.properties.expectedExitCodes, "intent fields are still offered");
});

test("the checker finds a rejected keyword at any depth but ignores property names", () => {
    assert.deepEqual(findProviderRejectedKeywords({ properties: { a: { anyOf: [{ type: "array", uniqueItems: true }] } } }),
        ["properties.a.anyOf.0.uniqueItems"]);
    assert.deepEqual(findProviderRejectedKeywords({ properties: { not: { type: "string" }, contains: { type: "string" } } }), []);
});
