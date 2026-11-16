import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

function installed(t) {
    const root = mkdtempSync(join(tmpdir(), "native-bootstrap-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const pkg = join(root, "node_modules/pi-better-subagents");
    const source = fileURLToPath(new URL("../", import.meta.url));
    cpSync(source, pkg, { recursive: true, filter: path => {
        const relative = path.slice(source.length);
        return !relative || relative.startsWith("shared-operation-coordinator")
            || (!relative.includes("/") && /\.(mjs|ts|json)$/.test(relative));
    } });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.PI_MANAGED_SUBAGENT;
    const run = (entry, proof) => spawnSync(process.execPath, [join(pkg, entry)], {
        env: proof ? { ...env, PI_MANAGED_SUBAGENT: JSON.stringify(proof) } : env,
        encoding: "utf8", timeout: 5000,
    });
    return { root, pkg, run };
}

test("installed native bootstrap loads without a TypeScript loader, including unmanaged launches", t => {
    const { run } = installed(t);
    const result = run("managed-launch-bootstrap.mjs");
    assert.equal(result.status, 0, result.stderr);
    const task = run("task-runtime.mjs");
    assert.equal(task.status, 1);
    assert.match(task.stderr, /Missing trusted runtime paths/);
    const worker = run("managed-worker.mjs");
    assert.equal(worker.status, 1);
    assert.match(worker.stderr, Number(process.versions.node.split(".")[0]) < 24
        ? /Managed subagents require Node 24 or newer/
        : /Managed worker has no admitted launch intent/);
});

test("installed native bootstrap verifies admission and records exactly one writer", async t => {
    const { root, pkg, run } = installed(t);
    const preflightPath = join(root, "preflight.json"), policyPath = join(root, "policy.json"), leasePath = join(root, "lease.json");
    writeFileSync(preflightPath, '{"tools":["read"],"model":"fixture"}');
    writeFileSync(policyPath, '{"tools":["read"]}');
    writeFileSync(leasePath, JSON.stringify({ token: "lease", sessionId: "session", attemptId: "attempt" }));
    // Compute independently, including key order, to keep persisted digests compatible.
    const preflightDigest = createHash("sha256").update('{"model":"fixture","tools":["read"]}').digest("hex");
    const policyDigest = createHash("sha256").update('{"tools":["read"]}').digest("hex");
    const attempt = { id: "attempt", token: "token", state: "prepared", lease: "lease", sessionId: "session", leasePath, preflightPath, preflightDigest, policyPath, policyDigest };
    const proof = { path: join(root, "coordinator.sqlite"), owner: "owner", key: "key", id: "attempt", epoch: 1, token: "token" };
    const db = new DatabaseSync(proof.path);
    t.after(() => db.close());
    db.exec("CREATE TABLE subagent_management (singleton INTEGER PRIMARY KEY, epoch INTEGER); INSERT INTO subagent_management VALUES (1, 1); CREATE TABLE subagent_launch_intents (owner TEXT, request_key TEXT, epoch INTEGER, attempts TEXT)");
    const save = value => db.prepare("INSERT INTO subagent_launch_intents VALUES ('owner', 'key', 1, ?)").run(JSON.stringify([value]));
    save(attempt);
    const denied = run("managed-launch-bootstrap.mjs", { ...proof, token: "wrong" });
    assert.equal(denied.status, 1);
    assert.match(denied.stderr, /epoch\/token is no longer admitted/);
    const accepted = run("managed-launch-bootstrap.mjs", proof);
    assert.equal(accepted.status, 0, accepted.stderr);
    const [recorded] = JSON.parse(db.prepare("SELECT attempts FROM subagent_launch_intents").get().attempts);
    assert.equal(recorded.bootstrapped, true);
    assert.ok(recorded.writerPid > 0);
    assert.ok(recorded.writerStartTime);
    const replay = run("managed-launch-bootstrap.mjs", proof);
    assert.equal(replay.status, 1);
    assert.match(replay.stderr, /token already has a writer/);
    // The native entry and registry must use the same process identity implementation.
    const { processStartToken } = await import(pathToFileURL(join(pkg, "process-identity.mjs")));
    assert.ok(processStartToken(process.pid));
});
