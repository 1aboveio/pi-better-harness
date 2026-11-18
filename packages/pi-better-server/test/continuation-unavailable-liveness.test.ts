import assert from "node:assert/strict";
import { test } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

for (const fixed of [false, true]) for (const missingAuthority of [false, true]) test(`${fixed ? "fixed domain" : "canonical"} ${missingAuthority ? "missing" : "unavailable"} captured continuation authority holds its exact durable generation before granting liveness`, async t => {
  const subagents = fixed ? "../src/runtime/domain/subagents/" : "../../pi-better-subagents/";
  const suffix = fixed ? ".domain.mjs" : ".ts";
  const { ManagedSubagentHost } = await import(new URL(`${subagents}managed-launch-host${suffix}`, import.meta.url).href);
  const { createObservedWaitHost } = await import(new URL(fixed ? "../src/runtime/domain/background-service/observed-waits.domain.mjs" : "../../pi-better-background-tasks/src/observed-waits.ts", import.meta.url).href);
  const { createResumeOrchestration } = await import(new URL(`${subagents}worker-waits${suffix}`, import.meta.url).href);
  const { readParkRecord, writeParkRecord } = await import(new URL(`${subagents}registry${suffix}`, import.meta.url).href);
  const { readPermissionSettings } = await import(new URL(fixed ? "../src/runtime/domain/sandbox-policy/permission-settings.domain.mjs" : "../../pi-better-sandbox/permission-settings.ts", import.meta.url).href);
  // Process identity is an external boundary, not native ownership proof.
  t.mock.method(childProcess, "execFileSync", () => "fixture-process-start");
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const root = mkdtempSync(join(tmpdir(), "continuation-unavailable-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
  const pi = { events: new EventEmitter() } as any;
  const background = createObservedWaitHost(pi, { sharedStore: store, storePath: join(root, "operation-coordinator.sqlite"),
    supervisorDirectory: join(root, "supervisor"), serverOwnedResults: true, pollMs: 0 });
  writeFileSync(join(root, "settings.json"), JSON.stringify({ piBetterHarness: { sandboxPermissions: { version: 999 } } }));
  const managed = new ManagedSubagentHost(root, "instance", {}, store, undefined, () => readPermissionSettings({ agentDir: () => root }));
  t.after(async () => {
    background.close(); await managed.close(); store.close();
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  background.start();
  const owner = { kind: "worker-conversation" as const, sessionId: "captured-conversation", workspace: root, branchId: "captured-branch", goalId: null };
  store.registerOperation({ operationId: "dependency", taskId: "task", launchToken: "token", owner, observer: { kind: "local-supervisor", version: "1" } });
  store.recordTerminalOutcome({ operationId: "dependency", owner, eventId: "terminal", outcome: "succeeded", evidence: [{ kind: "terminal-record", ref: "captured-result" }] });
  const wait = store.registerWait({ waitId: "captured-wait", owner, dependencies: [{ operationId: "dependency" }], continuationNote: "Interpret exact evidence" }).wait;
  const otherOwner = { ...owner, sessionId: "other-conversation" };
  const other = store.registerWait({ waitId: "other-wait", owner: otherOwner, dependencies: [{ operationId: "dependency", link: "explicit" }], continuationNote: "Other live work" }).wait;
  const meta = { id: "sa_unavailable", sessionId: owner.sessionId, cwd: root, status: "completed", callbackOrigin: { cwd: root, sessionId: "parent" } };
  const record = { version: 1, waitId: wait.waitId, generation: wait.generation, attemptId: meta.id, parkedAt: Date.now(), phase: "ready", ownerSessionId: "parent", ownerWorkspace: root, ownerBranchId: owner.branchId };
  writeParkRecord(meta.id, record as any);
  const park = { runId: meta.id, conversationId: owner.sessionId, waitId: wait.waitId, generation: wait.generation, phase: "ready", meta, record } as any;
  const journal = (managed as any).journal;
  const epoch = (managed as any).epoch;
  journal.accept("captured-owner", "launch", "digest", epoch);
  if (!missingAuthority) journal.prepare("captured-owner", "launch", epoch, { id: meta.id, sessionId: owner.sessionId, launchAuthority: { permissions: {} } });
  const orchestration = createResumeOrchestration({ pi, service: () => background.service,
    rpc: {} as any, context: () => undefined,
    capacity: { tryReserve: () => { throw new Error("authority failure must precede capacity"); } } as any,
    launch: async () => { assert.fail("unavailable authority cannot launch"); },
    dispatch: (value: any, run: () => Promise<"resumed" | "held" | "skipped">) => (managed as any).dispatchContinuation(value, run) });
  // Register after seeding so automatic outbox dispatch cannot precede the assertion.
  background.service.registerContinuationAdapter(orchestration.adapter);
  assert.equal(background.advancingWaits().length, 2);
  assert.equal(await orchestration.resume(park), "held");
  assert.equal(store.getWait({ waitId: wait.waitId, generation: wait.generation })?.phase, "held");
  assert.equal(readParkRecord(meta.id)?.phase, "held");
  assert.deepEqual(background.advancingWaits().map((reason: any) => reason.id), [other.waitId], "foreign ready work must retain liveness");
  assert.equal(store.getOperation("dependency")?.terminalRevision, 1);
  assert.equal(store.listResumeClaims({ waitId: wait.waitId }).length, 0);
  if (!missingAuthority) assert.deepEqual(journal.attempt(meta.id).launchAuthority, { permissions: {} }, "refusal cannot rewrite frozen authority");
  assert.equal(managed.status().inFlight, 0);
  assert.match(managed.status().continuationUnavailable[0]!.reason,
    missingAuthority ? /Captured continuation launch authority unavailable/ : /Unsupported sandbox permissions file version/);
  const missing = { runId: "missing-authority", waitId: "missing-wait", generation: 1 };
  const neverDispatch = async () => { assert.fail("missing captured authority must not dispatch"); };
  await assert.rejects((managed as any).dispatchContinuation(missing, neverDispatch), /Captured continuation launch authority unavailable/);
  const refusal = managed.status().continuationUnavailable.find((value: any) => value.key === "missing-wait:1");
  assert.equal(await (managed as any).dispatchContinuation(missing, neverDispatch), "skipped", "existing backoff defers without a second dispatch");
  assert.deepEqual(managed.status().continuationUnavailable.find((value: any) => value.key === "missing-wait:1"), refusal);
  assert.equal(managed.busy, false);
  for (let i = 0; i < 130; i++) {
    await (managed as any).dispatchContinuation({ ...missing, waitId: `flood-${i}` }, neverDispatch).catch((error: unknown) => {
      assert.match(String(error), /Captured continuation launch authority unavailable/);
    });
  }
  assert.equal(managed.status().continuationUnavailable.length, 32, "admission still bounds distinct failed generations");
  assert.equal(managed.busy, false);
});
