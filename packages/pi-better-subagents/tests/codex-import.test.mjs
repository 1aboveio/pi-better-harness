import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
});
