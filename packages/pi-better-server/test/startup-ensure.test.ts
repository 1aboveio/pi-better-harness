import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { ensureDaemon } from "../src/startup/ensure.ts";
import { parseRuntime, remoteRuntimeScript, shellQuote } from "../src/startup/runtime.ts";
import { resolveTarget } from "../src/remote/target.ts";
import { makeEnv, waitFor, type Env } from "./helpers.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function environment(t: TestContext): { setup: Env; env: NodeJS.ProcessEnv } {
  const setup = makeEnv();
  const env: NodeJS.ProcessEnv = { ...process.env, ...setup.vars, HOME: setup.root, PI_SERVER_AGENT: "pi", PI_SERVER_DAEMON_IDLE_MS: "0" };
  delete env.PI_SERVER_COMMAND;
  delete env.PI_SERVER_LAUNCHER;
  t.after(async () => {
    const lock = join(setup.serverDir, "daemon-owner");
    if (!existsSync(lock)) return;
    const name = readdirSync(lock)[0];
    if (!name) return;
    const { pid } = JSON.parse(readFileSync(join(lock, name), "utf8"));
    try { process.kill(pid, "SIGTERM"); } catch { return; }
    await waitFor("owned daemon to stop", () => !existsSync(lock));
  });
  return { setup, env };
}

function run(argv: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const result = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, result };
}

async function ensure(env: NodeJS.ProcessEnv, args: string[] = []) {
  const result = await run([cli, "ensure", ...args], env).result;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1, "one machine-readable record only");
  return JSON.parse(result.stdout);
}

function setEnv(t: TestContext, env: NodeJS.ProcessEnv) {
  const previous = { ...process.env };
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
}

async function listener(t: TestContext, path: string, respond: (socket: Socket, request: any) => void) {
  mkdirSync(join(path, ".."), { recursive: true });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (chunk) => respond(socket, JSON.parse(String(chunk))));
  });
  server.listen(path);
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
}

function register(setup: Env, options: { launcher?: string; agentDir?: string; defaultServerDir?: string } = {}) {
  const launcher = options.launcher ?? join(setup.root, "runtime ' quoted", "bin", "pi-server");
  const agentDir = options.agentDir ?? setup.agentDir;
  const defaultServerDir = options.defaultServerDir ?? setup.serverDir;
  mkdirSync(join(launcher, ".."), { recursive: true });
  writeFileSync(launcher, `#!/bin/sh
export PI_SERVER_LAUNCHER=${shellQuote(launcher)}
if [ -z "\${PI_CODING_AGENT_DIR:-}" ]; then export PI_CODING_AGENT_DIR=${shellQuote(agentDir)}; fi
if [ -z "\${PI_SERVER_DIR:-}" ]; then export PI_SERVER_DIR=${shellQuote(defaultServerDir)}; fi
exec ${shellQuote(process.execPath)} ${shellQuote(cli)} "$@"
`, { mode: 0o700 });
  const runtime = { version: 1, agent: "pi", launcher, agentDir, defaultServerDir };
  mkdirSync(join(setup.root, ".pi"));
  writeFileSync(join(setup.root, ".pi", "remote-server.json"), JSON.stringify(runtime));
  return runtime;
}

/** SSH is the external boundary. Ordinary commands execute the actual remote shell/launcher locally. */
function fakeSsh(setup: Env, env: NodeJS.ProcessEnv, stallEnsure = false) {
  const bin = join(setup.root, "ssh-bin");
  const log = join(setup.root, "ssh.jsonl");
  mkdirSync(bin);
  writeFileSync(log, "");
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const { appendFileSync, writeFileSync, rmSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const op = argv.indexOf("-O");
const operation = op < 0 ? "command" : argv[op + 1];
const command = argv.at(-1);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ operation, command, pid: process.pid, argv }) + "\\n");
if (operation === "forward" || operation === "cancel") {
  const path = argv[argv.indexOf("-L") + 1].split(":")[0];
  if (operation === "forward") writeFileSync(path, "forward");
  else rmSync(path, { force: true });
} else if (operation === "command") {
  if (${stallEnsure} && command.includes("'ensure'")) {
    setInterval(() => {}, 1000);
  } else {
    const result = spawnSync("/bin/sh", ["-c", command], { env: process.env, encoding: "utf8" });
    process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
    process.exitCode = result.status ?? 1;
  }
}
`, { mode: 0o700 });
  env.PATH = `${bin}:${env.PATH}`;
  return { log, commands: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

describe("on-demand Pi startup", { concurrency: false, timeout: 120_000 }, () => {
  it("concurrent fresh ensures converge on one real writer and retain each accepted session", async (t) => {
    const { setup, env } = environment(t);
    const records = await Promise.all(Array.from({ length: 4 }, () => ensure(env)));
    assert.ok(records.every((record) => record.socketPath === join(setup.serverDir, "pi-server.sock")));
    const clients = await Promise.all(records.map((record) => DaemonClient.connect(record.socketPath)));
    t.after(() => clients.forEach((client) => client.close()));
    const created = await Promise.all(clients.map((client, i) => client.call({ type: "create_session", cwd: setup.cwd, name: `session-${i}`, model: { provider: "fake", modelId: "fake-1" } })));
    assert.ok(created.every((reply) => reply.data.model?.includes("fake-1")), "detached child loaded the selected agent providers");
    const expected = created.map((reply) => reply.sessionId).sort();
    assert.equal(new Set(expected).size, 4);
    assert.deepEqual((await clients[0]!.call({ type: "list_sessions" })).data.sessions.map((session: any) => session.sessionId).sort(), expected);
    await ensure(env);
    assert.deepEqual((await clients[1]!.call({ type: "list_sessions" })).data.sessions.map((session: any) => session.sessionId).sort(), expected);
    assert.deepEqual(JSON.parse(readFileSync(join(setup.serverDir, "sessions.json"), "utf8")).sessions.map((session: any) => session.sessionId).sort(), expected);
    assert.equal(readFileSync(join(setup.serverDir, "daemon.log"), "utf8").split("listening on").length - 1, 1);
  });

  it("recovers a stale socket left by a crashed process", async (t) => {
    const { setup, env } = environment(t);
    mkdirSync(setup.serverDir);
    const socketPath = join(setup.serverDir, "pi-server.sock");
    const crashed = run(["--input-type=module", "-e", `import {createServer} from 'node:net'; createServer().listen(${JSON.stringify(socketPath)}, () => process.stdout.write('listening'));`], env);
    await once(crashed.child.stdout!, "data");
    crashed.child.kill("SIGKILL");
    await crashed.result;
    assert.equal(existsSync(socketPath), true);
    const record = await ensure(env);
    const client = await DaemonClient.connect(record.socketPath);
    t.after(() => client.close());
    assert.deepEqual((await client.call({ type: "list_sessions" })).data.sessions, []);
  });

  it("bounds readiness and reports a startup failure with its log path", async (t) => {
    const { setup, env } = environment(t);
    mkdirSync(setup.serverDir);
    writeFileSync(join(setup.serverDir, "sessions.json"), "broken index");
    const result = await run([cli, "ensure", "--timeout-ms", "2500"], env).result;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /readiness timed out after 2500ms/);
    assert.ok(result.stderr.includes(join(setup.serverDir, "daemon.log")));
    assert.equal(existsSync(join(setup.serverDir, "daemon-owner")), false);
  });

  it("refuses an incompatible installed runtime before creating daemon state", async (t) => {
    const { setup, env } = environment(t);
    const result = await run([cli, "ensure", "--pi-version", "999.0.0"], env).result;
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Server runtime.*incompatible.*Pi version mismatch/s);
    assert.match(result.stderr, /no daemon was launched/);
    assert.equal(existsSync(setup.serverDir), false);
  });

  it("a launched daemon survives cancellation of its ensure parent while still starting", async (t) => {
    const { setup, env } = environment(t);
    mkdirSync(setup.serverDir);
    const index = join(setup.serverDir, "sessions.json");
    const fifo = spawnSync("mkfifo", [index], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
    const pending = run([cli, "ensure"], env);
    t.after(() => { if (pending.child.exitCode === null) pending.child.kill("SIGKILL"); });
    const lock = join(setup.serverDir, "daemon-owner");
    const name = await waitFor("daemon to claim ownership before reading the index", () => existsSync(lock) ? readdirSync(lock)[0] : undefined);
    const owner = JSON.parse(readFileSync(join(lock, name), "utf8"));
    pending.child.kill("SIGTERM");
    assert.equal((await pending.result).code, 1);
    // The FIFO gates real registry loading, not a fixed startup delay.
    const release = await run(["-e", `require('node:fs').writeFileSync(${JSON.stringify(index)}, JSON.stringify({version:1,sessions:[]}))`], env).result;
    assert.equal(release.code, 0, release.stderr);
    rmSync(index);
    const record = await ensure(env);
    assert.deepEqual(JSON.parse(readFileSync(join(lock, name), "utf8")), owner);
    const client = await DaemonClient.connect(record.socketPath);
    t.after(() => client.close());
    assert.deepEqual((await client.call({ type: "list_sessions" })).data.sessions, []);
  });

  it("refuses incompatible and unresponsive live listeners without launching or unlinking", async (t) => {
    const { setup } = environment(t);
    const path = join(setup.serverDir, "pi-server.sock");
    let mode: "reject" | "malformed" | "silent" = "reject";
    let hellos = 0;
    await listener(t, path, (socket, request) => {
      hellos++;
      if (mode === "reject") socket.end(JSON.stringify({ id: request.id, type: "response", success: false, error: "Protocol version mismatch" }) + "\n");
      if (mode === "malformed") socket.end(JSON.stringify({ id: request.id, type: "response", success: true, data: { protocolVersion: 1, piVersion: PI_VERSION, capabilities: "native-client-v1 session-browser-v1" } }) + "\n");
    });
    await assert.rejects(ensureDaemon({ serverDir: setup.serverDir, agentDir: setup.agentDir, timeoutMs: 200 }), /Server health.*Protocol version mismatch/);
    mode = "malformed";
    await assert.rejects(ensureDaemon({ serverDir: setup.serverDir, agentDir: setup.agentDir, timeoutMs: 200 }), /Server health.*valid capabilities array/);
    mode = "silent";
    await assert.rejects(ensureDaemon({ serverDir: setup.serverDir, agentDir: setup.agentDir, timeoutMs: 100 }), /Server health.*Existing listener was not replaced/);
    assert.equal(hellos, 3);
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(join(setup.serverDir, "daemon.log")), false);
  });

  it("SIGTERM cancels an ensure hello with bounded cleanup and leaves the existing listener alone", async (t) => {
    const { setup, env } = environment(t);
    const path = join(setup.serverDir, "pi-server.sock");
    let received!: () => void;
    const hello = new Promise<void>((resolve) => { received = resolve; });
    await listener(t, path, () => received());
    const pending = run([cli, "ensure"], env);
    await hello;
    pending.child.kill("SIGTERM");
    const result = await pending.result;
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /operation was aborted/);
    assert.equal(existsSync(path), true);
    assert.equal(existsSync(join(setup.serverDir, "daemon.log")), false);
  });

  it("discovers a registered trial root before ensure, survives SSH exit, and honors explicit remote dirs", async (t) => {
    const { setup, env } = environment(t);
    const runtime = register(setup);
    delete env.PI_SERVER_DIR;
    delete env.PI_CODING_AGENT_DIR;
    const ssh = fakeSsh(setup, env);
    setEnv(t, env);
    const stages: string[] = [];
    const target = await resolveTarget({ host: "115", controlPathRoot: join(setup.root, "mux"), onProgress: (stage) => stages.push(stage) });
    t.after(() => target.close());
    assert.deepEqual(stages, ["ssh", "directory", "server", "forward"]);
    const client = await DaemonClient.connect(join(setup.serverDir, "pi-server.sock"));
    t.after(() => client.close());
    assert.deepEqual((await client.call({ type: "list_sessions" })).data.sessions, []);
    const created = await client.call({ type: "create_session", cwd: setup.cwd, model: { provider: "fake", modelId: "fake-1" } });
    assert.equal(created.data.model, "fake/fake-1", "manifest agentDir supplies the detached child's provider");
    const local = await resolveTarget({});
    assert.equal(local.socketPath, join(setup.serverDir, "pi-server.sock"));
    await local.close();
    assert.ok(ssh.commands().find((entry) => entry.operation === "forward").argv.includes(`${target.socketPath}:${setup.serverDir}/pi-server.sock`));
    assert.ok(ssh.commands().some((entry) => entry.command.includes(shellQuote(runtime.agentDir))));
    await target.close();
    // A second explicit selection must not be redirected to the registered default.
    const other = join(setup.root, "other");
    mkdirSync(other);
    const otherSocket = join(other, "pi-server.sock");
    // Existing incompatible endpoint proves the explicit directory is probed, without starting another daemon.
    await listener(t, otherSocket, (socket, request) => socket.end(JSON.stringify({ id: request.id, success: false, error: "explicit endpoint" }) + "\n"));
    await assert.rejects(resolveTarget({ host: "r5", remoteDir: other, controlPathRoot: join(setup.root, "mux") }), /explicit endpoint/);
    assert.equal(existsSync(join(other, "daemon.log")), false);
  });

  for (const overrideServerDir of [false, true]) {
    it(`preserves the registered local agent with a different client agent${overrideServerDir ? " and explicit server dir" : ""}`, async (t) => {
      const { setup, env } = environment(t);
      const registeredServerDir = overrideServerDir ? join(setup.root, "registered-state") : setup.serverDir;
      register(setup, { defaultServerDir: registeredServerDir });
      env.PI_CODING_AGENT_DIR = join(setup.root, "client-agent");
      mkdirSync(env.PI_CODING_AGENT_DIR);
      if (!overrideServerDir) delete env.PI_SERVER_DIR;
      setEnv(t, env);
      const target = await resolveTarget({});
      t.after(() => target.close());
      assert.equal(target.socketPath, join(setup.serverDir, "pi-server.sock"));
      const client = await DaemonClient.connect(target.socketPath);
      t.after(() => client.close());
      const created = await client.call({ type: "create_session", cwd: setup.cwd, model: { provider: "fake", modelId: "fake-1" } });
      assert.equal(created.data.model, "fake/fake-1", "only the registered agent has the selected provider");
      assert.equal(existsSync(join(env.PI_CODING_AGENT_DIR, "server")), false);
      if (overrideServerDir) assert.equal(existsSync(registeredServerDir), false);
    });
  }

  it("retains explicit PI_SERVER_COMMAND agent context instead of imposing the registration", async (t) => {
    const { setup, env } = environment(t);
    const registeredAgent = join(setup.root, "registered-agent");
    mkdirSync(registeredAgent);
    const runtime = register(setup, { agentDir: registeredAgent });
    env.PI_SERVER_COMMAND = runtime.launcher;
    delete env.PI_SERVER_DIR;
    setEnv(t, env);
    const target = await resolveTarget({});
    t.after(() => target.close());
    assert.equal(target.socketPath, join(setup.serverDir, "pi-server.sock"));
    const client = await DaemonClient.connect(target.socketPath);
    t.after(() => client.close());
    const created = await client.call({ type: "create_session", cwd: setup.cwd, model: { provider: "fake", modelId: "fake-1" } });
    assert.equal(created.data.model, "fake/fake-1", "the deliberate launcher override keeps the caller's agent");
  });

  for (const branch of ["local", "local fallback", "remote registration", "remote command", "remote fallback"] as const) {
    it(`carries explicit Pi selection through ${branch} discovery and ensure with inherited Codex mode`, async (t) => {
      const { setup, env } = environment(t);
      const fallback = branch.endsWith("fallback");
      const runtime = register(setup, fallback
        ? { launcher: join(setup.root, ".pi-better-server", "bin", "pi-server") } : {});
      if (fallback) rmSync(join(setup.root, ".pi", "remote-server.json"));
      if (branch === "remote command") env.PI_SERVER_COMMAND = runtime.launcher;
      env.PI_SERVER_AGENT = "codex";
      env.PI_CODING_AGENT_DIR = branch === "local" || branch === "remote registration" ? join(setup.root, "client-agent") : setup.agentDir;
      if (branch === "local fallback") {
        delete env.PI_CODING_AGENT_DIR;
        delete env.PI_SERVER_DIR;
      }
      const remote = branch.startsWith("remote");
      const ssh = remote ? fakeSsh(setup, env) : undefined;
      setEnv(t, env);
      const target = await resolveTarget({ agent: "pi", ...(remote ? { host: "fixture", controlPathRoot: join(setup.root, "mux") } : {}) });
      t.after(() => target.close());
      const client = await DaemonClient.connect(join(setup.serverDir, "pi-server.sock"));
      t.after(() => client.close());
      const created = await client.call({ type: "create_session", cwd: setup.cwd, model: { provider: "fake", modelId: "fake-1" } });
      assert.equal(created.data.model, "fake/fake-1", "Pi ensure retains the selected runtime's agent context");
      if (ssh) assert.ok(ssh.commands().some((entry) => entry.operation === "forward"));
      else assert.equal(target.socketPath, join(setup.serverDir, "pi-server.sock"));
    });
  }

  it("cancels server setup without killing the shared SSH master or opening a forward", async (t) => {
    const { setup, env } = environment(t);
    register(setup);
    const ssh = fakeSsh(setup, env, true);
    setEnv(t, env);
    const controller = new AbortController();
    const resolving = resolveTarget({ host: "fixture", signal: controller.signal, controlPathRoot: join(setup.root, "mux") });
    const rejected = assert.rejects(resolving, { name: "AbortError" });
    const command = await waitFor("server SSH command", () => ssh.commands().find((entry) => entry.command.includes("'ensure'")));
    controller.abort();
    await rejected;
    assert.throws(() => process.kill(command.pid, 0), { code: "ESRCH" });
    assert.equal(ssh.commands().some((entry) => ["exit", "forward"].includes(entry.operation)), false);
  });

  it("does not auto-start Pi for Codex, transport opt-out, or an explicit local socket", async (t) => {
    const { setup, env } = environment(t);
    const ssh = fakeSsh(setup, env);
    setEnv(t, env);
    for (const options of [{ agent: "codex" as const }, { ensureServer: false }]) {
      const target = await resolveTarget({ ...options, host: "fixture", remoteDir: setup.serverDir, controlPathRoot: join(setup.root, "mux") });
      await target.close();
    }
    const local = await resolveTarget({ socket: "/foreign.sock" });
    assert.equal(local.socketPath, "/foreign.sock");
    assert.equal(ssh.commands().some((entry) => entry.operation === "command"), false);
    assert.equal(existsSync(setup.serverDir), false);
  });

  it("rejects missing and malformed registrations with installation guidance before forwarding", async (t) => {
    const { setup, env } = environment(t);
    const ssh = fakeSsh(setup, env);
    setEnv(t, env);
    await assert.rejects(resolveTarget({ host: "fixture", controlPathRoot: join(setup.root, "mux") }), /Runtime discovery.*bootstrap-host.sh/s);
    mkdirSync(join(setup.root, ".pi"));
    writeFileSync(join(setup.root, ".pi", "remote-server.json"), JSON.stringify({ version: 1, agent: "pi", launcher: "relative" }));
    await assert.rejects(resolveTarget({ host: "fixture", controlPathRoot: join(setup.root, "mux") }), /runtime.launcher.*absolute path/);
    writeFileSync(join(setup.root, ".pi", "remote-server.json"), JSON.stringify({ version: 1, agent: "pi", launcher: join(setup.root, "missing-launcher"), agentDir: setup.agentDir, defaultServerDir: setup.serverDir }));
    await assert.rejects(resolveTarget({ host: "fixture", controlPathRoot: join(setup.root, "mux") }), /Server ensure.*bootstrap-host.sh/s);
    assert.equal(ssh.commands().some((entry) => entry.operation === "forward"), false);
    assert.throws(() => parseRuntime('{"version":2}'), /Unsupported/);
    assert.throws(() => remoteRuntimeScript("pi-server; unwanted"), /absolute path/);
  });
});
