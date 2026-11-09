/**
 * Real multi-PROCESS acceptance for issue #675.
 *
 * - 17 independent Node processes connect to one shared coordinator over the
 *   emitted Unix-socket entrypoint, against a real SQLite store and a 2,500-row
 *   terminal fixture. The central running-set scan count is independent of the
 *   client count.
 * - killing the leader proves reconnect/failover and that a replacement process
 *   is elected with verified identity.
 * - 17 independent observed-wait hosts share one store; one owner's real
 *   supervised task completion reaches that owner only. No other host receives
 *   a notification, and synchronization never calls a model API.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { openStore } from "../shared-operation-coordinator/index.js";
import { coordinatorPaths } from "./paths.js";
import { CoordinatorServer } from "./server.js";
import { CoordinatorClient } from "./client.js";
import { COORDINATOR_PROTOCOL_VERSION } from "./protocol.js";

const tsxImport = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const packageSource = dirname(fileURLToPath(import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
const fixtures: Fixture[] = [];
const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  // Stop reconnecting clients before any leader can disappear during teardown.
  await Promise.all(fixtures.filter((fixture) => fixture.graceful && !fixture.isClosed).map(async (fixture) => {
    fixture.child.stdin.write("close\n");
    await waitForLine(fixture, /^CLOSED$/);
  }));
  while (cleanups.length > 0) await cleanups.pop()!();
  fixtures.length = 0;
  if (originalAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
});

function workspace(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `pi-coordinator-mp-${name}-`));
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  cleanups.push(() => {
    try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) {
      console.error("fixture removal failed", JSON.stringify({ root, children: fixtures.map((fixture) => ({
        pid: fixture.child.pid, closed: fixture.isClosed, exitCode: fixture.child.exitCode,
        signal: fixture.child.signalCode, tail: fixture.lines.slice(-3), stderr: fixture.stderr.slice(-500),
      })) }));
      throw error;
    }
  });
  return root;
}

interface Fixture {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  waiters: Array<{ pattern: RegExp; resolve: (line: string) => void }>;
  stderr: string;
  closed: Promise<void>;
  isClosed: boolean;
  graceful?: boolean;
}

function startFixture(script: string, args: string[], cwd: string, environment: Record<string, string> = {}): Fixture {
  const child = spawn(process.execPath, ["--import", tsxImport, script, ...args], {
    cwd,
    env: { ...process.env, PI_BG_COORDINATOR: "on", ...environment },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  const fixture: Fixture = { child, lines: [], waiters: [], stderr: "", isClosed: false,
    closed: new Promise<void>((resolve) => child.once("close", () => { fixture.isClosed = true; resolve(); })) };
  fixtures.push(fixture);
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { fixture.stderr += chunk; });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      fixture.lines.push(line);
      for (let index = fixture.waiters.length - 1; index >= 0; index -= 1) {
        const waiter = fixture.waiters[index]!;
        if (!waiter.pattern.test(line)) continue;
        fixture.waiters.splice(index, 1);
        waiter.resolve(line);
      }
      newline = buffer.indexOf("\n");
    }
  });
  cleanups.push(async () => {
    if (!fixture.isClosed) {
      if (fixture.graceful) child.stdin.write("exit\n");
      else child.kill("SIGKILL");
    }
    await waitForClose(fixture);
  });
  return fixture;
}

async function waitForClose(fixture: Fixture): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fixture.closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture did not close: pid=${fixture.child.pid}; stdout=${fixture.lines.slice(-5).join("|")}; stderr=${fixture.stderr.slice(-1000)}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitForLine(fixture: Fixture, pattern: RegExp, timeoutMs = 30_000): Promise<string> {
  const existing = fixture.lines.find((line) => pattern.test(line));
  if (existing) return existing;
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for ${pattern}; stderr=${fixture.stderr.slice(-2000)}; stdout=${fixture.lines.join("\n")}`));
    }, timeoutMs);
    fixture.waiters.push({
      pattern,
      resolve: (line) => { clearTimeout(timer); resolve(line); },
    });
  });
}

function writeIdleFixture(root: string): string {
  const entryPath = join(root, "source-coordinator.mjs");
  const api = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
  writeFileSync(entryPath, `import { tsImport } from ${JSON.stringify(api)}; await tsImport(${JSON.stringify(pathToFileURL(join(packageSource, "runner.ts")).href)}, import.meta.url);`);
  const path = join(root, "idle-client.mts");
  // Keep real on-demand spawning, but retain its ChildProcess handles inside
  // the spawning fixture so failover and teardown never signal a stored PID.
  writeFileSync(path, [
    `import { createInterface } from "node:readline";`,
    `import childProcess from "node:child_process";`,
    `import { syncBuiltinESMExports } from "node:module";`,
    `import { CoordinatorClient } from ${JSON.stringify(pathToFileURL(join(packageSource, "client.ts")).href)};`,
    `import { coordinatorPaths } from ${JSON.stringify(pathToFileURL(join(packageSource, "paths.ts")).href)};`,
    `const [storePath, supervisorDirectory, sessionId] = process.argv.slice(2);`,
    `const owned = new Map();`,
    `const originalSpawn = childProcess.spawn;`,
    `childProcess.spawn = (...args) => {`,
    `  const child = originalSpawn(...args);`,
    `  if (args[1]?.includes(${JSON.stringify(entryPath)})) owned.set(child, new Promise(resolve => child.once("close", resolve)));`,
    `  return child;`,
    `};`,
    `syncBuiltinESMExports();`,
    `async function stopOwned(pid) {`,
    `  const children = [...owned].filter(([child]) => pid === undefined || child.pid === pid);`,
    `  for (const [child] of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");`,
    `  await Promise.all(children.map(([, closed]) => closed));`,
    `  return children.length;`,
    `}`,
    `const client = new CoordinatorClient({`,
    `  storePath, supervisorDirectory,`,
    `  stateDirectory: coordinatorPaths(storePath, supervisorDirectory).stateDirectory,`,
    `  spawnServer: true,`,
    `  entryPath: ${JSON.stringify(entryPath)},`,
    `  onLog: (line) => process.stderr.write("coordinator: " + line + "\\n"),`,
    `});`,
    `const owner = { kind: "parent-session", sessionId, workspace: ${JSON.stringify(root)}, branchId: "branch", goalId: null };`,
    `await client.start([owner]);`,
    `process.stdout.write("READY\\n");`,
    `const rl = createInterface({ input: process.stdin });`,
    `rl.on("line", async (line) => {`,
    `  if (line === "stats") { const stats = await client.stats(); process.stdout.write("STATS " + JSON.stringify(stats) + "\\n"); }`,
    `  if (line === "close") { client.close(); process.stdout.write("CLOSED\\n"); }`,
    `  if (line.startsWith("kill ")) { const pid = Number(line.slice(5)); process.stdout.write("OWNED " + pid + " " + await stopOwned(pid) + "\\n"); }`,
    `  if (line === "exit") { client.close(); console.log("STOPPING OWNED " + [...owned.keys()].map(child => child.pid).join(",")); await stopOwned(); process.exit(0); }`,
    `});`,
  ].join("\n"));
  return path;
}

function writeHostFixture(root: string): string {
  const path = join(root, "host-client.mts");
  writeFileSync(path, [
    `import { EventEmitter } from "node:events";`,
    `import { createInterface } from "node:readline";`,
    `import { createObservedWaitHost } from ${JSON.stringify(pathToFileURL(join(packageSource, "..", "observed-waits.ts")).href)};`,
    `const [storePath, supervisorDirectory, sessionId, role] = process.argv.slice(2);`,
    `const ctx = { cwd: ${JSON.stringify(root)}, sessionManager: { getSessionId: () => sessionId, getBranch: () => [{ id: "branch" }] }, isIdle: () => true };`,
    `const events = new EventEmitter();`,
    `const pi = { events, on() { return () => {}; }, registerTool(definition) { return definition; } };`,
    `const host = createObservedWaitHost(pi, {`,
    `  storePath, supervisorDirectory, coordinator: true,`,
    `  notifyParent: (notification, delivery) => {`,
    `    process.stdout.write("NOTIFY " + JSON.stringify({ sessionId, taskId: notification.taskId, waitId: notification.waitId ?? null, status: notification.status }) + "\\n");`,
    `    delivery.delivered();`,
    `  },`,
    `});`,
    `host.start(ctx);`,
    `process.stdout.write("READY\\n");`,
    `if (role === "launcher") {`,
    `  const launch = await host.launchParent({ kind: "process", params: { argv: [process.execPath, "-e", "process.exit(0)"], shell: false, callback: true }, ctx });`,
    `  process.stdout.write("LAUNCH " + JSON.stringify({ taskId: launch.id, operationId: launch.operationId }) + "\\n");`,
    `}`,
    `const rl = createInterface({ input: process.stdin });`,
    `rl.on("line", (line) => {`,
    `  if (line === "close") { host.close(); process.stdout.write("CLOSED\\n"); }`,
    `  if (line === "exit") { host.close(); process.exit(0); }`,
    `});`,
    `setTimeout(() => process.exit(0), 25_000);`,
  ].join("\n"));
  return path;
}

describe("real multi-process coordinator acceptance", () => {
  it("lets an idle subscribed client exit naturally while the external leader stays alive", async () => {
    const root = workspace("idle-exit");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), spawnServer: false };
    const server = (await CoordinatorServer.start(options)).server!;
    cleanups.push(() => server.close());
    const script = join(root, "idle-exit.mts");
    writeFileSync(script, `import { CoordinatorClient } from ${JSON.stringify(pathToFileURL(join(packageSource, "client.ts")).href)};
      const client = new CoordinatorClient(${JSON.stringify(options)});
      await client.start([{ kind: "parent-session", sessionId: "idle-exit", workspace: ${JSON.stringify(root)}, branchId: null, goalId: null }]);
      console.log("STARTED");`);
    const fixture = startFixture(script, [], root);
    await waitForLine(fixture, /^STARTED$/);
    await waitForClose(fixture);
    expect(fixture.child.exitCode).toBe(0);
    const observer = new CoordinatorClient(options);
    cleanups.push(() => observer.close());
    await observer.start([]);
    expect((await observer.stats()).pid).toBe(process.pid);
  }, 15_000);

  it.each(["reply", "timeout"])("keeps a child alive through delayed subscription and pending RPC %s, then exits naturally", async (mode) => {
    const root = workspace(`rpc-exit-${mode}`);
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), spawnServer: false };
    const paths = coordinatorPaths(options.storePath, options.supervisorDirectory);
    if (process.platform !== "win32") mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 });
    const sockets = new Set<Socket>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let statsRequests = 0;
    const peer = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          if (request.type === "stats") statsRequests++;
          if (request.type === "stats" && mode === "timeout") continue;
          const reply = request.type === "subscribe"
            ? { type: "subscribed", owners: 0, latestSeq: 0 }
            : { type: "stats", stats: { pid: process.pid } };
          const timer = setTimeout(() => {
            timers.delete(timer);
            socket.write(JSON.stringify({ ...reply, version: COORDINATOR_PROTOCOL_VERSION, requestId: request.requestId }) + "\n");
          }, request.type === "subscribe" ? 200 : 200 * statsRequests);
          timers.add(timer);
        }
      });
    });
    await new Promise<void>((resolve) => peer.listen(paths.socket, resolve));
    cleanups.push(async () => {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => peer.close(() => resolve()));
    });
    const script = join(root, "rpc-exit.mts");
    writeFileSync(script, `import assert from "node:assert/strict";
      import { CoordinatorClient } from ${JSON.stringify(pathToFileURL(join(packageSource, "client.ts")).href)};
      const client = new CoordinatorClient(${JSON.stringify(options)});
      await client.start([]);
      console.log("STARTED");
      ${mode === "reply"
        ? `const replies = await Promise.all([client.stats(), client.stats()]); assert.ok(replies.every(reply => reply.pid === ${process.pid}));`
        : `await assert.rejects(client.stats(), /coordinator request timed out/);`}
      console.log("SETTLED");`);
    const fixture = startFixture(script, [], root);
    await waitForLine(fixture, /^SETTLED$/);
    await waitForClose(fixture);
    expect(fixture.child.exitCode).toBe(0);
    expect(statsRequests).toBe(mode === "reply" ? 2 : 1);
  }, 15_000);

  it("keeps an awaited unavailable start alive until its bounded rejection", async () => {
    const root = workspace("unavailable-exit");
    const options = { storePath: join(root, "operations.sqlite"), supervisorDirectory: join(root, "supervisor"), stateDirectory: join(root, "state"), spawnServer: false };
    const script = join(root, "unavailable-exit.mts");
    writeFileSync(script, `import assert from "node:assert/strict";
      import { CoordinatorClient } from ${JSON.stringify(pathToFileURL(join(packageSource, "client.ts")).href)};
      const client = new CoordinatorClient(${JSON.stringify(options)});
      await assert.rejects(client.start([]), /unavailable after 8 attempts/);
      console.log("UNAVAILABLE");`);
    const fixture = startFixture(script, [], root);
    await waitForLine(fixture, /^UNAVAILABLE$/);
    await waitForClose(fixture);
    expect(fixture.child.exitCode).toBe(0);
  }, 15_000);

  it.skipIf(process.platform === "win32").each([false, true])("shares election and discovery across temporary and agent environments (explicit state: %s)", async (explicitState) => {
    const root = workspace("environment-namespace");
    const storePath = join(root, "operations.sqlite"), supervisorDirectory = join(root, "supervisor");
    const script = join(root, "environment.mts");
    writeFileSync(script, `import { CoordinatorServer } from ${JSON.stringify(pathToFileURL(join(packageSource, "server.ts")).href)};
      import { CoordinatorClient } from ${JSON.stringify(pathToFileURL(join(packageSource, "client.ts")).href)};
      import { coordinatorPaths } from ${JSON.stringify(pathToFileURL(join(packageSource, "paths.ts")).href)};
      const storePath = ${JSON.stringify(storePath)}, supervisorDirectory = ${JSON.stringify(supervisorDirectory)};
      const paths = coordinatorPaths(storePath, supervisorDirectory, ${explicitState ? JSON.stringify(join(root, "state")) : "undefined"});
      console.log("PATHS " + JSON.stringify({ socket: paths.socket, election: paths.leaderDb }));
      const options = { storePath, supervisorDirectory, stateDirectory: paths.stateDirectory, safetyIntervalMs: 60000 };
      const result = await CoordinatorServer.start({ ...options, onElectionLocked: process.argv[2] === "pause" ? () => { console.log("LOCKED"); process.kill(process.pid, "SIGSTOP"); } : undefined });
      console.log("LEADER " + result.leader);
      const client = new CoordinatorClient({ ...options, spawnServer: false });
      await client.start([]);
      console.log("CONNECTED " + (await client.stats()).pid);`);
    const environment = (name: string) => {
      const temporary = join(root, name);
      mkdirSync(temporary);
      return { TMPDIR: temporary, TMP: temporary, TEMP: temporary, PI_CODING_AGENT_DIR: join(root, `agent-${name}`) };
    };
    const first = startFixture(script, ["pause"], root, environment("first"));
    await waitForLine(first, /^LOCKED$/);
    const second = startFixture(script, [], root, environment("second"));
    await waitForLine(second, /^LEADER false$/);
    expect(await waitForLine(second, /^PATHS /)).toBe(await waitForLine(first, /^PATHS /));
    first.child.kill("SIGCONT");
    await waitForLine(first, /^LEADER true$/);
    const firstConnection = await waitForLine(first, /^CONNECTED /);
    expect(await waitForLine(second, /^CONNECTED /)).toBe(firstConnection);
    expect(Number(firstConnection.slice(10))).toBe(first.child.pid);
  }, 30_000);

  it.skipIf(process.platform === "win32")("holds exclusion across interrupted publication and stale diagnostic replacement", async () => {
    const root = workspace("election-publication");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const script = join(root, "election.mts");
    writeFileSync(script, `import { CoordinatorServer } from ${JSON.stringify(pathToFileURL(join(packageSource, "server.ts")).href)};
      const paused = process.argv[2] === "pause";
      const result = await CoordinatorServer.start({ storePath: ${JSON.stringify(storePath)}, supervisorDirectory: ${JSON.stringify(supervisorDirectory)}, stateDirectory: ${JSON.stringify(join(root, "state"))},
        onElectionLocked: paused ? () => { console.log("LOCKED"); process.kill(process.pid, "SIGSTOP"); } : undefined });
      console.log("LEADER " + result.leader);
      if (!result.leader) process.exit(0);`);
    const first = startFixture(script, ["pause"], root);
    await waitForLine(first, /^LOCKED$/);
    // Another process observes the old empty-file publication interval.
    const paths = coordinatorPaths(storePath, supervisorDirectory, join(root, "state"));
    writeFileSync(paths.lock, "");
    const contender = startFixture(script, [], root);
    await waitForLine(contender, /^LEADER false$/);
    first.child.kill("SIGCONT");
    await waitForLine(first, /^LEADER true$/);
    // Simulate a stale reclaimer replacing the diagnostic while a leader lives.
    writeFileSync(paths.lock, JSON.stringify({ version: 1, pid: 99999999, nonce: "stale" }));
    await waitForLine(startFixture(script, [], root), /^LEADER false$/);
    const exited = new Promise<void>((resolve) => first.child.once("exit", () => resolve()));
    first.child.kill("SIGKILL");
    await exited;
    await waitForLine(startFixture(script, [], root), /^LEADER true$/);
  }, 30_000);

  it("17 processes share one central scan and recover when the leader dies", async () => {
    const root = workspace("idle");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");

    // Seed thousands of terminal rows directly. They are historical data, never
    // work: the coordinator's idle path must not compensate by scanning them.
    const seed = openStore({ path: storePath });
    seed.close();
    const db = new DatabaseSync(storePath);
    const insert = db.prepare(
      `INSERT INTO operations (
        operation_id, task_id, launch_token, owner_kind, owner_session_id, owner_workspace,
        owner_branch_id, owner_goal_id, observer_kind, observer_version, phase, health,
        terminal_revision, terminal_outcome, terminal_event_id, terminal_detail_lost,
        terminal_reason, created_at, updated_at, terminal_at
      ) VALUES (?, ?, ?, 'parent-session', 'fixture-owner', ?, 'branch', NULL,
        'local-supervisor', '1', 'terminal', 'active', 1, 'succeeded', ?, 0, NULL, ?, ?, ?)`,
    );
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < 2_500; index += 1) {
      const operationId = `op_fixture_${index}`;
      insert.run(
        operationId,
        `bgs_fixture_${String(index).padStart(13, "0")}`,
        `launch_fixture_${index}`,
        root,
        `${operationId}:terminal`,
        now - 30 * 24 * 60 * 60 * 1000,
        now - 30 * 24 * 60 * 60 * 1000,
        now - 30 * 24 * 60 * 60 * 1000,
      );
    }
    db.exec("COMMIT");
    db.close();

    const script = writeIdleFixture(root);
    const clients = Array.from({ length: 17 }, (_, index) =>
      startFixture(script, [storePath, supervisorDirectory, `idle-session-${index}`], root));
    for (const client of clients) client.graceful = true;
    await Promise.all(clients.map((client) => waitForLine(client, /^READY$/)));

    await new Promise((resolve) => setTimeout(resolve, 900));
    clients[0]!.child.stdin.write("stats\n");
    const firstStatsLine = await waitForLine(clients[0]!, /^STATS /);
    clients[0]!.lines.splice(clients[0]!.lines.indexOf(firstStatsLine), 1);
    const firstStats = JSON.parse(firstStatsLine.slice(6)) as {
      pid: number;
      connectedClients: number;
      runningScans: number;
      terminalScans: number;
    };
    expect(firstStats.connectedClients).toBe(17);
    console.info("675 measured idle baseline", JSON.stringify(firstStats));
    expect(firstStats.terminalScans).toBe(0);
    // 17 subscribers cannot multiply a central cadence. At 1s this window is
    // allowed a small scheduling margin, never 17 separate scans.
    expect(firstStats.runningScans).toBeLessThanOrEqual(18);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    clients[0]!.child.stdin.write("stats\n");
    const measuredLine = await waitForLine(clients[0]!, /^STATS /);
    clients[0]!.lines.splice(clients[0]!.lines.indexOf(measuredLine), 1);
    const measured = JSON.parse(measuredLine.slice(6));
    const scanDelta = measured.runningScans - firstStats.runningScans;
    expect(scanDelta).toBeGreaterThanOrEqual(1);
    expect(scanDelta).toBeLessThanOrEqual(4);
    expect(measured.terminalScans).toBe(0);
    expect(measured.changeReads).toBe(0);
    console.info("675 measured 1100ms scan delta", scanDelta);

    // Kill only the leader. Every client must reconnect and all must converge on
    // one newly elected process with a different pid.
    for (const client of clients) client.child.stdin.write(`kill ${firstStats.pid}\n`);
    const owners = await Promise.all(clients.map((client) => waitForLine(client, new RegExp(`^OWNED ${firstStats.pid} `))));
    expect(owners.filter((line) => line.endsWith(" 1"))).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 600));
    let secondStats: {
      pid: number;
      connectedClients: number;
    } | undefined;
    const reconnectDeadline = Date.now() + 15_000;
    while (Date.now() < reconnectDeadline) {
      clients[0]!.child.stdin.write("stats\n");
      const line = await waitForLine(clients[0]!, /^STATS /);
      clients[0]!.lines.splice(clients[0]!.lines.indexOf(line), 1);
      secondStats = JSON.parse(line.slice(6)) as { pid: number; connectedClients: number };
      if (secondStats.connectedClients === 17 && secondStats.pid !== firstStats.pid) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(secondStats).toBeDefined();
    expect(secondStats!.pid).not.toBe(firstStats.pid);
    expect(secondStats!.connectedClients).toBe(17);
    console.info("675 measured failover", JSON.stringify(secondStats));

  }, 90_000);

  it("17 real hosts deliver one owner's completion only to that owner, without a model wake", async () => {
    const root = workspace("hosts");
    const storePath = join(root, "operations.sqlite");
    const supervisorDirectory = join(root, "supervisor");
    const script = writeHostFixture(root);
    const serverScript = join(root, "source-server.mts");
    writeFileSync(serverScript, `import { CoordinatorServer } from ${JSON.stringify(pathToFileURL(join(packageSource, "server.ts")).href)};
      import { coordinatorPaths } from ${JSON.stringify(pathToFileURL(join(packageSource, "paths.ts")).href)};
      await CoordinatorServer.start({ storePath: ${JSON.stringify(storePath)}, supervisorDirectory: ${JSON.stringify(supervisorDirectory)}, stateDirectory: coordinatorPaths(${JSON.stringify(storePath)}, ${JSON.stringify(supervisorDirectory)}).stateDirectory });
      console.log("READY");`);
    await waitForLine(startFixture(serverScript, [], root), /^READY$/);
    const hosts = Array.from({ length: 17 }, (_, index) =>
      startFixture(script, [storePath, supervisorDirectory, `owner-${index}`, index === 0 ? "launcher" : "idle"], root));
    for (const host of hosts) host.graceful = true;
    await Promise.all(hosts.map((host) => waitForLine(host, /^READY$/)));
    const launched = JSON.parse((await waitForLine(hosts[0]!, /^LAUNCH /)).slice(7)) as {
      taskId: string;
      operationId: string;
    };
    const notification = JSON.parse((await waitForLine(hosts[0]!, /^NOTIFY /)).slice(7)) as {
      sessionId: string;
      taskId: string;
      status: string;
    };
    expect(notification.sessionId).toBe("owner-0");
    expect(notification.taskId).toBe(launched.taskId);
    expect(notification.status).toBe("succeeded");

    await new Promise((resolve) => setTimeout(resolve, 500));
    for (const host of hosts.slice(1)) {
      expect(host.lines.some((line) => line.startsWith("NOTIFY "))).toBe(false);
    }
    const store = openStore({ path: storePath });
    cleanups.push(() => store.close());
    expect(store.getOperation(launched.operationId)?.terminalRevision).toBe(1);
    expect(store.getOperation(launched.operationId)?.terminalOutcome).toBe("succeeded");
  }, 90_000);
});
