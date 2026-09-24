import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeDefinition } from "../catalog-schema.ts";
import {
    PI_VS_CODEX_PRECEDENCE,
    agentIdFromDisplayName,
    buildImportedAgent,
    explainCodexImportPrecedence,
    isCodexSkillMetadataPath,
    parseCodexSource,
    renderReimportPreview,
    suggestBaseRoles,
} from "../codex-import.ts";
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");

describe("codex adapter", () => {
    it("T21 parses supported fields with the real TOML parser and does not treat instruction text as effort", () => {
        const parsed = parseCodexSource(readFileSync(join(fixtureDir, "reviewer.toml"), "utf8"), "/tmp/reviewer.toml");
        assert.equal(parsed.ok, true);
        assert.equal(parsed.document.name, "Reviewer");
        assert.equal(parsed.document.description, "Reviews changes. Includes a # hash.");
        assert.match(parsed.document.developerInstructions, /Review the change\./);
        assert.match(parsed.document.developerInstructions, /model_reasoning_effort = "max"/);
        assert.equal(parsed.document.model, "openai/gpt-6-astra");
        assert.equal(parsed.document.modelReasoningEffort, "medium");
        assert.equal(parsed.document.storableEffort, "medium");
        assert.equal(parsed.document.proposedId, "agent.reviewer");
        assert.equal(parsed.document.restrictions.length, 0);
    });

    it("T21 rejects skill agents/openai.yaml and missing required fields", () => {
        const skillPath = join(fixtureDir, "agents", "openai.yaml");
        assert.equal(isCodexSkillMetadataPath(skillPath), true);
        const skill = parseCodexSource(readFileSync(skillPath, "utf8"), skillPath);
        assert.equal(skill.ok, false);
        assert.equal(skill.diagnostics[0].code, "skill-metadata-not-agent");
        assert.match(skill.diagnostics[0].message, /Nothing was imported/);
        const missing = parseCodexSource('name = "Only"\ndescription = "No instructions"\n', "/tmp/partial.toml");
        assert.equal(missing.ok, false);
        assert.match(missing.diagnostics[0].message, /developer_instructions/);
        const duplicate = parseCodexSource('name = "A"\nname = "B"\n', "/tmp/dup.toml");
        assert.equal(duplicate.ok, false);
        assert.match(duplicate.diagnostics[0].message, /line 2/);
    });

    it("T21 preserves sandbox_mode without claiming it is enforced", () => {
        const parsed = parseCodexSource(readFileSync(join(fixtureDir, "read-only.toml"), "utf8"), "/tmp/read-only.toml");
        assert.equal(parsed.ok, true);
        const restriction = parsed.document.restrictions.find((item) => item.name === "sandbox_mode");
        assert.equal(restriction.value, "read-only");
        assert.equal(restriction.required, true);
        assert.equal(restriction.honored, false);
        assert.match(restriction.reason, /not enforced/);
        assert.match(restriction.reason, /read-only/);
        assert.equal(parsed.document.cosmetic.nickname, "roa");
        assert.doesNotMatch(JSON.stringify(parsed.document), /enforced":true/);
    });

    it("T21 invocation and workflow choices override Codex defaults without reading prose", () => {
        const explained = explainCodexImportPrecedence({
            invocationModel: "openai/gpt-6-luna",
            invocationEffort: "low",
            workflowModel: "openai/gpt-6-astra",
            workflowEffort: "high",
            agentOverrideModel: "openai/gpt-6-sol",
            agentOverrideEffort: "max",
            roleModel: "openai/gpt-6-sol",
            roleEffort: "medium",
        });
        assert.equal(explained.model, "openai/gpt-6-luna");
        assert.equal(explained.modelSource, "invocation");
        assert.equal(explained.effort, "low");
        assert.equal(explained.effortSource, "invocation");
        const workflow = explainCodexImportPrecedence({
            workflowModel: "openai/gpt-6-astra",
            workflowEffort: "high",
            agentOverrideModel: "openai/gpt-6-sol",
            roleModel: "openai/gpt-6-sol",
            roleEffort: "medium",
        });
        assert.equal(workflow.modelSource, "workflow");
        assert.equal(workflow.effortSource, "workflow");
        assert.match(explained.note, /Codex gives the agent file/);
        assert.match(explained.note, /Pi does not copy that precedence/);
        assert.match(PI_VS_CODEX_PRECEDENCE.pi, /workflow instructions/);
    });

    it("T32 preview shows actual lost lines, role, and mode and does not merge", () => {
        const parsed = parseCodexSource(readFileSync(join(fixtureDir, "reviewer.toml"), "utf8"), "/tmp/reviewer.toml");
        const built = buildImportedAgent(parsed.document, {
            id: "agent.reviewer",
            roleId: "role.reviewer",
            saveOverrides: false,
            importedAt: "2026-09-24T00:00:00.000Z",
            sourceRef: "codex-file:/tmp/reviewer.toml",
        });
        assert.equal(built.ok, true);
        assert.deepEqual(built.definition.overrides, {});
        assert.equal(built.definition.instructionMode, "replace");
        assert.equal(built.definition.roleId, "role.reviewer");
        const local = {
            ...built.definition,
            roleId: "role.developer",
            instructionMode: "add",
            overrides: { effort: "low" },
            body: `${built.definition.body.replace(/\n$/, "")}\nLOCAL ONLY EDIT\n`,
        };
        const preview = renderReimportPreview(local, built.definition);
        assert.equal(preview.replacedNotMerged, true);
        assert.equal(preview.id, "agent.reviewer");
        assert.match(preview.text, /LOCAL ONLY EDIT/);
        assert.match(preview.text, /role: role\.developer → role\.reviewer/);
        assert.match(preview.text, /instruction mode: add → replace/);
        assert.match(preview.text, /lost local override effort: "low"/);
        assert.match(preview.text, /instructions before:/);
        assert.match(preview.text, /instructions after:/);
        assert.equal(agentIdFromDisplayName("Read Only Reviewer"), "agent.read-only-reviewer");
        const tie = suggestBaseRoles("research and review", [
            { id: "role.researcher", name: "Researcher" },
            { id: "role.reviewer", name: "Reviewer" },
            { id: "role.developer", name: "Developer" },
        ]);
        assert.equal(tie.unique, undefined);
        assert.deepEqual(tie.ambiguous.sort(), ["role.researcher", "role.reviewer"]);
    });

    it("redacts nested credentials before reasons, diagnostics, provenance, preview, and serialized output", () => {
        const sentinel = "SYNTHETIC_REVIEW_SENTINEL";
        const source = [
            'name = "Nested Secret"',
            'description = "Holds a nested key."',
            'developer_instructions = "Do not keep secrets."',
            "",
            "[env]",
            `API_KEY = "${sentinel}"`,
            "",
            "[profile]",
            `password = "${sentinel}"`,
            `nested = { token = "${sentinel}" }`,
        ].join("\n");
        const parsed = parseCodexSource(source, "/tmp/nested.toml");
        assert.equal(parsed.ok, true);
        assert.equal(JSON.stringify({ document: parsed.document, diagnostics: parsed.diagnostics }).includes(sentinel), false);
        assert.equal(parsed.diagnostics.some((item) => item.code === "credential-material"), true);
        const env = parsed.document.restrictions.find((item) => item.name === "env");
        assert.equal(env.required, true);
        assert.equal(env.honored, false);
        assert.equal(env.value.API_KEY, "[redacted]");
        assert.match(env.reason, /blocks launch/);
        assert.doesNotMatch(env.reason, new RegExp(sentinel));
        const built = buildImportedAgent(parsed.document, {
            id: "agent.nested-secret",
            roleId: "role.developer",
            saveOverrides: false,
            importedAt: "2026-09-24T00:00:00.000Z",
            sourceRef: "codex-file:/tmp/nested.toml",
        });
        assert.equal(built.ok, true);
        const serialized = serializeDefinition(built.definition);
        assert.equal(serialized.ok, true);
        const packed = JSON.stringify({
            built,
            markdown: serialized.markdown,
            diagnostics: [...parsed.diagnostics, ...built.diagnostics, ...serialized.diagnostics],
            provenance: built.definition.provenance,
        });
        assert.equal(packed.includes(sentinel), false);
        const poisoned = {
            ...built.definition,
            metadata: { ...(built.definition.metadata ?? {}), owner: "local-owner", apiKey: sentinel },
            provenance: { ...built.definition.provenance, note: "local note" },
            executionRestrictions: [
                ...built.definition.executionRestrictions,
                {
                    name: "env",
                    value: { API_KEY: sentinel },
                    required: true,
                    honored: false,
                    reason: `Codex env={"API_KEY":"${sentinel}"} leaked into a reason`,
                },
            ],
        };
        const preview = renderReimportPreview(poisoned, built.definition);
        assert.equal(JSON.stringify(preview).includes(sentinel), false);
        assert.match(preview.text, /local note/);
        assert.match(preview.text, /local-owner/);
        assert.match(preview.text, /\[redacted\]/);
    });

    it("preserves web_search as an unsupported restriction and does not grant launch", () => {
        const source = [
            'name = "Web Reader"',
            'description = "Review without search"',
            'developer_instructions = "Review"',
            'web_search = "disabled"',
            'nickname = "reader"',
        ].join("\n");
        const parsed = parseCodexSource(source, "/tmp/web-reader.toml");
        assert.equal(parsed.ok, true);
        assert.equal(parsed.document.cosmetic.web_search, undefined);
        assert.equal(parsed.document.cosmetic.nickname, "reader");
        const restriction = parsed.document.restrictions.find((item) => item.name === "web_search");
        assert.equal(restriction.value, "disabled");
        assert.equal(restriction.required, true);
        assert.equal(restriction.honored, false);
        assert.match(restriction.reason, /blocks launch/);
        assert.match(restriction.reason, /not enforced/);
        assert.match(restriction.reason, /does not grant or disable search/);
        const live = parseCodexSource(source.replace('web_search = "disabled"', 'web_search = "live"'), "/tmp/web-live.toml");
        assert.equal(live.document.cosmetic.web_search, undefined);
        assert.equal(live.document.restrictions.find((item) => item.name === "web_search").value, "live");
        assert.equal(live.document.restrictions.find((item) => item.name === "web_search").honored, false);
    });

    it("previews every replaced or lost local field, not a fixed field list", () => {
        const parsed = parseCodexSource(readFileSync(join(fixtureDir, "reviewer.toml"), "utf8"), "/tmp/reviewer.toml");
        const built = buildImportedAgent(parsed.document, {
            id: "agent.reviewer",
            roleId: "role.reviewer",
            saveOverrides: false,
            importedAt: "2026-09-24T00:00:00.000Z",
            sourceRef: "codex-file:/tmp/reviewer.toml",
        });
        const local = {
            ...built.definition,
            roleId: "role.developer",
            instructionMode: "add",
            overrides: { effort: "low" },
            metadata: { ...(built.definition.metadata ?? {}), owner: "UNPREVIEWED_LOCAL_OWNER", team: "LOCAL_TEAM" },
            provenance: { ...built.definition.provenance, note: "UNPREVIEWED_LOCAL_NOTE" },
            extensions: { ...(built.definition.extensions ?? {}), reviewLabel: "LOCAL_LABEL" },
            body: `${built.definition.body.replace(/\n$/, "")}\nLOCAL ONLY EDIT\n`,
        };
        const preview = renderReimportPreview(local, built.definition);
        for (const marker of ["UNPREVIEWED_LOCAL_OWNER", "LOCAL_TEAM", "UNPREVIEWED_LOCAL_NOTE", "LOCAL_LABEL", "LOCAL ONLY EDIT"]) {
            assert.match(preview.text, new RegExp(marker));
        }
        assert.match(preview.text, /role: role\.developer → role\.reviewer/);
        assert.match(preview.text, /instruction mode: add → replace/);
        assert.match(preview.text, /lost local metadata\.owner: "UNPREVIEWED_LOCAL_OWNER"/);
        assert.match(preview.text, /lost local override effort: "low"/);
        const fields = new Set(preview.changes.map((item) => item.field));
        for (const field of ["roleId", "instructionMode", "body", "overrides.effort", "metadata.owner", "metadata.team", "provenance.note", "extensions.reviewLabel"]) {
            assert.equal(fields.has(field), true, field);
        }
        assert.match(preview.text, /changed fields:/);
    });
});
