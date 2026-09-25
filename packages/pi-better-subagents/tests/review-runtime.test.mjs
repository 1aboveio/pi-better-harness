/**
 * SPEC-03/04/06/07: current launchability, effective capabilities, the Pi
 * argument schema, and per-job clarification. Schema checks go through Pi's
 * validateToolArguments, not only tool.execute.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "review-runtime-"));
const runtimeTmp = join(root, "tmp");
mkdirSync(runtimeTmp, { recursive: true });
process.env.TMPDIR = runtimeTmp;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { setConfigForTests } = await import("../config.ts");
const { clarifyCatalogRequest } = await import("../catalog-runtime.ts");
const { resolveRoleAssignment } = await import("../role-assignment.ts");
const { mergeJobOptions } = await import("../batch.mjs");
const { default: extension } = await import("../index.ts");
// Pi does not export this subpath. Import the installed file, the same boundary command-repros used.
const { validateToolArguments } = await import("../../../node_modules/@earendil-works/pi-ai/dist/utils/validation.js");

const tools = {};
setConfigForTests({ defaultTools: "read", maxConcurrent: 4, defaultModel: null, tierPolicy: null });
extension({
    registerTool(tool) { tools[tool.name] = tool; },
    registerCommand() {},
    on() {},
    sendMessage() {},
});

function ctxWith(registry) {
    return {
        cwd: root,
        hasUI: false,
        isProjectTrusted: () => true,
        model: { provider: "openai", id: "gpt-6-sol" },
        modelRegistry: registry,
        ui: { select: async () => undefined },
    };
}

function runNames() {
    const dir = join(runtimeTmp, "pi-better-subagents", "runs");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("review runtime P1", () => {
    after(() => {
        setConfigForTests(undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it("reflects registry availability and the default tool allowlist on inspection", async () => {
        const models = [{ provider: "openai", id: "gpt-6-sol", reasoning: true }];
        const registry = { getAvailable: () => models };
        const ctx = ctxWith(registry);
        const inspect = () => tools.agents_catalog.execute("inspect", { action: "inspect", id: "role.developer" }, undefined, undefined, ctx);
        const first = await inspect();
        assert.equal(first.details.view.launchable, true);
        assert.equal(first.details.view.actualModel, "openai/gpt-6-sol");
        assert.equal(first.details.view.capabilities.grantedByCatalog, false);
        assert.equal(first.details.view.capabilities.sameAsLegacySpawn, true);
        assert.deepEqual([...first.details.view.capabilities.extraGrants], []);
        assert.equal(first.details.view.capabilities.effective.toolAllowlist, "read");
        assert.equal(first.details.view.capabilities.effective.extensions.providerExtensions, "resolved");
        assert.equal(first.details.view.capabilities.effective.nesting.allowNested, false);
        assert.equal(first.details.view.capabilities.effective.sandbox.enabled, true);
        assert.equal(typeof first.details.view.capabilities.effective.sandbox.applied, "boolean");
        assert.equal(first.details.view.capabilities.effective.workspace.cwd, root);
        assert.equal(first.details.view.capabilities.effective.workspace.gitClone, false);
        assert.match(first.details.view.text, /tool allowlist: "read"/);
        assert.match(first.details.view.text, /catalog did not grant/);

        registry.getAvailable = () => [];
        const second = await inspect();
        assert.equal(second.details.view.launchable, false);
        assert.equal(second.details.view.actualModel, null);
        assert.equal(second.details.view.capabilities.effective.extensions.providerExtensions, "unknown");
        assert.equal(second.details.view.capabilities.effective.toolAllowlist, "read");

        setConfigForTests({ defaultTools: "read,bash,edit,write", maxConcurrent: 4, defaultModel: null, tierPolicy: null });
        const third = await inspect();
        assert.equal(third.details.view.launchable, false);
        assert.equal(third.details.view.capabilities.effective.toolAllowlist, "read,bash,edit,write");
        assert.equal(third.details.view.capabilities.grantedByCatalog, false);
        assert.notEqual(JSON.stringify(first.details.view.capabilities), JSON.stringify(third.details.view.capabilities));
        assert.match(third.details.view.text, /read,bash,edit,write/);
        assert.deepEqual(
            third.details.view.capabilities.controls,
            first.details.view.capabilities.controls,
        );
    });

    it("admits an ambiguous role array through Pi validation and does not launch", async () => {
        const ambiguous = ["role.developer", "role.reviewer"];
        const spawnArgs = validateToolArguments(tools.subagent_spawn, {
            id: "t",
            name: "subagent_spawn",
            arguments: { prompt: "Both", role: ambiguous },
        });
        assert.deepEqual(spawnArgs.role, ambiguous);
        const batchArgs = validateToolArguments(tools.subagent_spawn_batch, {
            id: "t",
            name: "subagent_spawn_batch",
            arguments: {
                shared: { role: ["role.developer", "role.reviewer"] },
                jobs: [
                    { prompt: "Shared" },
                    { prompt: "Per job", role: ["role.explorer", "role.architect"] },
                    { prompt: "Plain" },
                ],
            },
        });
        assert.deepEqual(batchArgs.shared.role, ["role.developer", "role.reviewer"]);
        assert.deepEqual(batchArgs.jobs[1].role, ["role.explorer", "role.architect"]);
        const plain = validateToolArguments(tools.subagent_spawn, {
            id: "t",
            name: "subagent_spawn",
            arguments: { prompt: "One", role: "role.developer" },
        });
        assert.equal(plain.role, "role.developer");

        const before = runNames();
        const single = await tools.subagent_spawn.execute("call", spawnArgs, undefined, undefined, ctxWith({
            getAvailable: () => [{ provider: "openai", id: "gpt-6-sol", reasoning: true }],
        }));
        assert.equal(single.details.status, "clarification-needed");
        assert.equal(single.details.launched, false);
        assert.equal(single.details.wrote, false);
        assert.match(single.content[0].text, /Nothing was launched/);
        const batch = await tools.subagent_spawn_batch.execute("call", batchArgs, undefined, undefined, ctxWith({
            getAvailable: () => [{ provider: "openai", id: "gpt-6-sol", reasoning: true }],
        }));
        assert.equal(batch.details.status, "clarification-needed");
        assert.equal(batch.details.launched, false);
        assert.equal(batch.details.wrote, false);
        assert.deepEqual(runNames(), before);
    });

    it("keeps one choice on its own job across shared and per-job selectors", async () => {
        const calls = [];
        const merged = [
            { prompt: "From shared" },
            { prompt: "Per job", role: ["role.explorer", "role.architect"] },
            { prompt: "Stay", role: "role.researcher" },
        ].map((job) => mergeJobOptions({ role: ["role.developer", "role.reviewer"], alias: "shared-alias" }, job));
        const result = await clarifyCatalogRequest(merged, {
            hasUI: true,
            select: async (title, options) => {
                calls.push({ title, options: [...options] });
                if (options.includes("Choose role.developer")) return "Choose role.developer";
                if (options.includes("Choose role.architect")) return "Choose role.architect";
                throw new Error(`unexpected options for ${title}: ${options.join("|")}`);
            },
        });
        assert.equal(result.status, "resolved");
        assert.equal(calls.length, 2);
        assert.deepEqual(result.jobs.map((job) => [job.prompt, job.role, job.alias ?? null]), [
            ["From shared", "role.developer", "shared-alias"],
            ["Per job", "role.architect", "shared-alias"],
            ["Stay", "role.researcher", "shared-alias"],
        ]);

        const leaked = await clarifyCatalogRequest([
            { prompt: "Review payments", agent: "agent.payments", role: "role.reviewer" },
            { prompt: "Explore separately", agent: "agent.research", role: "role.explorer" },
        ], { hasUI: true, select: async () => "Choose role.reviewer" });
        assert.equal(leaked.status, "clarification-needed");
        assert.equal(leaked.launched, false);

        const roles = await resolveRoleAssignment([
            { jobId: "pay", roleId: "role.developer" },
            { jobId: "pay", roleId: "role.reviewer" },
            { jobId: "look", roleId: "role.explorer" },
            { jobId: "look", roleId: "role.architect" },
            { jobId: "plain", roleId: "role.researcher" },
        ], {
            hasUI: true,
            select: async (_title, options) => {
                if (options.includes("Choose role.reviewer") && options.includes("Choose role.developer")) return "Split into 2 runs";
                if (options.includes("Choose role.explorer")) return "Choose role.explorer";
                throw new Error(options.join("|"));
            },
        });
        assert.equal(roles.status, "resolved");
        assert.equal(roles.launched, false);
        assert.deepEqual(roles.jobs, [
            { jobId: "pay#1", roleId: "role.developer" },
            { jobId: "pay#2", roleId: "role.reviewer" },
            { jobId: "look", roleId: "role.explorer" },
            { jobId: "plain", roleId: "role.researcher" },
        ]);
    });
});
