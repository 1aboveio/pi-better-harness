import assert from "node:assert/strict";
import test from "node:test";
import {
    effectiveSubagentSettings,
    formatSubagentSettings,
    publishSubagentSettings,
    SUBAGENT_SETTINGS_SECTION,
} from "../effective-settings.ts";

// A section target is all the publisher needs, so the test never fakes a prompt string.
const publish = (settings) => publishSubagentSettings({ sections: {} }, settings).sections[SUBAGENT_SETTINGS_SECTION];

function snapshot(mode, overrides = {}) {
    return effectiveSubagentSettings(
        { delegationMode: mode, maxConcurrent: 6, sources: { delegationMode: "session", maxConcurrent: "config" } },
        overrides.running ?? 0,
        overrides.pending ?? 0,
    );
}

test("the policy is published as its own section, with the block last and its note first", () => {
    const settings = snapshot("adaptive");
    const section = publish(settings);
    assert.ok(section.startsWith("Treat the Subagent settings block in this section as the authoritative delegation mode and cap."),
        "the note that points at the block has to travel with it, and lead it");
    assert.ok(section.endsWith(formatSubagentSettings(settings)),
        "the block stays last inside its own section, so the note introduces it");
    // Custom sections render in publication order, so Background Tasks and Goal
    // publish after this one. Claiming a position in the whole prompt would be a
    // false statement the model could catch and then discount the rest.
    assert.doesNotMatch(section, /at the end of this prompt/);
});

test("publishing is an assignment, so a rebuilt prompt cannot stack copies", () => {
    const settings = snapshot("manual");
    const options = { sections: { [SUBAGENT_SETTINGS_SECTION]: "stale text" } };
    publishSubagentSettings(options, settings);
    assert.equal(options.sections[SUBAGENT_SETTINGS_SECTION], publish(settings));
});

test("the policy survives compaction because it is not conversation content", () => {
    // Compaction rewrites the message list, never the system prompt; the policy
    // must therefore be reachable without any injected message.
    const settings = snapshot("manual");
    const section = publish(settings);
    assert.match(section, /Do not proactively delegate/);
    assert.ok(section.includes(formatSubagentSettings(settings)));
});

test("live occupancy never reaches the system prompt", () => {
    for (const mode of ["manual", "adaptive", "coordinator"]) {
        const quiet = snapshot(mode, { running: 0 });
        const busy = snapshot(mode, { running: 3, pending: 2 });
        assert.equal(formatSubagentSettings(quiet), formatSubagentSettings(busy),
            `${mode}: occupancy belongs to the tool, not the cached prefix`);
        assert.equal(publish(quiet), publish(busy),
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
