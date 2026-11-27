import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../src/client.ts";
import { CodexAppServerClient } from "../src/codex/app-server.ts";
import { startCodexDaemon, type CodexDaemon, type CodexEndpoint } from "../src/codex/daemon.ts";
import { rewriteRolloutCwd } from "../src/codex/rollout.ts";
import { digestWorktree } from "../src/core/bundle.ts";
import { moveSession, MoveError } from "../src/move/orchestrate.ts";
import { resolveTarget } from "../src/remote/target.ts";
import { waitFor } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const THREAD_ID = "0198a000-0000-7000-8000-000000000478";
const FIXTURE_CWD = "/original/workspace";
const CODEX_BIN = process.env.PI_CODEX_BIN ?? "codex";
const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

/** A short path: unix socket paths are capped near 104 bytes. */
function shortDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(existsSync("/tmp") ? "/tmp" : tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A repo with a committed base, a dirty tracked file, an untracked file and an executable. */
function makeRepo(root: string): string {
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

/** Plant the fixture thread in a CODEX_HOME, as if Codex had recorded it for `cwd`. */
function plantThread(home: string, cwd: string): string {
  const dir = join(home, "sessions", "2026", "10", "16");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-10-16T14-23-03-${THREAD_ID}.jsonl`);
  writeFileSync(file, rewriteRolloutCwd(readFileSync(join(here, "fixtures", "codex-rollout.jsonl"), "utf8"), FIXTURE_CWD, cwd).text);
  return file;
}

interface Host {
  home: string;
  daemon: CodexDaemon;
  client: DaemonClient;
}

async function startHost(label: string, options: { pin?: string; version?: string } = {}): Promise<Host> {
  const root = shortDir(`cx-${label}-`);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: `canary-secret-${label}` }), { mode: 0o600 });
  const daemon = await startCodexDaemon({ serverDir: join(root, "srv"), codex: { bin: CODEX_BIN, home, ...(options.pin ? { pinnedVersion: options.pin } : {}) } });
  if (options.version) daemon.runtime.version = () => options.version!;
  const client = await DaemonClient.connect(daemon.socketPath);
  cleanups.push(async () => {
    client.close();
    await daemon.stop();
    spawnSync(CODEX_BIN, ["app-server", "daemon", "stop"], { env: { ...process.env, CODEX_HOME: home }, timeout: 30_000 });
    // `daemon stop` leaves the managed copy's pid-update-loop running; it would outlive the test for good.
    spawnSync("pkill", ["-f", `${home}/packages/app-server-daemon`]);
  });
  return { home, daemon, client };
}

async function threadView(host: Host, threadId = THREAD_ID): Promise<{ cwd: string; texts: string[] }> {
  const app = await host.daemon.runtime.client();
  const { thread } = await app.call<{ thread: { cwd: string } }>("thread/read", { threadId, includeTurns: false });
  const turns = await app.call<{ data: Array<{ items: Array<{ type: string; text?: string; content?: Array<{ text: string }> }> }> }>("thread/turns/list", { threadId });
  const texts = turns.data.flatMap((turn) => turn.items.map((item) => item.text ?? item.content?.map((c) => c.text).join("") ?? ""));
  return { cwd: thread.cwd, texts };
}

describe("rollout cwd rewriting", () => {
  it("changes only cwd fields of session_meta and turn_context", () => {
    const text = readFileSync(join(here, "fixtures", "codex-rollout.jsonl"), "utf8");
    const out = rewriteRolloutCwd(text, FIXTURE_CWD, "/new/place");
    assert.ok(out.changed >= 3);
    const before = text.split("\n");
    const after = out.text.split("\n");
    assert.equal(before.length, after.length);
    for (let i = 0; i < before.length; i++) {
      const type = before[i] ? JSON.parse(before[i]!).type : "";
      if (type === "session_meta" || type === "turn_context") continue;
      assert.equal(after[i], before[i], `line ${i} (${type}) must stay byte for byte`);
    }
    assert.equal(JSON.parse(after[0]!).payload.cwd, "/new/place");
  });
});

describe("Codex thread move between two Codex hosts (real codex-cli, real app-servers)", { concurrency: false }, () => {
  it("moves a thread with its workspace; history, checksums and ownership carry over, auth does not", async () => {
    const source = await startHost("a");
    const target = await startHost("b");
    const repo = makeRepo(shortDir("cx-ws-"));
    const rollout = plantThread(source.home, repo);

    // Codex indexes a rollout when it first reads it; a real laptop thread was indexed when it was recorded.
    await threadView(source);
    const rows = ((await source.client.call({ type: "list_sessions" })).data as { sessions: Array<{ sessionId: string; branch?: string }> }).sessions;
    assert.deepEqual(rows.map((s) => s.sessionId), [THREAD_ID]);
    assert.equal(rows[0]!.branch, "feature-x");

    const result = await moveSession(source.client, target.client, { sessionId: THREAD_ID, chunkBytes: 4096 });
    assert.equal(result.verified, true);
    assert.equal(result.worktreeFiles, digestWorktree(repo).length);
    assert.notEqual(result.cwd, repo);

    // Workspace: same bytes, executable bit, dirty and untracked files.
    for (const file of ["a.txt", "src/untracked.ts", "run.sh"]) {
      assert.equal(createHash("sha256").update(readFileSync(join(result.cwd, file))).digest("hex"), createHash("sha256").update(readFileSync(join(repo, file))).digest("hex"), file);
    }
    assert.equal(git(result.cwd, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));

    // Thread: the target app-server reads the whole history, now rooted at the new workspace.
    const view = await threadView(target);
    assert.equal(view.cwd, result.cwd);
    assert.ok(view.texts.includes("pong"), `history on the target: ${JSON.stringify(view.texts)}`);
    assert.ok(view.texts.some((t) => t.startsWith("Reply with exactly")));

    // Source: tombstoned (archived), fenced out; target owns it at epoch + 1.
    assert.equal(source.daemon.runtime.rolloutPath(THREAD_ID), undefined);
    assert.ok(source.daemon.runtime.archivedRolloutPath(THREAD_ID));
    assert.equal(existsSync(rollout), false);
    assert.equal(target.daemon.runtime.rolloutPath(THREAD_ID) !== undefined, true);
    const targetList = (await target.client.call({ type: "list_sessions" })).data as { sessions: Array<{ sessionId: string; cwd: string }> };
    assert.equal(targetList.sessions[0]?.cwd, result.cwd);

    // No credential travelled: the target's home has only what it had, and nothing mentions the source's key.
    assert.equal(readFileSync(join(target.home, "auth.json"), "utf8").includes("canary-secret-a"), false);
    const grep = spawnSync("grep", ["-rl", "canary-secret-a", target.home, dirname(target.daemon.socketPath)], { encoding: "utf8" });
    assert.equal(grep.stdout.trim(), "");
  });

  it("refuses a bundle from a different Codex CLI version and leaves the source untouched", async () => {
    const source = await startHost("c");
    const target = await startHost("d", { version: "0.0.1" });
    const repo = makeRepo(shortDir("cx-ws-"));
    const rollout = plantThread(source.home, repo);
    await assert.rejects(moveSession(source.client, target.client, { sessionId: THREAD_ID }), (error: unknown) => {
      assert.ok(error instanceof MoveError);
      assert.equal(error.sourceUnfenced, true);
      assert.match(error.message, /Codex CLI version mismatch: bundle from codex-cli .*, this host runs codex-cli 0\.0\.1/);
      return true;
    });
    assert.equal(existsSync(rollout), true);
    assert.equal(target.daemon.runtime.rolloutPath(THREAD_ID), undefined);
  });

  it("a fenced thread cannot be driven by another client of the source app-server until the move is aborted", async () => {
    const source = await startHost("i");
    const repo = makeRepo(shortDir("cx-ws-"));
    const rollout = plantThread(source.home, repo);
    await threadView(source);
    // A second client, like a TUI attached through `pi-remote attach`, has the thread loaded.
    const status = await source.daemon.runtime.daemonStatus();
    const other = await CodexAppServerClient.connect(status.socketPath, "second-client");
    cleanups.push(() => other.close());
    await other.call("thread/resume", { threadId: THREAD_ID });

    const moveId = "move-fence-test-1";
    await source.client.call({ type: "move_fence", sessionId: THREAD_ID, moveId });
    const input = [{ type: "text", text: "sneak in a turn", text_elements: [] }];
    await assert.rejects(other.call("turn/start", { threadId: THREAD_ID, input }), /not found|no rollout|archived/i);
    await assert.rejects(other.call("thread/resume", { threadId: THREAD_ID }), /not found|no rollout|archived/i);
    assert.equal(readFileSync(source.daemon.runtime.archivedRolloutPath(THREAD_ID)!, "utf8").includes("sneak in a turn"), false);

    // Aborting gives the thread back to every client.
    await source.client.call({ type: "move_unfence", sessionId: THREAD_ID, moveId });
    assert.equal(existsSync(rollout), true);
    const back = await other.call<{ thread: { id: string } }>("thread/resume", { threadId: THREAD_ID });
    assert.equal(back.thread.id, THREAD_ID);
  });

  it("a failed move leaves the fenced thread listed, and `pi-remote move --abort <prefix>` restores it", async () => {
    const source = await startHost("j");
    const repo = makeRepo(shortDir("cx-ws-"));
    const rollout = plantThread(source.home, repo);
    await threadView(source);

    await source.client.call({ type: "move_fence", sessionId: THREAD_ID, moveId: "move-fence-test-2" });
    assert.equal(existsSync(rollout), false);
    const listed = ((await source.client.call({ type: "list_sessions" })).data as { sessions: Array<{ sessionId: string; ownership?: string }> }).sessions;
    assert.deepEqual(listed.map((s) => [s.sessionId, s.ownership]), [[THREAD_ID, "fenced"]]);

    const abort = await runCli(["move", THREAD_ID.slice(0, 8), "--abort", "--socket", source.daemon.socketPath]);
    assert.equal(abort.status, 0, abort.stderr);
    assert.equal(existsSync(rollout), true);
    const after = ((await source.client.call({ type: "list_sessions" })).data as { sessions: Array<{ sessionId: string; ownership?: string }> }).sessions;
    assert.deepEqual(after.map((s) => [s.sessionId, s.ownership]), [[THREAD_ID, undefined]]);
    const app = await source.daemon.runtime.client();
    assert.equal((await app.call<{ thread: { id: string } }>("thread/resume", { threadId: THREAD_ID })).thread.id, THREAD_ID);
  });

  it("refuses when the target host is pinned to another version", async () => {
    const source = await startHost("e");
    const version = execFileSync(CODEX_BIN, ["--version"], { encoding: "utf8" }).match(/(\d+\.\d+\.\d+)/)![1]!;
    await assert.rejects(startHost("f", { pin: "0.0.1" }), new RegExp(`mismatch: this host runs codex-cli ${version.replaceAll(".", "\\.")} but 0\\.0\\.1 is pinned`));
    assert.ok(source);
  });
});

/** Run a command in a pty (80x... terminal answered like a real one) for a few seconds; returns the text it drew. */
async function runInPty(argv: string[], seconds: number, extraEnv: Record<string, string> = {}): Promise<string> {
  const script = String.raw`
import os, pty, sys, time, select, signal, fcntl, termios, struct
seconds = float(sys.argv[1])
argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
out = b""
start = time.time()
end = start + seconds
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d: break
        out += d
        # The TUI interrogates its terminal before drawing; answer like a terminal would.
        if b"\x1b[6n" in d: os.write(fd, b"\x1b[1;1R")
        if b"\x1b[c" in d: os.write(fd, b"\x1b[?62;c")
        if b"\x1b]10;?" in d: os.write(fd, b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\")
        if b"\x1b]11;?" in d: os.write(fd, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
sys.stdout.write(out.decode("utf8", "replace"))
`;
  // Async: the daemons under test live in this process and must keep answering while the TUI runs.
  const child = spawn("python3", ["-I", "-c", script, String(seconds), ...argv], { cwd: pkgRoot, env: { ...process.env, TERM: "xterm-256color", ...extraEnv } });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
  const result = { stdout };
  // Drop terminal control sequences so assertions read the text the TUI drew.
  return result.stdout.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ");
}

/** The TUI runs on this machine with this machine's own Codex sign-in; nothing of it is sent anywhere. */
function tuiEnv(): Record<string, string> {
  return { PI_CODEX_BIN: CODEX_BIN };
}

const NO_UPDATE_PROMPT = ["-c", "check_for_update_on_startup=false"];
/** Run pi-remote without blocking this process: the daemons under test live in it. */
async function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn("node", ["--import", "tsx", join(pkgRoot, "src", "remote-cli.ts"), "--agent", "codex", ...args], { cwd: pkgRoot, env: process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve) => child.once("close", resolve));
  return { status, stdout, stderr };
}

const remoteCli = ["node", "--import", "tsx", join(pkgRoot, "src", "remote-cli.ts"), "--agent", "codex"];

describe("attach", { concurrency: false }, () => {
  it("pi-remote attach opens the native Codex TUI on the host's app-server through a forwarded socket", async () => {
    const host = await startHost("g");
    const repo = makeRepo(shortDir("cx-ws-"));
    plantThread(host.home, repo);
    await threadView(host);
    const endpoint = (await host.client.request({ type: "codex_endpoint" })).data as CodexEndpoint;
    assert.equal(endpoint.codexVersion, host.daemon.runtime.version());
    // The endpoint is the app-server's own control socket; a plain client can talk to it.
    const app = await CodexAppServerClient.connect(endpoint.socketPath);
    app.close();
    const output = await runInPty([...remoteCli, "attach", THREAD_ID, "--socket", host.daemon.socketPath, "--", ...NO_UPDATE_PROMPT], 10, tuiEnv());
    assert.match(output, /Reply with exactly the word|pong/, output.slice(0, 800));
  });
});

const remoteHost = process.env.PI_REMOTE_TEST_HOST;
if (remoteHost) {
  describe(`Codex thread move to ${remoteHost} over an SSH-forwarded socket`, { concurrency: false }, () => {
    const hostRoot = process.env.PI_REMOTE_TEST_HOST_ROOT;
    const remoteCodex = process.env.PI_REMOTE_TEST_CODEX_BIN;
    const ssh = (script: string, input?: string) => spawnSync("ssh", ["-o", "BatchMode=yes", "-T", remoteHost, script], { encoding: "utf8", input });

    it("detaches a thread with dirty + untracked changes to the host, then re-attaches after the laptop disconnects", async () => {
      assert.ok(hostRoot && remoteCodex, "PI_REMOTE_TEST_HOST_ROOT and PI_REMOTE_TEST_CODEX_BIN are required");
      const work = `${hostRoot}/pbc-${randomBytes(4).toString("hex")}`;
      const nodeBin = ssh(`ls -d ${hostRoot}/node-v*/bin/node | head -1`).stdout.trim();
      ssh(`mkdir -p ${work}/home`);
      execFileSync("sh", ["-c", `tar -C ${pkgRoot} -cf - src | ssh -o BatchMode=yes ${remoteHost} 'tar -C ${work} -xf -'`]);
      ssh(`printf '{ "type": "module" }\\n' > ${work}/package.json`);
      const pid = ssh(
        `cd ${work} && (PATH=$(dirname ${nodeBin}):$PATH PI_SERVER_DIR=${work}/srv CODEX_HOME=${work}/home PI_CODEX_BIN=${remoteCodex} setsid nohup ${nodeBin} src/cli.ts --agent codex > daemon.log 2>&1 < /dev/null & echo $!)`,
      ).stdout.trim();
      cleanups.push(() => {
        // The pattern's bracket keeps pkill from matching this very command line.
        ssh(`PATH=$(dirname ${nodeBin}):$PATH CODEX_HOME=${work}/home ${remoteCodex} app-server daemon stop >/dev/null 2>&1; kill -9 ${pid} 2>/dev/null; pkill -f '${work.slice(0, -1)}[${work.slice(-1)}]'; sleep 1; rm -rf ${work}; true`);
      });
      await waitFor("remote codex daemon to listen", () => ssh(`grep -c 'listening on' ${work}/daemon.log || true`).stdout.trim() !== "0", 90_000);

      const source = await startHost("h");
      const repo = makeRepo(shortDir("cx-ws-"));
      plantThread(source.home, repo);

      const destination = await resolveTarget({ host: remoteHost, agent: "codex", remoteDir: `${work}/srv`, controlPathRoot: shortDir("cx-ctl-") });
      cleanups.push(() => destination.close());
      const client = await DaemonClient.connect(destination.socketPath);
      const result = await moveSession(source.client, client, { sessionId: THREAD_ID });
      assert.equal(result.verified, true);
      assert.equal(result.worktreeFiles, digestWorktree(repo).length);
      const sha = (file: string) => createHash("sha256").update(readFileSync(join(repo, file))).digest("hex");
      for (const file of ["a.txt", "src/untracked.ts", "run.sh"]) assert.equal(ssh(`sha256sum ${result.cwd}/${file}`).stdout.split(" ")[0], sha(file), `${file} differs on the host`);
      assert.equal(ssh(`cd ${result.cwd} && git rev-parse HEAD`).stdout.trim(), git(repo, "rev-parse", "HEAD"));
      assert.equal(ssh(`ls ${work}/home | grep -c '^auth.json$' || true`).stdout.trim(), "0");

      // Laptop disconnects: drop every connection, then come back with a fresh forward.
      client.close();
      await destination.close();

      const again = await resolveTarget({ host: remoteHost, agent: "codex", remoteDir: `${work}/srv`, controlPathRoot: shortDir("cx-ctl-") });
      cleanups.push(() => again.close());
      const back = await DaemonClient.connect(again.socketPath);
      const endpoint = (await back.request({ type: "codex_endpoint" })).data as CodexEndpoint;
      const forward = await again.forwardSocket(endpoint.socketPath);
      cleanups.push(() => forward.close());
      const app = await CodexAppServerClient.connect(forward.socketPath);
      const { thread } = await app.call<{ thread: { cwd: string } }>("thread/read", { threadId: THREAD_ID, includeTurns: false });
      assert.equal(thread.cwd, result.cwd);
      const turns = await app.call<{ data: Array<{ items: Array<{ text?: string }> }> }>("thread/turns/list", { threadId: THREAD_ID });
      assert.ok(turns.data.some((turn) => turn.items.some((item) => item.text === "pong")), "history survives the move");
      app.close();
      back.close();
      forward.close();
      // `pi-remote attach --host`: the native TUI reconnects through a fresh ssh-forwarded socket.
      const output = await runInPty([...remoteCli, "attach", THREAD_ID, "--host", remoteHost, "--remote-dir", `${work}/srv`, "--", ...NO_UPDATE_PROMPT], 15, { ...tuiEnv(), PI_REMOTE_TMP: shortDir("cx-fw-"), PI_REMOTE_STATE_DIR: shortDir("cx-st-") });
      // The TUI reached the host's app-server. Until `codex login` has been run on the host the app-server
      // answers with its sign-in screen instead of the conversation; that step needs a human and is pending.
      assert.match(output, /Reply with exactly the word|pong|Sign in with ChatGPT/, output.slice(0, 800));
      process.stderr.write(`[attach via ${remoteHost}] ${/Sign in with ChatGPT/.test(output) ? "connected; host not signed in (pending: codex login on host)" : "history shown"}\n`);
    });
  });
} else {
  describe("Codex thread move to a real host", () => it("is skipped without PI_REMOTE_TEST_HOST", { skip: "set PI_REMOTE_TEST_HOST, PI_REMOTE_TEST_HOST_ROOT and PI_REMOTE_TEST_CODEX_BIN" }, () => undefined));
}
