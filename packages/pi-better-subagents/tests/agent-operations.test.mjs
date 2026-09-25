import { selectPackedResult } from "../../../scripts/stage-harness-dependencies.mjs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentOperations } from "../agent-operations.ts";
import { executeAgentsCommand, registerAgentCommands } from "../agent-commands.ts";
import { agentsCatalogTool } from "../agents-catalog-tool.ts";
import { CAPABILITY_NOTE, LEGACY_CAPABILITY_CONTROLS } from "../agent-inspection.ts";
import { parseDefinition } from "../catalog-schema.ts";
import { prepareCatalogJob } from "../catalog-runtime.ts";
import { loadCatalog, saveDefinition } from "../catalog-store.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "codex");
const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageDir, "../..");
const Type = {
    Object: (value) => value,
    String: (value) => value,
    Optional: (value) => value,
};

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-agents-ops-"));
    const cwd = join(root, "project");
    const userRoot = join(root, "user");
    mkdirSync(cwd);
    mkdirSync(userRoot);
    return {
        root,
        cwd,
        userRoot,
        cleanup() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}

function scripted(steps) {
    const calls = [];
    const take = (type, title) => {
        calls.push({ type, title });
        const step = steps.shift();
        if (!step || step.type !== type) throw new Error(`unexpected ${type} ${title}; next ${JSON.stringify(step)}`);
        return step;
    };
    return {
        calls,
        async select(title, options) {
            const step = take("select", title);
            calls.at(-1).options = options;
            calls.at(-1).message = title;
            return typeof step.value === "function" ? step.value(options) : step.value;
        },
        async confirm(title, message) {
            const step = take("confirm", title);
            calls.at(-1).message = message;
            return step.value;
        },
        async input(title, placeholder) {
            const step = take("input", title);
            calls.at(-1).placeholder = placeholder;
            return step.value;
        },
        async editor(title, prefill) {
            const step = take("editor", title);
            calls.at(-1).prefill = prefill;
            return step.value;
        },
        notify(message, level) {
            calls.push({ type: "notify", message, level });
        },
    };
}

function host(ctx, ui, { trusted = true, hasUI = true, mode = "tui" } = {}) {
    return {
        cwd: ctx.cwd,
        hasUI,
        mode,
        isProjectTrusted: () => trusted,
        ui,
    };
}

function deps(ctx) {
    return { userRoot: ctx.userRoot, now: () => "2026-09-24T00:00:00.000Z" };
}

function filesUnder(directory) {
    try {
        return readdirSync(directory).sort();
    } catch {
        return [];
    }
}

describe("agent operations", () => {
    it("T18 lists precedence, duplicate diagnostics, and fresh edits for humans and the tool", async () => {
        const ctx = fixture();
        try {
            const created = await executeAgentsCommand(
                'create --role role.developer --name "Personal Dev" --instructions "Personal body."',
                host(ctx, scripted([]), { hasUI: false }),
                deps(ctx),
            );
            assert.equal(created.status, "ok", created.message);
            assert.equal(created.scope, "user");
            assert.equal(created.wrote, true);
            const project = await executeAgentsCommand(
                'create --role role.developer --id agent.personal-dev --name "Project Dev" --scope project --instructions "Project body." --description "Project wins"',
                host(ctx, scripted([]), { hasUI: false }),
                deps(ctx),
            );
            assert.equal(project.status, "ok", project.message);
            assert.match(project.path, /\.pi\/agents\/agents\/agent\.personal-dev\.md$/);
            const listed = await executeAgentsCommand("list", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            const winner = listed.data.entries.find((entry) => entry.id === "agent.personal-dev");
            assert.equal(winner.identity.scope, "project");
            assert.equal(winner.shadowed.some((item) => item.scope === "user"), true);
            assert.match(listed.message, /role\.developer/);
            assert.match(listed.message, /not required/);
            const inspected = await executeAgentsCommand("inspect agent.personal-dev", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.equal(inspected.status, "ok");
            assert.match(inspected.message, /winning source: project/);
            assert.match(inspected.message, /shadowed: user/);
            assert.equal(inspected.data.fields.model.source, "role-default");
            assert.equal(inspected.data.fields.model.explicit, false);
            assert.equal(inspected.data.launchable, null);
            assert.match(inspected.message, /Definition validity is not launchability/);
            writeFileSync(project.path, readFileSync(project.path, "utf8").replace("Project body.", "Edited project body."));
            const reloaded = await executeAgentsCommand("reload", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.match(reloaded.message, /not a prerequisite/);
            const edited = await executeAgentsCommand("show agent.personal-dev", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.match(edited.message, /Edited project body\./);
            assert.equal(edited.data.instructions.includes("Edited project body."), true);
            const userAgents = join(ctx.userRoot, "agents", "agents");
            writeFileSync(join(ctx.cwd, ".pi", "agents", "agents", "second-copy.md"), `---
schema: pi-agent/v1
kind: agent
id: agent.personal-dev
name: Duplicate
roleId: role.developer
instructions:
  mode: add
---
Duplicate body.
`);
            const duplicated = await executeAgentsCommand("list", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.match(duplicated.message, /duplicate-id/);
            assert.equal(duplicated.data.entries.some((entry) => entry.id === "role.developer"), true);
            mkdirSync(join(ctx.cwd, ".codex", "agents"), { recursive: true });
            writeFileSync(join(ctx.cwd, ".codex", "agents", "hidden.toml"), readFileSync(join(fixtureDir, "reviewer.toml"), "utf8"));
            const hidden = await executeAgentsCommand("list", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.equal(hidden.data.entries.some((entry) => entry.id === "agent.reviewer"), false);
            const scanned = await executeAgentsCommand(
                `import-codex ${join(ctx.cwd, ".codex", "agents")}`,
                host(ctx, scripted([]), { hasUI: false }),
                deps(ctx),
            );
            assert.equal(scanned.wrote, false);
            assert.match(scanned.message, /does not scan directories/);
            const skill = await executeAgentsCommand(
                `import-codex ${join(fixtureDir, "agents", "openai.yaml")}`,
                host(ctx, scripted([]), { hasUI: false }),
                deps(ctx),
            );
            assert.equal(skill.wrote, false);
            assert.equal(skill.diagnostics.some((item) => item.code === "skill-metadata-not-agent"), true);
            const tool = agentsCatalogTool(Type, deps(ctx));
            assert.deepEqual(tool.promptGuidelines.length > 0, true);
            const toolList = await tool.execute("call-1", { action: "list" }, undefined, undefined, {
                cwd: ctx.cwd,
                isProjectTrusted: () => true,
            });
            assert.equal(toolList.details.wrote, false);
            assert.equal(toolList.details.entries.some((entry) => entry.id === "role.architect"), true);
            const before = filesUnder(userAgents).concat(filesUnder(join(ctx.cwd, ".pi", "agents", "agents")));
            const refused = await tool.execute("call-2", { action: "import-codex", id: "agent.reviewer" }, undefined, undefined, {
                cwd: ctx.cwd,
                isProjectTrusted: () => true,
            });
            assert.equal(refused.isError, true);
            assert.match(refused.content[0].text, /Nothing was written/);
            const after = filesUnder(userAgents).concat(filesUnder(join(ctx.cwd, ".pi", "agents", "agents")));
            assert.deepEqual(after, before);
        } finally {
            ctx.cleanup();
        }
    });

    it("T24 catalog inspection grants no capabilities beyond the legacy spawn controls", async () => {
        const ctx = fixture();
        try {
            mkdirSync(join(ctx.cwd, ".pi", "agents", "roles"), { recursive: true });
            writeFileSync(join(ctx.cwd, ".pi", "agents", "roles", "role.locked-reader.md"), `---
schema: pi-agent/v1
kind: role
id: role.locked-reader
name: Read Only
description: The name says read-only and that is not enforcement.
defaults:
  model: openai/gpt-6-sol
  effort: medium
  tier: balanced
---
You only have read-only access.
`);
            const view = await executeAgentsCommand("show role.locked-reader", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            const legacy = await executeAgentsCommand("show role.developer", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.deepEqual(view.data.capabilities.controls, [...LEGACY_CAPABILITY_CONTROLS]);
            assert.deepEqual(view.data.capabilities.controls, legacy.data.capabilities.controls);
            assert.equal(view.data.capabilities.grantedByCatalog, false);
            assert.deepEqual([...view.data.capabilities.extraGrants], []);
            assert.equal(view.data.capabilities.sameAsLegacySpawn, true);
            assert.equal(view.data.capabilities.note, CAPABILITY_NOTE);
            assert.equal(view.data.restrictions.length, 0);
            assert.match(view.message, /read-only is not enforcement/);
            assert.doesNotMatch(view.message, /read-only mode is on|sandbox_mode is active/);
        } finally {
            ctx.cleanup();
        }
    });

    it("T31 confirms role and replace mode, defaults to personal storage, and ignores later source edits", async () => {
        const ctx = fixture();
        try {
            const headless = await executeAgentsCommand(
                `import-codex ${join(fixtureDir, "reviewer.toml")}`,
                host(ctx, scripted([]), { hasUI: false, mode: "print" }),
                deps(ctx),
            );
            assert.equal(headless.status, "clarification-needed");
            assert.equal(headless.wrote, false);
            assert.match(headless.message, /Suggested role: role\.reviewer/);
            assert.match(headless.message, /replace/);
            assert.match(headless.message, /Nothing was written/);
            assert.match(headless.message, /Review the change/);
            assert.deepEqual(filesUnder(join(ctx.userRoot, "agents", "agents")), []);
            const ui = scripted([
                { type: "select", value: (options) => options.find((option) => option.startsWith("role.reviewer")) },
                { type: "confirm", value: true },
                { type: "select", value: "Inherit model and effort from the selected role" },
            ]);
            const imported = await executeAgentsCommand(
                `import-codex ${join(fixtureDir, "reviewer.toml")}`,
                host(ctx, ui),
                deps(ctx),
            );
            assert.equal(imported.status, "ok", imported.message);
            assert.equal(imported.scope, "user");
            assert.match(imported.path, new RegExp(`${ctx.userRoot}/agents/agents/agent\\.reviewer\\.md`));
            assert.equal(ui.calls.some((call) => call.type === "confirm" && /replace the role\.reviewer/.test(call.message)), true);
            const native = parseDefinition(readFileSync(imported.path, "utf8"));
            assert.equal(native.definition.instructionMode, "replace");
            assert.equal(native.definition.roleId, "role.reviewer");
            assert.deepEqual(native.definition.overrides, {});
            assert.match(native.definition.body, /Review the change/);
            assert.equal(native.definition.provenance.origin, "imported");
            assert.equal(native.definition.provenance.format, "codex-toml");
            const sourcePath = join(ctx.cwd, "reviewer.toml");
            writeFileSync(sourcePath, readFileSync(join(fixtureDir, "reviewer.toml"), "utf8").replace("Review the change.", "SOURCE CHANGED."));
            const copied = join(ctx.cwd, "copied.toml");
            writeFileSync(copied, readFileSync(sourcePath, "utf8"));
            const reread = readFileSync(imported.path, "utf8");
            assert.match(reread, /Review the change/);
            assert.doesNotMatch(reread, /SOURCE CHANGED/);
            const declined = await executeAgentsCommand(
                `import-codex ${copied}`,
                host(ctx, scripted([
                    { type: "select", value: (options) => options.find((option) => option.startsWith("role.reviewer")) },
                    { type: "confirm", value: false },
                ])),
                deps(ctx),
            );
            assert.equal(declined.wrote, false);
            assert.match(readFileSync(imported.path, "utf8"), /Review the change/);
            const project = await executeAgentsCommand(
                'create --role role.explorer --name "Project Explorer" --scope project --instructions "Explore."',
                host(ctx, scripted([]), { hasUI: false }),
                deps(ctx),
            );
            assert.match(project.path, /\.pi\/agents\/agents\/agent\.project-explorer\.md$/);
            const untrusted = await executeAgentsCommand(
                'create --role role.explorer --name "Nope" --scope project --instructions "No."',
                host(ctx, scripted([]), { hasUI: false, trusted: false }),
                deps(ctx),
            );
            assert.equal(untrusted.wrote, false);
            assert.match(untrusted.message, /not trusted/);
        } finally {
            ctx.cleanup();
        }
    });

    it("T32 re-import previews lost edits and replaces only after confirmation while retaining the id", async () => {
        const ctx = fixture();
        try {
            const ui = scripted([
                { type: "select", value: (options) => options.find((option) => option.startsWith("role.reviewer")) },
                { type: "confirm", value: true },
                { type: "select", value: "Inherit model and effort from the selected role" },
            ]);
            const imported = await executeAgentsCommand(`import-codex ${join(fixtureDir, "reviewer.toml")}`, host(ctx, ui), deps(ctx));
            assert.equal(imported.wrote, true, imported.message);
            const current = parseDefinition(readFileSync(imported.path, "utf8"));
            current.definition.body = `${current.definition.body.replace(/\n$/, "")}\nLOCAL ONLY EDIT\n`;
            current.definition.roleId = "role.developer";
            current.definition.instructionMode = "add";
            current.definition.overrides = { effort: "low" };
            const saved = saveDefinition({
                definition: current.definition,
                scope: "user",
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: true,
                replace: true,
            });
            assert.equal(saved.ok, true, saved.diagnostics.map((item) => item.message).join("\n"));
            const source = join(ctx.cwd, "reviewer.toml");
            writeFileSync(source, readFileSync(join(fixtureDir, "reviewer.toml"), "utf8"));
            const declinedUi = scripted([
                { type: "select", value: (options) => options.find((option) => option.startsWith("role.reviewer")) },
                { type: "confirm", value: true },
                { type: "select", value: "Inherit model and effort from the selected role" },
                { type: "confirm", value: false },
            ]);
            const declined = await executeAgentsCommand(`import-codex ${source}`, host(ctx, declinedUi), deps(ctx));
            assert.equal(declined.status, "clarification-needed");
            assert.equal(declined.wrote, false);
            const preview = declinedUi.calls.find((call) => call.type === "confirm" && call.title?.startsWith?.("Replace") || (call.type === "confirm" && /Replace agent\.reviewer/.test(call.title ?? "")));
            const previewCall = declinedUi.calls.filter((call) => call.type === "confirm").at(-1);
            assert.match(previewCall.message, /LOCAL ONLY EDIT/);
            assert.match(previewCall.message, /role: role\.developer → role\.reviewer/);
            assert.match(previewCall.message, /instruction mode: add → replace/);
            assert.match(previewCall.message, /lost local override effort/);
            assert.match(declined.message, /LOCAL ONLY EDIT/);
            assert.match(readFileSync(saved.path, "utf8"), /LOCAL ONLY EDIT/);
            assert.equal(preview, previewCall);
            const acceptedUi = scripted([
                { type: "select", value: (options) => options.find((option) => option.startsWith("role.reviewer")) },
                { type: "confirm", value: true },
                { type: "select", value: "Inherit model and effort from the selected role" },
                { type: "confirm", value: true },
            ]);
            const accepted = await executeAgentsCommand(`import-codex ${source}`, host(ctx, acceptedUi), deps(ctx));
            assert.equal(accepted.wrote, true, accepted.message);
            const replaced = parseDefinition(readFileSync(accepted.path, "utf8"));
            assert.equal(replaced.definition.id, "agent.reviewer");
            assert.equal(replaced.definition.roleId, "role.reviewer");
            assert.equal(replaced.definition.instructionMode, "replace");
            assert.equal(replaced.definition.overrides.effort, undefined);
            assert.match(replaced.definition.body, /Review the change/);
            assert.doesNotMatch(replaced.definition.body, /LOCAL ONLY EDIT/);
            assert.doesNotMatch(replaced.definition.body, /LOCAL ONLY EDIT[\s\S]*Review the change|Review the change[\s\S]*LOCAL ONLY EDIT/);
        } finally {
            ctx.cleanup();
        }
    });

    it("T34 asks to choose or split for two roles and leaves two distinct jobs valid", async () => {
        const ctx = fixture();
        try {
            const headless = await executeAgentsCommand(
                'create --role role.developer --role role.reviewer --name "Both" --instructions "No."',
                host(ctx, scripted([]), { hasUI: false, mode: "json" }),
                deps(ctx),
            );
            assert.equal(headless.status, "clarification-needed");
            assert.equal(headless.wrote, false);
            assert.match(headless.message, /role\.developer/);
            assert.match(headless.message, /role\.reviewer/);
            assert.match(headless.message, /Choose one role or split/);
            assert.match(headless.message, /UI is unavailable/);
            assert.deepEqual(filesUnder(join(ctx.userRoot, "agents", "agents")), []);
            const chosen = await executeAgentsCommand(
                'create --role role.developer --role role.reviewer --name "Chosen" --instructions "One role."',
                host(ctx, scripted([{ type: "select", value: "Choose role.developer" }]), { hasUI: true }),
                deps(ctx),
            );
            assert.equal(chosen.wrote, true, chosen.message);
            const chosenDef = parseDefinition(readFileSync(chosen.path, "utf8"));
            assert.equal(chosenDef.definition.roleId, "role.developer");
            assert.equal(chosenDef.definition.roleIds, undefined);
            const split = await executeAgentsCommand(
                'create --role role.developer --role role.reviewer --name "Split" --instructions "Two runs."',
                host(ctx, scripted([{ type: "select", value: "Split into 2 runs" }]), { hasUI: true }),
                deps(ctx),
            );
            assert.equal(split.wrote, false);
            assert.match(split.message, /Split chosen/);
            assert.match(split.message, /not multiple parents/);
            const operations = createAgentOperations(deps(ctx));
            let selects = 0;
            const jobs = await operations.resolveRoleAssignment([
                { jobId: "implement", roleId: "role.developer" },
                { jobId: "review", roleId: "role.reviewer" },
            ], { hasUI: true, select: async () => { selects += 1; return undefined; } });
            assert.equal(jobs.status, "resolved");
            assert.equal(jobs.launched, false);
            assert.equal(jobs.wrote, false);
            assert.equal(jobs.multipleParents, false);
            assert.equal(selects, 0);
            assert.deepEqual(jobs.jobs, [
                { jobId: "implement", roleId: "role.developer" },
                { jobId: "review", roleId: "role.reviewer" },
            ]);
            const unattended = await operations.resolveRoleAssignment([
                { roleId: "role.developer" },
                { roleId: "role.architect" },
            ], { hasUI: false });
            assert.equal(unattended.status, "clarification-needed");
            assert.equal(unattended.launched, false);
            assert.equal(unattended.jobs.length, 0);
        } finally {
            ctx.cleanup();
        }
    });

    it("T36 imports an unsupported read-only restriction, blocks that agent, and leaves another definition usable", async () => {
        const ctx = fixture();
        try {
            const ui = scripted([
                { type: "select", value: (options) => options.find((option) => option.startsWith("role.reviewer")) },
                { type: "confirm", value: true },
            ]);
            const imported = await executeAgentsCommand(`import-codex ${join(fixtureDir, "read-only.toml")}`, host(ctx, ui), deps(ctx));
            assert.equal(imported.wrote, true, imported.message);
            assert.equal(imported.data.view.definitionValid, true);
            assert.equal(imported.data.view.catalogLaunchable, false);
            assert.equal(imported.data.view.launchable, false);
            const restriction = imported.data.view.restrictions.find((item) => item.name === "sandbox_mode");
            assert.equal(restriction.value, "read-only");
            assert.equal(restriction.honored, false);
            assert.equal(restriction.enforced, false);
            assert.match(imported.message, /not enforced/);
            assert.match(readFileSync(imported.path, "utf8"), /sandbox_mode/);
            assert.doesNotMatch(imported.message, /read-only is active|enforced=true/);
            const sibling = await executeAgentsCommand("show role.developer", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.equal(sibling.data.catalogLaunchable, true);
            assert.equal(sibling.data.launchable, null);
            const enriched = agentsCatalogTool(Type, {
                ...deps(ctx),
                enrich: () => ({
                    availability: "available",
                    requestedModel: "openai/gpt-6-sol",
                    actualModel: "openai/gpt-6-sol",
                    requestedEffort: "high",
                    actualEffort: "high",
                    launchable: true,
                    modelReason: "test registry has the model",
                }),
            });
            const blocked = await enriched.execute("c", { action: "inspect", id: "agent.read-only-reviewer" }, undefined, undefined, {
                cwd: ctx.cwd,
                isProjectTrusted: () => true,
            });
            assert.equal(blocked.details.view.launchable, false);
            assert.match(blocked.details.view.text, /not enforced/);
            const open = await enriched.execute("c2", { action: "inspect", id: "role.developer" }, undefined, undefined, {
                cwd: ctx.cwd,
                isProjectTrusted: () => true,
            });
            assert.equal(open.details.view.launchable, true);
            assert.equal(open.details.view.actualModel, "openai/gpt-6-sol");
            assert.equal(open.details.view.actualEffort, "high");
            assert.notEqual(open.details.view.definitionValid, open.details.view.launchable && false);
            const secret = join(ctx.cwd, "secret.toml");
            writeFileSync(secret, `name = "Secret Agent"\ndescription = "Holds a secret."\ndeveloper_instructions = "Do not keep secrets."\napi_key = "super-secret-value"\n`);
            const leaked = await executeAgentsCommand(
                `import-codex ${secret}`,
                host(ctx, scripted([
                    { type: "select", value: (options) => options.find((option) => option.startsWith("role.developer")) },
                    { type: "confirm", value: true },
                ])),
                deps(ctx),
            );
            assert.equal(leaked.wrote, true, leaked.message);
            assert.doesNotMatch(readFileSync(leaked.path, "utf8"), /super-secret-value/);
            assert.doesNotMatch(leaked.message, /super-secret-value/);
            assert.equal(leaked.data.view.launchable, false);
        } finally {
            ctx.cleanup();
        }
    });

    it("blocks imported web_search restrictions and previews every lost local field through the command", async () => {
        const ctx = fixture();
        try {
            const source = join(ctx.cwd, "reader.toml");
            writeFileSync(source, [
                'name = "Web Reader"',
                'description = "Review without search"',
                'developer_instructions = "Review"',
                'web_search = "disabled"',
                'nickname = "reader"',
            ].join("\n"));
            const ui = scripted([
                { type: "confirm", value: true },
            ]);
            const imported = await executeAgentsCommand(`import-codex ${source} --role role.developer`, host(ctx, ui), deps(ctx));
            assert.equal(imported.wrote, true, imported.message);
            assert.equal(imported.data.view.catalogLaunchable, false);
            assert.equal(imported.data.view.launchable, false);
            const def = parseDefinition(readFileSync(imported.path, "utf8")).definition;
            const restriction = def.executionRestrictions.find((item) => item.name === "web_search");
            assert.equal(restriction.value, "disabled");
            assert.equal(restriction.required, true);
            assert.equal(restriction.honored, false);
            assert.equal(def.metadata?.codexCosmetic?.web_search, undefined);
            assert.equal(def.metadata?.codexCosmetic?.nickname, "reader");
            const registry = { getAvailable: () => [{ provider: "openai", id: "gpt-6-sol", reasoning: true }] };
            const prepared = await prepareCatalogJob(
                loadCatalog({ cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true }),
                { prompt: "Check", agent: "agent.web-reader" },
                { cwd: ctx.cwd, userRoot: ctx.userRoot, projectTrusted: true, registry, foregroundModel: "openai/gpt-6-sol" },
            );
            assert.equal(prepared.status, "blocked");
            const sibling = await executeAgentsCommand("show role.developer", host(ctx, scripted([]), { hasUI: false }), deps(ctx));
            assert.equal(sibling.data.catalogLaunchable, true);
            def.metadata.owner = "UNPREVIEWED_LOCAL_OWNER";
            def.metadata.team = "LOCAL_TEAM";
            def.provenance.note = "UNPREVIEWED_LOCAL_NOTE";
            def.extensions = { ...(def.extensions ?? {}), reviewLabel: "LOCAL_LABEL" };
            assert.equal(saveDefinition({
                definition: def,
                scope: "user",
                cwd: ctx.cwd,
                userRoot: ctx.userRoot,
                projectTrusted: true,
                replace: true,
            }).ok, true);
            const reimportUi = scripted([
                { type: "confirm", value: true },
                { type: "confirm", value: false },
            ]);
            const declined = await executeAgentsCommand(`import-codex ${source} --role role.developer`, host(ctx, reimportUi), deps(ctx));
            assert.equal(declined.wrote, false);
            const preview = reimportUi.calls.filter((call) => call.type === "confirm").at(-1);
            assert.match(preview.title, /^Replace /);
            for (const marker of ["UNPREVIEWED_LOCAL_OWNER", "LOCAL_TEAM", "UNPREVIEWED_LOCAL_NOTE", "LOCAL_LABEL"]) {
                assert.match(preview.message, new RegExp(marker), preview.message);
            }
            assert.match(preview.message, /role: role\.developer → role\.developer/);
            assert.match(preview.message, /instruction mode: replace → replace/);
            const acceptedUi = scripted([
                { type: "confirm", value: true },
                { type: "confirm", value: true },
            ]);
            const accepted = await executeAgentsCommand(`import-codex ${source} --role role.developer`, host(ctx, acceptedUi), deps(ctx));
            assert.equal(accepted.wrote, true, accepted.message);
            const replaced = parseDefinition(readFileSync(accepted.path, "utf8")).definition;
            assert.equal(replaced.id, "agent.web-reader");
            assert.equal(replaced.metadata.owner, undefined);
            assert.equal(replaced.extensions?.reviewLabel, undefined);
            assert.doesNotMatch(replaced.provenance.note, /UNPREVIEWED_LOCAL_NOTE/);
            assert.equal(replaced.executionRestrictions.some((item) => item.name === "web_search"), true);

            const sentinel = "SYNTHETIC_REVIEW_SENTINEL";
            const secret = join(ctx.cwd, "nested-secret.toml");
            writeFileSync(secret, [
                'name = "Nested Secret"',
                'description = "Holds a nested key."',
                'developer_instructions = "Do not keep secrets."',
                "",
                "[env]",
                `API_KEY = "${sentinel}"`,
                "",
                "[profile]",
                `password = "${sentinel}"`,
            ].join("\n"));
            const leaked = await executeAgentsCommand(
                `import-codex ${secret} --role role.developer`,
                host(ctx, scripted([
                    { type: "confirm", value: true },
                ])),
                deps(ctx),
            );
            assert.equal(leaked.wrote, true, leaked.message);
            assert.equal(JSON.stringify(leaked).includes(sentinel), false);
            assert.equal(readFileSync(leaked.path, "utf8").includes(sentinel), false);
            assert.equal(leaked.data.view.catalogLaunchable, false);
            const stored = parseDefinition(readFileSync(leaked.path, "utf8"));
            assert.equal(JSON.stringify(stored).includes(sentinel), false);
        } finally {
            ctx.cleanup();
        }
    });

    it("registers the Pi command and keeps create overrides explicit", async () => {
        const ctx = fixture();
        try {
            const ui = scripted([]);
            let registered;
            registerAgentCommands({
                registerCommand(name, options) {
                    registered = { name, options };
                },
            }, deps(ctx));
            assert.equal(registered.name, "agents");
            await registered.options.handler("list", {
                cwd: ctx.cwd,
                hasUI: true,
                mode: "tui",
                isProjectTrusted: () => true,
                ui,
            });
            assert.match(ui.calls.find((call) => call.type === "notify").message, /role\.developer/);
            const created = await executeAgentsCommand(
                'create --role role.developer --name "Payments" --model openai/gpt-6-luna --instructions "Look at payments."',
                host(ctx, scripted([]), { hasUI: false }),
                deps(ctx),
            );
            assert.equal(created.wrote, true, created.message);
            const definition = parseDefinition(readFileSync(created.path, "utf8")).definition;
            assert.deepEqual(definition.overrides, { model: "openai/gpt-6-luna" });
            assert.equal(definition.instructionMode, "add");
            assert.equal(created.data.fields.model.explicit, true);
            assert.equal(created.data.fields.effort.source, "role-default");
            assert.equal(created.data.fields.effort.explicit, false);
            assert.equal(created.data.fields.effort.value, "high");
            const badModel = await executeAgentsCommand(
                'create --role role.developer --name "Bad" --model gpt-6-luna --instructions "No."',
                host(ctx, scripted([]), { hasUI: false }),
                deps(ctx),
            );
            assert.equal(badModel.wrote, false);
            assert.match(badModel.message, /provider\/model/);
        } finally {
            ctx.cleanup();
        }
    });

    it("publishes the TOML parser, command modules, and operations doc", () => {
        const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
        assert.equal(manifest.dependencies["smol-toml"], "1.9.0");
        assert.ok(manifest.files.includes("docs/agent-catalog-operations.md"));
        const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
        assert.equal(lock.packages["packages/pi-better-subagents"].dependencies["smol-toml"], "1.9.0");
        assert.equal(lock.packages["node_modules/smol-toml"].version, "1.9.0");
        const source = readFileSync(join(packageDir, "codex-import.ts"), "utf8");
        assert.match(source, /from "smol-toml"/);
        const toolSource = readFileSync(join(packageDir, "agents-catalog-tool.ts"), "utf8");
        assert.doesNotMatch(toolSource, /saveDefinition|createDefinition|writeFile/);
        const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
            cwd: packageDir,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, npm_config_cache: join(repoRoot, ".npm-cache") },
        });
        const record = selectPackedResult(stdout);
        const names = record.files.map((file) => file.path);
        for (const fileName of ["codex-import.ts", "agent-commands.ts", "agents-catalog-tool.ts", "agent-operations.ts", "docs/agent-catalog-operations.md"]) {
            assert.ok(names.includes(fileName), `pack is missing ${fileName}`);
        }
    });
});
