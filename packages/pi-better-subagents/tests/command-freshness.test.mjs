/**
 * SPEC-03-R: /agents and model_select must follow the current foreground.
 * agents_catalog already re-read the tool context; the slash command kept the
 * host noted at session start, so human inspection stayed on the old model.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "command-freshness-"));
const runtimeTmp = join(root, "tmp");
mkdirSync(runtimeTmp, { recursive: true });
process.env.TMPDIR = runtimeTmp;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { setConfigForTests } = await import("../config.ts");
const { createLaunchEnricher, loadLaunchSnapshot, noteCatalogHost } = await import("../catalog-runtime.ts");
const { default: extension } = await import("../index.ts");

const tools = {};
const commands = {};
const events = {};
setConfigForTests({ defaultTools: "read", maxConcurrent: 4, defaultModel: null, tierPolicy: null });
extension({
    registerTool(tool) { tools[tool.name] = tool; },
    registerCommand(name, command) { commands[name] = command; },
    on(name, handler) { events[name] = handler; },
    sendMessage() {},
});

const baseConfig = { defaultTools: "read", maxConcurrent: 4, defaultModel: null, tierPolicy: null };

function model(id) {
    return { provider: "local", id, reasoning: true };
}

function harness(initial) {
    const notices = [];
    const state = {
        models: [initial],
        ctx: {
            cwd: root,
            hasUI: true,
            mode: "rpc",
            model: initial,
            modelRegistry: { getAvailable: () => state.models },
            isProjectTrusted: () => true,
            ui: {
                notify(message) { notices.push(message); },
                select: async () => undefined,
                setWidget() {},
            },
        },
    };
    return { notices, state };
}

function developer(list) {
    return list.entries.find((entry) => entry.id === "role.developer");
}

async function inspect(state) {
    return tools.agents_catalog.execute("inspect", { action: "inspect", id: "role.developer" }, undefined, undefined, state.ctx);
}

describe("current foreground for /agents", { concurrency: false }, () => {
    after(() => {
        setConfigForTests(undefined);
        rmSync(root, { recursive: true, force: true });
    });

    it("follows model_select for both the slash command and the discovery tool", async () => {
        setConfigForTests({ ...baseConfig });
        const before = model("before");
        const afterModel = model("after");
        const { notices, state } = harness(before);
        const first = await inspect(state);
        assert.equal(first.details.view.actualModel, "local/before");
        assert.equal(first.details.view.launchable, true);

        state.models = [afterModel];
        state.ctx.model = afterModel;
        await events.model_select({}, state.ctx);
        const command = await commands.agents.handler("inspect role.developer", state.ctx);
        const fresh = await inspect(state);

        assert.equal(command.data.actualModel, "local/after");
        assert.equal(command.data.launchable, true);
        assert.match(notices.at(-1), /launchable=yes/);
        assert.match(notices.at(-1), /actual model: "local\/after"/);
        assert.doesNotMatch(notices.at(-1), /local\/before/);
        assert.equal(fresh.details.view.actualModel, command.data.actualModel);
        assert.equal(fresh.details.view.launchable, command.data.launchable);
        assert.equal(fresh.details.view.actualEffort, command.data.actualEffort);
    });

    it("propagates a later command context when model_select did not run", async () => {
        setConfigForTests({ ...baseConfig });
        const { notices, state } = harness(model("before"));
        await commands.agents.handler("inspect role.developer", state.ctx);
        assert.match(notices.at(-1), /actual model: "local\/before"/);

        const later = model("later");
        state.models = [later];
        state.ctx.model = later;
        const listed = await commands.agents.handler("list", state.ctx);
        const shown = await commands.agents.handler("show role.developer", state.ctx);
        const tool = await inspect(state);

        assert.equal(developer(listed.data).actualModel, "local/later");
        assert.equal(developer(listed.data).launchable, true);
        assert.equal(shown.data.actualModel, "local/later");
        assert.equal(shown.data.launchable, true);
        assert.equal(tool.details.view.actualModel, shown.data.actualModel);
        assert.equal(tool.details.view.launchable, shown.data.launchable);
    });

    it("notes the selected model before the next slash command", async () => {
        setConfigForTests({ ...baseConfig });
        const afterModel = model("after");
        const { state } = harness(model("before"));
        state.models = [afterModel];
        state.ctx.model = afterModel;
        await events.model_select({}, state.ctx);

        const snapshot = loadLaunchSnapshot({
            cwd: root,
            projectTrusted: true,
            userRoot: process.env.PI_CODING_AGENT_DIR,
        });
        const row = createLaunchEnricher()({
            inspection: { id: "role.developer", found: true },
            snapshotDigest: snapshot.digest,
        });
        assert.equal(row.actualModel, "local/after");
        assert.equal(row.launchable, true);
        assert.match(row.modelReason, /local\/after/);
    });

    it("uses the current tier settings instead of the settings noted earlier", async () => {
        setConfigForTests({ ...baseConfig });
        const { state } = harness(model("before"));
        const first = await commands.agents.handler("inspect role.developer", state.ctx);
        assert.equal(first.data.actualModel, "local/before");

        const backup = { provider: "openai", id: "gpt-6-sol-backup", reasoning: true };
        setConfigForTests({
            ...baseConfig,
            tierPolicy: {
                balanced: {
                    members: ["openai/gpt-6-sol", "openai/gpt-6-sol-backup"],
                    candidates: ["openai/gpt-6-sol-backup"],
                },
            },
        });
        state.models = [backup];
        const command = await commands.agents.handler("inspect role.developer", state.ctx);
        const tool = await inspect(state);

        assert.equal(command.data.actualModel, "openai/gpt-6-sol-backup");
        assert.equal(command.data.launchable, true);
        assert.match(command.data.modelReason, /same-tier candidate/);
        assert.equal(tool.details.view.actualModel, "openai/gpt-6-sol-backup");
        assert.equal(tool.details.view.launchable, true);
        assert.equal(tool.details.view.modelReason, command.data.modelReason);
    });

    it("does not keep a foreground the current context cleared", async () => {
        setConfigForTests({ ...baseConfig });
        const { notices, state } = harness(model("before"));
        await commands.agents.handler("inspect role.developer", state.ctx);

        state.models = [];
        state.ctx.model = undefined;
        const command = await commands.agents.handler("inspect role.developer", state.ctx);
        const tool = await inspect(state);

        assert.equal(command.data.actualModel, null);
        assert.equal(command.data.launchable, false);
        assert.match(command.message, /Foreground model \(not set\) is not/);
        assert.doesNotMatch(command.message, /Foreground model local\/before/);
        assert.match(notices.at(-1), /Foreground model \(not set\) is not/);
        assert.equal(tool.details.view.actualModel, null);
        assert.equal(tool.details.view.launchable, false);
        assert.equal(tool.details.view.modelReason, command.data.modelReason);
    });

    it("lets a partial host note omit foreground without clearing it", () => {
        setConfigForTests({ ...baseConfig });
        const registry = { getAvailable: () => [model("before")] };
        noteCatalogHost({
            cwd: root,
            projectTrusted: true,
            userRoot: process.env.PI_CODING_AGENT_DIR,
            registry,
            foregroundModel: "local/before",
            configuredDefaultModel: null,
            tiers: undefined,
        });
        noteCatalogHost({ cwd: root, projectTrusted: true, registry });
        const snapshot = loadLaunchSnapshot({
            cwd: root,
            projectTrusted: true,
            userRoot: process.env.PI_CODING_AGENT_DIR,
        });
        const kept = createLaunchEnricher()({
            inspection: { id: "role.developer", found: true },
            snapshotDigest: snapshot.digest,
        });
        assert.equal(kept.actualModel, "local/before");

        noteCatalogHost({
            cwd: root,
            projectTrusted: true,
            registry: { getAvailable: () => [] },
            foregroundModel: undefined,
            configuredDefaultModel: null,
        });
        const cleared = createLaunchEnricher()({
            inspection: { id: "role.developer", found: true },
            snapshotDigest: snapshot.digest,
        });
        assert.equal(cleared.actualModel, null);
        assert.match(cleared.modelReason, /Foreground model \(not set\) is not/);
    });
});
