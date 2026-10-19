import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { DaemonClient } from "../src/client.ts";
import { encodeLine, LineDecoder, type SessionSummary } from "../src/protocol.ts";
import { browseRemoteSessions, RemoteSessionBrowser, RemoteSessionBrowserState, type RemoteSessionBrowserIntent } from "../src/remote-client/session-browser.ts";
import { startDaemon } from "../src/server.ts";
import { makeEnv } from "./helpers.ts";

const keys = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", tab: "\t", shiftTab: "\x1b[Z", enter: "\r", escape: "\x1b" };
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;
const plain = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function summary(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId, name: "Same name", cwd: "/work/project", sessionFile: `/sessions/${sessionId}.jsonl`,
    status: "running", isStreaming: false, live: true, lastSeq: 0, hasController: false,
    needsInput: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides,
  };
}

function component(state: RemoteSessionBrowserState, rows = 30, options: { cwd?: string; loading?: string } = {}) {
  const intents: RemoteSessionBrowserIntent[] = [];
  let renders = 0;
  const screen = new RemoteSessionBrowser(state, "test-host", {
    theme, rows: () => rows, requestRender: () => { renders++; }, done: intent => intents.push(intent),
  }, options);
  return { screen, intents, renders: () => renders };
}

test("tabs classify status and moved ownership, preserve independent selection by ID, and fall back near a removed row", () => {
  const state = new RemoteSessionBrowserState();
  const sessions = [summary("first"), summary("second"), summary("third"), summary("fenced", { ownership: "fenced" }), summary("moved-running", { ownership: "moved" }), summary("closed", { status: "closed", live: false }), summary("moved-closed", { status: "closed", ownership: "moved" })];
  state.replaceSessions(sessions);
  assert.deepEqual(state.rows().map(s => s.sessionId), ["first", "second", "third", "fenced"]);
  state.select("second");
  state.changeTab();
  assert.deepEqual(state.rows().map(s => s.sessionId), ["moved-running", "closed", "moved-closed"]);
  state.select("closed");
  state.changeTab();
  state.replaceSessions([...sessions].reverse());
  assert.equal(state.selected?.sessionId, "second");
  state.changeTab();
  assert.equal(state.selected?.sessionId, "closed");
  state.changeTab();
  state.replaceSessions([summary("first"), summary("second"), summary("third")]);
  state.replaceSessions([summary("first"), summary("third")]);
  assert.equal(state.selected?.sessionId, "third");
  state.replaceSessions([]);
  assert.equal(state.selected, undefined);
});

test("all tab shortcuts and up/down selection work before render, and Enter targets the selected real ID", () => {
  const state = new RemoteSessionBrowserState();
  state.replaceSessions([summary("one"), summary("two"), summary("closed", { status: "closed" })]);
  const { screen, intents, renders } = component(state);
  for (const key of [keys.tab, keys.shiftTab, keys.left, keys.right]) {
    const before = state.tab;
    screen.handleInput(key);
    assert.notEqual(state.tab, before);
  }
  screen.handleInput(keys.down);
  assert.equal(state.selected?.sessionId, "two");
  screen.handleInput(keys.up);
  assert.equal(state.selected?.sessionId, "one");
  screen.handleInput(keys.up);
  assert.equal(state.selected?.sessionId, "two");
  screen.handleInput(keys.enter);
  screen.handleInput("c");
  assert.deepEqual(intents, [{ action: "attach", session: state.selected }]);
  assert.equal(renders(), 7);
});

test("non-owned rows are labeled and reject attach, close, and rename without leaving the browser", () => {
  for (const ownership of ["fenced", "moved"] as const) {
    for (const status of ["running", "closed"] as const) {
      const state = new RemoteSessionBrowserState();
      state.replaceSessions([summary("non-owned", { ownership, status }), summary("owned", { status })]);
      if (ownership === "moved" || status === "closed") state.changeTab();
      const { screen, intents, renders } = component(state);
      assert.match(plain(screen.render(100)), new RegExp(`\\[${ownership}`));
      for (const key of [keys.enter, "x", "n"]) {
        screen.handleInput(key);
        assert.deepEqual(intents, [], `${ownership}/${status}: ${JSON.stringify(key)} must stay in browser`);
        assert.equal(state.selected?.sessionId, "non-owned");
        assert.match(state.error!, new RegExp(ownership === "moved" ? "moved away" : "fenced"));
      }
      assert.equal(renders(), 3);
      screen.handleInput(keys.tab);
      assert.equal(state.tab, ownership === "fenced" && status === "running" ? "closed" : "active");
      screen.handleInput("r");
      assert.deepEqual(intents, [{ action: "refresh" }]);

      const create = component(state);
      create.screen.handleInput("c");
      assert.deepEqual(create.intents, [{ action: "create" }]);
    }
  }
});

test("moved rows are labeled and cannot attach or close; closed rows only return attach or rename intents", () => {
  const state = new RemoteSessionBrowserState();
  state.replaceSessions([summary("moved", { ownership: "moved" }), summary("closed", { status: "closed" })]);
  state.changeTab();
  const { screen, intents } = component(state);
  assert.match(plain(screen.render(100)), /moved - cannot attach/);
  screen.handleInput(keys.enter);
  screen.handleInput("x");
  assert.deepEqual(intents, []);
  assert.match(state.error!, /moved away/);
  screen.handleInput(keys.down);
  screen.handleInput("x");
  assert.deepEqual(intents, []);
  screen.handleInput("n");
  assert.deepEqual(intents, [{ action: "rename", session: state.selected }]);
});

test("dense rendering bounds ANSI/wide text, keeps the shortcut legend, and scrolls to the actual selected session on resize", () => {
  const state = new RemoteSessionBrowserState();
  state.replaceSessions(Array.from({ length: 40 }, (_, index) => summary(`id-${index}`, {
    name: `${index} 中文 e\u0301 very long session name\n\x1b[2J`, cwd: `/work/中文/${"path/".repeat(20)}`,
    isStreaming: index === 1, needsInput: index === 2 ? [{ type: "extension_ui_request", id: "dialog", method: "input", title: "Question" }] : [],
  })));
  const { screen, intents } = component(state, 24);
  for (let index = 0; index < 39; index++) screen.handleInput(keys.down);
  for (const width of [1, 16, 32, 60, 100, 160]) {
    screen.invalidate();
    const lines = screen.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width), `overflow at ${width}`);
    if (width >= 32) {
      const output = plain(lines);
      assert.match(output, /39 中文/);
      assert.match(output, /ID: id-39/);
      for (const shortcut of ["Enter attach", "x close", "n rename", "c Create session", "r refresh", "Esc back"]) {
        assert.ok(output.replace(/\n/g, " ").includes(shortcut), shortcut);
      }
      assert.ok(lines.length <= 24, `height at ${width}`);
    }
    assert.ok(!lines.some(line => line.includes("\x1b[2J")));
  }
  assert.deepEqual(screen.render(0), []);
  screen.handleInput("x");
  assert.equal(intents[0]?.action, "close");
  assert.equal(intents[0] && "session" in intents[0] ? intents[0].session.sessionId : undefined, "id-39");
  const statusView = component(state, 40).screen;
  state.select("id-1");
  assert.match(plain(statusView.render(100)), /\[busy\]/);
  state.select("id-2");
  assert.match(plain(statusView.render(100)), /\[needsInput\]/);
  assert.match(plain(statusView.render(100)), /\[idle\]/);
});

test("short viewports reserve Pi footer space, retain tabs and actions, and scroll multiple rows after resizing", () => {
  for (const [width, height] of [[32, 12], [20, 10], [48, 10], [100, 10], [160, 8]] as const) {
    const state = new RemoteSessionBrowserState();
    state.replaceSessions(Array.from({ length: 12 }, (_, index) => summary(`12345678-1234-4234-8234-${String(index).padStart(12, "0")}`, {
      name: `Row${index} 中文 e\u0301`, cwd: `/work/${"long-path/".repeat(10)}`,
    })).concat(summary("closed", { status: "closed" })));
    const { screen, intents } = component(state, height);
    const checkFrame = (selectedIndex: number, withError = false) => {
      const lines = screen.render(width);
      assert.ok(lines.length <= height - 2, `${width}x${height}: ${lines.length} component lines leave no Pi footer`);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `${width}x${height}: horizontal overflow`);
      const output = plain(lines).replace(/\n/g, " ");
      for (const label of ["Active", "Closed", "Tab", "Enter attach", "x close", "n rename", "c create", "r refresh", "Esc back"]) {
        assert.ok(output.toLowerCase().includes(label.toLowerCase()), `${width}x${height}: missing ${label}`);
      }
      if (!withError) assert.ok(lines.filter(line => /Row\d+/.test(plain([line]))).length >= 2, `${width}x${height}: list collapsed to one row`);
      assert.match(output, new RegExp(`Row${selectedIndex}(?: |$)`));
      assert.ok(output.includes(`(${selectedIndex + 1}/12)`), `${width}x${height}: missing scroll position`);
    };
    checkFrame(0);
    for (let index = 0; index < 11; index++) {
      screen.handleInput(keys.down);
      checkFrame(index + 1);
    }
    assert.equal(state.selected?.sessionId, "12345678-1234-4234-8234-000000000011");
    screen.render(100);
    screen.invalidate();
    checkFrame(11);
    state.error = "Refresh failed: a very long message about the remote host. Press r to retry.";
    checkFrame(11, true);
    screen.handleInput(keys.up);
    checkFrame(10, true);
    screen.handleInput(keys.enter);
    assert.deepEqual(intents, [{ action: "attach", session: state.sessions[10] }]);
  }
});

test("empty, loading, and single-session layouts fit short viewports without hiding tabs or action legends", () => {
  for (const [width, height] of [[32, 12], [20, 10], [100, 8]] as const) {
    for (const variant of ["empty", "loading", "active", "closed"] as const) {
      const state = new RemoteSessionBrowserState();
      if (variant === "active" || variant === "closed") {
        state.replaceSessions([summary("12345678-1234-4234-8234-123456789abc", { name: "Solo", status: variant === "closed" ? "closed" : "running" })]);
      }
      if (variant === "closed") state.changeTab();
      const { screen } = component(state, height, { cwd: "/workspace", loading: variant === "loading" ? "Loading sessions..." : undefined });
      const lines = screen.render(width);
      const output = plain(lines).replace(/\n/g, " ");
      assert.ok(lines.length <= height - 2, `${variant} at ${width}x${height}: vertical overflow`);
      assert.ok(lines.every(line => visibleWidth(line) <= width), `${variant} at ${width}x${height}: horizontal overflow`);
      for (const label of ["Active", "Closed", "Tab", "Enter attach", "x close", "n rename", "c create", "r refresh", "Esc back"]) {
        assert.ok(output.toLowerCase().includes(label.toLowerCase()), `${variant} at ${width}x${height}: missing ${label}`);
      }
      assert.match(output, variant === "empty" ? /No active sessions/ : variant === "loading" ? /Loading sessions/ : /Solo/);
    }
  }
});

test("empty and loading screens retain create/escape affordances; disposed screens ignore further input", () => {
  const state = new RemoteSessionBrowserState();
  const { screen, intents } = component(state);
  assert.match(plain(screen.render(80)), /No active sessions/);
  screen.handleInput("x"); screen.handleInput("n"); screen.handleInput(keys.enter);
  assert.deepEqual(intents, []);
  screen.handleInput("c");
  assert.deepEqual(intents, [{ action: "create" }]);
  const disposed = component(state);
  disposed.screen.dispose(); disposed.screen.handleInput("c");
  assert.deepEqual(disposed.intents, []);
});

type Screen = Component & { dispose?(): void };
type Step = (screen: Screen) => void;

function scriptedUI(steps: Step[], options: { input?: () => Promise<string | undefined>; confirm?: () => Promise<boolean>; loading?: Step } = {}) {
  let active = false;
  let mounts = 0;
  const frames: string[] = [];
  const custom: ExtensionUIContext["custom"] = factory => new Promise((resolve, reject) => {
    assert.equal(active, false, "custom screens must not overlap");
    active = true;
    mounts++;
    let screen: Screen;
    const finish = (value: Parameters<Parameters<typeof factory>[3]>[0]) => {
      assert.equal(active, true, "done called twice or after disposal");
      active = false;
      screen.dispose?.();
      resolve(value);
    };
    const tui = { requestRender() {}, terminal: { rows: 40 } } as unknown as TUI;
    const created = factory(tui, theme, {} as Parameters<typeof factory>[2], finish);
    assert.ok(!("then" in created), "browser factory should be synchronous");
    screen = created;
    const output = plain(screen.render(100));
    frames.push(output);
    queueMicrotask(() => {
      try {
        if (/Loading sessions|Closing session|Renaming session/.test(output)) options.loading?.(screen);
        else {
          const step = steps.shift();
          assert.ok(step, `unexpected browser mount:\n${output}`);
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
    input: async () => { assert.equal(active, false, "input nested inside custom"); return options.input?.(); },
    confirm: async () => { assert.equal(active, false, "confirm nested inside custom"); return await options.confirm?.() ?? false; },
  } as unknown as ExtensionUIContext;
  return { ui, frames, mounts: () => mounts, remaining: () => steps.length };
}

function send(...data: string[]): Step { return screen => { for (const key of data) screen.handleInput?.(key); }; }

async function wireDaemon(t: TestContext, respond: (command: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const root = mkdtempSync("/tmp/pbs-browser-");
  const sockets = new Set<Socket>();
  const commands: Record<string, unknown>[] = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    const decoder = new LineDecoder(line => {
      const { id, ...command } = JSON.parse(line);
      commands.push(command);
      void Promise.resolve(respond(command)).then(response => {
        if (!socket.destroyed) socket.write(encodeLine({ id, type: "response", command: command.type, success: true, ...response }));
      });
    }, () => socket.destroy());
    socket.on("data", (data: string) => decoder.push(data));
    socket.on("close", () => sockets.delete(socket));
  });
  const path = join(root, "daemon.sock");
  await new Promise<void>(resolve => server.listen(path, resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const client = await DaemonClient.connect(path, { hello: false });
  t.after(() => client.close());
  return { client, commands };
}

test("rename uses the new daemon command with the selected ID, trims names, refreshes, and never opens a closed session", async t => {
  let sessions = [summary("first", { status: "closed" }), summary("second", { status: "closed" })];
  const { client, commands } = await wireDaemon(t, command => {
    if (command.type === "list_sessions") return { data: { sessions } };
    assert.deepEqual(command, { type: "rename_session", sessionId: "second", name: "New name" });
    sessions = [sessions[1]!, sessions[0]!].map(s => s.sessionId === "second" ? { ...s, name: "New name" } : s);
    return {};
  });
  const ui = scriptedUI([send(keys.tab, keys.down, "n"), screen => {
    assert.match(plain(screen.render(100)), /New name/);
    screen.handleInput?.(keys.enter);
  }], { input: async () => "  New name  " });
  const result = await browseRemoteSessions(ui.ui, client, "test-host");
  assert.equal(result?.action, "attach");
  assert.equal(result && "session" in result ? result.session.sessionId : undefined, "second");
  assert.equal(result && "session" in result ? result.session.status : undefined, "closed");
  assert.deepEqual(commands.map(c => c.type), ["list_sessions", "rename_session", "list_sessions"]);
  assert.equal(ui.remaining(), 0);
});

test("close confirms busy and needsInput sessions outside custom; cancellation preserves selection and makes no mutation", async t => {
  const sessions = [summary("busy", { isStreaming: true }), summary("waiting", { needsInput: [{ type: "extension_ui_request", id: "d", method: "input", title: "Question" }] })];
  const { client, commands } = await wireDaemon(t, command => {
    if (command.type === "list_sessions") return { data: { sessions } };
    assert.equal(command.sessionId, "waiting");
    sessions.splice(1, 1);
    return {};
  });
  let confirmations = 0;
  const ui = scriptedUI([send("x"), send(keys.down, "x"), send(keys.escape)], {
    confirm: async () => ++confirmations === 2,
  });
  assert.equal(await browseRemoteSessions(ui.ui, client, "host"), undefined);
  assert.equal(confirmations, 2);
  assert.deepEqual(commands, [{ type: "list_sessions" }, { type: "close_session", sessionId: "waiting" }, { type: "list_sessions" }]);
});

test("close and rename failures stay in the browser with retry guidance and refresh server state", async t => {
  for (const action of ["x", "n"]) {
    const { client, commands } = await wireDaemon(t, command => command.type === "list_sessions"
      ? { data: { sessions: [summary("selected")] } }
      : { success: false, error: "permission denied" });
    const ui = scriptedUI([send(action), screen => {
      const output = plain(screen.render(100));
      assert.match(output, /permission denied/);
      assert.match(output, /retry or r to refresh/);
      assert.match(output, /ID: selected/);
      screen.handleInput?.(keys.escape);
    }], { input: async () => "Renamed" });
    assert.equal(await browseRemoteSessions(ui.ui, client, "host"), undefined);
    assert.deepEqual(commands.map(c => c.type), ["list_sessions", action === "x" ? "close_session" : "rename_session", "list_sessions"]);
  }
});

test("refresh failures can be retried and an empty server can return create without creating anything", async t => {
  let lists = 0;
  const { client, commands } = await wireDaemon(t, () => ++lists === 1
    ? { success: false, error: "temporary failure" }
    : { data: { sessions: [] } });
  const ui = scriptedUI([screen => {
    assert.match(plain(screen.render(100)), /Refresh failed: temporary failure/);
    screen.handleInput?.("r");
  }, screen => {
    const output = plain(screen.render(100));
    assert.doesNotMatch(output, /Refresh failed/);
    assert.match(output, /cwd: \/workspace/);
    screen.handleInput?.("c");
  }]);
  assert.deepEqual(await browseRemoteSessions(ui.ui, client, "host", { cwd: "/workspace" }), { action: "create" });
  assert.deepEqual(commands, [{ type: "list_sessions" }, { type: "list_sessions" }]);
});

test("cancelled or blank rename sends no mutation and leaves the selected closed row available", async t => {
  const { client, commands } = await wireDaemon(t, () => ({ data: { sessions: [summary("closed", { status: "closed" })] } }));
  let inputs = 0;
  const ui = scriptedUI([send(keys.tab, "n"), send("n"), screen => {
    assert.match(plain(screen.render(100)), /Name cannot be empty/);
    screen.handleInput?.(keys.enter);
  }], { input: async () => ++inputs === 1 ? undefined : "   " });
  const result = await browseRemoteSessions(ui.ui, client, "host");
  assert.equal(result && "session" in result ? result.session.sessionId : undefined, "closed");
  assert.deepEqual(commands, [{ type: "list_sessions" }]);
});

test("Escape leaves a pending loading screen; late completion cannot finish or render a disposed screen", async t => {
  let release!: (value: Record<string, unknown>) => void;
  const pending = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
  const { client } = await wireDaemon(t, () => pending);
  const ui = scriptedUI([], { loading: send("c", keys.escape) });
  assert.equal(await browseRemoteSessions(ui.ui, client, "host"), undefined);
  release({ data: { sessions: [] } });
  // A following real socket round trip drains the earlier response without sleeps.
  await client.call({ type: "list_sessions" });
  assert.equal(ui.mounts(), 1);
});

test("transport rejection stays in the browser with retry guidance and an Escape path", async t => {
  const { client, commands } = await wireDaemon(t, () => ({ data: { sessions: [] } }));
  await new Promise<void>(resolve => {
    const unsubscribe = client.onClose(() => { unsubscribe(); resolve(); });
    client.close();
  });
  const ui = scriptedUI([screen => {
    const output = plain(screen.render(100));
    assert.match(output, /Refresh failed: connection closed/);
    assert.match(output, /Press r to retry/);
    screen.handleInput?.(keys.escape);
  }]);
  assert.equal(await browseRemoteSessions(ui.ui, client, "host"), undefined);
  assert.deepEqual(commands, []);
});

test("real daemon: close and rename the selected duplicate-name session, then return closed attach without reopening", async t => {
  const env = makeEnv();
  const oldEnv = { ...process.env };
  Object.assign(process.env, env.vars);
  t.after(() => { for (const key of Object.keys(env.vars)) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; } });
  const daemon = await startDaemon({ serverDir: env.serverDir });
  t.after(() => daemon.stop());
  const client = await DaemonClient.connect(daemon.socketPath);
  t.after(() => client.close());
  const first = await client.call({ type: "create_session", cwd: env.cwd, name: "Duplicate" });
  const second = await client.call({ type: "create_session", cwd: env.cwd, name: "Duplicate" });
  const target = daemon.registry.list()[1]!;
  const other = target.sessionId === first.sessionId ? second.sessionId : first.sessionId;
  const ui = scriptedUI([send(keys.down, "x"), screen => {
    screen.handleInput?.(keys.tab);
    assert.match(plain(screen.render(100)), /\[closed\] Duplicate/);
    screen.handleInput?.("n");
  }, screen => {
    assert.match(plain(screen.render(100)), /\[closed\] Renamed closed/);
    screen.handleInput?.(keys.enter);
  }], {
    confirm: async () => { assert.fail("idle close must not prompt"); },
    input: async () => {
      assert.equal(daemon.registry.get(target.sessionId), undefined, "rename starts with no hosted backend");
      return "Renamed closed";
    },
  });
  const result = await browseRemoteSessions(ui.ui, client, "local-daemon");
  assert.equal(result && "session" in result ? result.session.sessionId : undefined, target.sessionId);
  assert.equal(daemon.registry.entry(target.sessionId)?.status, "closed");
  assert.equal(daemon.registry.list().find(session => session.sessionId === target.sessionId)?.name, "Renamed closed");
  assert.equal(daemon.registry.get(target.sessionId), undefined);
  assert.equal(daemon.registry.entry(other as string)?.status, "running");
});
