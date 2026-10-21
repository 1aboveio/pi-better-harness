import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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

function remoteSession(status: "running" | "closed" = "running"): SessionSummary {
  return {
    sessionId: "older-session", cwd: "/outside/default-root/project", name: "Older project", sessionFile: "/sessions/older.jsonl",
    status, live: status === "running", isStreaming: false, lastSeq: 0, hasController: false, needsInput: [],
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  };
}

function folderUI(keys: string[]) {
  const frames: string[] = [];
  const ui = {
    select: async () => assert.fail("Workspace picker must not open"),
    input: async () => assert.fail("Workspace input must not open"),
    custom: (factory => new Promise((resolve, reject) => {
      let screen: Component & { dispose?(): void };
      const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
      const created = factory({ requestRender() {}, terminal: { rows: 40 } } as unknown as TUI, theme, {} as Parameters<typeof factory>[2], value => {
        screen.dispose?.();
        resolve(value);
      });
      assert.ok(!("then" in created));
      screen = created;
      const output = screen.render(120).join("\n");
      frames.push(output);
      if (!output.includes("Loading sessions...")) queueMicrotask(() => {
        try {
          const input = keys.splice(0);
          assert.ok(input.length, "Unexpected browser interaction");
          for (const key of input) screen.handleInput?.(key);
        } catch (error) { screen.dispose?.(); reject(error); }
      });
    })) as ExtensionUIContext["custom"],
  } as unknown as ExtensionUIContext;
  return { ui, frames };
}

function folderClient(root: unknown, sessions: SessionSummary[] = []) {
  const commands: Record<string, unknown>[] = [];
  const client = {
    call: async (command: Record<string, unknown>) => {
      commands.push(command);
      if (command.type === "client_workspaces") return { data: { root, workspaces: [{ path: "/not-the-default/child" }] } };
      if (command.type === "list_sessions") return { data: { sessions } };
      assert.fail(`Unexpected command: ${command.type}`);
    },
  } as unknown as DaemonClient;
  return { client, commands };
}

test("browser n uses the daemon-reported root, not a child workspace or local path, without a picker", async () => {
  for (const root of ["/srv/configured-workspaces", "/home/remote-user/workspaces"]) {
    const { client, commands } = folderClient(root);
    const { ui, frames } = folderUI(["c", "n"]);
    assert.deepEqual(await chooseRemoteSession(client, ui, "host", {}), { action: "create", cwd: root });
    assert.ok(frames.some(frame => frame.includes(root)), `Empty browser shows its creation context:\n${frames.join("\n")}`);
    assert.deepEqual(commands, [{ type: "client_workspaces" }, { type: "list_sessions" }]);
  }
});

test("browser attach and a fresh sessions browse retain existing cwd outside the default root in either tab", async () => {
  for (const status of ["running", "closed"] as const) {
    const session = remoteSession(status);
    const { client, commands } = folderClient("/srv/workspaces", [session]);
    // Re-entering /remote sessions starts another browse with no explicit cwd.
    for (let visit = 0; visit < 2; visit++) {
      const { ui } = folderUI(status === "closed" ? ["\t", "\r"] : ["\r"]);
      assert.deepEqual(await chooseRemoteSession(client, ui, "host", {}), {
        action: "attach", cwd: session.cwd, sessionId: session.sessionId,
      });
    }
    assert.deepEqual(commands, [
      { type: "client_workspaces" }, { type: "list_sessions" },
      { type: "client_workspaces" }, { type: "list_sessions" },
    ], "Creation context must never become a list filter");
  }
});

test("direct session attach bypasses default-root discovery and preserves explicit cwd constraints", async () => {
  const session = remoteSession();
  const { client, commands } = folderClient("invalid-root-that-must-not-be-read", [session]);
  const { ui, frames } = folderUI([]);
  assert.deepEqual(await chooseRemoteSession(client, ui, "host", { sessionId: "older" }), {
    action: "attach", cwd: session.cwd, sessionId: session.sessionId,
  });
  await assert.rejects(chooseRemoteSession(client, ui, "host", { sessionId: "older", cwd: "/explicit/other" }), /not the requested \/explicit\/other/);
  assert.deepEqual(commands, [{ type: "list_sessions" }, { type: "list_sessions" }]);
  assert.deepEqual(frames, []);
});

test("explicit cwd overrides creation context but still rejects a mismatching browser selection", async () => {
  const session = remoteSession();
  const { client, commands } = folderClient(undefined, [session]);
  const cwd = "/explicit/workspace";
  assert.deepEqual(await chooseRemoteSession(client, folderUI(["n"]).ui, "host", { cwd }), { action: "create", cwd });
  await assert.rejects(chooseRemoteSession(client, folderUI(["\r"]).ui, "host", { cwd }), /not the requested \/explicit\/workspace/);
  assert.deepEqual(await chooseRemoteSession(client, folderUI(["\r"]).ui, "host", { cwd: session.cwd }), {
    action: "attach", cwd: session.cwd, sessionId: session.sessionId,
  });
  assert.deepEqual(commands, [{ type: "list_sessions" }, { type: "list_sessions" }, { type: "list_sessions" }]);
});

test("malformed daemon roots fail before opening a browser; cancellation makes no mutation", async () => {
  for (const root of [undefined, null, 12, {}, "", "relative/path", "~/workspaces", "C:\\workspaces"]) {
    const { client, commands } = folderClient(root);
    const { ui, frames } = folderUI([]);
    await assert.rejects(chooseRemoteSession(client, ui, "host", {}), /server workspace root must be an absolute remote path/);
    assert.deepEqual(frames, []);
    assert.deepEqual(commands, [{ type: "client_workspaces" }]);
  }
  const { client, commands } = folderClient("/srv/workspaces");
  assert.equal(await chooseRemoteSession(client, folderUI(["\x1b"]).ui, "host", {}), undefined);
  assert.deepEqual(commands, [{ type: "client_workspaces" }, { type: "list_sessions" }]);
});

test("a missing host root is discoverable but package preflight rejects it without creating directories", async t => {
  const temp = mkdtempSync(join(tmpdir(), "remote-root-"));
  const root = join(temp, "missing", "workspaces");
  const previous = process.env.PI_SERVER_WORKSPACES_DIR;
  process.env.PI_SERVER_WORKSPACES_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SERVER_WORKSPACES_DIR;
    else process.env.PI_SERVER_WORKSPACES_DIR = previous;
    rmSync(temp, { recursive: true, force: true });
  });
  const host = new NativeClientHost(new SessionRegistry({ serverDir: temp }));
  const client = { call: async (command: Record<string, unknown>) => ({
    data: command.type === "list_sessions" ? { sessions: [] } : await host.handle(command),
  }) } as unknown as DaemonClient;
  const choice = await chooseRemoteSession(client, folderUI(["n"]).ui, "host", {});
  assert.equal(choice?.cwd, root);
  await assert.rejects(client.call({ type: "client_packages", cwd: choice?.cwd }), error => {
    assert.match((error as Error).message, /ENOENT/);
    assert.ok((error as Error).message.includes(root), "Failure identifies the missing remote root");
    return true;
  });
  assert.equal(existsSync(join(temp, "missing")), false);
});