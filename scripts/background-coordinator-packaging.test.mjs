// @covers background-coordinator.packaging
// @level integration
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { coordinatorPaths } from "../packages/pi-better-background-tasks/src/coordinator/paths.ts";
import { COORDINATOR_PROTOCOL_VERSION } from "../packages/pi-better-background-tasks/src/coordinator/protocol.ts";
import { selectPackedResult } from "./stage-harness-dependencies.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const packageDir = join(repoRoot, "packages", "pi-better-background-tasks");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function timed(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  })]).finally(() => clearTimeout(timer));
}

async function connectWhenReady(path, child, stderr, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (!child.pid) {
      await delay(50, undefined, { ref: false });
      throw new Error(`coordinator failed to spawn: ${stderr().slice(-2000)}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`coordinator exited before readiness (${child.exitCode ?? child.signalCode}): ${stderr().slice(-2000)}`);
    }
    try {
      return await new Promise((resolvePromise, reject) => {
        const socket = connect(path);
        const fail = (error) => { socket.destroy(); reject(error); };
        socket.once("error", fail);
        socket.once("connect", () => { socket.off("error", fail); resolvePromise(socket); });
      });
    } catch (error) { lastError = error; }
    await delay(50, undefined, { ref: false });
  }
  throw new Error(`coordinator socket never accepted IPC (${path}): ${lastError?.message}; stderr=${stderr().slice(-2000)}`);
}

function jsonLines(socket) {
  const reader = createInterface({ input: socket, crlfDelay: Infinity });
  const lines = reader[Symbol.asyncIterator]();
  return {
    async next() {
      const result = await timed(lines.next(), 5_000, "timed out waiting for coordinator IPC");
      assert.equal(result.done, false, "coordinator closed the IPC stream");
      return JSON.parse(result.value);
    },
    close: () => reader.close(),
  };
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(3_000, undefined, { ref: false })]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.race([exited, delay(2_000, undefined, { ref: false })]);
}

test("the packed coordinator executable serves stats from node_modules", async () => {
  const envKeys = ["TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR"];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const root = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "pi-bg-pack-")));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) process.env[key] = root;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  let child, socket, socketPath;
  try {
    const output = execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", root], {
      cwd: packageDir, encoding: "utf8", shell: process.platform === "win32", stdio: ["ignore", "pipe", "inherit"],
    });
    const packed = selectPackedResult(output);
    assert.ok(packed?.filename, `npm pack returned no tarball: ${output.slice(0, 500)}`);

    const installed = join(root, "node_modules", "pi-better-background-tasks");
    mkdirSync(installed, { recursive: true });
    execFileSync("tar", ["-xzf", join(root, packed.filename), "--strip-components=1", "-C", installed], { stdio: "inherit" });
    const store = join(root, "operations.sqlite");
    const supervisor = join(root, "supervisor");
    const state = join(root, "state");
    socketPath = coordinatorPaths(store, supervisor, state).socket;

    const env = { ...process.env };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    child = spawn(process.execPath, [
      join(installed, "src/coordinator/generated/coordinator.mjs"),
      "--store", store, "--supervisor", supervisor, "--state", state,
    ], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { stderr += `\nspawn error: ${error.stack ?? error.message}`; });

    socket = await connectWhenReady(socketPath, child, () => stderr);
    const replies = jsonLines(socket);
    try {
      const hello = await replies.next();
      assert.equal(hello.type, "hello");
      assert.equal(hello.version, COORDINATOR_PROTOCOL_VERSION);
      socket.write(`${JSON.stringify({ type: "stats", version: COORDINATOR_PROTOCOL_VERSION, clientId: "packaging", requestId: "packaging-stats" })}\n`);
      const reply = await replies.next();
      assert.equal(reply.type, "stats");
      assert.equal(reply.requestId, "packaging-stats");
      assert.equal(reply.stats.pid, child.pid, "stats must come from the spawned standalone coordinator");
      assert.equal(reply.stats.connectedClients, 1);
    } finally { replies.close(); }
  } finally {
    if (child) await stopChild(child);
    socket?.destroy();
    if (socketPath) try { unlinkSync(socketPath); } catch { /* Windows named pipes and already-removed sockets */ }
    for (const key of envKeys) {
      if (previous.get(key) === undefined) delete process.env[key];
      else process.env[key] = previous.get(key);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
