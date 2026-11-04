import assert from "node:assert/strict";
import test from "node:test";
import {
    appendSubagentSettings,
    effectiveSubagentSettings,
    formatSubagentSettings,
} from "../effective-settings.ts";

function snapshot(mode, overrides = {}) {
    return effectiveSubagentSettings(
        { delegationMode: mode, maxConcurrent: 6, sources: { delegationMode: "session", maxConcurrent: "config" } },
        overrides.running ?? 0,
        overrides.pending ?? 0,
    );
}

test("the policy is appended at the very end of the system prompt", () => {
    const settings = snapshot("adaptive");
    const prompt = appendSubagentSettings("base system prompt", settings);
    assert.ok(prompt.startsWith("base system prompt"));
    assert.ok(prompt.endsWith(formatSubagentSettings(settings)), "the policy is the last thing the model reads");
});

test("appending is idempotent, so a rebuilt prompt cannot stack copies", () => {
    const settings = snapshot("manual");
    const once = appendSubagentSettings("base", settings);
    assert.equal(appendSubagentSettings(once, settings), once);
});

test("the policy survives compaction because it is not conversation content", () => {
    // Compaction rewrites the message list, never the system prompt; the policy
    // must therefore be reachable without any injected message.
    const settings = snapshot("manual");
    const prompt = appendSubagentSettings("base", settings);
    assert.match(prompt, /Do not proactively delegate/);
    assert.ok(prompt.includes(formatSubagentSettings(settings)));
});

test("live occupancy never reaches the system prompt", () => {
    for (const mode of ["manual", "adaptive", "coordinator"]) {
        const quiet = snapshot(mode, { running: 0 });
        const busy = snapshot(mode, { running: 3, pending: 2 });
        assert.equal(formatSubagentSettings(quiet), formatSubagentSettings(busy),
            `${mode}: occupancy belongs to the tool, not the cached prefix`);
        assert.equal(appendSubagentSettings("base", quiet), appendSubagentSettings("base", busy),
            `${mode}: child churn must not rewrite the cached system prompt`);
    }
});

test("manual mode carries no slot counts and no launch instruction", () => {
    const text = formatSubagentSettings(snapshot("manual"));
    for (const forbidden of ["Available slots", "Occupied slots", "Running:", "Launch ready, independent"]) {
        assert.equal(text.includes(forbidden), false, `manual block must not contain ${JSON.stringify(forbidden)}`);
    }
    assert.match(text, /Do not proactively delegate/);
    assert.ok(text.indexOf("Do not proactively delegate") < text.indexOf("The limit is a ceiling"),
        "the mode governs before the capacity sentence");
});

test("delegating modes keep their delegation prompt and drop the counters", () => {
    for (const mode of ["adaptive", "coordinator"]) {
        const text = formatSubagentSettings(snapshot(mode));
        assert.equal(text.includes("Available slots"), false);
        assert.match(text, /Concurrency limit: 6/);
    }
    assert.match(formatSubagentSettings(snapshot("adaptive")), /Launch ready, independent/);
});
