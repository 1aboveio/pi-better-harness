/**
 * Shared setup for the Codex steer / return / plugin tests: a Codex host is a CODEX_HOME
 * pointed at a mock model, a daemon on a short socket path, and a real app-server.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../src/client.ts";
import { startCodexDaemon, type CodexDaemon } from "../src/codex/daemon.ts";
import { startMockModel, writeMockConfig, type MockModel } from "./codex-mock-model.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const pkgRoot = join(here, "..");
export const CODEX_BIN = process.env.PI_CODEX_BIN ?? "codex";
export const cleanups: Array<() => Promise<void> | void> = [];

export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/** A short path: unix socket paths are capped near 104 bytes. */
export function shortDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repo with a committed base, a dirty tracked file, an untracked file and an executable. */
export function makeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "feature-x");
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  writeFileSync(join(repo, "a.txt"), "one\ndirty\n");
  writeFileSync(join(repo, "src", "untracked.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  return repo;
}

export interface Host {
  root: string;
  home: string;
  serverDir: string;
  daemon: CodexDaemon;
  client: DaemonClient;
  model: MockModel;
  /** Environment that makes a child process talk to this host as its "local" machine. */
  env: Record<string, string>;
}

export async function startHost(label: string): Promise<Host> {
  const root = shortDir(`cx-${label}-`);
  const home = join(root, "home");
  const model = await startMockModel();
  writeMockConfig(home, model.port);
  const serverDir = join(root, "srv");
  const daemon = await startCodexDaemon({ serverDir, codex: { bin: CODEX_BIN, home } });
  const client = await DaemonClient.connect(daemon.socketPath);
  cleanups.push(async () => {
    client.close();
    await daemon.stop();
    spawnSync(CODEX_BIN, ["app-server", "daemon", "stop"], { env: { ...process.env, CODEX_HOME: home }, timeout: 30_000 });
    // `daemon stop` leaves the managed copy's pid-update-loop running; it would outlive the test for good.
    spawnSync("pkill", ["-f", `${home}/packages/app-server-daemon`]);
    await model.close();
  });
  return { root, home, serverDir, daemon, client, model, env: { CODEX_HOME: home, PI_SERVER_DIR: serverDir, PI_CODEX_BIN: CODEX_BIN } };
}

/** Make a real thread on the host: the app-server runs one turn against the mock model. */
export async function createThread(host: Host, cwd: string, firstMessage = "hello from the laptop"): Promise<string> {
  const app = await host.daemon.runtime.client();
  const { thread } = await app.call<{ thread: { id: string } }>("thread/start", { cwd });
  const done = new Promise<void>((resolve) => {
    const off = app.onNotification((n) => {
      if (n.method === "turn/completed" && n.params?.threadId === thread.id) {
        off();
        resolve();
      }
    });
  });
  await app.call("turn/start", { threadId: thread.id, input: [{ type: "text", text: firstMessage, text_elements: [] }] });
  await done;
  await app.call("thread/unsubscribe", { threadId: thread.id });
  return thread.id;
}

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run a command asynchronously (the daemons under test live in this process and must keep answering). */
export function run(argv: string[], env: Record<string, string> = {}, cwd = pkgRoot): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export const MARKETPLACE = join(pkgRoot, "codex-plugin");

export async function installPlugin(host: Host): Promise<void> {
  const env = { CODEX_HOME: host.home };
  const added = await run([CODEX_BIN, "plugin", "marketplace", "add", MARKETPLACE], env);
  assert.equal(added.code, 0, added.stderr);
  const installed = await run([CODEX_BIN, "plugin", "add", "pi-remote@pi-remote", "--json"], env);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).pluginId, "pi-remote@pi-remote");
  const listed = await run([CODEX_BIN, "plugin", "list"], env);
  assert.match(listed.stdout, /pi-remote@pi-remote\s+installed, enabled/);
}

export const REMOTE_CLI = ["node", "--import", "tsx", join(pkgRoot, "src", "remote-cli.ts")];

export function remote(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return run([...REMOTE_CLI, ...args], env);
}

/** An executable `pi-remote` for the Codex plugin to call: runs the CLI from this checkout. */
export function writePiRemoteWrapper(dir: string): string {
  const file = join(dir, "pi-remote");
  writeFileSync(file, `#!/bin/sh\ncd "${pkgRoot}" && exec node --import tsx "${join(pkgRoot, "src", "remote-cli.ts")}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}
