import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Backend } from "./backend.ts";
import { llmCalls, makeEnv, spawnDaemon, waitFor, gate } from "./helpers.ts";
import { remoteBackend } from "./remote-host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "remote-cli.ts");

async function localBackend(): Promise<Backend> {
  const env = makeEnv();
  const { child } = await spawnDaemon(env);
  mkdirSync(join(env.root, "state"));
  const repo = join(env.cwd, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "feature-x", repo]);
  const g = (name: string) => gate(env, name);
  return {
    flags: [],
    cwd: repo,
    env: { ...env.vars, PI_REMOTE_STATE_DIR: join(env.root, "state") },
    userTexts: async () => llmCalls(env).map((c) => c.messages.filter((m) => m.role === "user").at(-1)?.text ?? ""),
    gateStarted: async (name) => g(name).started(),
    releaseGate: async (name) => g(name).release(),
    cleanup: async () => void child.kill("SIGKILL"),
  };
}

function runCli(backend: Backend, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnCli(backend, args);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c));
    child.stderr!.on("data", (c: Buffer) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function spawnCli(backend: Backend, args: string[]): ChildProcess {
  const [name, ...rest] = args;
  return spawn(process.execPath, [cliPath, name!, ...backend.flags, ...rest], { env: { ...process.env, ...backend.env }, stdio: ["ignore", "pipe", "pipe"] });
}

async function sessionsOf(backend: Backend): Promise<any[]> {
  const out = await runCli(backend, ["ls", "--json"]);
  assert.equal(out.code, 0, out.stderr);
  return JSON.parse(out.stdout);
}

function scenarios(label: string, make: () => Promise<Backend>) {
  describe(label, { concurrency: false }, () => {
    let backend: Backend;
    let alpha = "";
    after(async () => backend?.cleanup());

    it("ls on an empty daemon says so", async () => {
      backend = await make();
      const out = await runCli(backend, ["ls"]);
      assert.equal(out.code, 0, out.stderr);
      assert.equal(out.stdout, "No sessions.\n");
    });

    it("new creates a session in the given cwd, runs the prompt, and ls shows idle with cwd and branch", async () => {
      const out = await runCli(backend, ["new", "--model", "fake/fake-1", "--cwd", backend.cwd, "--name", "alpha", "hello there"]);
      assert.equal(out.code, 0, out.stderr);
      alpha = out.stdout.trim();
      assert.match(alpha, /^[0-9a-f-]{36}$/);
      const row = await waitFor("alpha to go idle", async () => (await sessionsOf(backend)).find((s) => s.sessionId === alpha && s.displayStatus === "idle"));
      assert.equal(row.cwd, backend.cwd);
      assert.equal(row.branch, "feature-x");
      assert.equal(row.name, "alpha");
      assert.ok(Date.parse(row.updatedAt) > 0);
      assert.ok((await backend.userTexts()).includes("hello there"));
      const table = await runCli(backend, ["ls"]);
      const line = table.stdout.split("\n").find((l) => l.startsWith(alpha.slice(0, 8)))!;
      assert.match(line, new RegExp(`idle\\s+\\d+s ago\\s+feature-x\\s+${backend.cwd.replaceAll("/", "\\/")}\\s+alpha$`));
    });

    it("steer queues into a running turn; ls shows running while it is blocked", async () => {
      const out = await runCli(backend, ["new", "--model", "fake/fake-1", "--cwd", backend.cwd, "tool g1"]);
      assert.equal(out.code, 0, out.stderr);
      const id = out.stdout.trim();
      await waitFor("gate g1 to start", () => backend.gateStarted("g1"));
      assert.equal((await sessionsOf(backend)).find((s) => s.sessionId === id).displayStatus, "running");
      const steered = await runCli(backend, ["steer", id.slice(0, 8), "nudge"]);
      assert.equal(steered.code, 0, steered.stderr);
      assert.match(steered.stdout, /^steered /);
      await backend.releaseGate("g1");
      await waitFor("steer text to reach the model", async () => (await backend.userTexts()).includes("nudge"));
      await waitFor("g1 session idle", async () => (await sessionsOf(backend)).find((s) => s.sessionId === id)?.displayStatus === "idle");
    });

    it("steer on an idle session starts a turn with the message", async () => {
      const out = await runCli(backend, ["steer", "alpha", "second message"]);
      assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, /^started turn on /);
      await waitFor("idle steer to reach the model", async () => (await backend.userTexts()).includes("second message"));
    });

    it("tail streams a session's live output until interrupted", async () => {
      const tail = spawnCli(backend, ["tail", "alpha"]);
      let seen = "";
      tail.stdout!.on("data", (c: Buffer) => (seen += c));
      const exited = new Promise<number | null>((resolve) => tail.on("close", (code) => resolve(code)));
      await waitFor("tail to attach", async () => {
        // Keep nudging until the tail has attached and relays a reply; attach is asynchronous.
        await runCli(backend, ["steer", "alpha", "tail-me"]);
        return seen.includes("echo:tail-me");
      });
      assert.match(seen, /-- turn started --/);
      assert.match(seen, /-- turn ended --/);
      tail.kill("SIGINT");
      assert.equal(await exited, 0);
    });

    it("reports an unknown session as an error", async () => {
      const out = await runCli(backend, ["steer", "nope", "x"]);
      assert.equal(out.code, 1);
      assert.match(out.stderr, /No session matches "nope"/);
    });
  });
}

scenarios("pi-remote against a local daemon", localBackend);

const remote = process.env.PI_REMOTE_TEST_HOST;
if (remote) scenarios(`pi-remote --host ${remote} through an SSH-forwarded socket`, () => remoteBackend(remote));
else describe("pi-remote --host", () => it("is skipped without PI_REMOTE_TEST_HOST", { skip: "set PI_REMOTE_TEST_HOST (+ PI_REMOTE_TEST_HOST_ROOT) to run against a real host" }, () => undefined));
