import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";

test("real SQLite launch journal retains exact retry identity and bootstrap fences epoch, lease and frozen policy", async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "fences-"));
  process.env.PI_SUBAGENT_DURABLE_DIR = join(root, "durable");
  const domain = "../src/runtime/domain/subagents/";
  const { LaunchJournal, launchDigest } = await import(domain + "managed-launch-journal.mjs");
  const { verifyManagedBootstrap } = await import(domain + "managed-launch-bootstrap.mjs");
  const { acquireConversationLease } = await import(domain + "continuation.ts");
  const { nextRunId } = await import(domain + "registry.ts");
  const path = join(root, "coordinator.sqlite"), journal = new LaunchJournal(path);
  const epoch = journal.epoch("first-server"), id = nextRunId();
  const lease = acquireConversationLease({ sessionId: id, attemptId: id });
  const preflightPath = join(root, "preflight.json"), policyPath = join(root, "policy.json");
  const preflight = { tools: ["read"], model: "openai/gpt-4.1" }, policy = { network: false, projectFiles: "read" };
  writeFileSync(preflightPath, JSON.stringify(preflight)); writeFileSync(policyPath, JSON.stringify(policy));
  try {
    journal.accept("owner", "request", "digest", epoch);
    const attempt = journal.prepare("owner", "request", epoch, { id, sessionId: id, lease: lease.token, leasePath: lease.path,
      preflightPath, policyPath, preflightDigest: launchDigest(preflight), policyDigest: launchDigest(policy) });
    const retry = journal.accept("owner", "request", "digest", epoch);
    assert.equal(JSON.parse(retry.attempts)[0].token, attempt.token);
    assert.equal(JSON.parse(retry.attempts).length, 1);
    assert.throws(() => journal.accept("owner", "request", "different", epoch), /request-conflict/);
    assert.throws(() => journal.prepare("owner", "request", epoch, { id }), /already dispatched/);
    const env = { PI_MANAGED_SUBAGENT: JSON.stringify({ path, owner: "owner", key: "request", epoch, id, token: attempt.token }) };
    verifyManagedBootstrap(env);
    writeFileSync(policyPath, JSON.stringify({ ...policy, network: true }));
    assert.throws(() => verifyManagedBootstrap(env), /captured permissions changed/);
    writeFileSync(policyPath, JSON.stringify(policy));
    writeFileSync(preflightPath, JSON.stringify({ ...preflight, tools: ["bash"] }));
    assert.throws(() => verifyManagedBootstrap(env), /preflight changed/);
    writeFileSync(preflightPath, JSON.stringify(preflight));
    journal.spawned("owner", "request", epoch, id, process.pid);
    assert.throws(() => verifyManagedBootstrap(env), /already has a writer/);
    lease.release();
    assert.throws(() => verifyManagedBootstrap(env), /ENOENT/);
    const successor = journal.epoch("replacement-server");
    assert.equal(successor, epoch + 1);
    assert.throws(() => verifyManagedBootstrap(env), /epoch\/token/);
    assert.throws(() => journal.prepare("owner", "request", epoch, { id }), /stale-runtime-epoch/);
    const replay = journal.accept("owner", "request", "digest", successor);
    assert.equal(JSON.parse(replay.attempts)[0].token, attempt.token);
    assert.equal(JSON.parse(replay.attempts).length, 1);
  } finally { lease.release(); journal.close(); }
});

test("SQLite launch-intent writer SIGKILL retains one attempt, recipe and token across replacement", async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "crash-intent-"));
  const module = "../src/runtime/domain/subagents/managed-launch-journal.mjs";
  const { LaunchJournal } = await import(module);
  const path = join(root, "coordinator.sqlite");
  const recipe = { version: 1, attemptId: "sa_crash_1", sessionId: "sa_crash_1", cwd: root,
    sessionDir: join(root, "sessions"), tools: "read", clean: false, allowNested: false, sandbox: false, approve: false, gitCloneWorkspace: false };
  const child = fork(new URL("./support/subagent-intent-crash.mjs", import.meta.url), [], { execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = once(child, "exit"), published = once(child, "message");
  child.send({ path, input: { id: recipe.attemptId, sessionId: recipe.sessionId, recipe, capacityOwner: { pid: 123, start: "original-capacity-domain" } } });
  const [publication] = await published;
  const [code, signal] = await exited;
  assert.equal(code, null); assert.equal(signal, "SIGKILL");
  const recovered = new LaunchJournal(path);
  try {
    const epoch = recovered.epoch("replacement-server");
    assert.equal(epoch, publication.epoch + 1);
    const replay = recovered.accept("original-recipient", "one-launch", "same-request", epoch);
    assert.equal(replay.prior, true);
    const attempts = JSON.parse(replay.attempts);
    assert.equal(attempts.length, 1); assert.equal(attempts[0].id, publication.id); assert.equal(attempts[0].token, publication.token);
    assert.deepEqual(attempts[0].recipe, recipe);
    assert.deepEqual(attempts[0].capacityOwner, { pid: 123, start: "original-capacity-domain" });
    assert.throws(() => recovered.prepare("original-recipient", "one-launch", epoch, { id: "sa_duplicate_1" }), /not admitted/);
    assert.equal(recovered.unresolvedAttempts().length, 1);
  } finally { recovered.close(); }
});
