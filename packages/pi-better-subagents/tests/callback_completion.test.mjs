import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatCallbackTrigger, formatCallbackQuiet, buildCompletionDelivery } from "../completion.mjs";

const payload = "PRIVATE_RESULT_SENTINEL_" + "x".repeat(2000);
const input = {
    id: "sa_callback", label: "worker (sa_callback)", verdict: "✓ completed", stat: "45s",
    result: payload, resultText: payload, tools: "read,bash",
};

describe("completion callback formatters", () => {
    for (const [name, format] of [["trigger", formatCallbackTrigger], ["quiet", formatCallbackQuiet]]) {
        it(`${name} names the result tool and outcome without embedding supplied artifacts`, () => {
            const text = format(input);
            assert.match(text, /subagent_result id="sa_callback"/);
            assert.match(text, /worker \(sa_callback\)/);
            assert.match(text, /✓ completed/);
            assert.match(text, /45s/);
            assert.ok(!text.includes(payload));
            assert.doesNotMatch(text, /--- result ---|read,bash|tools:/);
            if (name === "quiet") assert.match(text, /NOT auto-posted|callback:false/);
        });
    }
});

describe("buildCompletionDelivery", () => {
    for (const callback of [true, false]) {
        it(`routes callback:${callback} and excludes supplied result and tool history`, () => {
            const delivery = buildCompletionDelivery({ ...input, callback });
            assert.equal(delivery.options.deliverAs, callback ? "followUp" : "nextTurn");
            assert.equal(Boolean(delivery.options.triggerTurn), callback);
            assert.match(delivery.content, /subagent_result id="sa_callback"/);
            assert.match(delivery.content, /worker \(sa_callback\)/);
            assert.match(delivery.content, /✓ completed/);
            assert.ok(!delivery.content.includes(payload));
            assert.doesNotMatch(delivery.content, /--- result ---|read,bash|tools:/);
        });
        it(`reports an incomplete exit as unexpected for callback:${callback}`, () => {
            const delivery = buildCompletionDelivery({
                ...input, callback, verdict: "! incomplete child exit (exit 0)", incomplete: true,
                lifecycleClassification: "incomplete_open_tools",
            });
            assert.match(delivery.content, /(?:ended|exited) unexpectedly/i);
            assert.match(delivery.content, /incomplete_open_tools/);
            assert.doesNotMatch(delivery.content, /has returned|completed|result NOT auto-posted/i);
        });
    }
    it("distinguishes nonzero failures from incomplete streams", () => {
        const delivery = buildCompletionDelivery({
            ...input, callback: true, verdict: "✗ failed (exit 1)", incomplete: false,
            lifecycleClassification: "failed_exit",
        });
        assert.match(delivery.content, /failed \(exit 1\)/);
        assert.doesNotMatch(delivery.content, /ended unexpectedly|incomplete/i);
    });
});
// Registered delivery, durable markers, retries and quiet runs are exercised in
// extension_health_lifecycle.test.mjs; real log assembly in run_finalization.test.mjs.
