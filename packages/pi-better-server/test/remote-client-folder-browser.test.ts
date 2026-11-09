import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { DaemonClient } from "../src/client.ts";
import { browseRemoteFolders, RemoteFolderBrowser, RemoteFolderBrowserState, type RemoteFolderIntent } from "../src/remote-client/folder-browser.ts";
import { startDaemon } from "../src/server.ts";
import { makeEnv } from "./helpers.ts";

const keys = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" };
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function component(state: RemoteFolderBrowserState, rows = 30) {
  const intents: RemoteFolderIntent[] = [];
  const screen = new RemoteFolderBrowser(state, "host\n\x1b[2J", {
    theme, rows: () => rows, requestRender() {}, done: intent => intents.push(intent),
  });
  return { screen, intents };
}

function populated() {
  const state = new RemoteFolderBrowserState("/work");
  state.replace({ path: "/work", parent: "/", directories: [{ name: "first", path: "/work/first" }, { name: "second", path: "/work/second" }] });
  return state;
}

test("up/down wraps, Enter opens the selected child or parent, and only s selects the current directory", () => {
  const state = populated();
  const { screen, intents } = component(state);
  screen.handleInput(keys.up);
  assert.equal(state.selectedIndex, 2);
  screen.handleInput(keys.down);
  assert.equal(state.selectedIndex, 0);
  screen.handleInput(keys.down);
  screen.handleInput(keys.enter);
  screen.handleInput("s");
  assert.deepEqual(intents, [{ action: "open", path: "/work/first" }]);
  const parent = component(populated());
  parent.screen.handleInput(keys.enter);
  assert.deepEqual(parent.intents, [{ action: "open", path: "/" }]);
  const select = component(state);
  select.screen.handleInput("s");
  assert.deepEqual(select.intents, [{ action: "select" }]);
});

test("missing directories allow only parent navigation, retry and cancellation; root has no parent row", () => {
  const state = new RemoteFolderBrowserState("/missing/workspaces");
  const { screen, intents } = component(state);
  screen.handleInput("s");
  screen.handleInput("n");
  assert.deepEqual(intents, []);
  assert.match(plain(screen.render(100)), /unavailable.*parent.*retry/);
  screen.handleInput(keys.enter);
  assert.deepEqual(intents, [{ action: "open", path: "/missing" }]);
  const root = new RemoteFolderBrowserState("/");
  root.replace({ path: "/", parent: null, directories: [] });
  const empty = component(root);
  assert.match(plain(empty.screen.render(80)), /No subfolders/);
  empty.screen.handleInput(keys.enter);
  empty.screen.handleInput(keys.down);
  assert.deepEqual(empty.intents, []);
  empty.screen.handleInput("n");
  assert.deepEqual(empty.intents, [{ action: "create" }]);
  const disposed = component(state);
  disposed.screen.dispose();
  disposed.screen.handleInput("r");
  assert.deepEqual(disposed.intents, []);
  for (const key of [keys.escape, "\x03"]) {
    const cancelled = component(state);
    cancelled.screen.handleInput(key);
    assert.deepEqual(cancelled.intents, [undefined]);
  }
});

test("rendering sanitizes terminal controls and bidi paths, fits narrow rows, and keeps the selected row after resize", t => {
  const previousRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  t.after(() => {
    if (previousRows) Object.defineProperty(process.stdout, "rows", previousRows);
    else Reflect.deleteProperty(process.stdout, "rows");
  });
  const state = new RemoteFolderBrowserState("/work/\x1b[2J\n\u202ehidden");
  state.replace({ path: state.path, parent: "/work", directories: Array.from({ length: 40 }, (_, index) => ({
    name: `Row${index} 中文 e\u0301\x1b[2J\u2066`, path: `/work/${index}`,
  })) });
  const { screen } = component(state, 40);
  for (let i = 0; i < 40; i++) screen.handleInput(keys.down);
  for (const [width, height] of [[20, 10], [32, 12], [80, 16], [160, 30], [1, 4], [0, 10]] as const) {
    Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
    for (const error of [undefined, "Permission denied\n\x1b[2J\u202e. Press r to retry."]) {
      state.error = error;
      screen.invalidate();
      const lines = screen.render(width);
      assert.ok(lines.length <= height - 3, `${width}x${height}: vertical overflow`);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `${width}x${height}: horizontal overflow`);
      const output = plain(lines);
      assert.doesNotMatch(output, /\x1b\[2J|[\u202e\u2066]/);
      if (width >= 20) {
        assert.match(output, /Row39/);
        assert.match(output, /41\/41/);
        for (const command of ["Enter open", "s select", "n new folder", "r retry", "Esc back"]) assert.ok(output.includes(command), command);
        if (error) assert.match(output, /Permission denied/);
      }
    }
  }
});

type Screen = Component & { dispose?(): void };
type Step = (screen: Screen) => void;
const send = (...keys: string[]): Step => screen => { for (const key of keys) screen.handleInput?.(key); };

function scriptedUI(steps: Step[], options: { input?: () => Promise<string | undefined>; progress?: (screen: Screen, output: string) => void } = {}) {
  let active = false;
  const frames: string[] = [];
  const progress: string[] = [];
  const custom: ExtensionUIContext["custom"] = factory => new Promise((resolve, reject) => {
    assert.equal(active, false, "custom screens must not overlap");
    active = true;
    let screen: Screen;
    const done = (value: Parameters<Parameters<typeof factory>[3]>[0]) => {
      assert.equal(active, true, "done must not run after disposal");
      active = false;
      screen.dispose?.();
      resolve(value);
    };
    screen = factory({ requestRender() {}, terminal: { rows: 30 } } as unknown as TUI, theme, {} as Parameters<typeof factory>[2], done) as Screen;
    const output = plain(screen.render(120));
    frames.push(output);
    queueMicrotask(() => {
      try {
        if (/Loading remote folders|Creating remote folder/.test(output)) {
          progress.push(output);
          options.progress?.(screen, output);
        } else {
          const step = steps.shift();
          assert.ok(step, `Unexpected folder screen:\n${output}`);
          step(screen);
        }
      } catch (error) {
        active = false;
        screen.dispose?.();
        reject(error);
      }
    });
  });
  const ui = {
    custom,
    input: async () => {
      assert.equal(active, false, "input must be outside custom");
      return options.input?.();
    },
  } as unknown as ExtensionUIContext;
  return { ui, frames, progress, remaining: () => steps.length };
}

async function realDaemon(t: TestContext) {
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
  return { env, daemon, client };
}

test("real daemon: Enter navigates without choosing; s returns the current absolute directory", async t => {
  const { env, daemon, client } = await realDaemon(t);
  await mkdir(join(env.cwd, "child"));
  const ui = scriptedUI([send(keys.down, keys.enter), screen => {
    assert.match(plain(screen.render(120)), /Folder: .*\/child/);
    screen.handleInput?.("s");
  }]);
  assert.equal(await browseRemoteFolders(ui.ui, client, "daemon", env.cwd), join(env.cwd, "child"));
  assert.equal(ui.progress.length, 2, "both list operations display progress");
  assert.equal(ui.remaining(), 0);
  assert.deepEqual(daemon.registry.list(), [], "choosing a cwd must not start a session");
});

test("real daemon: a missing default root reports an error, allows parent navigation and creates only an explicit child", async t => {
  const { env, daemon, client } = await realDaemon(t);
  const missing = join(env.cwd, "workspaces");
  let inputs = 0;
  const ui = scriptedUI([screen => {
    assert.match(plain(screen.render(120)), /List failed:.*ENOENT/);
    screen.handleInput?.("s");
    screen.handleInput?.("n");
    assert.equal(inputs, 0);
    screen.handleInput?.(keys.enter);
  }, send("n"), screen => {
    assert.match(plain(screen.render(120)), /Folder: .*\/explicit-project/);
    assert.deepEqual(daemon.registry.list(), []);
    assert.equal(existsSync(missing), false);
    screen.handleInput?.("s");
  }], {
    input: async () => { inputs++; return "explicit-project"; },
    progress: (screen, output) => {
      if (/Creating remote folder/.test(output)) {
        assert.match(output, /Waiting for the remote operation to finish/);
        screen.handleInput?.(keys.escape);
      }
    },
  });
  assert.equal(await browseRemoteFolders(ui.ui, client, "daemon", missing), join(env.cwd, "explicit-project"));
  assert.deepEqual(await readdir(env.cwd), ["explicit-project"]);
  assert.equal(inputs, 1);
  assert.equal(ui.progress.length, 4, "failed list, parent list, create and child list all show progress");
  assert.equal(ui.remaining(), 0);
});

test("real daemon: cancelled or invalid names do not write; create failure can retry and cancellation leaves the child intact", async t => {
  const { env, client } = await realDaemon(t);
  await writeFile(join(env.cwd, "taken"), "keep");
  const names = [undefined, "../escape", "taken", "new-project"];
  const ui = scriptedUI([send("n"), send("n"), screen => {
    assert.match(plain(screen.render(120)), /without traversal/);
    screen.handleInput?.("n");
  }, screen => {
    assert.match(plain(screen.render(120)), /Create failed:.*EEXIST/);
    screen.handleInput?.("n");
  }, send(keys.escape)], { input: async () => names.shift() });
  assert.equal(await browseRemoteFolders(ui.ui, client, "daemon", env.cwd), undefined);
  assert.equal(await readFile(join(env.cwd, "taken"), "utf8"), "keep");
  assert.deepEqual(await readdir(join(env.cwd, "new-project")), []);
  assert.equal(existsSync(join(env.root, "escape")), false);
  assert.equal(ui.progress.length, 4, "invalid and cancelled input must not send create operations");
  assert.equal(ui.remaining(), 0);
});

test("real daemon: list errors retry after a directory appears, while a dead transport remains escapable", async t => {
  const { env, client } = await realDaemon(t);
  const path = join(env.cwd, "later");
  let created: Promise<void> | undefined;
  const ui = scriptedUI([screen => {
    assert.match(plain(screen.render(120)), /List failed:.*ENOENT/);
    created = mkdir(path);
    // mkdir completion, not a timer, gates retry input.
    void created.then(() => screen.handleInput?.("r"));
  }, screen => {
    assert.doesNotMatch(plain(screen.render(120)), /List failed/);
    screen.handleInput?.("s");
  }]);
  assert.equal(await browseRemoteFolders(ui.ui, client, "daemon", path), path);
  await created;
  assert.equal(ui.progress.length, 2);
  await new Promise<void>(resolve => { client.onClose(resolve); client.close(); });
  const closed = scriptedUI([screen => {
    assert.match(plain(screen.render(120)), /List failed: connection closed/);
    screen.handleInput?.(keys.escape);
  }]);
  assert.equal(await browseRemoteFolders(closed.ui, client, "daemon", path), undefined);
});

test("real daemon: cancelling read progress returns undefined without mounting a folder screen", async t => {
  const { env, client } = await realDaemon(t);
  const ui = scriptedUI([], { progress: send(keys.escape) });
  assert.equal(await browseRemoteFolders(ui.ui, client, "daemon", env.cwd), undefined);
  // Drain any read already sent before cancellation without sleeping.
  await client.call({ type: "client_browse_directory", path: env.cwd });
  assert.equal(ui.frames.length, 1);
  assert.equal(ui.remaining(), 0);
});
