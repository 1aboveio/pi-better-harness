import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { showRemoteProgress } from "../src/remote-client/remote-progress.ts";
import { syncPackages } from "../src/remote-client/extension.ts";
import { DaemonClient } from "../src/client.ts";
import { startDaemon } from "../src/server.ts";
import { makeEnv } from "./helpers.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(t: TestContext) {
  let screen: Component & { dispose?(): void };
  let completions = 0;
  const ui = { custom: (factory: (...args: any[]) => typeof screen) => new Promise(resolve => {
    screen = factory({ requestRender() {} }, { fg: (_color: string, text: string) => text }, {}, (value: unknown) => {
      completions++;
      screen.dispose?.();
      resolve(value);
    });
  }) } as unknown as Pick<ExtensionUIContext, "custom">;
  t.after(() => screen?.dispose?.());
  return { ui, render: (width = 80) => screen.render(width), cancel: () => screen.handleInput?.("\x1b"), completions: () => completions };
}

test("remote reads show bounded progress immediately and ignore a result arriving after cancellation", async t => {
  const ui = harness(t);
  const pending = deferred<string>();
  const attempt = showRemoteProgress(ui.ui, "r5", "Loading remote folders...", () => pending.promise);
  assert.match(ui.render().join("\n"), /r5: Loading remote folders/);
  assert.match(ui.render().join("\n"), /Esc cancel/);
  assert.ok(ui.render(14).every(line => visibleWidth(line) <= 14));
  assert.deepEqual(ui.render(0), []);
  await Promise.resolve();
  ui.cancel();
  assert.equal(await attempt, undefined);
  pending.resolve("late folder list");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ui.completions(), 1);
});

test("in-flight remote writes cannot be dismissed as if cancelled and return their actual result", async t => {
  const ui = harness(t);
  const pending = deferred<{ path: string }>();
  const attempt = showRemoteProgress(ui.ui, "r5", "Creating folder...", () => pending.promise, { cancellable: false });
  assert.doesNotMatch(ui.render().join("\n"), /Esc cancel/);
  ui.cancel();
  assert.equal(ui.completions(), 0, "Escape cannot hide an unabortable write");
  const value = { path: "/work/new-project" };
  pending.resolve(value);
  assert.deepEqual(await attempt, { value });
  assert.equal(ui.completions(), 1);
});

test("remote progress preserves operation errors and handles late rejection after cancellation", async t => {
  const ui = harness(t);
  const failure = new Error("permission denied");
  await assert.rejects(showRemoteProgress(ui.ui, "r5", "Loading folders...", async () => { throw failure; }), error => error === failure);
  const late = deferred<void>();
  const attempt = showRemoteProgress(ui.ui, "r5", "Refreshing sessions...", () => late.promise);
  await Promise.resolve();
  ui.cancel();
  assert.equal(await attempt, undefined);
  late.reject(failure);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(ui.completions(), 2);
});

test("cancelling the package preflight returns a stop decision rather than permission to create or attach", async t => {
  const env = makeEnv();
  const previous = { ...process.env };
  Object.assign(process.env, env.vars);
  t.after(() => {
    for (const key of Object.keys(env.vars)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  const daemon = await startDaemon({ serverDir: env.serverDir });
  t.after(() => daemon.stop());
  const client = await DaemonClient.connect(daemon.socketPath);
  t.after(() => client.close());
  const ui = harness(t);
  const result = syncPackages(client, { cwd: env.cwd, ui: ui.ui as ExtensionUIContext }, env.cwd);
  assert.match(ui.render().join("\n"), /Checking workspace extensions/);
  assert.match(ui.render().join("\n"), /Esc cancel/);
  await Promise.resolve();
  ui.cancel();
  assert.equal(await result, false, "Caller must stop before creating or attaching a session");
  assert.deepEqual(daemon.registry.list(), []);
});