import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { startDaemon, type Daemon } from "../src/server.ts";
import { Client, gate, makeEnv, waitFor, type Env } from "./helpers.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function setup(configure?: (env: Env) => void) {
  const env = makeEnv();
  configure?.(env);
  Object.assign(process.env, env.vars);
  const daemon: Daemon = await startDaemon({ serverDir: env.serverDir });
  cleanups.push(() => daemon.stop());
  const client = await Client.connect(daemon.socketPath);
  cleanups.push(() => client.close());
  const created = await client.request({ type: "create_session", cwd: env.cwd, name: "Native remote", model: { provider: "fake", modelId: "fake-1" } });
  assert.equal(created.success, true, JSON.stringify(created));
  return { env, daemon, client, sessionId: created.sessionId as string };
}

test("native attach snapshot restores history and catches up after an active remote tool", async () => {
  const { env, daemon, client, sessionId } = await setup();
  await client.request({ type: "prompt", sessionId, message: "tool snapshot" });
  await waitFor("remote gate", gate(env, "snapshot").started);
  const before = await client.request({ type: "client_snapshot", sessionId });
  assert.equal(before.success, true, JSON.stringify(before));
  assert.equal(before.data.cwd, env.cwd);
  assert.equal(before.data.name, "Native remote");
  assert.equal(before.data.state.isStreaming, true);
  assert.ok(before.data.activeTools.some((tool: any) => tool.toolName === "gate"));
  assert.ok(before.data.messages.some((message: any) => message.role === "user"));
  assert.ok(before.data.tools.some((tool: any) => tool.name === "gate"));
  assert.ok(before.data.commands.some((command: any) => command.name === "kick"));
  assert.equal(before.data.models.find((model: any) => model.provider === "fake").baseUrl, undefined);

  gate(env, "snapshot").release();
  await waitFor("settled snapshot", async () => {
    const state = await client.request({ type: "get_state", sessionId });
    return !state.data.isStreaming;
  });
  const reader = await Client.connect(daemon.socketPath);
  cleanups.push(() => reader.close());
  const subscribed = await reader.request({ type: "subscribe", sessionId, sinceSeq: before.data.lastSeq });
  assert.equal(subscribed.data.generation, before.data.generation);
  await waitFor("native catch-up", () => reader.events.some((item) => item.event.type === "agent_end"));
  assert.ok(reader.events.every((item) => item.seq > before.data.lastSeq && item.generation === before.data.generation));
  const after = await reader.request({ type: "client_snapshot", sessionId });
  assert.equal(after.data.state.isStreaming, false);
  assert.deepEqual(after.data.activeTools, []);
  assert.ok(after.data.messages.some((message: any) => message.role === "assistant" && message.content.some((part: any) => part.text === "tool-done:gate:snapshot")));
});

test("native snapshot generation changes when a session backend is reopened", async () => {
  const { client, sessionId } = await setup();
  const first = await client.request({ type: "client_snapshot", sessionId });
  await client.request({ type: "close_session", sessionId });
  await client.request({ type: "open_session", sessionId });
  const second = await client.request({ type: "client_snapshot", sessionId });
  assert.notEqual(first.data.generation, second.data.generation);
  assert.equal(first.data.sessionId, second.data.sessionId);
});

test("workspace discovery uses remote workspace roots rather than the daemon installation", async () => {
  const { env, client } = await setup();
  const root = join(env.root, "projects");
  mkdirSync(join(root, "bravo"), { recursive: true });
  mkdirSync(join(root, "alpha"));
  mkdirSync(join(root, ".private"));
  const previous = process.env.PI_SERVER_WORKSPACES_DIR;
  process.env.PI_SERVER_WORKSPACES_DIR = root;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PI_SERVER_WORKSPACES_DIR;
    else process.env.PI_SERVER_WORKSPACES_DIR = previous;
  });
  const result = await client.request({ type: "client_workspaces" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.deepEqual(result.data.workspaces, [
    { name: "alpha", path: join(root, "alpha") },
    { name: "bravo", path: join(root, "bravo") },
  ]);
});

test("folder browsing reaches absolute directories outside the workspace root and resolves directory links", async () => {
  const { env, client } = await setup();
  const root = await mkdtemp(join(env.root, "folders-"));
  await mkdir(join(root, "bravo"));
  await mkdir(join(root, "alpha"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "file"), "not a folder");
  await symlink(join(root, "alpha"), join(root, "linked"));
  await symlink(join(root, "missing"), join(root, "dangling"));
  const previous = process.env.PI_SERVER_WORKSPACES_DIR;
  process.env.PI_SERVER_WORKSPACES_DIR = env.cwd;
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PI_SERVER_WORKSPACES_DIR;
    else process.env.PI_SERVER_WORKSPACES_DIR = previous;
  });
  const listed = await client.request({ type: "client_browse_directory", path: root });
  assert.equal(listed.success, true, JSON.stringify(listed));
  assert.deepEqual(listed.data, {
    path: root, parent: dirname(root), directories: [".hidden", "alpha", "bravo", "linked"].map(name => ({ name, path: join(root, name) })),
  });
  const linked = await client.request({ type: "client_browse_directory", path: join(root, "linked") });
  assert.equal(linked.success, true, JSON.stringify(linked));
  assert.deepEqual(linked.data, { path: join(root, "alpha"), parent: root, directories: [] });
  const filesystemRoot = await client.request({ type: "client_browse_directory", path: "/" });
  assert.equal(filesystemRoot.success, true, JSON.stringify(filesystemRoot));
  assert.equal(filesystemRoot.data.path, "/");
  assert.equal(filesystemRoot.data.parent, null);
});

test("folder commands reject invalid paths and leave missing workspace roots absent", async () => {
  const { env, client } = await setup();
  const missing = join(env.root, "absent", "workspaces");
  const file = join(env.root, "plain-file");
  await writeFile(file, "untouched");
  for (const type of ["client_browse_directory", "client_create_directory"]) {
    for (const path of [undefined, null, 42, "relative", "", file, missing]) {
      const result = await client.request({ type, path, name: "child" });
      assert.equal(result.success, false, `${type}: ${String(path)}`);
      assert.match(result.error, path === missing ? /ENOENT/ : /absolute remote directory/);
    }
  }
  assert.equal(existsSync(join(env.root, "absent")), false);
  assert.equal(await readFile(file, "utf8"), "untouched");
});

test("folder creation validates a single child and never replaces a file, directory or symlink", async () => {
  const { env, client } = await setup();
  const parent = join(env.root, "create-parent");
  await mkdir(parent);
  for (const name of [undefined, 42, "", "   ", ".", "..", "../escape", "a/b", "a\\b", "/absolute", "line\nbreak", "nul\0byte", "escape\x1b", "delete\x7f", "control\x85"]) {
    const result = await client.request({ type: "client_create_directory", path: parent, name });
    assert.equal(result.success, false, JSON.stringify(name));
    assert.match(result.error, /single new child folder name/);
  }
  assert.deepEqual(await readdir(parent), []);
  await writeFile(join(parent, "file"), "keep file");
  await mkdir(join(parent, "directory"));
  await writeFile(join(parent, "directory", "marker"), "keep directory");
  await symlink(join(parent, "directory"), join(parent, "link"));
  await symlink(join(parent, "missing"), join(parent, "dangling"));
  for (const name of ["file", "directory", "link", "dangling"]) {
    const result = await client.request({ type: "client_create_directory", path: parent, name });
    assert.equal(result.success, false, name);
    assert.match(result.error, /EEXIST/);
  }
  assert.equal(await readFile(join(parent, "file"), "utf8"), "keep file");
  assert.equal(await readFile(join(parent, "directory", "marker"), "utf8"), "keep directory");
  assert.equal(await realpath(join(parent, "link")), join(parent, "directory"));
  const created = await client.request({ type: "client_create_directory", path: parent, name: "project with spaces" });
  assert.equal(created.success, true, JSON.stringify(created));
  assert.deepEqual(created.data, { path: join(parent, "project with spaces") });
  assert.deepEqual(await readdir(created.data.path), []);
  const contenders = await Promise.all([1, 2].map(() => client.request({ type: "client_create_directory", path: parent, name: "once" })));
  assert.equal(contenders.filter(result => result.success).length, 1);
  assert.match(contenders.find(result => !result.success)!.error, /EEXIST/);
});

test("package synchronization refuses to replace extension code during remote execution", async () => {
  const { client, env, sessionId } = await setup();
  await client.request({ type: "prompt", sessionId, message: "tool package-update" });
  await waitFor("package update gate", gate(env, "package-update").started);
  const result = await client.request({ type: "client_packages_install", packages: [{ source: "npm:pi-better-harness@0.31.0" }] });
  assert.equal(result.success, false);
  assert.match(result.error, /Wait for remote/);
  gate(env, "package-update").release();
});

test("remote shell commands run the remote user_bash extension hooks", async () => {
  const { client, sessionId } = await setup((env) => {
    writeFileSync(join(env.agentDir, "extensions", "shell.ts"), `export default function (pi) {
      pi.on("user_bash", () => ({ result: { output: "remote-intercepted", exitCode: 0, cancelled: false, truncated: false } }));
    }`);
  });
  const result = await client.request({ type: "bash", sessionId, command: "printf not-intercepted" });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.output, "remote-intercepted");
});

test("extension sync cannot race a session still loading its extension runtime", async () => {
  const { env, daemon, client, sessionId } = await setup();
  await client.request({ type: "close_session", sessionId });
  const started = join(env.root, "loading.started");
  const released = join(env.root, "loading.release");
  writeFileSync(join(env.agentDir, "extensions", "loading.ts"), `import {existsSync,writeFileSync} from "node:fs";
    export default async function () {
      writeFileSync(${JSON.stringify(started)}, "ready");
      while (!existsSync(${JSON.stringify(released)})) await new Promise(resolve => setTimeout(resolve, 10));
    }`);
  const opening = client.request({ type: "open_session", sessionId });
  try {
    await waitFor("extension loading", () => existsSync(started));
    assert.equal(daemon.registry.list()[0]!.live, false);
    const other = await Client.connect(daemon.socketPath);
    cleanups.push(() => other.close());
    const result = await other.request({ type: "client_packages_install", packages: [] });
    assert.equal(result.success, false);
    assert.match(result.error, /session operations are already in progress/);
  } finally {
    writeFileSync(released, "release");
    assert.equal((await opening).success, true);
  }
});

test("a failed remote shell guard never falls through to unguarded execution", async () => {
  const { env, client, sessionId } = await setup((env) => {
    writeFileSync(join(env.agentDir, "extensions", "shell.ts"), `export default function (pi) {
      pi.on("user_bash", () => { throw new Error("remote shell guard refused"); });
    }`);
  });
  const marker = join(env.cwd, "unguarded-execution");
  const result = await client.request({ type: "bash", sessionId, command: `touch '${marker}'` });
  assert.equal(result.success, false);
  assert.match(result.error, /remote shell guard refused/);
  assert.equal(existsSync(marker), false);
});