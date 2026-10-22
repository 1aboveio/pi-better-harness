import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/client.ts";
import type { SessionSummary } from "../src/protocol.ts";
import { SessionRegistry } from "../src/registry.ts";
import { checkedRemoteWorkspace, chooseConnectionTransfer, chooseRemoteConnection, chooseRemoteSession, parseRemoteArgs } from "../src/remote-client/extension.ts";
import { NativeClientHost } from "../src/remote-client/host.ts";

test("remote command accepts an SSH alias and explicit remote connection selectors", () => {
  assert.equal(parseRemoteArgs("r5").host, "r5");
  assert.equal(parseRemoteArgs("connect r5").host, "r5");
  assert.deepEqual(parseRemoteArgs("r5 --cwd /home/user/workspaces/project --session selected --remote-dir /home/user/server"), {
    host: "r5", cwd: "/home/user/workspaces/project", sessionId: "selected", remoteDir: "/home/user/server",
  });
  for (const input of ["", "connect", "r5 r6", "r5 --unknown", "r5 --cwd"]) assert.throws(() => parseRemoteArgs(input));
});

test("an explicit remote workspace cannot silently attach a session belonging to another project", () => {
  assert.equal(checkedRemoteWorkspace(undefined, "/remote/actual"), "/remote/actual");
  assert.equal(checkedRemoteWorkspace("/remote/actual", "/remote/actual"), "/remote/actual");
  assert.throws(() => checkedRemoteWorkspace("/remote/expected", "/remote/actual"), /workspace is \/remote\/actual, not the requested \/remote\/expected/);
});

test("list selection asks for connection approval and cancellation never requests a connection", async () => {
  const confirmations: string[] = [];
  const ui = {
    select: async () => "r5", input: async () => undefined, notify: () => {},
    confirm: async (title: string) => { confirmations.push(title); return true; },
  };
  assert.equal((await chooseRemoteConnection("list", ui, ["r5"]))?.host, "r5");
  assert.deepEqual(confirmations, ["Connect to r5?"]);
  assert.equal(await chooseRemoteConnection("list", { ...ui, confirm: async () => false }, ["r5"]), undefined);
  const before = confirmations.length;
  assert.equal(await chooseRemoteConnection("list", { ...ui, select: async () => undefined }, ["r5"]), undefined);
  assert.equal(confirmations.length, before);
});

test("connect without a host opens selection and explicit connect bypasses selection", async () => {
  let selections = 0;
  const ui = {
    select: async () => { selections++; return "Connect to r5"; },
    input: async () => undefined, notify: () => {}, confirm: async () => { throw new Error("Unexpected confirmation"); },
  };
  assert.equal((await chooseRemoteConnection("connect", ui, ["r5"]))?.host, "r5");
  assert.equal(selections, 1);
  assert.equal((await chooseRemoteConnection("connect r6", ui, ["r5"]))?.host, "r6");
  assert.equal(selections, 1);
});

test("connection transfer offers browse, move, and copy; browsing skips scope selection", async () => {
  const prompts: Array<{ title: string; options: string[] }> = [];
  const result = await chooseConnectionTransfer({ select: async (title, options) => {
    prompts.push({ title, options: [...options] });
    return "Browse remote sessions";
  } });
  assert.equal(result, "browse");
  assert.equal(prompts.length, 1, "browsing must not ask for transfer scope");
  assert.deepEqual(prompts[0]?.options, ["Browse remote sessions", "Move current session here", "Copy current session here"]);
});

test("connection transfer cancellation at either prompt returns no transfer decision", async () => {
  for (const mode of [undefined, "Move current session here", "Copy current session here"]) {
    let selections = 0;
    const result = await chooseConnectionTransfer({ select: async () => ++selections === 1 ? mode : undefined });
    assert.equal(result, undefined);
    assert.equal(selections, mode === undefined ? 1 : 2);
  }
});

test("connection transfer preserves copy versus handoff and defaults to conversation-only scope", async () => {
  for (const [mode, copy] of [["Move current session here", false], ["Copy current session here", true]] as const) {
    for (const [scope, includeWorkspace] of [["Conversation only", false], ["Conversation and workspace files", true]] as const) {
      let selections = 0;
      const result = await chooseConnectionTransfer({ select: async (_title, options) => {
        if (++selections === 1) return mode;
        assert.deepEqual(options, ["Conversation only", "Conversation and workspace files"], "conversation only is the default scope");
        return scope;
      } });
      assert.deepEqual(result, { copy, includeWorkspace }, `${mode}: ${scope}`);
      assert.equal(selections, 2);
    }
  }
});

test("connection transfer refuses unrecognized selections instead of authorizing a transfer", async () => {
  await assert.rejects(chooseConnectionTransfer({ select: async () => "push" }), /Unknown connection action/);
  let selections = 0;
  await assert.rejects(chooseConnectionTransfer({ select: async () => ++selections === 1 ? "Move current session here" : "Everything" }), /Unknown transfer scope/);
});

test("a chosen transfer intent asks only for scope and still permits cancellation or rejects unknown scope", async () => {
  for (const copy of [false, true]) {
    for (const scope of [undefined, "Everything"]) {
      const prompts: string[] = [];
      const decision = chooseConnectionTransfer({ select: async (title, options) => {
        prompts.push(title);
        assert.deepEqual(options, ["Conversation only", "Conversation and workspace files"]);
        return scope;
      } }, copy);
      if (scope === undefined) assert.equal(await decision, undefined);
      else await assert.rejects(decision, /Unknown transfer scope/);
      assert.deepEqual(prompts, ["Transfer scope"], "The landing intent must skip the legacy mode menu");
    }
  }
});

function remoteSession(status: "running" | "closed" = "running"): SessionSummary {
  return {
    sessionId: "older-session", cwd: "/outside/default-root/project", name: "Older project", sessionFile: "/sessions/older.jsonl",
    status, live: status === "running", isStreaming: false, lastSeq: 0, hasController: false, needsInput: [],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

type Screen = Component & { dispose?(): void };
type Step = (screen: Screen) => void;
const send = (...keys: string[]): Step => screen => { for (const key of keys) screen.handleInput?.(key); };
const keys = { down: "\x1b[B", enter: "\r", escape: "\x1b", tab: "\t" };

function folderUI(steps: Step[], options: {
  input?: ExtensionUIContext["input"];
  select?: ExtensionUIContext["select"];
  progress?: (screen: Screen, output: string) => void;
} = {}) {
  const frames: string[] = [];
  const progress: string[] = [];
  let active = false;
  const custom: ExtensionUIContext["custom"] = factory => new Promise((resolve, reject) => {
    assert.equal(active, false, "Custom screens must not overlap");
    active = true;
    let screen: Screen;
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    const created = factory({ requestRender() {
      if (screen) frames.push(screen.render(240).join("\n"));
    }, terminal: { rows: 40 } } as unknown as TUI, theme, {} as Parameters<typeof factory>[2], value => {
      assert.equal(active, true, "A screen must finish only once");
      active = false;
      screen.dispose?.();
      resolve(value);
    });
    assert.ok(!("then" in created));
    screen = created;
    const output = screen.render(240).join("\n");
    frames.push(output);
    queueMicrotask(() => {
      try {
        if (/(?:Loading (?:remote (?:browser|folders)|sessions)|Finding remote session|Creating remote folder)\.\.\./.test(output)) {
          progress.push(output);
          options.progress?.(screen, output);
        } else {
          const step = steps.shift();
          assert.ok(step, `Unexpected browser interaction:\n${output}`);
          step(screen);
          assert.equal(active, false, "Each scripted interaction must close its screen");
        }
      } catch (error) {
        active = false;
        screen.dispose?.();
        reject(error);
      }
    });
  });
  const ui = {
    select: async (...args: Parameters<ExtensionUIContext["select"]>) => {
      assert.equal(active, false, "Selection prompts must be outside custom screens");
      assert.ok(options.select, "Unexpected selection prompt");
      return options.select(...args);
    },
    input: async (...args: Parameters<ExtensionUIContext["input"]>) => {
      assert.equal(active, false, "Input prompts must be outside custom screens");
      assert.ok(options.input, "Unexpected workspace input");
      return options.input(...args);
    },
    custom,
  } as unknown as ExtensionUIContext;
  return { ui, frames, progress, assertComplete() {
    assert.equal(steps.length, 0, "All scripted interactions must run");
    assert.equal(active, false, "The final screen must be disposed");
  } };
}

function folderClient(root: unknown, sessions: SessionSummary[] = []) {
  const commands: Record<string, unknown>[] = [];
  const client = {
    call: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "client_workspaces") return { data: { root, workspaces: [{ path: "/not-the-default/child" }] } };
      if (command.type === "list_sessions") return { data: { sessions } };
      if (command.type === "client_browse_directory") {
        const path = command.path as string;
        return { data: { path, parent: path === "/" ? null : posix.dirname(path), directories: [] } };
      }
      assert.fail(`Unexpected command: ${command.type}`);
    },
  } as unknown as DaemonClient;
  return { client, commands };
}

function nativeFolderClient(t: TestContext, createRoot = true) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "remote-root-")));
  const root = join(temp, "workspaces");
  if (createRoot) mkdirSync(root);
  const previous = process.env.PI_SERVER_WORKSPACES_DIR;
  process.env.PI_SERVER_WORKSPACES_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SERVER_WORKSPACES_DIR;
    else process.env.PI_SERVER_WORKSPACES_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  });
  const registry = new SessionRegistry({ serverDir: temp });
  const host = new NativeClientHost(registry);
  const commands: Record<string, unknown>[] = [];
  const client = { call: async (command: Record<string, unknown>) => {
    commands.push(command);
    return { data: command.type === "list_sessions" ? { sessions: registry.list() } : await host.handle(command) };
  } } as unknown as DaemonClient;
  return { client, commands, root, registry };
}

test("browser n starts the native folder picker at the daemon root, not a child workspace or local path", async () => {
  for (const root of ["/srv/configured-workspaces", "/home/remote-user/workspaces", "/"]) {
    const { client, commands } = folderClient(root);
    const ui = folderUI([send("n"), send("s")]);
    assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", {}), { action: "create", cwd: root });
    ui.assertComplete();
    assert.ok(ui.frames.some(frame => frame.includes(`Folder: ${root}`)), "The picker shows its remote context");
    for (const message of ["Loading remote browser...", "Loading sessions...", "Loading remote folders..."]) {
      assert.ok(ui.progress.some(frame => frame.includes(message)), `Missing progress: ${message}`);
    }
    assert.deepEqual(commands, [{ type: "client_workspaces" }, { type: "list_sessions" }, { type: "client_browse_directory", path: root }]);
  }
});

test("an older daemon retains existing-session access and gives update guidance instead of sending folder commands", async () => {
  const session = remoteSession();
  const { client, commands } = folderClient("/work", [session]);
  Object.defineProperty(client, "server", { value: { capabilities: ["native-client-v1", "session-browser-v1"] } });
  const ui = folderUI([send("n"), send(keys.enter)]);
  const notices: string[] = [];
  ui.ui.notify = message => { notices.push(message); };
  assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", {}), {
    action: "attach", cwd: session.cwd, sessionId: session.sessionId,
  });
  assert.ok(notices.some(message => message.includes("Update pi-better-server")));
  assert.deepEqual(commands, [{ type: "client_workspaces" }, { type: "list_sessions" }]);
  ui.assertComplete();
});

test("browser n opens an existing child with Enter and selects its cwd only with s", async t => {
  const { client, commands, root, registry } = nativeFolderClient(t);
  const child = join(root, "existing-project");
  mkdirSync(child);
  for (const options of [{}, { cwd: root }]) {
    commands.length = 0;
    const ui = folderUI([send("n"), send(keys.down, keys.enter), screen => {
      assert.match(screen.render(240).join("\n"), /Folder: .*\/existing-project/);
      screen.handleInput?.("s");
    }]);
    assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", options), { action: "create", cwd: child });
    ui.assertComplete();
    assert.deepEqual(commands, [
      ...("cwd" in options ? [] : [{ type: "client_workspaces" }]),
      { type: "list_sessions" },
      { type: "client_browse_directory", path: root },
      { type: "client_browse_directory", path: child },
    ], "Enter browses before s selects; explicit cwd only changes the starting context");
    assert.deepEqual(readdirSync(root), ["existing-project"]);
    assert.deepEqual(readdirSync(child), []);
    assert.deepEqual(registry.list(), [], "Choosing a folder must not create or open a session");
  }
});

test("browser n can create a named child folder and select it without starting a session", async t => {
  const { client, commands, root, registry } = nativeFolderClient(t);
  const child = join(root, "new-project");
  const inputs: string[] = [];
  const ui = folderUI([send("n"), send("n"), send("s")], {
    input: async title => { inputs.push(title); return "new-project"; },
    progress: (screen, output) => {
      if (output.includes("Creating remote folder...")) {
        assert.match(output, /Waiting for the remote operation to finish/);
        screen.handleInput?.(keys.escape);
      }
    },
  });
  assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", {}), { action: "create", cwd: child });
  ui.assertComplete();
  assert.deepEqual(inputs, [`New folder in ${root}`]);
  assert.deepEqual(readdirSync(root), ["new-project"]);
  assert.deepEqual(readdirSync(child), []);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(commands, [
    { type: "client_workspaces" }, { type: "list_sessions" },
    { type: "client_browse_directory", path: root },
    { type: "client_create_directory", path: root, name: "new-project" },
    { type: "client_browse_directory", path: child },
  ]);
  assert.equal(ui.progress.filter(frame => frame.includes("Creating remote folder...")).length, 1);
  assert.equal(ui.progress.filter(frame => frame.includes("Loading remote folders...")).length, 2);
});

test("cancelling a new, move or copy folder picker returns to the same selected session and tab", async () => {
  for (const status of ["running", "closed"] as const) {
    for (const intent of ["n", "m", "c"]) {
      const first = remoteSession(status);
      const selected = { ...first, sessionId: "second-session", name: "Selected project", cwd: "/outside/second" };
      const { client, commands } = folderClient("/srv/workspaces", [first, selected]);
      const ui = folderUI([
        send(...(status === "closed" ? [keys.tab] : []), keys.down, intent),
        send(keys.escape),
        send(keys.enter),
      ]);
      assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", { allowTransfer: true }), {
        action: "attach", cwd: selected.cwd, sessionId: selected.sessionId,
      }, `${status}: ${intent}`);
      ui.assertComplete();
      assert.deepEqual(commands, [
        { type: "client_workspaces" }, { type: "list_sessions" }, { type: "client_browse_directory", path: "/srv/workspaces" },
      ], "Cancelling a picker must not restart discovery, refresh sessions or mutate anything");
    }
  }
});

test("landing ignores move and copy unless transfers are allowed", async () => {
  for (const allowTransfer of [undefined, false]) {
    const session = remoteSession();
    const { client, commands } = folderClient("/srv/workspaces", [session]);
    const ui = folderUI([send("m", "c", keys.enter)]);
    assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", { allowTransfer }), {
      action: "attach", cwd: session.cwd, sessionId: session.sessionId,
    });
    ui.assertComplete();
    assert.deepEqual(commands, [{ type: "client_workspaces" }, { type: "list_sessions" }]);
  }
});

test("landing move and copy choose a destination before asking only for the chosen intent's scope", async t => {
  const { client, commands, root, registry } = nativeFolderClient(t);
  const child = join(root, "destination");
  mkdirSync(child);
  for (const [key, copy] of [["m", false], ["c", true]] as const) {
    for (const [scope, includeWorkspace] of [["Conversation only", false], ["Conversation and workspace files", true]] as const) {
      commands.length = 0;
      const prompts: string[] = [];
      const ui = folderUI([send(key), send(keys.down, keys.enter), send("s")], {
        select: async (title, options) => {
          prompts.push(title);
          assert.deepEqual(options, ["Conversation only", "Conversation and workspace files"]);
          return scope;
        },
      });
      const choice = await chooseRemoteSession(client, ui.ui, "host", { allowTransfer: true });
      assert.deepEqual(choice, { action: "transfer", copy, cwd: child });
      assert.deepEqual(prompts, [], "Landing and folder selection must not automatically ask for transfer scope");
      if (choice?.action !== "transfer") assert.fail("Expected a transfer intent");
      assert.deepEqual(await chooseConnectionTransfer(ui.ui, choice.copy), { copy, includeWorkspace });
      assert.deepEqual(prompts, ["Transfer scope"], "The selected intent skips Browse/Move/Copy selection");
      ui.assertComplete();
      assert.deepEqual(commands, [
        { type: "client_workspaces" }, { type: "list_sessions" },
        { type: "client_browse_directory", path: root }, { type: "client_browse_directory", path: child },
      ], "Choosing intent and scope must not execute a transfer");
      assert.deepEqual(registry.list(), []);
      assert.deepEqual(readdirSync(root), ["destination"]);
      assert.deepEqual(readdirSync(child), []);
    }
  }
});

test("cancelling discovery, session resolution, session loading or folder loading ignores late reads without writes", async () => {
  for (const stage of [
    { message: "Loading remote browser...", type: "client_workspaces", options: {}, steps: [], data: { root: "/srv/workspaces" } },
    { message: "Finding remote session...", type: "list_sessions", options: { sessionId: "older" }, steps: [], data: { sessions: [remoteSession()] } },
    { message: "Loading sessions...", type: "list_sessions", options: {}, steps: [], data: { sessions: [remoteSession()] } },
    { message: "Loading remote folders...", type: "client_browse_directory", options: {}, steps: [send("n"), send(keys.escape)],
      data: { path: "/srv/workspaces", parent: "/srv", directories: [] } },
  ]) {
    let finishRead!: (value: { data: unknown }) => void;
    const pending = new Promise<{ data: unknown }>(resolve => { finishRead = resolve; });
    const commands: Record<string, unknown>[] = [];
    const client = { call: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === stage.type) return pending;
      if (command.type === "client_workspaces") return { data: { root: "/srv/workspaces" } };
      if (command.type === "list_sessions") return { data: { sessions: [remoteSession()] } };
      assert.fail(`Unexpected command: ${command.type}`);
    } } as unknown as DaemonClient;
    let cancellations = 0;
    const ui = folderUI(stage.steps, { progress: (screen, output) => {
      if (output.includes(stage.message)) { cancellations++; screen.handleInput?.(keys.escape); }
    } });
    assert.equal(await chooseRemoteSession(client, ui.ui, "host", { ...stage.options, allowTransfer: true }), undefined);
    ui.assertComplete();
    assert.equal(cancellations, 1, stage.message);
    const expected = stage.message === "Loading remote browser..." ? [{ type: "client_workspaces" }]
      : stage.message === "Finding remote session..." ? [{ type: "list_sessions" }]
      : [{ type: "client_workspaces" }, { type: "list_sessions" },
        ...(stage.type === "client_browse_directory" ? [{ type: stage.type, path: "/srv/workspaces" }] : [])];
    assert.deepEqual(commands, expected);
    const framesBeforeReply = [...ui.frames];
    finishRead({ data: stage.data });
    await pending;
    // Drain promise continuations for the dismissed loader, without a timer.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(commands, expected, "Late completion must not attach, create or transfer");
    assert.deepEqual(ui.frames, framesBeforeReply, "Late completion must not mount another screen");
    ui.assertComplete();
  }
});

test("browser attach and a fresh sessions browse retain existing cwd outside the default root in either tab", async () => {
  for (const status of ["running", "closed"] as const) {
    const session = remoteSession(status);
    const { client, commands } = folderClient("/srv/workspaces", [session]);
    // Re-entering /remote sessions starts another browse with no explicit cwd.
    for (let visit = 0; visit < 2; visit++) {
      const ui = folderUI([send(...(status === "closed" ? [keys.tab, keys.enter] : [keys.enter]))]);
      assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", { allowTransfer: true }), {
        action: "attach", cwd: session.cwd, sessionId: session.sessionId,
      });
      ui.assertComplete();
      assert.ok(ui.frames.some(frame => frame.includes(session.cwd)), "Existing outside-root sessions remain visible");
    }
    assert.deepEqual(commands, [
      { type: "client_workspaces" }, { type: "list_sessions" },
      { type: "client_workspaces" }, { type: "list_sessions" },
    ], "Creation context must never become a list filter or force a transfer prompt");
  }
});

test("direct session attach shows progress but bypasses landing and root discovery, preserving explicit cwd constraints", async () => {
  const session = remoteSession();
  const { client, commands } = folderClient("invalid-root-that-must-not-be-read", [session]);
  const ui = folderUI([]);
  assert.deepEqual(await chooseRemoteSession(client, ui.ui, "host", { sessionId: "older", allowTransfer: true }), {
    action: "attach", cwd: session.cwd, sessionId: session.sessionId,
  });
  await assert.rejects(chooseRemoteSession(client, ui.ui, "host", { sessionId: "older", cwd: "/explicit/other" }), /not the requested \/explicit\/other/);
  ui.assertComplete();
  assert.deepEqual(commands, [{ type: "list_sessions" }, { type: "list_sessions" }]);
  assert.equal(ui.frames.length, 2);
  assert.deepEqual(ui.frames, ui.progress, "Direct resolution never mounts landing or picker screens");
  assert.ok(ui.progress.every(frame => frame.includes("Finding remote session...")));
});

test("explicit cwd starts the folder picker there but still rejects a mismatching browser selection", async () => {
  const session = remoteSession();
  const { client, commands } = folderClient(undefined, [session]);
  const cwd = "/explicit/workspace";
  const create = folderUI([send("n"), send("s")]);
  assert.deepEqual(await chooseRemoteSession(client, create.ui, "host", { cwd }), { action: "create", cwd });
  create.assertComplete();
  const mismatch = folderUI([send(keys.enter)]);
  await assert.rejects(chooseRemoteSession(client, mismatch.ui, "host", { cwd }), /not the requested \/explicit\/workspace/);
  mismatch.assertComplete();
  const attach = folderUI([send(keys.enter)]);
  assert.deepEqual(await chooseRemoteSession(client, attach.ui, "host", { cwd: session.cwd }), {
    action: "attach", cwd: session.cwd, sessionId: session.sessionId,
  });
  attach.assertComplete();
  assert.deepEqual(commands, [
    { type: "list_sessions" }, { type: "client_browse_directory", path: cwd }, { type: "list_sessions" }, { type: "list_sessions" },
  ]);
});

test("malformed daemon roots fail after discovery progress and before opening a browser; landing cancellation makes no mutation", async () => {
  for (const root of [undefined, null, 12, {}, "", "relative/path", "~/workspaces", "C:\\workspaces"]) {
    const { client, commands } = folderClient(root);
    const ui = folderUI([]);
    await assert.rejects(chooseRemoteSession(client, ui.ui, "host", {}), /server workspace root must be an absolute remote path/);
    ui.assertComplete();
    assert.equal(ui.frames.length, 1);
    assert.deepEqual(ui.frames, ui.progress);
    assert.match(ui.progress[0]!, /Loading remote browser\.\.\./);
    assert.deepEqual(commands, [{ type: "client_workspaces" }]);
  }
  const { client, commands } = folderClient("/srv/workspaces");
  const ui = folderUI([send(keys.escape)]);
  assert.equal(await chooseRemoteSession(client, ui.ui, "host", {}), undefined);
  ui.assertComplete();
  assert.deepEqual(commands, [{ type: "client_workspaces" }, { type: "list_sessions" }]);
});

test("a missing host root is discoverable but neither the picker nor package preflight creates it", async t => {
  const { client, commands, root, registry } = nativeFolderClient(t, false);
  const ui = folderUI([send("n"), screen => {
    assert.match(screen.render(120).join("\n"), /List failed:.*ENOENT/);
    send("s", "n", keys.escape)(screen);
  }, send(keys.escape)]);
  assert.equal(await chooseRemoteSession(client, ui.ui, "host", {}), undefined);
  ui.assertComplete();
  assert.deepEqual(commands, [
    { type: "client_workspaces" }, { type: "list_sessions" }, { type: "client_browse_directory", path: root },
  ]);
  await assert.rejects(client.call({ type: "client_packages", cwd: root }), error => {
    assert.match((error as Error).message, /ENOENT/);
    assert.ok((error as Error).message.includes(root), "Failure identifies the missing remote root");
    return true;
  });
  assert.equal(existsSync(root), false);
  assert.deepEqual(registry.list(), []);
});