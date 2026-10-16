import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeLine, LineDecoder } from "../src/protocol.ts";

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
process.on("exit", () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

export interface Env {
  root: string;
  agentDir: string;
  serverDir: string;
  gateDir: string;
  logFile: string;
  cwd: string;
  /** Environment variables that point a Pi process at this test setup. */
  vars: Record<string, string>;
}

/** A private agent dir with the scripted-provider extension, plus gate/log dirs. Short path: unix sockets cap at ~104 bytes. */
export function makeEnv(): Env {
  // A short base path, not the isolated TMPDIR: a unix socket path is capped near 104 bytes.
  const root = realpathSync(mkdtempSync(join(process.env.PI_SERVER_TEST_BASE ?? (existsSync("/tmp") ? "/tmp" : tmpdir()), "pbs-")));
  roots.push(root);
  const agentDir = join(root, "agent");
  const serverDir = join(root, "srv");
  const gateDir = join(root, "gate");
  const cwd = join(root, "work");
  mkdirSync(gateDir);
  mkdirSync(cwd);
  cpSync(join(here, "fixtures", "agent"), agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fake", defaultModel: "fake-1" }));
  // Never let a developer's real provider keys leak into a test session.
  for (const key of Object.keys(process.env)) if (/(_API_KEY|_TOKEN|_AUTH_TOKEN)$/.test(key)) delete process.env[key];
  const logFile = join(root, "llm.log");
  writeFileSync(logFile, "");
  return {
    root,
    agentDir,
    serverDir,
    gateDir,
    logFile,
    cwd,
    vars: { PI_CODING_AGENT_DIR: agentDir, PI_SERVER_DIR: serverDir, PI_FAKE_GATE_DIR: gateDir, PI_FAKE_LOG: logFile },
  };
}

export function llmCalls(env: Env): Array<{ at: number; messages: Array<{ role: string; text: string }> }> {
  return readFileSync(env.logFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export class Client {
  private readonly pending = new Map<string, (message: any) => void>();
  readonly events: any[] = [];
  private nextId = 1;

  private readonly socket: Socket;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding("utf8");
    const decoder = new LineDecoder(
      (line) => {
        const message = JSON.parse(line);
        if (message.type === "event") this.events.push(message);
        else if (message.id && this.pending.has(message.id)) {
          this.pending.get(message.id)!(message);
          this.pending.delete(message.id);
        }
      },
      () => undefined,
    );
    socket.on("data", (chunk: string) => decoder.push(chunk));
  }

  static connect(path: string): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once("connect", () => resolve(new Client(socket)));
      socket.once("error", reject);
    });
  }

  request(command: Record<string, unknown>): Promise<any> {
    const id = `r${this.nextId++}`;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.write(encodeLine({ ...command, id }));
    });
  }

  /** Resolve with the response to a request id that was written with `sendRaw`. */
  responseFor(id: string): Promise<any> {
    return new Promise((resolve) => this.pending.set(id, resolve));
  }

  sendRaw(text: string): void {
    this.socket.write(text);
  }

  close(): void {
    this.socket.destroy();
  }
}

export async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 15_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function gate(env: Env, name: string) {
  return {
    started: () => existsSync(join(env.gateDir, `${name}.started`)),
    finished: () => existsSync(join(env.gateDir, `${name}.finished`)),
    release: () => writeFileSync(join(env.gateDir, `${name}.release`), "1"),
  };
}

/** Spawn the daemon as a real child process (so tests can kill -9 it). Node strips the .ts types itself. */
export async function spawnDaemon(env: Env): Promise<{ child: ChildProcess; socketPath: string }> {
  const child = spawn(process.execPath, [join(here, "..", "src", "cli.ts")], {
    env: { ...process.env, ...env.vars },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const socketPath = join(env.serverDir, "pi-server.sock");
  await waitFor(`daemon to listen (${stderr})`, () => stderr.includes("listening on"), 30_000);
  return { child, socketPath };
}
