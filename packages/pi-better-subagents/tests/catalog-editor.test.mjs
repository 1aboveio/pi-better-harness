import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    catalogModelChoices,
    catalogModelOptionLabel,
    catalogModelScopeLabel,
    modelReference,
    scopedModelReferences,
} from "../catalog-editor.ts";

const scoped = (provider, id) => ({ model: { provider, id, name: `${provider} ${id}` }, thinkingLevel: "high" });

describe("agent catalog model picker scope", () => {
    it("reads provider/id from Pi scoped models and tolerates bare or malformed entries", () => {
        assert.equal(modelReference(scoped("openai", "gpt-6.1-sol")), "openai/gpt-6.1-sol");
        assert.equal(modelReference({ provider: " openai ", id: " gpt-6.1-sol " }), "openai/gpt-6.1-sol");
        for (const bad of [undefined, null, "openai/gpt", 7, {}, { model: {} }, { model: { provider: "", id: "x" } }, { provider: "openai", id: 42 }]) {
            assert.equal(modelReference(bad), undefined, JSON.stringify(bad));
        }
    });

    it("keeps session order, drops duplicates, and ignores malformed scope entries", () => {
        assert.deepEqual(scopedModelReferences([
            scoped("openai", "beta"),
            scoped("openai", "beta"),
            null,
            scoped("anthropic", "claude-9"),
        ]), ["openai/beta", "anthropic/claude-9"]);
        assert.deepEqual(scopedModelReferences(undefined), []);
        assert.deepEqual(scopedModelReferences([]), []);
    });

    it("offers only the session scope when one is configured, even if more models are available", () => {
        const choices = catalogModelChoices({
            scoped: [scoped("openai", "beta"), scoped("anthropic", "claude-9")],
            available: ["openai/alpha", "openai/beta", "openai/gamma"],
            current: "openai/alpha",
        });
        assert.deepEqual(choices.values, ["openai/beta", "anthropic/claude-9"]);
        assert.equal(choices.scope, "scoped");
        assert.equal(choices.fallback, false);
        assert.equal(choices.retained, "openai/alpha");
        assert.doesNotMatch(choices.values.join(" "), /openai\/gamma/);
        assert.doesNotMatch(choices.values.join(" "), /openai\/alpha/);
    });

    it("falls back to the available models when no scope is configured, per Pi's empty-scope semantics", () => {
        for (const empty of [undefined, null, []]) {
            const choices = catalogModelChoices({
                scoped: empty,
                available: ["openai/gamma", "openai/alpha", "openai/gamma", " "],
                current: "openai/alpha",
            });
            assert.deepEqual(choices.values, ["openai/alpha", "openai/gamma"]);
            assert.equal(choices.scope, "all");
            assert.equal(choices.fallback, true);
            assert.equal(choices.retained, undefined);
        }
    });

    it("keeps an out-of-scope saved value out of the picker but reports it, and keeps an unavailable one selectable without a scope", () => {
        const scopedChoices = catalogModelChoices({
            scoped: [scoped("openai", "beta")],
            available: ["openai/beta"],
            current: "openai/legacy",
        });
        assert.deepEqual(scopedChoices.values, ["openai/beta"]);
        assert.equal(scopedChoices.retained, "openai/legacy");
        assert.equal(catalogModelScopeLabel(scopedChoices), "Session model scope \u00b7 1 model \u00b7 saved value is outside this scope");
        assert.equal(catalogModelOptionLabel(scopedChoices, "openai/legacy"), "openai/legacy");
        assert.equal(catalogModelOptionLabel(scopedChoices, "openai/beta"), "openai/beta");

        const fallbackChoices = catalogModelChoices({ available: ["openai/beta"], current: "openai/legacy" });
        assert.deepEqual(fallbackChoices.values, ["openai/beta", "openai/legacy"]);
        assert.equal(catalogModelOptionLabel(fallbackChoices, "openai/legacy"), "openai/legacy \u00b7 saved, unavailable");
    });

    it("labels the source of the choices without counting the retained value as scoped", () => {
        assert.equal(
            catalogModelScopeLabel(catalogModelChoices({ scoped: [scoped("openai", "beta")], current: "openai/alpha" })),
            "Session model scope \u00b7 1 model \u00b7 saved value is outside this scope",
        );
        assert.equal(
            catalogModelScopeLabel(catalogModelChoices({ scoped: [scoped("openai", "beta"), scoped("openai", "gamma")] })),
            "Session model scope \u00b7 2 models",
        );
        assert.equal(
            catalogModelScopeLabel(catalogModelChoices({ available: ["openai/beta"] })),
            "All available models \u00b7 no session scope",
        );
    });
});
