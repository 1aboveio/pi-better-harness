import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { WorkQueries } from "../src/runtime/queries.ts";
import { subscribeBackgroundReady } from "./support/background-source-ready.ts";

for (const abort of [false, true]) test(`Background source publication wait preserves initial rebuilding and abort=${abort}`, async () => {
  const root = mkdtempSync(join(tmpdir(), "background-source-ready-"));
  const watch = (() => Object.assign(new EventEmitter(), { close() {}, ready: Promise.resolve() })) as any;
  const model = new WorkReadModel(root, "publication-owner", { baseDir: join(root, "raw"),
    durableDir: join(root, "archive"), watch, intervalMs: 60000 });
  const listeners = new Set<(value: any) => void>();
  let subscriptions = 0;
  const client: any = { snapshot: undefined,
    subscribe(scope: any) { subscriptions++; return client.snapshot = queries.handle({ type: "runtime_subscribe", scope }); },
    onChange(listener: (value: any) => void) { listeners.add(listener); return () => listeners.delete(listener); } };
  const socket = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
    write(line: string) { client.snapshot = JSON.parse(line).event.snapshot; for (const listener of listeners) listener(client.snapshot); } });
  const queries = new WorkQueries(model, socket as any);
  const controller = new AbortController();
  try {
    const waiting = subscribeBackgroundReady(client, { background: true, cwd: root, sessionId: "original-parent" }, controller.signal);
    let settled = false; void waiting.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(client.snapshot.status, "rebuilding", "a listening control plane does not prove initialized source coverage");
    assert.equal(settled, false, "original ready assertion must wait for actual source publication");
    assert.equal(subscriptions, 1, "readiness must not issue another query");
    if (abort) {
      controller.abort(new Error("original test deadline"));
      await assert.rejects(waiting, /original test deadline/);
    } else {
      await model.reconcile();
      const ready = await waiting;
      assert.equal(ready.status, "ready");
      assert.equal(ready.instanceId, "publication-owner");
      assert.equal(ready.activity.active, 0);
    }
    assert.equal(listeners.size, 0);
    assert.equal(subscriptions, 1);
  } finally { queries.close(); await model.close(); rmSync(root, { recursive: true, force: true }); }
});
