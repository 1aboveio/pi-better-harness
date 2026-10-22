import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once, getEventListeners } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { gunzipSync } from "node:zlib";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { validatePayload, type ArtifactPayload } from "../scripts/private-runtime/format.ts";
import { ownPackageDir } from "../src/startup/artifact.ts";
import type { ActivationResult, RemoteCommandResult, StagedRuntime } from "../src/startup/managed-types.ts";
import { shellQuote, type InstalledRuntime } from "../src/startup/runtime.ts";
import type { DaemonClient } from "../src/client.ts";
import { openUpgradeTransport } from "../src/remote-client/upgrade-transport.ts";
import { resolveTarget } from "../src/remote/target.ts";

function environment(t: TestContext, values: NodeJS.ProcessEnv) {
  const before = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}
function execute(command: string, env: NodeJS.ProcessEnv, input?: Buffer): Promise<RemoteCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env, stdio: "pipe" });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", () => {});
    child.on("close", exitCode => resolve({ exitCode, stdout, stderr }));
    child.stdin.end(input);
  });
}
const hello = () => ({ protocolVersion: 1, piVersion: PI_VERSION, capabilities: ["native-client-v1", "session-browser-v1"] });
const readiness = (serverDir: string) => ({ version: 1 as const, agent: "pi" as const, serverDir, socketPath: join(serverDir, "pi-server.sock"), hello: hello() });
type Command = { argv: string[]; command: string; operation: string; input: Buffer; pid: number };

/** Only the SSH/download/install boundary is faked. Discovery, staging, shell quoting and readiness run unchanged. */
async function fixture(t: TestContext, registered = false) {
  const root = realpathSync(mkdtempSync("/tmp/pcm-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const forwards = join(root, "forwards");
  mkdirSync(forwards);
  const remoteEnv = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, PI_SERVER_COMMAND: "", PI_CODING_AGENT_DIR: "/wrong/client-agent", PI_SERVER_DIR: "/wrong/client-state" };
  // The target platform deliberately differs from the test machine on macOS.
  writeFileSync(join(bin, "uname"), '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo aarch64; fi\n', { mode: 0o700 });
  const runtime: InstalledRuntime = { version: 1, agent: "pi", launcher: join(root, "legacy ' launcher"), agentDir: join(root, "registered ' agent"), defaultServerDir: join(root, "registered'state") };
  if (registered) {
    mkdirSync(join(root, ".pi"));
    mkdirSync(runtime.agentDir);
    mkdirSync(runtime.defaultServerDir);
    writeFileSync(join(root, ".pi/remote-server.json"), JSON.stringify(runtime));
    writeFileSync(join(runtime.agentDir, "auth.json"), "existing credentials");
    writeFileSync(join(runtime.defaultServerDir, "sessions.json"), "existing sessions");
  }
  const commands: Command[] = [];
  const activations: Array<{ argv: string[]; agentDir: string; serverDir: string }> = [];
  const sockets = new Set<Socket>();
  const pids = new Set<number>();
  let artifact: ArtifactPayload | undefined;
  let staged: StagedRuntime | undefined;
  let outcome: (serverDir: string) => unknown = serverDir => ({ status: "ready", readiness: { ...readiness(serverDir), hello: { ...hello(), build: staged!.build } } });
  let gate: ((command: Command) => boolean) | undefined;
  const waiters: Array<{ predicate: (command: Command) => boolean; resolve: (command: Command) => void }> = [];
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let data = "";
    socket.on("data", chunk => {
      data += chunk;
      if (!data.includes("\n")) return;
      const message = JSON.parse(data);
      data = "";
      const argv: string[] = message.argv;
      const op = argv.indexOf("-O");
      const command: Command = { argv, command: argv.at(-1)!, operation: op < 0 ? "command" : argv[op + 1]!, input: Buffer.from(message.input, "base64"), pid: message.pid };
      commands.push(command);
      pids.add(command.pid);
      socket.on("close", () => pids.delete(command.pid));
      for (const waiter of waiters.splice(0)) {
        if (waiter.predicate(command)) waiter.resolve(command); else waiters.push(waiter);
      }
      if (gate?.(command)) return;
      void respond(command).then(result => socket.end(JSON.stringify(result) + "\n"), error => socket.end(JSON.stringify({ exitCode: 1, stderr: String(error) }) + "\n"));
    });
  });
  server.listen(join(root, "control.sock"));
  await once(server, "listening");
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, "SIGTERM"); } catch {} }
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  async function respond(request: Command): Promise<RemoteCommandResult> {
    const ok = { exitCode: 0, stdout: "", stderr: "" };
    const { operation, command, input, argv } = request;
    if (operation === "forward" || operation === "cancel") {
      const path = argv[argv.indexOf("-L") + 1]!.split(":")[0]!;
      if (operation === "forward") writeFileSync(path, "forward"); else rmSync(path, { force: true });
      return ok;
    }
    if (operation !== "command") return ok;
    if (command.startsWith("curl ") || command.startsWith("set -eu; if command -v sha256sum")) return ok;
    if (command.startsWith("env -i ")) {
      const work = readdirSync(join(root, ".pi-better-server/managed")).find(name => name.startsWith(".stage-"))!;
      artifact = validatePayload(JSON.parse(gunzipSync(readFileSync(join(root, ".pi-better-server/managed", work, "artifact.gz"))).toString()));
      const installRoot = join(root, ".pi-better-server/managed");
      const release = join(installRoot, "releases", artifact.build.contentId);
      staged = { format: 1, build: artifact.build, root: release, installRoot, node: join(release, "node/bin/node"), entrypoint: join(release, "src/cli.ts"), manifestPath: join(release, "runtime.json") };
      mkdirSync(join(release, "node/bin"), { recursive: true });
      symlinkSync(join(ownPackageDir, "src"), join(release, "src"));
      // Capture activate argv/env after the real shell parsed it. Read-only probes run on the real Node.
      writeFileSync(staged.node, `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');\nif(process.argv[2]==='--input-type=module'){const r=spawnSync(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:'inherit'});process.exitCode=r.status??1;}else{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),agentDir:process.env.PI_CODING_AGENT_DIR,serverDir:process.env.PI_SERVER_DIR}));}\n`, { mode: 0o700 });
      return { ...ok, stdout: JSON.stringify(staged) };
    }
    if (command.includes("'activate'")) {
      const result = await execute(command, remoteEnv, input);
      if (result.exitCode !== 0) return result;
      const activation = JSON.parse(result.stdout);
      activations.push(activation);
      return { ...ok, stdout: JSON.stringify(outcome(activation.serverDir)) };
    }
    return execute(command, remoteEnv, input);
  }
  writeFileSync(join(bin, "ssh"), `#!${process.execPath}
const {createConnection}=require('node:net');
const chunks=[];
process.stdin.on('data',chunk=>chunks.push(chunk));
process.stdin.on('end',()=>{
  const socket=createConnection(${JSON.stringify(join(root, "control.sock"))});
  socket.on('connect',()=>socket.write(JSON.stringify({argv:process.argv.slice(2),pid:process.pid,input:Buffer.concat(chunks).toString('base64')})+'\\n'));
  let data='';
  socket.on('data',chunk=>{data+=chunk;if(!data.includes('\\n'))return;const result=JSON.parse(data);process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exitCode=result.exitCode??0;socket.end();});
});
`, { mode: 0o700 });
  environment(t, { PATH: `${bin}:${process.env.PATH}`, PI_REMOTE_TMP: forwards, PI_REMOTE_SERVER_DIR: undefined, PI_SERVER_COMMAND: undefined, PI_SERVER_AGENT: "pi" });
  return {
    root, runtime, remoteEnv, commands, activations, forwards,
    options: { host: "managed-fixture.invalid", controlPathRoot: join(root, "mux"), managedRuntime: true },
    artifact: () => artifact!,
    outcome: (value: typeof outcome) => { outcome = value; },
    gate: (value: typeof gate) => { gate = value; },
    next(predicate: (command: Command) => boolean): Promise<Command> {
      const found = commands.find(predicate);
      return found ? Promise.resolve(found) : new Promise(resolve => waiters.push({ predicate, resolve }));
    },
  };
}

async function existingDaemon(t: TestContext, serverDir: string, announced = hello()) {
  mkdirSync(serverDir, { recursive: true });
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", chunk => socket.write(JSON.stringify({ id: JSON.parse(String(chunk)).id, type: "response", success: true, data: announced }) + "\n"));
  });
  server.listen(join(serverDir, "pi-server.sock"));
  await once(server, "listening");
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
}

describe("managed remote connect", { concurrency: false, timeout: 60_000 }, () => {
  for (const mode of ["disabled", "older CLI default"] as const) {
    it(`preserves registered startup when managed installation is ${mode}`, { skip: mode === "older CLI default" && PI_VERSION === "1.2.0" }, async t => {
      const f = await fixture(t, true);
      writeFileSync(f.runtime.launcher, `#!/bin/sh\nif [ "$1" = runtime ]; then printf %s ${shellQuote(JSON.stringify(f.runtime))}; else printf %s ${shellQuote(JSON.stringify(readiness(f.runtime.defaultServerDir)))}; fi\n`, { mode: 0o700 });
      const target = await resolveTarget({ ...f.options, managedRuntime: mode === "disabled" ? false : undefined });
      await target.close();
      assert.equal(target.desiredBuild, undefined);
      assert.equal(target.serverDir, f.runtime.defaultServerDir);
      assert.equal(f.activations.length, 0);
      assert.equal(existsSync(join(f.root, ".pi-better-server")), false);
      assert.ok(f.commands.some(c => c.command.includes("'ensure'")));
    });
  }
  for (const registered of [false, true]) {
    it(`stages the client source for the target platform and activates ${registered ? "registered paths" : "a fresh default agent"}`, async t => {
      const f = await fixture(t, registered);
      const stages: string[] = [], upgrades: string[] = [];
      const controller = new AbortController();
      const target = await resolveTarget({ ...f.options, signal: controller.signal, onProgress: stage => stages.push(stage), onUpgradeProgress: stage => upgrades.push(stage) });
      const agentDir = registered ? f.runtime.agentDir : join(f.root, ".pi/agent");
      const serverDir = registered ? f.runtime.defaultServerDir : join(agentDir, "server");
      assert.equal(target.serverDir, serverDir);
      assert.ok(existsSync(agentDir), "a fresh activation must receive an existing agent directory");
      assert.deepEqual(f.activations[0]!.argv.slice(1, 9), ["activate", "--agent", "pi", "--runtime", join(f.root, ".pi-better-server/managed/releases", target.desiredBuild!.contentId, "runtime.json"), "--agent-dir", agentDir, "--server-dir"]);
      assert.equal(f.activations[0]!.agentDir, agentDir);
      assert.equal(f.activations[0]!.serverDir, serverDir);
      assert.equal(target.desiredBuild?.platform, "linux-arm64");
      const uploaded = f.commands.find(c => c.command.startsWith("cat > ") && c.command.endsWith("/artifact.gz'"))!;
      assert.deepEqual(validatePayload(JSON.parse(gunzipSync(uploaded.input).toString())).build, target.desiredBuild);
      assert.ok(uploaded.input.includes(0), "binary upload includes bytes that cannot travel in shell argv");
      assert.ok(f.artifact().files.some(file => file.path === "src/remote/target.ts"));
      assert.ok(f.commands.filter(c => c.operation === "command").every(c => c.argv.some(arg => arg.startsWith("ControlPath="))), "every runtime operation shares the SSH mux");
      assert.deepEqual(stages, ["ssh", "directory", "server", "forward"]);
      for (const stage of ["artifact", "node-download", "dependencies", "staged", "activating", "ready"]) assert.ok(upgrades.includes(stage));
      assert.ok(f.commands.some(c => c.operation === "forward" && c.argv.includes(`${target.socketPath}:${serverDir}/pi-server.sock`)));
      assert.deepEqual(readdirSync(join(f.root, ".pi-better-server/managed")), ["releases"]);
      if (registered) {
        assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), "existing credentials");
        assert.equal(readFileSync(join(serverDir, "sessions.json"), "utf8"), "existing sessions");
        assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".pi/remote-server.json"), "utf8")), f.runtime);
      }
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      controller.abort();
      const extra = await target.forwardSocket("/extra.sock");
      await extra.close();
      await target.close();
      assert.deepEqual(readdirSync(f.forwards), []);
    });
  }

  for (const selection of ["option", "environment"] as const) {
    it(`preserves registered agentDir with an explicit ${selection} state directory`, async t => {
      const f = await fixture(t, true);
      const state = join(f.root, "other'state");
      if (selection === "environment") environment(t, { PI_REMOTE_SERVER_DIR: state });
      const target = await resolveTarget({ ...f.options, ...(selection === "option" ? { remoteDir: state } : {}) });
      await target.close();
      assert.equal(f.activations[0]!.agentDir, f.runtime.agentDir);
      assert.equal(f.activations[0]!.serverDir, state);
      assert.deepEqual(JSON.parse(readFileSync(join(f.root, ".pi/remote-server.json"), "utf8")), f.runtime);
    });
  }

  it("canonicalizes an explicitly selected symlink to the same registered state before readiness validation", async t => {
    const f = await fixture(t, true);
    const alias = join(f.root, "state alias");
    symlinkSync(f.runtime.defaultServerDir, alias);
    const target = await resolveTarget({ ...f.options, remoteDir: alias });
    await target.close();
    assert.equal(target.serverDir, f.runtime.defaultServerDir);
    assert.equal(f.activations[0]!.serverDir, f.runtime.defaultServerDir);
    assert.equal(f.activations[0]!.agentDir, f.runtime.agentDir);
    assert.equal(readFileSync(join(alias, "sessions.json"), "utf8"), "existing sessions");
    assert.ok(f.commands.some(c => c.operation === "forward" && c.argv.includes(`${target.socketPath}:${f.runtime.defaultServerDir}/pi-server.sock`)));
  });

  it("recovers through the canonical registered directory without staging or activation even when ensure is requested", async t => {
    const f = await fixture(t, true);
    // Discovery selects a registered symlink, not the shell's default directory.
    const alias = join(f.root, "registered-state-alias");
    symlinkSync(f.runtime.defaultServerDir, alias);
    writeFileSync(join(f.root, ".pi/remote-server.json"), JSON.stringify({ ...f.runtime, defaultServerDir: alias }));
    const initial = await resolveTarget(f.options);
    assert.equal(initial.serverDir, f.runtime.defaultServerDir);
    await initial.close();
    const before = f.commands.length;
    const activated = f.activations.length;
    const releases = readdirSync(join(f.root, ".pi-better-server/managed/releases"));
    const replacement = await openUpgradeTransport({ ...f.options, ensureServer: true, remoteDir: initial.serverDir }, {
      resolveTarget,
      connectClient: async () => ({ server: { capabilities: ["native-client-v1"] }, close() {} }) as unknown as DaemonClient,
    }, new AbortController().signal);
    await replacement.dispose?.();
    const recovery = f.commands.slice(before);
    assert.ok(recovery.some(c => c.operation === "forward" && c.argv.some(arg => arg.endsWith(`:${f.runtime.defaultServerDir}/pi-server.sock`))));
    assert.equal(recovery.some(c => c.operation === "command"), false, "recovery runs no remote shell, discovery, stage, ensure or activation command");
    assert.equal(f.activations.length, activated);
    assert.deepEqual(readdirSync(join(f.root, ".pi-better-server/managed/releases")), releases);
    assert.deepEqual(readdirSync(f.forwards), []);
  });

  for (const reason of ["Waiting for idle sessions and reconnect-capable controllers", "Legacy or unverified live daemon; staged runtime is pending verified owner exit"]) {
    it(`connects to valid existing readiness while deferred: ${reason}`, async t => {
      const f = await fixture(t, true);
      await existingDaemon(t, f.runtime.defaultServerDir);
      f.outcome(() => ({ status: "deferred", operationId: "pending", reason } satisfies ActivationResult));
      const progress: Array<[string, string | undefined]> = [];
      const target = await resolveTarget({ ...f.options, onUpgradeProgress: (stage, detail) => progress.push([stage, detail]) });
      await target.close();
      assert.equal(target.desiredBuild?.contentId, f.artifact().build.contentId);
      assert.ok(progress.some(([stage, detail]) => stage === "deferred" && detail === reason));
      assert.equal(progress.some(([stage]) => stage === "ready"), false);
      assert.equal(f.activations.length, 1);
      assert.equal(f.commands.some(c => c.command.includes("'ensure'")), false);
      assert.ok(existsSync(join(f.runtime.defaultServerDir, "pi-server.sock")));
      assert.equal(readFileSync(join(f.runtime.defaultServerDir, "sessions.json"), "utf8"), "existing sessions");
    });
  }

  for (const mode of ["absent", "incompatible", "recovery", "wrong-build", "malformed"] as const) {
    it(`does not forward or manually ensure after ${mode} readiness`, async t => {
      const f = await fixture(t, true);
      if (mode === "incompatible") await existingDaemon(t, f.runtime.defaultServerDir, { ...hello(), capabilities: [] });
      f.outcome(serverDir => mode === "recovery" ? { status: "recovery-required", operationId: "pending", reason: "owner needs recovery" }
        : mode === "wrong-build" ? { status: "ready", readiness: readiness(serverDir) }
        : mode === "malformed" ? { status: "unknown" }
        : { status: "deferred", operationId: "pending", reason: "busy or legacy" });
      await assert.rejects(resolveTarget(f.options), mode === "recovery" ? /requires recovery.*owner needs recovery/ : mode === "wrong-build" ? /does not match the desired build/ : mode === "malformed" ? /Invalid runtime activation/ : /Runtime activation deferred.*Existing daemon readiness/);
      assert.equal(f.commands.some(c => c.operation === "forward" || c.command.includes("'ensure'")), false);
      assert.deepEqual(readdirSync(f.forwards), []);
    });
  }

  for (const source of ["client", "host"] as const) {
    it(`keeps the ${source} explicit launcher authoritative without staging`, async t => {
      const f = await fixture(t, true);
      const manual = { ...f.runtime, launcher: join(f.root, "manual ' launcher"), agentDir: join(f.root, "manual agent"), defaultServerDir: join(f.root, "manual-state") };
      writeFileSync(manual.launcher, `#!/bin/sh\nif [ "$1" = runtime ]; then printf %s ${shellQuote(JSON.stringify(manual))}; else printf %s ${shellQuote(JSON.stringify(readiness(manual.defaultServerDir)))}; fi\n`, { mode: 0o700 });
      // Managed platform discovery must not restrict an explicit manual launcher.
      writeFileSync(join(f.root, "bin/uname"), "#!/bin/sh\necho unsupported\n", { mode: 0o700 });
      if (source === "client") environment(t, { PI_SERVER_COMMAND: manual.launcher }); else f.remoteEnv.PI_SERVER_COMMAND = manual.launcher;
      const target = await resolveTarget(f.options);
      await target.close();
      assert.equal(target.desiredBuild, undefined);
      assert.equal(f.activations.length, 0);
      assert.equal(existsSync(join(f.root, ".pi-better-server")), false);
      assert.ok(f.commands.some(c => c.operation === "forward" && c.argv.includes(`${target.socketPath}:${manual.defaultServerDir}/pi-server.sock`)));
    });
  }

  for (const stage of ["upload", "activation"] as const) {
    it(`cancels stalled ${stage} work without disabling staging cleanup or starting a forward`, async t => {
      const f = await fixture(t);
      const stalled = (c: Command) => stage === "upload" ? c.command.startsWith("cat > ") && c.command.endsWith("/artifact.gz'") : c.command.includes("'activate'");
      f.gate(stalled);
      const controller = new AbortController();
      const pending = resolveTarget({ ...f.options, signal: controller.signal });
      const rejection = assert.rejects(pending, { name: "AbortError" });
      const command = await f.next(stalled);
      controller.abort();
      await rejection;
      assert.throws(() => process.kill(command.pid, 0), { code: "ESRCH" });
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(f.commands.some(c => c.operation === "forward" || c.operation === "exit"), false);
      assert.equal(readdirSync(join(f.root, ".pi-better-server/managed")).some(name => name.startsWith(".stage-")), false);
      if (stage === "upload") assert.ok(f.commands.some(c => c.command.startsWith(": > ") && c.command.endsWith("/cancel'")));
    });
  }

  it("stops before installation when an upgrade progress callback cancels", async t => {
    const f = await fixture(t);
    const controller = new AbortController();
    await assert.rejects(resolveTarget({ ...f.options, signal: controller.signal, onUpgradeProgress: stage => { if (stage === "artifact") controller.abort(); } }), { name: "AbortError" });
    assert.equal(existsSync(join(f.root, ".pi-better-server")), false);
    assert.equal(f.commands.some(c => c.operation === "forward"), false);
  });
});
