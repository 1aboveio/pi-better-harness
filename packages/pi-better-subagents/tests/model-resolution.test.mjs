import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { bundledRolesRoot, loadCatalog } from "../catalog-store.ts";
import { resolveSelection } from "../catalog-resolver.ts";
import {
    DEFAULT_TIER_POLICY,
    ModelResolutionCodes,
    STARTUP_FAILURE_POLICY,
    assessCatalog,
    assessSelection,
    configureTierPolicy,
    launchParameters,
    nearestSupportedEffort,
    resolveModel,
    supportedEfforts,
} from "../model-resolution.ts";

const APPROVED = [
    ["role.researcher", "openai/gpt-6-sol", "medium"],
    ["role.explorer", "openai/gpt-6-luna", "medium"],
    ["role.product-manager", "openai/gpt-6-sol", "medium"],
    ["role.developer", "openai/gpt-6-sol", "high"],
    ["role.reviewer", "openai/gpt-6-astra", "medium"],
    ["role.architect", "openai/gpt-6-astra", "high"],
];

function model(provider, id, extra = {}) {
    return { provider, id, reasoning: true, ...extra };
}

function registryOf(models, hooks = {}) {
    return {
        getAvailable() {
            hooks.onAvailable?.();
            return models;
        },
        find(provider, id) {
            hooks.onFind?.();
            return hooks.known?.find((item) => item.provider === provider && item.id === id);
        },
    };
}

function countingRegistry(models, known = []) {
    const calls = { available: 0, find: 0 };
    const registry = registryOf(models, {
        onAvailable() {
            calls.available += 1;
        },
        onFind() {
            calls.find += 1;
        },
        known,
    });
    return { registry, calls };
}

function openFixture(files = []) {
    const root = mkdtempSync(join(tmpdir(), "pi-model-resolution-"));
    const cwd = join(root, "project");
    const userRoot = join(root, "user");
    mkdirSync(cwd);
    for (const file of files) {
        const directory = join(userRoot, "agents", file.kind === "agent" ? "agents" : "roles");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, file.name), file.markdown);
    }
    const snapshot = loadCatalog({
        cwd,
        userRoot,
        bundledRoot: join(root, "bundled-empty"),
        projectTrusted: true,
    });
    return {
        snapshot,
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}

function roleMarkdown(id, { model: modelId = "openai/gpt-6-sol", effort = "high", tier = "balanced", extra = "" } = {}) {
    return `---
schema: pi-agent/v1
kind: role
id: ${id}
name: ${id}
defaults:
  model: ${modelId}
  effort: ${effort}
  tier: ${tier}
${extra}---
Role instructions for ${id}.
`;
}

function agentMarkdown(id, roleId, overrides = "", body = "Agent instructions.") {
    const block = overrides ? `overrides:\n${overrides}\n` : "";
    return `---
schema: pi-agent/v1
kind: agent
id: ${id}
name: ${id}
roleId: ${roleId}
instructions:
  mode: add
${block}---
${body}
`;
}

function select(snapshot, selector) {
    const resolved = resolveSelection(snapshot, selector);
    assert.equal(resolved.status, "resolved", resolved.diagnostics.map((item) => item.message).join("\n"));
    assert.ok(resolved.effective);
    return resolved.effective;
}

function codes(decision) {
    return decision.diagnostics.map((item) => item.code);
}

describe("tier policy", () => {
    it("ships membership for the approved tiers and no invented candidates", () => {
        assert.deepEqual([...DEFAULT_TIER_POLICY.tiers.balanced.members], ["openai/gpt-6-sol"]);
        assert.deepEqual([...DEFAULT_TIER_POLICY.tiers.efficient.members], ["openai/gpt-6-luna"]);
        assert.deepEqual([...DEFAULT_TIER_POLICY.tiers.frontier.members], ["openai/gpt-6-astra"]);
        for (const spec of Object.values(DEFAULT_TIER_POLICY.tiers)) assert.deepEqual([...spec.candidates], []);
    });
});

describe("T07 approved defaults", () => {
    it("launches each bundled role at its model and effort when the registry has them", () => {
        const root = mkdtempSync(join(tmpdir(), "pi-model-resolution-bundled-"));
        const snapshot = loadCatalog({
            cwd: join(root, "project"),
            userRoot: join(root, "user"),
            bundledRoot: bundledRolesRoot(),
            projectTrusted: false,
        });
        mkdirSync(join(root, "project"));
        const { registry, calls } = countingRegistry([
            model("openai", "gpt-6-sol"),
            model("openai", "gpt-6-luna"),
            model("openai", "gpt-6-astra"),
        ]);
        try {
            const attachments = assessCatalog(snapshot, { registry, foregroundModel: "xai/grok-4.7" });
            assert.equal(attachments.length, 6);
            for (const [id, modelId, effort] of APPROVED) {
                const attachment = attachments.find((item) => item.id === id);
                assert.ok(attachment, id);
                assert.equal(attachment.schemaLaunchable, true);
                assert.equal(attachment.launchable, true);
                assert.equal(attachment.availability, "preferred");
                assert.equal(attachment.preferredModelAvailable, true);
                assert.equal(attachment.capabilities.grantedByCatalog, false);
                assert.match(attachment.capabilities.note, /does not grant or remove capabilities|stay on the existing spawn path/);
                const decision = attachment.decision;
                assert.equal(decision.status, "ready");
                assert.deepEqual(launchParameters(decision), { model: modelId, thinking: effort });
                assert.equal(decision.modelSelection.requested, modelId);
                assert.equal(decision.modelSelection.actual, modelId);
                assert.equal(decision.modelSelection.source, "role-default");
                assert.equal(decision.modelSelection.explicitRequest, false);
                assert.equal(decision.effortSelection.requested, effort);
                assert.equal(decision.effortSelection.actual, effort);
                assert.equal(decision.effortSelection.source, "role-default");
                assert.equal(decision.effortSelection.explicit, false);
                assert.equal(decision.effortSelection.adjusted, false);
                assert.equal(codes(decision).includes(ModelResolutionCodes.modelFallback), false);
            }
            assert.equal(calls.find, 0);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("T08 independent model and effort precedence", () => {
    it("keeps the role effort when only the model is overridden", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
            {
                kind: "agent",
                name: "agent.pay.md",
                markdown: agentMarkdown("agent.pay", "role.developer", "  model: openai/gpt-6-luna\n"),
            },
        ]);
        try {
            const effective = select(fixture.snapshot, { agentId: "agent.pay" });
            assert.equal(effective.model.explicit, true);
            assert.equal(effective.model.source, "agent-override");
            assert.equal(effective.effort.explicit, false);
            assert.equal(effective.effort.source, "role-default");
            assert.equal(effective.effort.value, "high");
            const decision = resolveModel({
                effective,
                registry: registryOf([model("openai", "gpt-6-sol"), model("openai", "gpt-6-luna")]),
                foregroundModel: "xai/grok-4.7",
            });
            assert.equal(decision.modelSelection.actual, "openai/gpt-6-luna");
            assert.equal(decision.modelSelection.source, "agent-override");
            assert.equal(decision.effortSelection.actual, "high");
            assert.equal(decision.effortSelection.source, "role-default");
            assert.equal(decision.effortSelection.explicit, false);
            assert.deepEqual(launchParameters(decision), { model: "openai/gpt-6-luna", thinking: "high" });
        } finally {
            fixture.cleanup();
        }
    });

    it("orders invocation thinking, suffix, authoritative effort, saved override, then role", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer", { effort: "medium" }) },
            {
                kind: "agent",
                name: "agent.pay.md",
                markdown: agentMarkdown("agent.pay", "role.developer", "  effort: max\n"),
            },
        ]);
        try {
            const effective = select(fixture.snapshot, { agentId: "agent.pay" });
            assert.equal(effective.effort.explicit, true);
            assert.equal(effective.effort.value, "max");
            const registry = registryOf([
                model("openai", "gpt-6-sol", { thinkingLevelMap: { max: "max", xhigh: "xhigh" } }),
                model("openai", "gpt-6-luna", { thinkingLevelMap: { max: "max", xhigh: "xhigh" } }),
                model("openai", "gpt-6-astra", { thinkingLevelMap: { max: "max", xhigh: "xhigh" } }),
            ]);
            const cases = [
                {
                    invocation: { model: "openai/gpt-6-luna@low", thinking: "minimal" },
                    authoritative: { model: "openai/gpt-6-astra@high", effort: "xhigh" },
                    model: "openai/gpt-6-luna",
                    effort: "minimal",
                    effortSource: "invocation-thinking",
                },
                {
                    invocation: { model: "openai/gpt-6-luna@low" },
                    authoritative: { effort: "xhigh" },
                    model: "openai/gpt-6-luna",
                    effort: "low",
                    effortSource: "invocation-suffix",
                },
                {
                    invocation: { model: "openai/gpt-6-luna" },
                    authoritative: { model: "openai/gpt-6-astra@medium", effort: "high" },
                    model: "openai/gpt-6-luna",
                    effort: "high",
                    effortSource: "authoritative-effort",
                },
                {
                    invocation: { model: "openai/gpt-6-luna" },
                    authoritative: { model: "openai/gpt-6-astra@high" },
                    model: "openai/gpt-6-luna",
                    effort: "high",
                    effortSource: "authoritative-suffix",
                },
                {
                    invocation: {},
                    authoritative: {},
                    model: "openai/gpt-6-sol",
                    effort: "max",
                    effortSource: "agent-override",
                },
            ];
            for (const item of cases) {
                const decision = resolveModel({ effective, registry, invocation: item.invocation, authoritative: item.authoritative });
                assert.equal(decision.status, "ready", item.effortSource);
                assert.equal(decision.modelSelection.actual, item.model, item.effortSource);
                assert.equal(decision.effortSelection.actual, item.effort, item.effortSource);
                assert.equal(decision.effortSelection.source, item.effortSource);
                assert.equal(decision.effortSelection.explicit, true);
            }
            const roleOnly = select(fixture.snapshot, { roleId: "role.developer" });
            const inherited = resolveModel({ effective: roleOnly, registry });
            assert.equal(inherited.effortSelection.actual, "medium");
            assert.equal(inherited.effortSelection.source, "role-default");
            assert.equal(inherited.effortSelection.explicit, false);
        } finally {
            fixture.cleanup();
        }
    });
});

describe("T09 T10 T17 fallback", () => {
    it("picks the first eligible same-tier candidate and keeps effort", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
        ]);
        try {
            const effective = select(fixture.snapshot, { roleId: "role.developer" });
            const tiers = configureTierPolicy({
                balanced: {
                    members: ["openai/gpt-6-sol", "openai/gpt-6-luna", "anthropic/claude-sonnet"],
                    candidates: [
                        "openai/gpt-6-missing",
                        { model: "anthropic/claude-sonnet" },
                        "openai/gpt-6-luna",
                        "openai/gpt-6-later",
                    ],
                },
            });
            const decision = resolveModel({
                effective,
                tiers,
                foregroundModel: "xai/grok-4.7",
                configuredDefaultModel: "openai/gpt-6-astra",
                registry: registryOf([
                    model("openai", "gpt-6-luna"),
                    model("openai", "gpt-6-later"),
                    model("anthropic", "claude-sonnet"),
                    model("openai", "gpt-6-astra"),
                    model("xai", "grok-4.7"),
                ]),
            });
            assert.equal(decision.status, "ready");
            assert.equal(decision.modelSelection.requested, "openai/gpt-6-sol");
            assert.equal(decision.modelSelection.requestedSource, "role-default");
            assert.equal(decision.modelSelection.actual, "openai/gpt-6-luna");
            assert.equal(decision.modelSelection.source, "tier-candidate");
            assert.equal(decision.effortSelection.actual, "high");
            assert.equal(decision.effortSelection.adjusted, false);
            assert.match(decision.modelSelection.reason, /cross-provider without opt-in/);
            assert.equal(decision.modelSelection.actual === "openai/gpt-6-astra", false);
            assert.equal(decision.modelSelection.actual === "xai/grok-4.7", false);
        } finally {
            fixture.cleanup();
        }
    });

    it("uses an explicit cross-provider candidate and skips non-members", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
        ]);
        try {
            const effective = select(fixture.snapshot, { roleId: "role.developer" });
            const opted = resolveModel({
                effective,
                tiers: configureTierPolicy({
                    balanced: {
                        members: ["openai/gpt-6-sol", "anthropic/claude-sonnet"],
                        candidates: [{ model: "anthropic/claude-sonnet", crossProvider: true }],
                    },
                }),
                foregroundModel: "xai/grok-4.7",
                registry: registryOf([model("anthropic", "claude-sonnet"), model("xai", "grok-4.7")]),
            });
            assert.equal(opted.modelSelection.actual, "anthropic/claude-sonnet");
            assert.equal(opted.modelSelection.source, "tier-candidate");

            const nonMember = resolveModel({
                effective,
                tiers: configureTierPolicy({
                    balanced: {
                        members: ["openai/gpt-6-sol"],
                        candidates: [{ model: "anthropic/claude-sonnet", crossProvider: true }, "openai/gpt-6-luna"],
                    },
                }),
                foregroundModel: "xai/grok-4.7",
                registry: registryOf([
                    model("anthropic", "claude-sonnet"),
                    model("openai", "gpt-6-luna"),
                    model("xai", "grok-4.7"),
                ]),
            });
            assert.equal(nonMember.modelSelection.actual, "xai/grok-4.7");
            assert.equal(nonMember.modelSelection.source, "foreground");
            assert.match(nonMember.modelSelection.reason, /not a member/);
            assert.match(nonMember.modelSelection.reason, /Foreground effort was not inherited/);
        } finally {
            fixture.cleanup();
        }
    });

    it("uses foreground when the tier has no candidate or the tier is unknown, and does not swap approved models", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
            {
                kind: "role",
                name: "role.custom.md",
                markdown: roleMarkdown("role.custom", { model: "openai/gpt-6-sol", tier: "mythic" }),
            },
        ]);
        try {
            const registry = registryOf([
                model("openai", "gpt-6-luna"),
                model("openai", "gpt-6-astra"),
                model("xai", "grok-4.7"),
            ]);
            const emptyTier = resolveModel({
                effective: select(fixture.snapshot, { roleId: "role.developer" }),
                registry,
                foregroundModel: "xai/grok-4.7",
                configuredDefaultModel: "openai/gpt-6-luna",
            });
            assert.equal(emptyTier.modelSelection.actual, "xai/grok-4.7");
            assert.equal(emptyTier.modelSelection.source, "foreground");
            assert.match(emptyTier.modelSelection.reason, /no configured candidates|no eligible available candidate/i);
            assert.equal(codes(emptyTier).includes(ModelResolutionCodes.unknownTier), false);
            assert.equal(emptyTier.effortSelection.actual, "high");

            const unknown = resolveModel({
                effective: select(fixture.snapshot, { roleId: "role.custom" }),
                registry,
                foregroundModel: "xai/grok-4.7",
            });
            assert.equal(unknown.modelSelection.actual, "xai/grok-4.7");
            assert.equal(codes(unknown).includes(ModelResolutionCodes.unknownTier), true);
            assert.match(unknown.diagnostics.find((item) => item.code === ModelResolutionCodes.unknownTier).message, /not guessed|was not guessed|No model from another tier/);
            assert.equal(unknown.modelSelection.actual === "openai/gpt-6-astra", false);

            const cleared = openFixture([
                { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
                {
                    kind: "agent",
                    name: "agent.pay.md",
                    markdown: agentMarkdown("agent.pay", "role.developer", "  tier: null\n"),
                },
            ]);
            try {
                const effective = select(cleared.snapshot, { agentId: "agent.pay" });
                assert.equal(effective.tier.explicit, true);
                assert.equal(effective.tier.value, null);
                const decision = resolveModel({
                    effective,
                    registry,
                    foregroundModel: "xai/grok-4.7",
                    tiers: configureTierPolicy({
                        balanced: { members: ["openai/gpt-6-sol", "openai/gpt-6-luna"], candidates: ["openai/gpt-6-luna"] },
                    }),
                });
                assert.equal(decision.modelSelection.actual, "xai/grok-4.7");
                assert.equal(decision.modelSelection.source, "foreground");
                assert.equal(codes(decision).includes(ModelResolutionCodes.unknownTier), true);
                assert.equal(decision.effortSelection.actual, "high");
                assert.equal(decision.effortSelection.source, "role-default");
            } finally {
                cleared.cleanup();
            }
        } finally {
            fixture.cleanup();
        }
    });

    it("does not start a child when preferred, candidates, and foreground are unusable", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
        ]);
        try {
            const decision = resolveModel({
                effective: select(fixture.snapshot, { roleId: "role.developer" }),
                tiers: configureTierPolicy({
                    balanced: { members: ["openai/gpt-6-sol", "openai/gpt-6-luna"], candidates: ["openai/gpt-6-luna"] },
                }),
                foregroundModel: "xai/grok-4.7",
                registry: registryOf([]),
            });
            assert.equal(decision.status, "blocked");
            assert.equal(decision.launch, null);
            assert.equal(decision.modelSelection.actual, null);
            assert.equal(codes(decision).includes(ModelResolutionCodes.noUsableModel), true);
            const message = decision.diagnostics.find((item) => item.code === ModelResolutionCodes.noUsableModel).message;
            assert.match(message, /No child was started/);
            assert.match(message, /Recovery/);
            assert.match(message, /will not retry/);
            assert.throws(() => launchParameters(decision), /No child was started/);
        } finally {
            fixture.cleanup();
        }
    });
});

describe("T12 T15 explicit models", () => {
    it("uses the invocation model and records provenance", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer", { effort: "medium" }) },
        ]);
        try {
            const decision = resolveModel({
                effective: select(fixture.snapshot, { roleId: "role.developer" }),
                invocation: { model: "openai/gpt-6-astra" },
                registry: registryOf([model("openai", "gpt-6-sol"), model("openai", "gpt-6-astra")]),
            });
            assert.deepEqual(launchParameters(decision), { model: "openai/gpt-6-astra", thinking: "medium" });
            assert.equal(decision.modelSelection.requested, "openai/gpt-6-astra");
            assert.equal(decision.modelSelection.actual, "openai/gpt-6-astra");
            assert.equal(decision.modelSelection.source, "invocation");
            assert.equal(decision.modelSelection.explicitRequest, true);
            assert.equal(decision.effortSelection.source, "role-default");
        } finally {
            fixture.cleanup();
        }
    });

    it("keeps invocation above an authoritative model and does not fall back when that explicit model is unavailable", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
            {
                kind: "agent",
                name: "agent.pay.md",
                markdown: agentMarkdown("agent.pay", "role.developer", "  model: openai/gpt-6-luna\n"),
            },
        ]);
        try {
            const effective = select(fixture.snapshot, { agentId: "agent.pay" });
            const registry = registryOf([
                model("openai", "gpt-6-sol"),
                model("openai", "gpt-6-luna"),
                model("xai", "grok-4.7"),
            ], { known: [model("openai", "gpt-6-astra")] });
            const { registry: counted, calls } = countingRegistry(
                [model("openai", "gpt-6-sol"), model("openai", "gpt-6-luna"), model("xai", "grok-4.7")],
                [model("openai", "gpt-6-astra")],
            );
            const decision = resolveModel({
                effective,
                registry: counted,
                invocation: { model: "openai/gpt-6-astra@high" },
                authoritative: { model: "openai/gpt-6-luna" },
                foregroundModel: "xai/grok-4.7",
                tiers: configureTierPolicy({
                    balanced: { members: ["openai/gpt-6-sol", "openai/gpt-6-luna"], candidates: ["openai/gpt-6-luna"] },
                }),
            });
            assert.equal(decision.status, "blocked");
            assert.equal(decision.launch, null);
            assert.equal(decision.modelSelection.requested, "openai/gpt-6-astra");
            assert.equal(decision.modelSelection.actual, null);
            assert.equal(decision.modelSelection.explicitRequest, true);
            assert.equal(codes(decision).includes(ModelResolutionCodes.unavailableExplicitModel), true);
            assert.match(decision.modelSelection.reason, /were not applied/);
            assert.match(decision.modelSelection.reason, /known to the registry/);
            assert.equal(calls.available, 1);
            assert.equal(calls.find, 1);
            assert.equal(registry.getAvailable().length, 3);

            const saved = resolveModel({
                effective,
                registry,
                foregroundModel: "xai/grok-4.7",
            });
            assert.equal(saved.status, "ready");
            assert.equal(saved.modelSelection.actual, "openai/gpt-6-luna");
            assert.equal(saved.modelSelection.requestedSource, "agent-override");
        } finally {
            fixture.cleanup();
        }
    });

    it("does not read prose, quoted names, or comparisons", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer", { effort: "high" }) },
        ]);
        try {
            const effective = select(fixture.snapshot, { roleId: "role.developer" });
            const input = {
                effective,
                registry: registryOf([model("openai", "gpt-6-sol"), model("openai", "gpt-6-astra"), model("openai", "gpt-6-luna")]),
                prompt: "use openai/gpt-6-astra@high for the implementer",
                task: "gpt-6-luna is cheaper than gpt-6-astra in this example",
                foregroundThinking: "max",
            };
            const decision = resolveModel(input);
            assert.deepEqual(launchParameters(decision), { model: "openai/gpt-6-sol", thinking: "high" });
        } finally {
            fixture.cleanup();
        }
    });
});

describe("T16 T33 effort support", () => {
    it("rejects unsupported explicit effort and adjusts inherited effort, breaking ties downward", () => {
        const hole = model("openai", "gpt-6-sol", { thinkingLevelMap: { medium: null } });
        const supported = supportedEfforts(hole);
        assert.deepEqual(supported, getSupportedThinkingLevels(hole));
        assert.equal(nearestSupportedEffort("medium", supported).level, "low");
        assert.equal(nearestSupportedEffort("medium", supported).tied, true);
        assert.equal(clampThinkingLevel(hole, "medium"), "high");

        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer", { effort: "medium" }) },
            {
                kind: "agent",
                name: "agent.pay.md",
                markdown: agentMarkdown("agent.pay", "role.developer", "  effort: max\n"),
            },
        ]);
        try {
            const role = select(fixture.snapshot, { roleId: "role.developer" });
            const adjusted = resolveModel({
                effective: role,
                registry: registryOf([hole]),
            });
            assert.equal(adjusted.status, "ready");
            assert.equal(adjusted.modelSelection.actual, "openai/gpt-6-sol");
            assert.equal(adjusted.effortSelection.requested, "medium");
            assert.equal(adjusted.effortSelection.actual, "low");
            assert.equal(adjusted.effortSelection.explicit, false);
            assert.equal(adjusted.effortSelection.adjusted, true);
            assert.equal(adjusted.effortSelection.source, "role-default");
            assert.match(adjusted.effortSelection.reason, /lower effort/);
            assert.equal(launchParameters(adjusted).thinking, "low");

            const agent = select(fixture.snapshot, { agentId: "agent.pay" });
            const explicit = resolveModel({
                effective: agent,
                registry: registryOf([model("openai", "gpt-6-sol")]),
            });
            assert.equal(explicit.status, "blocked");
            assert.equal(explicit.launch, null);
            assert.equal(explicit.effortSelection.explicit, true);
            assert.equal(explicit.effortSelection.adjusted, false);
            assert.equal(explicit.effortSelection.actual, null);
            assert.equal(explicit.modelSelection.actual, "openai/gpt-6-sol");
            assert.match(explicit.effortSelection.reason, /Saved agent overrides stay explicit/);
            assert.match(explicit.effortSelection.reason, /Supported levels/);

            const invocation = resolveModel({
                effective: role,
                invocation: { thinking: "max" },
                registry: registryOf([model("openai", "gpt-6-sol")]),
            });
            assert.equal(invocation.status, "blocked");
            assert.equal(invocation.effortSelection.source, "invocation-thinking");
            assert.equal(codes(invocation).includes(ModelResolutionCodes.unsupportedExplicitEffort), true);
        } finally {
            fixture.cleanup();
        }
    });

    it("keeps a saved effort override explicit when the model falls back, and never retries", () => {
        const fallback = model("anthropic", "claude-sonnet");
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer", { effort: "max" }) },
            {
                kind: "agent",
                name: "agent.pay.md",
                markdown: agentMarkdown("agent.pay", "role.developer", "  effort: max\n"),
            },
        ]);
        try {
            const tiers = configureTierPolicy({
                balanced: {
                    members: ["openai/gpt-6-sol", "anthropic/claude-sonnet"],
                    candidates: [{ model: "anthropic/claude-sonnet", crossProvider: true }],
                },
            });
            const registry = registryOf([fallback]);
            const inherited = resolveModel({
                effective: select(fixture.snapshot, { roleId: "role.developer" }),
                registry,
                tiers,
            });
            assert.equal(inherited.status, "ready");
            assert.equal(inherited.modelSelection.actual, "anthropic/claude-sonnet");
            assert.equal(inherited.effortSelection.requested, "max");
            assert.equal(inherited.effortSelection.actual, "high");
            assert.equal(inherited.effortSelection.adjusted, true);
            assert.equal(inherited.automaticRetry, false);
            assert.equal(inherited.substitutionAfterStart, false);
            assert.equal(inherited.availabilityIsStartupGuarantee, false);
            assert.equal(inherited.startupFailure, STARTUP_FAILURE_POLICY);

            const saved = resolveModel({
                effective: select(fixture.snapshot, { agentId: "agent.pay" }),
                registry,
                tiers,
                foregroundModel: "anthropic/claude-sonnet",
            });
            assert.equal(saved.status, "blocked");
            assert.equal(saved.launch, null);
            assert.equal(saved.effortSelection.requestedSource, "agent-override");
            assert.equal(saved.effortSelection.explicit, true);
            assert.equal(saved.effortSelection.adjusted, false);
            assert.equal(saved.automaticRetry, false);
            assert.equal(saved.substitutionAfterStart, false);
            assert.match(saved.startupFailure.detail, /Do not resolve again/);
        } finally {
            fixture.cleanup();
        }
    });

    it("breaks an xhigh hole toward high rather than Pi's upward clamp", () => {
        const mapped = model("openai", "gpt-6-sol", { thinkingLevelMap: { xhigh: null, max: "max" } });
        const supported = supportedEfforts(mapped);
        assert.equal(nearestSupportedEffort("xhigh", supported).level, "high");
        assert.equal(nearestSupportedEffort("xhigh", supported).tied, true);
        assert.equal(clampThinkingLevel(mapped, "xhigh"), "max");
    });
});

describe("catalog-free legacy chain and inspection guards", () => {
    it("preserves invocation, configured default, then foreground without availability checks", () => {
        const missing = resolveModel({
            invocation: { model: "openai/gpt-6-sol@high", thinking: "low" },
            configuredDefaultModel: "openai/gpt-6-luna@max",
            foregroundModel: "xai/grok-4.7@minimal",
            authoritative: { model: "openai/gpt-6-astra@medium" },
            prompt: "use openai/gpt-6-astra",
        });
        assert.equal(missing.catalogFree, true);
        assert.deepEqual(launchParameters(missing), { model: "openai/gpt-6-sol", thinking: "low" });
        assert.equal(missing.modelSelection.source, "invocation");
        assert.equal(missing.effortSelection.source, "invocation-thinking");

        const configured = resolveModel({
            configuredDefaultModel: "gpt-6-luna@high",
            foregroundModel: "xai/grok-4.7",
        });
        assert.deepEqual(launchParameters(configured), { model: "gpt-6-luna", thinking: "high" });
        assert.equal(configured.modelSelection.source, "configured-default");
        assert.equal(configured.effortSelection.source, "configured-default");

        const foreground = resolveModel({ foregroundModel: "xai/grok-4.7@minimal" });
        assert.deepEqual(launchParameters(foreground), { model: "xai/grok-4.7", thinking: "minimal" });
        assert.equal(foreground.effortSelection.source, "foreground-suffix");

        const absent = resolveModel({});
        assert.equal(absent.status, "ready");
        assert.deepEqual(launchParameters(absent), {});

        const invalid = resolveModel({ invocation: { model: "openai/gpt-6-sol@extreme" } });
        assert.equal(invalid.status, "blocked");
        assert.equal(invalid.launch, null);
    });

    it("uses the runtime default chain only when the catalog model preference is absent", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
            {
                kind: "agent",
                name: "agent.pay.md",
                markdown: agentMarkdown("agent.pay", "role.developer", "  model: null\n"),
            },
        ]);
        try {
            const effective = select(fixture.snapshot, { agentId: "agent.pay" });
            assert.equal(effective.model.explicit, true);
            assert.equal(effective.model.value, null);
            const decision = resolveModel({
                effective,
                configuredDefaultModel: "openai/gpt-6-luna",
                foregroundModel: "xai/grok-4.7",
                registry: registryOf([
                    model("openai", "gpt-6-sol"),
                    model("openai", "gpt-6-luna"),
                    model("xai", "grok-4.7"),
                ]),
            });
            assert.equal(decision.modelSelection.actual, "openai/gpt-6-luna");
            assert.equal(decision.modelSelection.source, "configured-default");
            assert.equal(decision.modelSelection.requested, null);
            assert.equal(decision.effortSelection.actual, "high");
            assert.match(decision.modelSelection.reason, /role model was not used/);
        } finally {
            fixture.cleanup();
        }
    });

    it("resolves a providerless explicit id only when the registry has one match", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
        ]);
        try {
            const effective = select(fixture.snapshot, { roleId: "role.developer" });
            const unique = resolveModel({
                effective,
                invocation: { model: "gpt-6-astra" },
                registry: registryOf([model("openai", "gpt-6-astra")]),
            });
            assert.equal(unique.modelSelection.actual, "openai/gpt-6-astra");
            const ambiguous = resolveModel({
                effective,
                invocation: { model: "gpt-6-astra" },
                registry: registryOf([model("openai", "gpt-6-astra"), model("azure", "gpt-6-astra")]),
            });
            assert.equal(ambiguous.status, "blocked");
            assert.equal(codes(ambiguous).includes(ModelResolutionCodes.ambiguousModel), true);
            assert.match(ambiguous.modelSelection.reason, /provider\/model/);
        } finally {
            fixture.cleanup();
        }
    });

    it("blocks an unlaunchable definition and a missing registry before a child", () => {
        const fixture = openFixture([
            {
                kind: "role",
                name: "role.developer.md",
                markdown: roleMarkdown("role.developer", { extra: "tools: [write]\n" }),
            },
        ]);
        try {
            const resolved = resolveSelection(fixture.snapshot, { roleId: "role.developer" });
            assert.equal(resolved.launchable, false);
            const decision = resolveModel({
                effective: resolved.effective,
                registry: registryOf([model("openai", "gpt-6-sol")]),
            });
            assert.equal(decision.status, "blocked");
            assert.equal(decision.launch, null);
            const attachment = assessSelection(fixture.snapshot, { roleId: "role.developer" }, {
                registry: registryOf([model("openai", "gpt-6-sol")]),
            });
            assert.equal(attachment.launchable, false);
            assert.equal(attachment.availability, "catalog-blocked");
            assert.equal(attachment.capabilities.grantedByCatalog, false);
            assert.equal(attachment.decision, undefined);
        } finally {
            fixture.cleanup();
        }

        const readyRole = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
        ]);
        try {
            const effective = select(readyRole.snapshot, { roleId: "role.developer" });
            const missing = resolveModel({ effective });
            assert.equal(missing.status, "blocked");
            assert.equal(codes(missing).includes(ModelResolutionCodes.registryRequired), true);
            const thrown = resolveModel({
                effective,
                registry: {
                    getAvailable() {
                        throw new Error("registry down");
                    },
                },
            });
            assert.equal(thrown.status, "blocked");
            assert.match(thrown.diagnostics[0].message, /registry down/);
            assert.match(thrown.diagnostics[0].message, /No provider was probed/);
        } finally {
            readyRole.cleanup();
        }
    });

    it("ignores registry entries that omit Pi's reasoning flag", () => {
        const fixture = openFixture([
            { kind: "role", name: "role.developer.md", markdown: roleMarkdown("role.developer") },
        ]);
        try {
            const decision = resolveModel({
                effective: select(fixture.snapshot, { roleId: "role.developer" }),
                foregroundModel: "xai/grok-4.7",
                registry: registryOf([
                    { provider: "openai", id: "gpt-6-sol" },
                    model("xai", "grok-4.7"),
                ]),
            });
            assert.equal(decision.modelSelection.actual, "xai/grok-4.7");
            assert.equal(decision.modelSelection.source, "foreground");
        } finally {
            fixture.cleanup();
        }
    });
});
