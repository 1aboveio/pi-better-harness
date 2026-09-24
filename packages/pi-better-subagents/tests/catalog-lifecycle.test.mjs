/**
 * Catalog launch wiring: selectors, one batch snapshot, model resolution before
 * spawn, provenance, ambiguity, and legacy behavior.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "catalog-lifecycle-"));
const runtimeTmp = join(root, "tmp");
mkdirSync(runtimeTmp, { recursive: true });
process.env.TMPDIR = runtimeTmp;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const { loadCatalog } = await import("../catalog-store.ts");
const {
    clarifyCatalogRequest,
    createLaunchEnricher,
    loadLaunchSnapshot,
    noteCatalogHost,
    prepareCatalogJob,
    roleSlug,
    tiersForLaunch,
} = await import("../catalog-runtime.ts");
const { configureTierPolicy } = await import("../tier-policy.ts");
const { setConfigForTests } = await import("../config.ts");
const { buildDetailLines, buildNavigatorDetail } = await import("../navigator.mjs");
const { mergeJobOptions } = await import("../batch.mjs");

function model(provider, id, extra = {}) {
    return { provider, id, reasoning: true, ...extra };
}

function registryOf(...models) {
    return { getAvailable: () => models, find: () => undefined };
}

function fixture() {
    const userRoot = mkdtempSync(join(root, "user-"));
    const cwd = mkdtempSync(join(root, "proj-"));
    return {
        userRoot,
        cwd,
        host(extra = {}) {
            return {
                cwd,
                projectTrusted: true,
                userRoot,
                projectConfigDirName: ".pi",
                hasUI: false,
                foregroundModel: "openai/gpt-6-luna",
                configuredDefaultModel: null,
                registry: registryOf(
                    model("openai", "gpt-6-sol"),
                    model("openai", "gpt-6-luna"),
                    model("openai", "gpt-6-astra"),
                    model("openai", "gpt-6-sol-backup"),
                ),
                ...extra,
            };
        },
    };
}

function writeAgent(userRoot, id, roleId, body, overrides = {}) {
    const dir = join(userRoot, "agents", "agents");
    mkdirSync(dir, { recursive: true });
    const overrideText = Object.keys(overrides).length === 0
        ? ""
        : `overrides:\n${Object.entries(overrides).map(([key, value]) => `  ${key}: ${value}`).join("\n")}\n`;
    writeFileSync(join(dir, `${id}.md`), `---
schema: pi-agent/v1
kind: agent
id: ${id}
name: Payments Developer
roleId: ${roleId}
${overrideText}---
${body}
`);
}

describe("catalog runtime", () => {
    after(() => setConfigForTests(undefined));

    it("resolves a named agent before launch and keeps the defined name", async () => {
        const fx = fixture();
        writeAgent(fx.userRoot, "agent.payments", "role.developer", "Look at payments.");
        const h = fx.host();
        const snapshot = loadLaunchSnapshot(h);
        const prepared = await prepareCatalogJob(snapshot, {
            prompt: "Ship the fix.",
            agent: "agent.payments",
            name: "ignored-label",
            model: "openai/gpt-6-astra",
            thinking: "high",
        }, h);
        assert.equal(prepared.status, "ready", prepared.message);
        assert.equal(prepared.assign.name, "Payments Developer");
        assert.equal(prepared.assign.model, "openai/gpt-6-astra");
        assert.equal(prepared.assign.thinking, "high");
        assert.equal(prepared.assign.catalogResolved, true);
        assert.match(prepared.assign.prompt, /Look at payments\./);
        assert.match(prepared.assign.prompt, /Ship the fix\./);
        assert.equal(prepared.assign.catalog.modelSelection.actual, "openai/gpt-6-astra");
        assert.equal(prepared.assign.catalog.modelSelection.source, "invocation");
        assert.equal(prepared.assign.catalog.effortSelection.actual, "high");
        assert.equal(prepared.assign.catalog.capabilities.grantedByCatalog, false);
        assert.equal(prepared.assign.catalog.snapshotDigest, snapshot.digest);
        assert.equal(JSON.parse(JSON.stringify(prepared.assign.catalog)).id, "agent.payments");
    });

    it("does not launch an unavailable explicit model", async () => {
        const h = fixture().host();
        const snapshot = loadLaunchSnapshot(h);
        const prepared = await prepareCatalogJob(snapshot, {
            prompt: "Review.",
            role: "role.reviewer",
            model: "openai/gpt-6-missing",
        }, h);
        assert.equal(prepared.status, "blocked");
        assert.match(prepared.message, /No child was started/);
    });

    it("uses one snapshot for every job and sees a later edit only on the next load", async () => {
        const fx = fixture();
        writeAgent(fx.userRoot, "agent.payments", "role.developer", "Look at payments.");
        writeAgent(fx.userRoot, "agent.review", "role.reviewer", "Review the change.");
        const reviewPath = join(fx.userRoot, "agents", "agents", "agent.review.md");
        writeFileSync(reviewPath, readFileSync(reviewPath, "utf8").replace("name: Payments Developer", "name: Review Agent"));
        const h = fx.host();
        const first = loadLaunchSnapshot(h);
        const developer = await prepareCatalogJob(first, { prompt: "Implement.", agent: "agent.payments", model: "openai/gpt-6-sol", thinking: "high" }, h);
        const reviewer = await prepareCatalogJob(first, { prompt: "Review.", agent: "agent.review", model: "openai/gpt-6-astra", thinking: "medium" }, h);
        assert.equal(developer.status, "ready", developer.message);
        assert.equal(reviewer.status, "ready", reviewer.message);
        assert.equal(developer.assign.catalog.snapshotDigest, reviewer.assign.catalog.snapshotDigest);
        assert.equal(developer.assign.name, "Payments Developer");
        assert.equal(reviewer.assign.name, "Review Agent");
        assert.equal(developer.assign.model, "openai/gpt-6-sol");
        assert.equal(reviewer.assign.model, "openai/gpt-6-astra");
        const roleFile = join(fx.userRoot, "agents", "roles", "role.developer.md");
        mkdirSync(join(roleFile, ".."), { recursive: true });
        writeFileSync(roleFile, `---
schema: pi-agent/v1
kind: role
id: role.developer
name: Developer
description: Edited after admission.
defaults:
  model: openai/gpt-6-sol
  effort: low
  tier: balanced
---
Edited instructions.
`);
        const second = loadLaunchSnapshot(h);
        assert.notEqual(second.digest, first.digest);
        const held = await prepareCatalogJob(first, { prompt: "Still the old snapshot.", agent: "agent.payments" }, h);
        assert.equal(held.assign.catalog.snapshotDigest, first.digest);
        assert.match(held.assign.prompt, /Implement the requested change/);
        assert.equal(held.assign.thinking, "high");
        const refreshed = await prepareCatalogJob(second, { prompt: "Next launch.", agent: "agent.payments" }, h);
        assert.match(refreshed.assign.prompt, /Edited instructions/);
        assert.equal(refreshed.assign.thinking, "low");
    });

    it("asks to choose or split and launches nothing when UI is absent", async () => {
        const mixed = await clarifyCatalogRequest([
            { prompt: "Both.", agent: "agent.payments", role: "role.reviewer" },
        ], { hasUI: false });
        assert.equal(mixed.status, "clarification-needed");
        assert.equal(mixed.launched, false);
        assert.equal(mixed.wrote, false);
        assert.match(mixed.message, /UI is unavailable/);
        const roles = await clarifyCatalogRequest([
            { prompt: "Two roles.", role: ["role.developer", "role.reviewer"] },
        ], { hasUI: false });
        assert.equal(roles.status, "clarification-needed");
        assert.equal(roles.launched, false);
        const distinct = await clarifyCatalogRequest([
            { prompt: "Implement.", role: "role.developer" },
            { prompt: "Review.", role: "role.reviewer" },
        ], { hasUI: false });
        assert.equal(distinct.status, "resolved");
        assert.deepEqual(distinct.jobs.map((job) => job.role), ["role.developer", "role.reviewer"]);
    });

    it("splits one ambiguous run into single-role jobs and keeps the other job", async () => {
        const result = await clarifyCatalogRequest([
            { prompt: "Both.", role: ["role.developer", "role.reviewer"] },
            { prompt: "Leave me.", role: "role.explorer" },
        ], { hasUI: true, select: async () => "Split into 2 runs" });
        assert.equal(result.status, "resolved");
        assert.deepEqual(result.jobs.map((job) => [job.prompt, job.role]), [
            ["Both.", "role.developer"],
            ["Both.", "role.reviewer"],
            ["Leave me.", "role.explorer"],
        ]);
    });

    it("lets a per-job role replace a shared agent instead of becoming ambiguous", async () => {
        const merged = mergeJobOptions(
            { agent: "agent.payments", model: "openai/gpt-6-luna", alias: "shared-alias" },
            { prompt: "Review.", role: "role.reviewer", model: "openai/gpt-6-astra" },
        );
        assert.equal(merged.role, "role.reviewer");
        assert.equal(merged.agent, undefined);
        assert.equal(merged.model, "openai/gpt-6-astra");
        assert.equal(merged.alias, "shared-alias");
        const sharedOnly = mergeJobOptions({ role: "role.developer", alias: "checkout" }, { prompt: "Build." });
        assert.equal(sharedOnly.role, "role.developer");
        assert.equal(sharedOnly.alias, "checkout");
    });

    it("reads configured tier candidates through tiersForLaunch", async () => {
        const policy = tiersForLaunch({
            tierPolicy: {
                balanced: {
                    members: ["openai/gpt-6-sol", "openai/gpt-6-sol-backup"],
                    candidates: ["openai/gpt-6-sol-backup"],
                },
            },
        });
        assert.deepEqual(policy, configureTierPolicy({
            balanced: {
                members: ["openai/gpt-6-sol", "openai/gpt-6-sol-backup"],
                candidates: ["openai/gpt-6-sol-backup"],
            },
        }));
        const fx = fixture();
        writeAgent(fx.userRoot, "agent.payments", "role.developer", "Look at payments.");
        const h = fx.host({
            tiers: policy,
            registry: registryOf(model("openai", "gpt-6-luna"), model("openai", "gpt-6-sol-backup")),
        });
        const snapshot = loadCatalog({ cwd: h.cwd, projectTrusted: true, userRoot: h.userRoot });
        const prepared = await prepareCatalogJob(snapshot, { prompt: "Fallback.", agent: "agent.payments" }, h);
        assert.equal(prepared.status, "ready", prepared.message);
        assert.equal(prepared.assign.model, "openai/gpt-6-sol-backup");
        assert.equal(prepared.assign.catalog.modelSelection.source, "tier-candidate");
        assert.equal(prepared.assign.catalog.effortSelection.actual, "high");
    });

    it("keeps a catalog-free job on the legacy path", async () => {
        const h = fixture().host();
        const prepared = await prepareCatalogJob(loadLaunchSnapshot(h), { prompt: "Plain.", name: "reviewer" }, h);
        assert.equal(prepared.status, "legacy");
    });

    it("maps assessCatalog into an enricher and does not invent launchability", () => {
        const h = fixture().host();
        noteCatalogHost(h);
        setConfigForTests({ defaultModel: null, tierPolicy: null });
        const snapshot = loadLaunchSnapshot(h);
        const enrich = createLaunchEnricher();
        const developer = enrich({
            inspection: { id: "role.developer", found: true },
            snapshotDigest: snapshot.digest,
        });
        assert.equal(developer.launchable, true);
        assert.equal(developer.actualModel, "openai/gpt-6-sol");
        assert.equal(developer.capabilities.grantedByCatalog, false);
        assert.ok(developer.capabilities.enforcedExistingControls.includes("tool selection"));
        assert.equal(enrich({
            inspection: { id: "role.developer", found: true },
            snapshotDigest: "not-the-loaded-snapshot",
        }), undefined);
        noteCatalogHost({ cwd: h.cwd, projectTrusted: true, registry: {} });
        assert.equal(createLaunchEnricher()({
            inspection: { id: "role.developer", found: true },
            snapshotDigest: snapshot.digest,
        }), undefined);
    });

    it("shows the run id, role, model, and effort in navigator details", () => {
        const detail = buildNavigatorDetail("sa_catalog", {
            readMeta: () => ({
                id: "sa_catalog",
                name: "Payments Developer",
                model: "openai/gpt-6-astra",
                effort: "high",
                status: "running",
                startedAt: 1_000,
                catalog: { roleId: "role.developer", roleName: "developer" },
            }),
            effectiveStatus: (meta) => meta.status,
            parseRun: () => ({ finalText: "", lastActivity: "", toolCalls: [], usage: {} }),
            shortModel: (modelId) => modelId,
            fmtElapsed: () => "1s",
            fmtSpend: () => "",
            now: 2_000,
        });
        assert.equal(detail.name, "Payments Developer");
        assert.equal(detail.role, "role.developer");
        assert.equal(detail.model, "openai/gpt-6-astra");
        assert.equal(detail.effort, "high");
        const text = buildDetailLines(detail, { width: 100, truncate: (line) => line }).join("\n");
        assert.match(text, /sa_catalog/);
        assert.match(text, /role\.developer/);
        assert.match(text, /gpt-6-astra/);
        assert.match(text, /high/);
        assert.equal(roleSlug("role.developer"), "developer");
    });

    it("reports direct-role allocation pending until catalog-identity.ts is present", async () => {
        let identity;
        try {
            identity = await import("../catalog-identity.ts");
        } catch {
            identity = undefined;
        }
        if (!identity?.allocateCatalogLabel) {
            const h = fixture().host();
            await assert.rejects(
                () => prepareCatalogJob(loadLaunchSnapshot(h), { prompt: "Build.", role: "role.developer", alias: "checkout" }, h),
                /allocateCatalogLabel/,
            );
            return;
        }
        const h = fixture().host();
        const prepared = await prepareCatalogJob(loadLaunchSnapshot(h), { prompt: "Build.", role: "role.developer", alias: "checkout" }, h);
        assert.equal(prepared.status, "ready", prepared.message);
        assert.match(prepared.assign.name, /developer/);
    });
});

describe("registered catalog spawn", () => {
    let tools;
    const fx = fixture();

    before(async () => {
        const binDir = join(root, "bin");
        mkdirSync(binDir, { recursive: true });
        const piPath = join(binDir, "pi");
        writeFileSync(piPath, `#!/bin/bash
args=("$@")
id=""
sess=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-id) id="$2"; shift 2 ;;
    --session-dir) sess="$2"; shift 2 ;;
    *) shift ;;
  esac
done
base=$(dirname "$sess")
mkdir -p "$base/runs/$id"
printf '%s\\n' "\${args[@]}" > "$base/runs/$id/argv.txt"
printf '%s\\n' '{"type":"agent_end","messages":[{"role":"assistant","content":[{"type":"text","text":"done"}]}]}' > "$base/runs/$id/output.log"
`);
        chmodSync(piPath, 0o755);
        process.env.PATH = `${binDir}:${process.env.PATH}`;
        process.env.PI_CODING_AGENT_DIR = fx.userRoot;
        writeAgent(fx.userRoot, "agent.payments", "role.developer", "Look at payments.");
        const extension = await import(`../index.ts?catalog-lifecycle=${Date.now()}`);
        tools = {};
        extension.default({
            registerTool(def) { tools[def.name] = def; },
            registerCommand() {},
            on() {},
            sendMessage() {},
        });
    });

    function ctx() {
        return {
            cwd: fx.cwd,
            hasUI: false,
            mode: "tui",
            model: { provider: "openai", id: "gpt-6-luna" },
            modelRegistry: registryOf(
                model("openai", "gpt-6-sol"),
                model("openai", "gpt-6-luna"),
                model("openai", "gpt-6-astra"),
            ),
            isProjectTrusted: () => true,
            ui: { setWidget() {}, notify() {}, select: async () => undefined },
        };
    }

    function textOf(result) {
        return result.content.map((part) => part.text).join("\n");
    }

    it("spawns a named agent with resolved model, effort, and catalog provenance", async () => {
        const result = await tools.subagent_spawn.execute("tc", {
            prompt: "Ship it.",
            agent: "agent.payments",
            name: "not-the-display-name",
            model: "openai/gpt-6-astra@high",
            tools: "read,bash",
            sandbox: false,
        }, null, null, ctx());
        const text = textOf(result);
        assert.match(text, /Payments Developer/);
        const id = text.match(/id=(sa_\S+)/)[1];
        const run = join(runtimeTmp, "pi-better-subagents", "runs", id);
        const meta = JSON.parse(readFileSync(join(run, "meta.json"), "utf8"));
        assert.equal(meta.name, "Payments Developer");
        assert.equal(meta.model, "openai/gpt-6-astra");
        assert.equal(meta.effort, "high");
        assert.equal(meta.catalog.id, "agent.payments");
        assert.equal(meta.catalog.roleId, "role.developer");
        assert.equal(meta.catalog.modelSelection.source, "invocation");
        assert.equal(meta.catalog.capabilities.grantedByCatalog, false);
        let argv = "";
        for (let attempt = 0; attempt < 40; attempt++) {
            try {
                argv = readFileSync(join(run, "argv.txt"), "utf8");
                break;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
        }
        assert.match(argv, /--model\nopenai\/gpt-6-astra/);
        assert.match(argv, /--thinking\nhigh/);
        assert.match(readFileSync(join(run, "prompt.md"), "utf8"), /Look at payments\./);
    });

    it("keeps a catalog-free launch free of catalog metadata", async () => {
        const result = await tools.subagent_spawn.execute("tc", {
            prompt: "Legacy.",
            name: "legacy-name",
            model: "openai/gpt-6-luna",
            thinking: "low",
            tools: "read,bash",
            sandbox: false,
        }, null, null, ctx());
        const id = textOf(result).match(/id=(sa_\S+)/)[1];
        const meta = JSON.parse(readFileSync(join(runtimeTmp, "pi-better-subagents", "runs", id, "meta.json"), "utf8"));
        assert.equal(meta.name, "legacy-name");
        assert.equal(meta.model, "openai/gpt-6-luna");
        assert.equal(meta.effort, "low");
        assert.equal(Object.hasOwn(meta, "catalog"), false);
    });

    it("returns clarification for one run with two roles and does not spawn", async () => {
        const runsDir = join(runtimeTmp, "pi-better-subagents", "runs");
        const before = existsSync(runsDir) ? readdirSync(runsDir) : [];
        const result = await tools.subagent_spawn.execute("tc", {
            prompt: "Ambiguous.",
            agent: "agent.payments",
            role: "role.reviewer",
            tools: "read,bash",
            sandbox: false,
        }, null, null, ctx());
        assert.equal(result.details.status, "clarification-needed");
        assert.equal(result.details.launched, false);
        assert.match(result.details && textOf(result), /UI is unavailable|choose|split/i);
        const after = existsSync(runsDir) ? readdirSync(runsDir) : [];
        assert.deepEqual(after, before);
    });

    it("resolves batch jobs independently against one snapshot", async () => {
        writeAgent(fx.userRoot, "agent.review", "role.reviewer", "Review the change.");
        const reviewPath = join(fx.userRoot, "agents", "agents", "agent.review.md");
        writeFileSync(reviewPath, readFileSync(reviewPath, "utf8").replace("name: Payments Developer", "name: Review Agent"));
        const result = await tools.subagent_spawn_batch.execute("tc", {
            jobs: [
                { prompt: "Implement.", agent: "agent.payments", model: "openai/gpt-6-sol", thinking: "high" },
                { prompt: "Review.", agent: "agent.review", model: "openai/gpt-6-astra", thinking: "medium" },
            ],
            shared: { tools: "read,bash", sandbox: false },
        }, null, null, ctx());
        const text = textOf(result);
        const ids = [...text.matchAll(/sa_[a-z0-9_]+/g)].map((match) => match[0]);
        assert.equal(ids.length, 2);
        const metas = ids.map((id) => JSON.parse(readFileSync(join(runtimeTmp, "pi-better-subagents", "runs", id, "meta.json"), "utf8")));
        assert.equal(metas[0].catalog.snapshotDigest, metas[1].catalog.snapshotDigest);
        assert.equal(metas[0].model, "openai/gpt-6-sol");
        assert.equal(metas[1].model, "openai/gpt-6-astra");
        assert.equal(metas[0].effort, "high");
        assert.equal(metas[1].effort, "medium");
        assert.notEqual(metas[0].catalog.id, metas[1].catalog.id);
    });

    it("treats a blocked catalog job as a batch failure and does not start that child", async () => {
        writeAgent(fx.userRoot, "agent.review", "role.reviewer", "Review the change.");
        const reviewPath = join(fx.userRoot, "agents", "agents", "agent.review.md");
        writeFileSync(reviewPath, readFileSync(reviewPath, "utf8").replace("name: Payments Developer", "name: Review Agent"));
        const runsDir = join(runtimeTmp, "pi-better-subagents", "runs");
        const before = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
        setConfigForTests({ defaultModel: null, maxConcurrent: 64, tierPolicy: null });
        const result = await tools.subagent_spawn_batch.execute("tc", {
            jobs: [
                { prompt: "Bad model.", agent: "agent.payments", model: "openai/gpt-6-missing" },
                { prompt: "Should not start in reject mode.", agent: "agent.review", model: "openai/gpt-6-astra", thinking: "medium" },
            ],
            shared: { tools: "read,bash", sandbox: false },
        }, null, null, ctx());
        const text = textOf(result);
        assert.match(text, /Failed/);
        assert.match(text, /No child was started/);
        assert.match(text, /not launched due to earlier job failure in reject mode/);
        const after = (existsSync(runsDir) ? readdirSync(runsDir) : []).filter((id) => !before.has(id));
        assert.deepEqual(after, []);
        assert.equal(typeof tools.agents_catalog.execute, "function");
    });
});

after(() => rmSync(root, { recursive: true, force: true }));
