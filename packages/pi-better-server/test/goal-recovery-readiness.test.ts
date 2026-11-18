import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { checkHello } from "../src/handshake.ts";
const { registerBackgroundTasksGoalProvider } = await import(new URL("../../pi-better-background-tasks/src/goal-provider.ts", import.meta.url).href);
const { closeBackgroundObservation, backgroundGoalObservation } = await import(new URL("../../pi-better-background-tasks/src/work-observation.ts", import.meta.url).href);
import { goalActivityWhenReady } from "./support/goal-ready.mjs";
import { collectActivitySnapshot, planBackgroundDrainWake } from "../../pi-better-goal/src/activity.ts";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);

test("a new owner can answer hello before Goal scope readiness, then recover through the same subscription", async t => {
  const root = mkdtempSync(join(tmpdir(), "goal-query-readiness-"));
  const seed = openStore({ path: join(root, "operation-coordinator.sqlite") }); seed.close();
  const model = new WorkReadModel(root, "replacement-owner", {
    baseDir: join(root, "raw"), durableDir: join(root, "archive"), supervisorDirectory: join(root, "supervisor"),
    watch: () => Object.assign(new EventEmitter(), { close() {} }) as any,
  });
  const commands: string[] = [];
  const socket: any = Object.assign(new EventEmitter(), {
    destroyed: false, writableLength: 0, setEncoding() {},
    destroy() { this.destroyed = true; socket.emit("close"); },
    write(line: string) {
      const command = JSON.parse(line); commands.push(command.type);
      queueMicrotask(() => {
        const result = command.type === "hello" ? checkHello(command, { agentDir: root, instanceId: model.instanceId }) : undefined;
        const data = result ? (assert.equal(result.ok, true), (result as any).data) : queries.handle(command);
        socket.emit("data", JSON.stringify({ id: command.id, type: "response", success: true, data }) + "\n");
      });
      return true;
    },
  });
  const stream: any = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
    write(line: string) { socket.emit("data", line); return true; }, destroy() {} });
  const queries = new WorkQueries(model, stream);
  const client = new WorkClient(socket, root, ["runtime-background-state-v1"]);
  let provider: any;
  const events = new EventEmitter();
  events.on("pi-better-runtime:connect", request => request.accept(client));
  events.on("pi-better-goal:register-provider", value => { provider = value; });
  const pi: any = { events };
  const ctx: any = { cwd: root, sessionManager: { getSessionId: () => "parent", getBranch: () => [] } };
  let notifications = 0;
  registerBackgroundTasksGoalProvider(pi);
  const off = provider.onActivityChanged(() => { notifications++; }, ctx);
  try {
    const hello = await client.ready;
    assert.equal(hello.instanceId, "replacement-owner");
    assert.equal(model.metrics.initialization.attempts, 0);
    const began = performance.now();
    await assert.rejects(provider.getActivity(ctx), /Initial source inventory is rebuilding/);
    assert.ok(performance.now() - began < 400, "unverified read returns within the existing caller bound; it does not wait for inventory");
    assert.equal(client.snapshot!.status, "rebuilding");
    const pending = await collectActivitySnapshot(ctx, [provider], false);
    assert.equal(pending.terminalAttentionCount, 1);
    assert.equal(pending.providers[0]!.items[0]!.id, "background-tasks:provider-error");
    assert.match(String(pending.providers[0]!.items[0]!.details?.error), /Initial source inventory is rebuilding/);
    const tracker = { goalId: "existing-goal", activeSignature: "previous-task:running" };
    const drain = planBackgroundDrainWake(tracker, { goalId: tracker.goalId, status: "active" } as any, pending);
    assert.equal(drain.wakeSignature, null, "unverified coverage cannot prove that previously active work drained");
    assert.deepEqual(drain.nextTracker, tracker);
    assert.equal(pending.coverage, "unverified");
    assert.equal(pending.category, "unverified");
    const initialCommands = [...commands];
    assert.deepEqual(initialCommands, ["hello", "runtime_subscribe"]);
    const before = notifications;
    let fixtureReady = false;
    const readyActivity = goalActivityWhenReady(provider, ctx, context => backgroundGoalObservation(pi, context))
      .then(value => { fixtureReady = true; return value; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fixtureReady, false, "fixture cannot qualify source readiness from successful hello");
    await model.reconcile();
    assert.deepEqual((await readyActivity as any).items, []);
    assert.equal(client.snapshot!.status, "ready");
    assert.ok(notifications > before, "existing subscribed publication reaches Goal's notification binding");
    const recovered = await collectActivitySnapshot(ctx, [provider], false);
    assert.equal(recovered.terminalAttentionCount, 0);
    assert.deepEqual(recovered.providers[0]!.items, []);
    assert.equal(recovered.coverage, "verified");
    const verifiedDrain = planBackgroundDrainWake(drain.nextTracker, { goalId: tracker.goalId, status: "active" } as any, recovered);
    assert.equal(verifiedDrain.wakeSignature, "existing-goal:previous-task:running");
    assert.equal(planBackgroundDrainWake(verifiedDrain.nextTracker, { goalId: tracker.goalId, status: "active" } as any, recovered).wakeSignature, null);
    for (let i = 0; i < 5; i++) await provider.getActivity(ctx);
    assert.deepEqual(commands, initialCommands, "initial failure, reconciliation and warmed Goal reads add no get RPC, resubscribe or full-state poll");
    assert.equal(model.metrics.initialization.attempts, 1);
    t.diagnostic(JSON.stringify({ helloInstance: hello.instanceId, initial: "rebuilding", caller: "provider-error", afterPublication: client.snapshot!.status,
      commands, notifications, providerErrorCategory: pending.category, priorActiveDrainWake: drain.wakeSignature, elapsedMs: performance.now() - began }));
  } finally {
    off(); closeBackgroundObservation(pi); queries.close(); client.close();
    await model.close(); rmSync(root, { recursive: true, force: true });
  }
});
