import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { withConnectionProgress } from "../src/remote-client/connection-progress.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

function nativeUi(t: TestContext) {
  let component: Component & { dispose?(): void };
  let fail!: (error: unknown) => void;
  let completions = 0;
  const ui = { custom: (factory: (...args: any[]) => typeof component) => new Promise((resolve, reject) => {
    fail = reject;
    component = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => {
      completions++;
      component.dispose?.();
      resolve(value);
    });
  }) } as unknown as Pick<ExtensionUIContext, "custom">;
  t.after(() => component?.dispose?.());
  return { ui, render: (width = 80) => component.render(width), cancel: () => component.handleInput?.("\x1b"), fail: (error: unknown) => fail(error), completions: () => completions };
}

test("connection spinner renders pending stages and preserves a successful connection after UI disposal", async t => {
  const h = nativeUi(t);
  const first = deferred<void>();
  const second = deferred<void>();
  const connection = { connected: true };
  let signal!: AbortSignal;
  const attempt = withConnectionProgress(h.ui, "115", async progress => {
    signal = progress.signal;
    progress.stage("establishing SSH...");
    await first.promise;
    progress.stage("opening SSH tunnel...");
    await second.promise;
    return connection;
  }, () => { throw new Error("Successful connection must not be disposed"); });
  await turn();
  assert.match(h.render().join("\n"), /Connecting to 115: establishing SSH/);
  assert.match(h.render().join("\n"), /Esc cancel/);
  assert.ok(h.render(12).every(line => visibleWidth(line) <= 12));
  first.resolve();
  await turn();
  assert.match(h.render().join("\n"), /opening SSH tunnel/);
  second.resolve();
  assert.equal(await attempt, connection);
  assert.equal(signal.aborted, false);
  assert.equal(h.completions(), 1);
});

test("connection failure preserves the original SSH error for the caller", async t => {
  const h = nativeUi(t);
  const error = new Error("SSH ControlMaster for 115: Host is down");
  await assert.rejects(withConnectionProgress(h.ui, "115", async () => { throw error; }, () => {}), caught => caught === error);
  assert.equal(h.completions(), 1);
});

test("Escape aborts the attempt and cleans a resource arriving after cancellation exactly once", async t => {
  const h = nativeUi(t);
  const pending = deferred<{ socket: string }>();
  let signal!: AbortSignal;
  const disposed: unknown[] = [];
  const attempt = withConnectionProgress(h.ui, "r5", async progress => { signal = progress.signal; return pending.promise; }, value => { disposed.push(value); });
  await turn();
  h.cancel();
  assert.equal(await attempt, undefined);
  assert.equal(signal.aborted, true);
  const late = { socket: "late-forward" };
  pending.resolve(late);
  await turn();
  assert.deepEqual(disposed, [late]);
  assert.equal(h.completions(), 1);
});

test("late rejection after cancellation does not replace the cancelled result with an error", async t => {
  const h = nativeUi(t);
  const pending = deferred<void>();
  const attempt = withConnectionProgress(h.ui, "r5", async () => pending.promise, () => {});
  await turn();
  h.cancel();
  assert.equal(await attempt, undefined);
  pending.reject(new Error("Late SSH failure"));
  await turn();
  assert.equal(h.completions(), 1);
});

test("native UI failure aborts pending connection work and cleans late resources", async t => {
  const h = nativeUi(t);
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const disposed: string[] = [];
  const attempt = withConnectionProgress(h.ui, "r5", async progress => { signal = progress.signal; return pending.promise; }, value => { disposed.push(value); });
  await turn();
  const failure = new Error("UI closed");
  const rejected = assert.rejects(attempt, error => error === failure);
  h.fail(failure);
  await rejected;
  assert.equal(signal.aborted, true);
  pending.resolve("late");
  await turn();
  assert.deepEqual(disposed, ["late"]);
});