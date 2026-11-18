import test from "node:test";
import assert from "node:assert/strict";
import { HostSourceWatches } from "../src/runtime/source-watch.ts";
import { WorkReadModel } from "../src/runtime/read-model.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the first real write after an empty inventory publishes without registration warmup", { timeout: 10000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "source-first-write-")); mkdirSync(join(root, "runs"));
  const model = new WorkReadModel(root, "first-write", { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 });
  let timer: ReturnType<typeof setTimeout> | undefined, off: (() => void) | undefined;
  try {
    await model.reconcile();
    assert.equal(model.snapshot({}).status, "ready"); assert.equal(model.snapshot({}).rows.length, 0);
    const published = new Promise<void>((resolve, reject) => {
      off = model.onChange(() => { if (model.snapshot({}).rows[0]?.meta.name === "before-root") resolve(); });
      timer = setTimeout(() => reject(new Error("first write missed its publication deadline")), 1000);
    });
    const directory = join(root, "runs", "sa_metadata_gap"); mkdirSync(directory);
    writeFileSync(join(directory, "meta.json"), JSON.stringify({ id: "sa_metadata_gap", cwd: root, status: "completed", startedAt: 1, name: "before-root" }));
    await published;
    assert.equal(model.metrics.metadataReads, 1);
    assert.equal(model.metrics.sourceWork.repair.paths, 0);
  } finally { clearTimeout(timer); off?.(); await model.close(); rmSync(root, { recursive: true, force: true }); }
});

test("unsubscribe revokes callbacks immediately but retiring streams retain their capacity", async () => {
  let callback!: (name?: string) => void, release!: () => void;
  const host = new HostSourceWatches((_path, changed) => { callback = changed; return () => new Promise<void>(resolve => { release = resolve; }); }, 1);
  const messages: any[] = [], send = (message: any) => messages.push(message);
  host.handle(0, { type: "source-watch-subscribe", id: 1, path: "/source" }, send);
  callback("a"); callback("b"); callback("c");
  assert.equal(messages.filter(value => value.type === "source-watch-event").length, 1);
  host.handle(0, { type: "source-watch-consumed", id: 1 }, send);
  assert.deepEqual(messages.at(-1).names, ["b", "c"], "coalescing retains precise source names");
  host.handle(0, { type: "source-watch-unsubscribe", id: 1 }, send);
  const count = messages.length; callback("after-revoke");
  assert.equal(messages.length, count);
  assert.deepEqual(host.metrics(), { allocated: 1, retiring: 1, stopFailures: 0 });
  host.handle(1, { type: "source-watch-subscribe", id: 1, path: "/replacement" }, send);
  assert.match(messages.at(-1).error, /capacity/);
  await Promise.resolve(); release(); await host.close();
  assert.equal(host.metrics().allocated, 0);
});

test("failed native stop remains counted and stale generations cannot allocate or deliver", async () => {
  let callback!: (name?: string) => void;
  const host = new HostSourceWatches((_path, changed) => { callback = changed; return async () => { throw new Error("stop refused"); }; }, 1);
  const messages: any[] = [], send = (message: any) => messages.push(message);
  host.handle(2, { type: "source-watch-subscribe", id: 1, path: "/source" }, send);
  await assert.rejects(host.revoke(2), /stop refused/);
  callback("late");
  host.handle(2, { type: "source-watch-subscribe", id: 2, path: "/late" }, send);
  assert.equal(messages.length, 1);
  assert.deepEqual(host.metrics(), { allocated: 1, retiring: 1, stopFailures: 1 });
});

test("watch event overflow is bounded and forwards a scoped repair hint", async () => {
  let callback!: (name?: string) => void;
  const host = new HostSourceWatches((_path, changed) => { callback = changed; return async () => {}; });
  const messages: any[] = [], send = (message: any) => messages.push(message);
  host.handle(0, { type: "source-watch-subscribe", id: 1, path: "/source" }, send);
  callback("first");
  for (let i = 0; i < 1000; i++) callback(String(i));
  assert.equal(messages.filter(message => message.type === "source-watch-event").length, 1);
  host.handle(0, { type: "source-watch-consumed", id: 1 }, send);
  assert.equal(messages.at(-1).names.length, 129);
  assert.equal(messages.at(-1).names.at(-1), undefined);
  await host.close();
});

test("backend registration failure returns an error without consuming capacity", () => {
  const host = new HostSourceWatches(() => { throw new Error("registration refused"); });
  const messages: any[] = [];
  host.handle(0, { type: "source-watch-subscribe", id: 1, path: "/source" }, value => messages.push(value));
  assert.match(messages[0].error, /registration refused/);
  assert.equal(host.metrics().allocated, 0);
});
