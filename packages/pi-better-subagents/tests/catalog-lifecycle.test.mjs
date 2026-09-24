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
const { baseDir, readMeta, writeMeta } = await import("../registry.ts");
const { CATALOG_LABEL_DIRECTORY } = await import("../catalog-identity.ts");

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
        assert.equal(prepared.assign.catalog.identity.label, "Payments Developer");
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

    it("allocates direct-role numeric and alias labels with the real allocator", async () => {
        const registryDir = mkdtempSync(join(root, "labels-"));
        const fx = fixture();
        writeAgent(fx.userRoot, "agent.payments", "role.developer", "Look at payments.");
        const h = fx.host({ registryDir });
        const snapshot = loadLaunchSnapshot(h);
        const plain = await prepareCatalogJob(snapshot, { prompt: "Build plain.", role: "role.developer" }, h);
        const alias = await prepareCatalogJob(snapshot, { prompt: "Build.", role: "role.developer", alias: "checkout" }, h);
        const collision = await prepareCatalogJob(snapshot, { prompt: "Build.", role: "role.developer", alias: "checkout" }, h);
        const explicitName = await prepareCatalogJob(snapshot, { prompt: "Build.", role: "role.developer", name: "job-1" }, h);
        const named = await prepareCatalogJob(snapshot, { prompt: "Ship.", agent: "agent.payments", name: "ignored" }, h);
        assert.equal(plain.status, "ready", plain.message);
        assert.equal(alias.status, "ready", alias.message);
        assert.equal(collision.status, "ready", collision.message);
        assert.equal(explicitName.status, "ready", explicitName.message);
        assert.equal(plain.assign.name, "developer-1");
        assert.equal(plain.assign.catalog.identity.label, "developer-1");
        assert.equal(alias.assign.name, "developer-checkout");
        assert.equal(collision.assign.name, "developer-checkout-2");
        assert.equal(explicitName.assign.name, "developer-job-1");
        assert.equal(named.status, "ready", named.message);
        assert.equal(named.assign.name, "Payments Developer");
        const reservation = JSON.parse(readFileSync(join(registryDir, CATALOG_LABEL_DIRECTORY, encodeURIComponent("developer-1")), "utf8"));
        assert.equal(reservation.kind, "numeric");
        assert.equal(reservation.roleId, "role.developer");
        const aliasReservation = JSON.parse(readFileSync(join(registryDir, CATALOG_LABEL_DIRECTORY, encodeURIComponent("developer-checkout")), "utf8"));
        assert.equal(aliasReservation.kind, "alias");
        assert.equal(existsSync(join(registryDir, CATALOG_LABEL_DIRECTORY, encodeURIComponent("Payments Developer"))), false);
    });
});

describe("registered catalog spawn", { concurrency: false }, () => {
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
if [[ -n "\${PI_SUBAGENT_TEST_HOLD:-}" ]]; then
  sleep 30
fi
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

    function runIdFrom(result) {
        const match = textOf(result).match(/sa_[a-z0-9_]+/);
        assert.ok(match, textOf(result));
        return match[0];
    }

    function metaOf(id) {
        return JSON.parse(readFileSync(join(baseDir(), "runs", id, "meta.json"), "utf8"));
    }

    async function settledMeta(id) {
        for (let attempt = 0; attempt < 40; attempt++) {
            const meta = metaOf(id);
            if (meta.status !== "running") return meta;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return metaOf(id);
    }

    it("spawns direct-role numeric and alias labels through the registered tool", async () => {
        const alias = `checkout-${Date.now().toString(36)}`;
        const first = await tools.subagent_spawn.execute("tc", {
            prompt: "Build the numeric run.",
            role: "role.developer",
            tools: "read,bash",
            sandbox: false,
        }, null, null, ctx());
        const second = await tools.subagent_spawn.execute("tc", {
            prompt: "Build the alias run.",
            role: "role.developer",
            alias,
            tools: "read,bash",
            sandbox: false,
        }, null, null, ctx());
        const third = await tools.subagent_spawn.execute("tc", {
            prompt: "Build the alias collision.",
            role: "role.developer",
            alias,
            tools: "read,bash",
            sandbox: false,
        }, null, null, ctx());
        const ids = [runIdFrom(first), runIdFrom(second), runIdFrom(third)];
        const metas = ids.map(metaOf);
        assert.match(metas[0].name, /^developer-\d+$/);
        assert.equal(metas[1].name, `developer-${alias}`);
        assert.equal(metas[2].name, `developer-${alias}-2`);
        assert.deepEqual(metas.map((meta) => meta.name), [...new Set(metas.map((meta) => meta.name))]);
        for (const meta of metas) {
            assert.equal(meta.catalog.identity.label, meta.name);
            assert.equal(meta.catalog.roleId, "role.developer");
            assert.equal(meta.model, "openai/gpt-6-sol");
            assert.equal(meta.effort, "high");
            assert.equal(meta.catalog.modelSelection.source, "role-default");
            assert.equal(meta.catalog.effortSelection.actual, "high");
            const reservation = JSON.parse(readFileSync(join(baseDir(), CATALOG_LABEL_DIRECTORY, encodeURIComponent(meta.name)), "utf8"));
            assert.equal(reservation.roleId, "role.developer");
            assert.notEqual(meta.name, "job-1");
        }
        assert.equal(JSON.parse(readFileSync(join(baseDir(), CATALOG_LABEL_DIRECTORY, encodeURIComponent(metas[0].name)), "utf8")).kind, "numeric");
        assert.equal(JSON.parse(readFileSync(join(baseDir(), CATALOG_LABEL_DIRECTORY, encodeURIComponent(metas[1].name)), "utf8")).kind, "alias");
        const finished = await settledMeta(ids[0]);
        assert.notEqual(finished.status, "running");
        assert.equal(finished.name, metas[0].name);
        assert.equal(finished.catalog.identity.label, metas[0].name);
        assert.equal(finished.catalog.modelSelection.actual, "openai/gpt-6-sol");
        const stale = readMeta(ids[0]);
        stale.name = "job-1";
        stale.catalog = { identity: { label: "stale" }, modelSelection: { actual: "stale" } };
        stale.status = "failed";
        writeMeta(stale);
        const kept = readMeta(ids[0]);
        assert.equal(kept.name, metas[0].name);
        assert.equal(kept.status, "failed");
        assert.equal(kept.catalog.identity.label, metas[0].name);
        assert.equal(kept.catalog.modelSelection.actual, "openai/gpt-6-sol");
        const dropped = readMeta(ids[0]);
        delete dropped.name;
        delete dropped.catalog;
        writeMeta(dropped);
        const still = readMeta(ids[0]);
        assert.equal(still.name, metas[0].name);
        assert.equal(still.catalog.identity.label, metas[0].name);
        const detail = buildNavigatorDetail(ids[1], {
            readMeta: (id) => readMeta(id),
            effectiveStatus: (meta) => meta.status,
            parseRun: () => ({ finalText: "", lastActivity: "", toolCalls: [], usage: {} }),
            shortModel: (modelId) => modelId,
            fmtElapsed: () => "1s",
            fmtSpend: () => "",
            now: 2_000,
        });
        assert.equal(detail.id, ids[1]);
        assert.equal(detail.name, metas[1].name);
        assert.equal(detail.role, "role.developer");
        assert.equal(detail.model, "openai/gpt-6-sol");
        assert.equal(detail.effort, "high");
        const lines = buildDetailLines(detail, { width: 120, truncate: (line) => line }).join("\n");
        assert.match(lines, new RegExp(ids[1]));
        assert.match(lines, /role\.developer/);
        assert.match(lines, /gpt-6-sol/);
        assert.match(lines, /high/);
    });

    it("keeps one batch snapshot and does not leak sibling role model or job labels", async () => {
        const result = await tools.subagent_spawn_batch.execute("tc", {
            jobs: [
                { prompt: "Implement one.", role: "role.developer" },
                { prompt: "Implement two.", role: "role.developer" },
                { prompt: "Review the change.", role: "role.reviewer", model: "openai/gpt-6-astra", thinking: "medium" },
            ],
            shared: { tools: "read,bash", sandbox: false },
        }, null, null, ctx());
        const text = textOf(result);
        assert.doesNotMatch(text, /job-1|job-2|job-3/);
        const ids = [...text.matchAll(/sa_[a-z0-9_]+/g)].map((match) => match[0]);
        assert.equal(ids.length, 3);
        const metas = ids.map(metaOf);
        assert.equal(metas[0].catalog.snapshotDigest, metas[1].catalog.snapshotDigest);
        assert.equal(metas[1].catalog.snapshotDigest, metas[2].catalog.snapshotDigest);
        assert.match(metas[0].name, /^developer-\d+$/);
        assert.match(metas[1].name, /^developer-\d+$/);
        assert.notEqual(metas[0].name, metas[1].name);
        assert.match(metas[2].name, /^reviewer-/);
        assert.equal(metas[0].model, "openai/gpt-6-sol");
        assert.equal(metas[1].model, "openai/gpt-6-sol");
        assert.equal(metas[2].model, "openai/gpt-6-astra");
        assert.equal(metas[0].effort, "high");
        assert.equal(metas[2].effort, "medium");
        assert.equal(metas[2].catalog.modelSelection.source, "invocation");
        const finished = await settledMeta(ids[2]);
        const resultText = textOf(await tools.subagent_result.execute("tc", { id: ids[2] }));
        assert.match(resultText, /done|still running|failed|completed/);
        const afterResult = metaOf(ids[2]);
        assert.equal(afterResult.name, finished.name);
        assert.equal(afterResult.catalog.snapshotDigest, metas[2].catalog.snapshotDigest);
        assert.equal(afterResult.catalog.modelSelection.actual, "openai/gpt-6-astra");
        const stopText = textOf(await tools.subagent_stop.execute("tc", { id: ids[2] }));
        assert.match(stopText, /not running|already|stopped|killed/i);
        assert.equal(metaOf(ids[2]).catalog.identity.label, metas[2].name);
    });

    it("does not read a quoted model out of the task", async () => {
        const result = await tools.subagent_spawn.execute("tc", {
            prompt: "Compare openai/gpt-6-astra@max with luna. Leave the default.",
            role: "role.developer",
            tools: "read,bash",
            sandbox: false,
        }, null, null, ctx());
        const meta = metaOf(runIdFrom(result));
        assert.equal(meta.model, "openai/gpt-6-sol");
        assert.equal(meta.effort, "high");
        assert.equal(meta.catalog.modelSelection.source, "role-default");
    });

    it("uses config.json tierPolicy on the registered spawn path", async () => {
        setConfigForTests({
            defaultModel: null,
            maxConcurrent: 8,
            tierPolicy: {
                balanced: {
                    members: ["openai/gpt-6-sol", "openai/gpt-6-sol-backup"],
                    candidates: ["openai/gpt-6-sol-backup"],
                },
            },
        });
        try {
            const host = ctx();
            host.modelRegistry = registryOf(model("openai", "gpt-6-luna"), model("openai", "gpt-6-sol-backup"));
            const result = await tools.subagent_spawn.execute("tc", {
                prompt: "Fallback through config.",
                role: "role.developer",
                tools: "read,bash",
                sandbox: false,
            }, null, null, host);
            const meta = metaOf(runIdFrom(result));
            assert.equal(meta.model, "openai/gpt-6-sol-backup");
            assert.equal(meta.effort, "high");
            assert.equal(meta.catalog.modelSelection.source, "tier-candidate");
            assert.equal(meta.catalog.effortSelection.actual, "high");
        } finally {
            setConfigForTests(undefined);
        }
    });

    it("reports launchability through the registered catalog tool", async () => {
        const inspected = await tools.agents_catalog.execute("tc", {
            action: "inspect",
            id: "role.developer",
        }, null, null, ctx());
        assert.equal(inspected.details.view.launchable, true);
        assert.equal(inspected.details.view.actualModel, "openai/gpt-6-sol");
        assert.equal(inspected.details.view.actualEffort, "high");
        assert.equal(inspected.details.view.capabilities.grantedByCatalog, false);
        assert.equal(inspected.details.wrote, false);
    });

    it("stops the sibling when one catalog job is blocked and still launches the other when capacity allows", async () => {
        setConfigForTests({ defaultModel: null, maxConcurrent: 8, tierPolicy: null });
        try {
            const runsDir = join(baseDir(), "runs");
            const before = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);
            const result = await tools.subagent_spawn_batch.execute("tc", {
                onCapacity: "launch-available",
                jobs: [
                    { prompt: "Bad model for this job.", role: "role.developer", model: "openai/gpt-6-missing" },
                    { prompt: "Good reviewer job.", role: "role.reviewer", model: "openai/gpt-6-astra", thinking: "medium" },
                ],
                shared: { tools: "read,bash", sandbox: false },
            }, null, null, ctx());
            const text = textOf(result);
            assert.match(text, /No child was started/);
            assert.match(text, /reviewer-/);
            const created = (existsSync(runsDir) ? readdirSync(runsDir) : []).filter((id) => !before.has(id));
            assert.equal(created.length, 1);
            const meta = metaOf(created[0]);
            assert.equal(meta.model, "openai/gpt-6-astra");
            assert.equal(meta.effort, "medium");
            assert.equal(meta.catalog.roleId, "role.reviewer");
        } finally {
            setConfigForTests(undefined);
        }
    });

    async function waitForNoRunning() {
        const dir = join(baseDir(), "runs");
        for (let attempt = 0; attempt < 40; attempt++) {
            const ids = existsSync(dir) ? readdirSync(dir) : [];
            const running = ids.some((id) => {
                try {
                    const meta = JSON.parse(readFileSync(join(dir, id, "meta.json"), "utf8"));
                    if (meta.status !== "running" || meta.spawnPid !== process.pid) return false;
                    try {
                        process.kill(meta.pid, 0);
                        return true;
                    } catch (error) {
                        return error?.code === "EPERM";
                    }
                } catch {
                    return false;
                }
            });
            if (!running) return;
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
    }

    it("rejects a second catalog launch at the shared capacity gate", async () => {
        await waitForNoRunning();
        process.env.PI_SUBAGENT_TEST_HOLD = "1";
        setConfigForTests({ defaultModel: null, maxConcurrent: 1, tierPolicy: null });
        let heldId;
        try {
            const first = await tools.subagent_spawn.execute("tc", {
                prompt: "Hold the only slot.",
                role: "role.explorer",
                tools: "read,bash",
                sandbox: false,
            }, null, null, ctx());
            heldId = runIdFrom(first);
            const runsDir = join(baseDir(), "runs");
            const before = new Set(readdirSync(runsDir));
            await assert.rejects(
                () => tools.subagent_spawn.execute("tc", {
                    prompt: "This must not start.",
                    role: "role.developer",
                    tools: "read,bash",
                    sandbox: false,
                }, null, null, ctx()),
                /Max concurrent subagents/,
            );
            const created = readdirSync(runsDir).filter((id) => !before.has(id));
            assert.deepEqual(created, []);
            const stopped = textOf(await tools.subagent_stop.execute("tc", { id: heldId }));
            assert.match(stopped, /stopped|killed/i);
            const meta = metaOf(heldId);
            assert.equal(meta.status, "killed");
            assert.match(meta.name, /^explorer-/);
            assert.equal(meta.catalog.identity.label, meta.name);
            assert.equal(meta.catalog.modelSelection.actual, "openai/gpt-6-luna");
            assert.equal(meta.effort, "medium");
        } finally {
            delete process.env.PI_SUBAGENT_TEST_HOLD;
            setConfigForTests(undefined);
            if (heldId) {
                try { await tools.subagent_stop.execute("tc", { id: heldId }); } catch { /* already terminal */ }
            }
        }
    });
});

after(() => rmSync(root, { recursive: true, force: true }));
