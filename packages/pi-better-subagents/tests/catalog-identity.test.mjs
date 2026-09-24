/**
 * Registry-wide catalog labels and immutable launch snapshots.
 *
 * Cross-process cases spawn real node processes against one registry directory.
 * Label files and run metas are on disk; nothing is mocked.
 *
 * // @covers catalog.identity
 * // @level unit
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateCatalogLabel, CATALOG_LABEL_DIRECTORY } from "../catalog-identity.ts";
import { listMetas, nextRunId, readMeta, removeMetaArtifacts, runDir, writeMeta } from "../registry.ts";
import { stopRun } from "../stop.ts";

const ALLOCATOR = fileURLToPath(new URL("../catalog-identity.ts", import.meta.url));
const REGISTRY = fileURLToPath(new URL("../registry.ts", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function tempRegistry() {
    return mkdtempSync(join(tmpdir(), "pi-catalog-identity-"));
}

function reservationPath(root, label) {
    return join(root, CATALOG_LABEL_DIRECTORY, encodeURIComponent(label));
}

function readReservation(root, label) {
    return JSON.parse(readFileSync(reservationPath(root, label), "utf8"));
}

function writeRunMeta(root, meta) {
    const dir = join(root, "runs", meta.id);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "meta.json");
    writeFileSync(file, JSON.stringify(meta, null, 2));
    return file;
}

function spawnNode(script, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
            cwd: REPO_ROOT,
            env: { ...process.env, ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`child exited ${code}\n${stderr}\n${stdout}`));
                return;
            }
            resolve(stdout);
        });
    });
}

const ALLOCATE_SCRIPT = `
import { allocateCatalogLabel } from ${JSON.stringify(ALLOCATOR)};
const alias = process.env.CATALOG_ALIAS;
const input = {
  roleId: process.env.CATALOG_ROLE_ID || "role.developer",
  roleName: process.env.CATALOG_ROLE_NAME || "Developer",
};
if (process.env.CATALOG_REGISTRY) input.registryDir = process.env.CATALOG_REGISTRY;
if (alias) input.alias = alias;
process.stdout.write(allocateCatalogLabel(input));
`;

function allocateChild(env) {
    return spawnNode(ALLOCATE_SCRIPT, env);
}

describe("allocateCatalogLabel", () => {
    it("issues stable role display slugs and alias labels", () => {
        const root = tempRegistry();
        try {
            assert.equal(allocateCatalogLabel({
                registryDir: root,
                roleId: "role.developer",
                roleName: "Developer",
            }), "developer-1");
            assert.equal(allocateCatalogLabel({
                registryDir: root,
                roleId: "role.other",
                roleName: "Developer",
            }), "developer-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root,
                roleId: "role.product-manager",
                roleName: "Product Manager",
            }), "product-manager-1");
            assert.equal(allocateCatalogLabel({
                registryDir: root,
                roleId: "role.developer",
                roleName: "",
            }), "developer-3");
            assert.equal(allocateCatalogLabel({
                registryDir: root,
                roleId: "role.developer",
                roleName: "Developer",
                alias: "checkout",
            }), "developer-checkout");
            assert.equal(allocateCatalogLabel({
                registryDir: root,
                roleId: "role.developer",
                roleName: "Developer",
                alias: "Developer-checkout",
            }), "developer-checkout-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root,
                roleId: "role.explorer",
                roleName: "Explorer",
            }), "explorer-1");
            const first = readReservation(root, "developer-1");
            assert.equal(first.kind, "numeric");
            assert.equal(first.roleId, "role.developer");
            assert.equal(readReservation(root, "developer-checkout").kind, "alias");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps numeric and alias labels in one namespace without rewriting reservations", () => {
        const root = tempRegistry();
        try {
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer",
            }), "developer-1");
            const numeric = readFileSync(reservationPath(root, "developer-1"), "utf8");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer", alias: "1",
            }), "developer-1-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer",
            }), "developer-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer", alias: "checkout",
            }), "developer-checkout");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer", alias: "checkout",
            }), "developer-checkout-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer", alias: "checkout-2",
            }), "developer-checkout-2-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer",
            }), "developer-3");
            assert.equal(readFileSync(reservationPath(root, "developer-1"), "utf8"), numeric);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("adopts persisted run labels and does not rewrite them", () => {
        const root = tempRegistry();
        try {
            const named = writeRunMeta(root, {
                id: "named-agent-run",
                name: "payments-developer",
                status: "completed",
                pid: 1,
                spawnPid: 1,
                cwd: root,
                promptPreview: "named",
                startedAt: 1,
                logPath: join(root, "named.log"),
                sessionId: "named-agent-run",
            });
            const numeric = writeRunMeta(root, {
                id: "role-run",
                name: "developer-1",
                status: "completed",
                pid: 1,
                spawnPid: 1,
                cwd: root,
                promptPreview: "role",
                startedAt: 2,
                logPath: join(root, "role.log"),
                sessionId: "role-run",
                catalog: { identity: { label: "developer-checkout" } },
            });
            const namedBefore = readFileSync(named, "utf8");
            const numericBefore = readFileSync(numeric, "utf8");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer",
            }), "developer-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.developer", roleName: "Developer", alias: "checkout",
            }), "developer-checkout-2");
            assert.equal(allocateCatalogLabel({
                registryDir: root, roleId: "role.payments", roleName: "Payments", alias: "developer",
            }), "payments-developer-2");
            assert.equal(readFileSync(named, "utf8"), namedBefore);
            assert.equal(readFileSync(numeric, "utf8"), numericBefore);
            assert.equal(readReservation(root, "payments-developer").kind, "adopted");
            assert.equal(readReservation(root, "developer-1").adopted, true);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("allocates distinct labels across concurrent processes and keeps them after reload", { timeout: 60_000 }, async () => {
        const root = tempRegistry();
        try {
            const jobs = [
                ...Array.from({ length: 4 }, () => ({ CATALOG_REGISTRY: root, CATALOG_ROLE_ID: "role.developer", CATALOG_ROLE_NAME: "Developer" })),
                ...Array.from({ length: 3 }, () => ({ CATALOG_REGISTRY: root, CATALOG_ROLE_ID: "role.developer", CATALOG_ROLE_NAME: "Developer", CATALOG_ALIAS: "checkout" })),
                { CATALOG_REGISTRY: root, CATALOG_ROLE_ID: "role.developer", CATALOG_ROLE_NAME: "Developer", CATALOG_ALIAS: "1" },
            ];
            const labels = await Promise.all(jobs.map((env) => allocateChild(env)));
            assert.equal(new Set(labels).size, labels.length);
            const checkout = labels.filter((label) => label === "developer-checkout" || label.startsWith("developer-checkout-"));
            assert.equal(checkout.length, 3);
            assert.ok(checkout.includes("developer-checkout"));
            assert.ok(labels.includes("developer-1") || labels.includes("developer-1-2"));
            const firstPath = reservationPath(root, labels[0]);
            const firstBytes = readFileSync(firstPath, "utf8");
            const reloaded = await allocateChild({
                CATALOG_REGISTRY: root,
                CATALOG_ROLE_ID: "role.developer",
                CATALOG_ROLE_NAME: "Developer",
            });
            assert.equal(labels.includes(reloaded), false);
            assert.equal(readFileSync(firstPath, "utf8"), firstBytes);
            assert.match(reloaded, /^developer-\d+$/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("keeps label reservations after the run directory is removed", { timeout: 30_000 }, async () => {
        const isolatedTmp = tempRegistry();
        try {
            const script = `
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { allocateCatalogLabel, CATALOG_LABEL_DIRECTORY } from ${JSON.stringify(ALLOCATOR)};
import { baseDir, nextRunId, readMeta, removeMetaArtifacts, writeMeta } from ${JSON.stringify(REGISTRY)};
const label = allocateCatalogLabel({ roleId: "role.developer", roleName: "Developer", alias: "checkout" });
const id = nextRunId();
const root = baseDir();
writeMeta({
  id, name: label, status: "completed", pid: 1, spawnPid: 1, cwd: root,
  promptPreview: "retention", startedAt: 1, endedAt: 2, logPath: join(root, id + ".log"), sessionId: id,
  catalog: { identity: { label }, effective: { model: "openai/gpt-6-sol" }, provenance: { model: "role-default" } },
});
const reservation = join(root, CATALOG_LABEL_DIRECTORY, encodeURIComponent(label));
const before = readFileSync(reservation, "utf8");
removeMetaArtifacts(readMeta(id));
process.stdout.write(JSON.stringify({
  label,
  reservationRemains: existsSync(reservation),
  sameBytes: readFileSync(reservation, "utf8") === before,
  runGone: !existsSync(join(root, "runs", id)),
}));
`;
            const reported = JSON.parse(await spawnNode(script, { TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp }));
            assert.equal(reported.label, "developer-checkout");
            assert.equal(reported.reservationRemains, true);
            assert.equal(reported.sameBytes, true);
            assert.equal(reported.runGone, true);
            const again = await spawnNode(ALLOCATE_SCRIPT, {
                TMPDIR: isolatedTmp,
                TMP: isolatedTmp,
                TEMP: isolatedTmp,
                CATALOG_ROLE_ID: "role.developer",
                CATALOG_ROLE_NAME: "Developer",
                CATALOG_ALIAS: "checkout",
            });
            assert.equal(again, "developer-checkout-2");
        } finally {
            rmSync(isolatedTmp, { recursive: true, force: true });
        }
    });

    it("uses the registry baseDir when registryDir is omitted", { timeout: 30_000 }, async () => {
        const isolatedTmp = tempRegistry();
        try {
            const script = `
import { allocateCatalogLabel } from ${JSON.stringify(ALLOCATOR)};
import { baseDir } from ${JSON.stringify(REGISTRY)};
import { existsSync } from "node:fs";
import { join } from "node:path";
const label = allocateCatalogLabel({ roleId: "role.developer", roleName: "Developer" });
const root = baseDir();
process.stdout.write(JSON.stringify({
  label,
  root,
  reservation: existsSync(join(root, ${JSON.stringify(CATALOG_LABEL_DIRECTORY)}, encodeURIComponent(label))),
}));
`;
            const stdout = await spawnNode(script, { TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp });
            const reported = JSON.parse(stdout);
            assert.equal(reported.label, "developer-1");
            assert.equal(reported.root, join(isolatedTmp, "pi-better-subagents"));
            assert.equal(reported.reservation, true);
            assert.equal(reported.root.includes("sessions"), false);
        } finally {
            rmSync(isolatedTmp, { recursive: true, force: true });
        }
    });
});

describe("catalog launch snapshot", () => {
    it("persists flexible catalog JSON, survives disk reload, and does not rewrite it", { timeout: 30_000 }, async () => {
        const id = nextRunId();
        const snapshot = {
            identity: { roleId: "role.developer", roleName: "Developer", label: "developer-1", alias: null },
            effective: { model: "openai/gpt-6-sol", effort: "high", instructions: "implement the change" },
            provenance: { model: "role-default", effort: "role-default", definitionRevision: "rev-1" },
            extra: { sourcePath: "roles/developer.md", note: ["kept", 1] },
        };
        const meta = {
            id,
            name: "developer-1",
            status: "running",
            pid: 1,
            spawnPid: process.pid,
            cwd: tmpdir(),
            promptPreview: "snapshot",
            startedAt: 10,
            logPath: `/tmp/${id}.log`,
            sessionId: id,
            catalog: snapshot,
        };
        try {
            writeMeta(meta);
            const listed = listMetas().find((item) => item.id === id);
            assert.deepEqual(listed.catalog, snapshot);
            assert.equal(listed.name, "developer-1");
            const script = `
import { readMeta, writeMeta } from ${JSON.stringify(REGISTRY)};
const meta = readMeta(${JSON.stringify(id)});
if (!meta) throw new Error("missing meta on disk");
meta.status = "completed";
meta.endedAt = 99;
meta.catalog = { identity: { label: "rewritten-by-reload" }, effective: { model: "nope" }, provenance: { model: "reload" } };
writeMeta(meta);
const after = readMeta(${JSON.stringify(id)});
process.stdout.write(JSON.stringify({ status: after.status, endedAt: after.endedAt, catalog: after.catalog }));
`;
            const reloaded = JSON.parse(await spawnNode(script, {}));
            assert.equal(reloaded.status, "completed");
            assert.equal(reloaded.endedAt, 99);
            assert.deepEqual(reloaded.catalog, snapshot);

            const again = readMeta(id);
            again.catalog.effective.model = "mutated-in-memory";
            again.status = "failed";
            writeMeta(again);
            const preserved = readMeta(id);
            assert.equal(preserved.status, "failed");
            assert.deepEqual(preserved.catalog, snapshot);

            const completed = {
                ...preserved,
                status: "completed",
                endedAt: 100,
            };
            writeMeta(completed);
            const rawBeforeStop = readFileSync(join(runDir(id), "meta.json"), "utf8");
            const stopped = stopRun(id);
            assert.equal(stopped.action, "not-running");
            assert.equal(readFileSync(join(runDir(id), "meta.json"), "utf8"), rawBeforeStop);
        } finally {
            const current = readMeta(id);
            if (current) removeMetaArtifacts(current);
            else rmSync(runDir(id), { recursive: true, force: true });
        }
    });

    it("leaves legacy metadata without a catalog key", () => {
        const id = nextRunId();
        const meta = {
            id,
            status: "running",
            pid: 1,
            spawnPid: 1,
            cwd: tmpdir(),
            promptPreview: "legacy",
            startedAt: 11,
            logPath: `/tmp/${id}.log`,
            sessionId: id,
        };
        try {
            writeMeta(meta);
            const back = readMeta(id);
            assert.equal(back.catalog, undefined);
            assert.equal(back.status, "running");
            back.status = "killed";
            writeMeta(back);
            const raw = readFileSync(join(runDir(id), "meta.json"), "utf8");
            assert.equal(Object.hasOwn(JSON.parse(raw), "catalog"), false);
            assert.equal(JSON.parse(raw).status, "killed");
        } finally {
            const current = readMeta(id);
            if (current) removeMetaArtifacts(current);
        }
    });
});
