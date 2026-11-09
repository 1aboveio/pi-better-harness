import assert from "node:assert/strict";
import { once, getEventListeners } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { DaemonClient, HandshakeError } from "../src/client.ts";
import { startDaemon } from "../src/server.ts";
import { encodeLine, LineDecoder } from "../src/protocol.ts";
import { createProcessRunner } from "../src/remote/process-runner.ts";
import { resolveTarget } from "../src/remote/target.ts";
import { makeEnv } from "./helpers.ts";

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";
const cleanups = new WeakMap<TestContext, Array<() => void | Promise<void>>>();

function cleanup(t: TestContext, callback: () => void | Promise<void>) {
  let callbacks = cleanups.get(t);
  if (!callbacks) {
    callbacks = [];
    cleanups.set(t, callbacks);
    t.after(async () => {
      while (callbacks!.length) await callbacks!.pop()!();
    });
  }
  callbacks.push(callback);
}

function tempDir(t: TestContext) {
  const root = mkdtempSync("/tmp/pct-");
  cleanup(t, () => rmSync(root, { recursive: true, force: true }));
  return root;
}

function env(t: TestContext, values: Record<string, string | undefined>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanup(t, () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function socketServer(t: TestContext, onSocket: (socket: Socket) => void) {
  const path = join(tempDir(t), "s");
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    onSocket(socket);
  });
  server.listen(path);
  await once(server, "listening");
  cleanup(t, async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  return path;
}

type SshCommand = { kind: string; argv: string[]; pid: number; socket: Socket; reply: (result?: { exitCode?: number; stdout?: string; stderr?: string }) => void };

/** A real executable at the SSH CLI boundary; its control socket provides event-driven gates. */
async function sshFixture(t: TestContext, respond: (command: SshCommand) => void = (command) => command.reply()) {
  const root = tempDir(t);
  const commands: SshCommand[] = [];
  const consumed = new Set<SshCommand>();
  const waiters: Array<{ kind: string; resolve: (command: SshCommand) => void }> = [];
  const pids = new Set<number>();
  const control = await socketServer(t, (socket) => {
    socket.setEncoding("utf8");
    const decoder = new LineDecoder((line) => {
      const input = JSON.parse(line) as { kind: string; argv: string[]; pid: number };
      pids.add(input.pid);
      socket.once("close", () => pids.delete(input.pid));
      const command: SshCommand = {
        ...input,
        socket,
        reply: (result = {}) => socket.end(JSON.stringify({ stdout: input.kind === "directory" ? "/daemon\n" : "", ...result }) + "\n"),
      };
      commands.push(command);
      respond(command);
      const index = waiters.findIndex((waiter) => waiter.kind === command.kind);
      if (index !== -1) {
        consumed.add(command);
        waiters.splice(index, 1)[0]!.resolve(command);
      }
    }, () => socket.destroy());
    socket.on("data", (chunk: string) => decoder.push(chunk));
  });
  cleanup(t, () => {
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ }
    }
  });
  const executable = join(root, "ssh");
  writeFileSync(executable, `#!${process.execPath}
import { createConnection } from "node:net";
import { writeFileSync, rmSync } from "node:fs";
const argv = process.argv.slice(2);
const operation = argv.indexOf("-O");
const kind = operation !== -1 ? argv[operation + 1] : argv.includes("-N") ? "open" : "directory";
const forward = argv[argv.indexOf("-L") + 1];
if (kind === "forward") writeFileSync(forward.split(":")[0], "partial forward");
if (kind === "cancel") rmSync(forward.split(":")[0], { force: true });
const socket = createConnection(process.env.PI_TEST_SSH_CONTROL);
socket.on("connect", () => socket.write(JSON.stringify({ kind, argv, pid: process.pid }) + "\\n"));
let input = "";
socket.on("data", (chunk) => {
  input += chunk;
  if (!input.includes("\\n")) return;
  const result = JSON.parse(input);
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  socket.end();
  process.exitCode = result.exitCode ?? 0;
});
`, { mode: 0o700 });
  const forwards = join(root, "forwards");
  mkdirSync(forwards);
  env(t, {
    PATH: `${root}:${process.env.PATH}`,
    PI_TEST_SSH_CONTROL: control,
    PI_REMOTE_TMP: forwards,
    PI_REMOTE_SERVER_DIR: undefined,
  });
  return {
    executable,
    forwards,
    commands,
    options: { host: "fixture.invalid", controlPathRoot: join(root, "mux"), ensureServer: false },
    next(kind: string): Promise<SshCommand> {
      const command = commands.find((candidate) => candidate.kind === kind && !consumed.has(candidate));
      if (command) {
        consumed.add(command);
        return Promise.resolve(command);
      }
      return new Promise((resolve) => waiters.push({ kind, resolve }));
    },
  };
}

describe("remote connect transport", { concurrency: false, timeout: 15_000 }, () => {
  it("rejects an already aborted runner without spawning and preserves normal command results", async (t) => {
    const controller = new AbortController();
    const runner = createProcessRunner({ signal: controller.signal });
    const marker = join(tempDir(t), "spawned");
    const spec = { command: "fixture", shell: false, argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`] };
    controller.abort(new Error("custom reason"));
    await assert.rejects(runner.runOnce(spec), isAbort);
    assert.equal(existsSync(marker), false);
    const resultController = new AbortController();
    const result = await createProcessRunner({ signal: resultController.signal }).runOnce({ command: "fixture", shell: false, argv: [process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7"] });
    assert.equal(getEventListeners(resultController.signal, "abort").length, 0);
    assert.equal(result.stdout, "out");
    assert.equal(result.stderr, "err");
    assert.equal(result.exitCode, 7);
  });

  it("kills an in-flight short child, removes its listener, and cannot run another command", async (t) => {
    const fixture = await sshFixture(t, () => undefined);
    const controller = new AbortController();
    const runner = createProcessRunner({ signal: controller.signal });
    const spec = { command: "fixture", shell: false, argv: [fixture.executable] };
    const running = runner.runOnce(spec);
    const rejected = assert.rejects(running, isAbort);
    const command = await fixture.next("directory");
    controller.abort("escape");
    await rejected;
    assert.throws(() => process.kill(command.pid, 0), { code: "ESRCH" });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    await assert.rejects(runner.runOnce(spec), isAbort);
    assert.equal(fixture.commands.length, 1);
  });

  it("reports phases before work and leaves a successful target usable after setup abort", async (t) => {
    const phases: string[] = [];
    const fixture = await sshFixture(t, (command) => {
      assert.equal(phases.at(-1), command.kind === "check" ? "ssh" : command.kind === "directory" ? "directory" : "forward");
      command.reply();
    });
    const controller = new AbortController();
    const target = await resolveTarget({ ...fixture.options, signal: controller.signal, onProgress: (stage) => phases.push(stage) });
    cleanup(t, () => target.close());
    assert.deepEqual(phases, ["ssh", "directory", "forward"]);
    assert.equal(existsSync(target.socketPath), true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
    const extra = await target.forwardSocket("/daemon/extra.sock");
    cleanup(t, () => extra.close());
    assert.equal(existsSync(extra.socketPath), true);
    await extra.close();
    await target.close();
    assert.deepEqual(readdirSync(fixture.forwards), []);
    assert.equal(fixture.commands.some((command) => command.kind === "exit"), false);
    const forwardSpecs = fixture.commands.filter((command) => command.kind === "forward").map((command) => command.argv[command.argv.indexOf("-L") + 1]);
    const cancelledSpecs = fixture.commands.filter((command) => command.kind === "cancel").map((command) => command.argv[command.argv.indexOf("-L") + 1]);
    assert.deepEqual(cancelledSpecs, [...forwardSpecs].reverse());
  });

  for (const stage of ["ssh", "directory", "forward"] as const) {
    it(`aborts stalled ${stage} work without advancing and cleans any partial forward`, async (t) => {
      const kind = stage === "ssh" ? "check" : stage;
      const fixture = await sshFixture(t, (command) => {
        if (command.kind !== kind) command.reply();
      });
      const phases: string[] = [];
      const controller = new AbortController();
      const resolving = resolveTarget({ ...fixture.options, signal: controller.signal, onProgress: (phase) => phases.push(phase) });
      const rejected = assert.rejects(resolving, isAbort);
      const pending = await fixture.next(kind);
      controller.abort(new Error("escape"));
      await rejected;
      assert.throws(() => process.kill(pending.pid, 0), { code: "ESRCH" });
      assert.deepEqual(phases, ["ssh", "directory", "forward"].slice(0, ["ssh", "directory", "forward"].indexOf(stage) + 1));
      assert.deepEqual(readdirSync(fixture.forwards), []);
      assert.deepEqual(fixture.commands.map((command) => command.kind), stage === "ssh" ? ["check"] : stage === "directory" ? ["check", "directory"] : ["check", "directory", "forward", "cancel"]);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
  }

  it("does not reopen a master after cancellation of a failed check", async (t) => {
    const fixture = await sshFixture(t, () => undefined);
    const controller = new AbortController();
    const resolving = resolveTarget({ ...fixture.options, signal: controller.signal });
    const rejected = assert.rejects(resolving, isAbort);
    const command = await fixture.next("check");
    command.reply({ exitCode: 1 });
    controller.abort();
    await rejected;
    assert.deepEqual(fixture.commands.map((command) => command.kind), ["check"]);
  });

  it("honors aborts from progress callbacks before spawning that phase", async (t) => {
    const fixture = await sshFixture(t);
    for (const stage of ["ssh", "directory", "forward"] as const) {
      const controller = new AbortController();
      const start = fixture.commands.length;
      const phases: string[] = [];
      await assert.rejects(resolveTarget({
        ...fixture.options,
        signal: controller.signal,
        onProgress: (phase) => {
          phases.push(phase);
          if (phase === stage) controller.abort();
        },
      }), isAbort);
      assert.equal(phases.at(-1), stage);
      assert.deepEqual(fixture.commands.slice(start).map((command) => command.kind), stage === "ssh" ? [] : stage === "directory" ? ["check"] : ["check", "directory"]);
      assert.deepEqual(readdirSync(fixture.forwards), []);
    }
  });

  it("cancels failed forwards best-effort and removes their directories even if cancellation fails", async (t) => {
    let failForward = true;
    const fixture = await sshFixture(t, (command) => {
      command.reply({ exitCode: (command.kind === "forward" && failForward) || command.kind === "cancel" ? 1 : 0, stderr: "fixture failure" });
    });
    await assert.rejects(resolveTarget(fixture.options), /SSH forward.*fixture failure/);
    assert.deepEqual(readdirSync(fixture.forwards), []);
    failForward = false;
    const target = await resolveTarget({ ...fixture.options, remoteDir: "/explicit" });
    cleanup(t, () => target.close());
    failForward = true;
    await assert.rejects(target.forwardSocket("/extra.sock"), /SSH forward.*fixture failure/);
    assert.equal(existsSync(target.socketPath), true);
    assert.equal(readdirSync(fixture.forwards).length, 1);
    await target.close();
    assert.deepEqual(readdirSync(fixture.forwards), []);
    assert.equal(fixture.commands.filter((command) => command.kind === "cancel").length, 3);
  });

  it("keeps local target behavior and rejects pre-aborted targets without progress", async () => {
    const target = await resolveTarget({ socket: "/local.sock" });
    assert.equal(target.socketPath, "/local.sock");
    const extra = await target.forwardSocket("/extra.sock");
    assert.equal(extra.socketPath, "/extra.sock");
    await extra.close();
    await target.close();
    const controller = new AbortController();
    controller.abort("escape");
    for (const host of [undefined, "fixture.invalid"]) {
      const phases: string[] = [];
      await assert.rejects(resolveTarget({ host, signal: controller.signal, onProgress: (phase) => phases.push(phase) }), isAbort);
      assert.deepEqual(phases, []);
    }
  });

  it("rejects pre-aborted and in-flight Unix connects with AbortError", async (t) => {
    const controller = new AbortController();
    controller.abort("escape");
    await assert.rejects(DaemonClient.connect("/unused", { signal: controller.signal }), isAbort);
    const path = await socketServer(t, () => undefined);
    const pendingController = new AbortController();
    const pending = DaemonClient.connect(path, { signal: pendingController.signal });
    const rejected = assert.rejects(pending, isAbort);
    pendingController.abort(new Error("escape"));
    await rejected;
    assert.equal(getEventListeners(pendingController.signal, "abort").length, 0);
  });

  it("aborts a stalled hello, closes the socket and removes the connect listener", async (t) => {
    let receivedHello!: (socket: Socket) => void;
    const hello = new Promise<Socket>((resolve) => { receivedHello = resolve; });
    const path = await socketServer(t, (socket) => socket.once("data", () => receivedHello(socket)));
    const controller = new AbortController();
    const pending = DaemonClient.connect(path, { signal: controller.signal });
    const rejected = assert.rejects(pending, isAbort);
    const peer = await hello;
    const closed = once(peer, "close");
    controller.abort("escape");
    await rejected;
    await closed;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  it("removes the abort listener on socket errors and rejected hellos", async (t) => {
    const controller = new AbortController();
    await assert.rejects(DaemonClient.connect(join(tempDir(t), "absent"), { signal: controller.signal }), { code: "ENOENT" });
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    const path = await socketServer(t, (socket) => {
      socket.once("data", (chunk) => {
        const request = JSON.parse(chunk.toString());
        socket.write(encodeLine({ id: request.id, type: "response", success: false, error: "fixture rejects hello" }));
      });
    });
    await assert.rejects(DaemonClient.connect(path, { signal: controller.signal }), (error) => error instanceof HandshakeError && error.message === "fixture rejects hello");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    controller.abort();
  });

  it("does not let a discarded connect signal close an established daemon session", async (t) => {
    const setup = makeEnv();
    env(t, setup.vars);
    const daemon = await startDaemon({ serverDir: setup.serverDir });
    cleanup(t, () => daemon.stop());
    for (const hello of [undefined, false] as const) {
      const controller = new AbortController();
      const client = await DaemonClient.connect(daemon.socketPath, { signal: controller.signal, hello });
      cleanup(t, () => client.close());
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      controller.abort("late escape");
      assert.deepEqual((await client.call({ type: "list_sessions" })).data, { sessions: [] });
      client.close();
    }
  });
});
