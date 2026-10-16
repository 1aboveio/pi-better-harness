import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { DaemonClient } from "../src/client.ts";
import { digestWorktree } from "../src/core/bundle.ts";
import { detachSession, returnSession } from "../src/detach/detach.ts";
import { recoverLocal } from "../src/detach/recover.ts";
import { MoveError } from "../src/move/orchestrate.ts";
import detachExtension, { parseDetachArgs } from "../src/detach/extension.ts";
import type { LocalSessionInfo } from "../src/detach/local-source.ts";
import { localBlockedReason, readLocalRecord } from "../src/detach/local-state.ts";
import { PreflightError } from "../src/move/preflight.ts";
import { resolveTarget } from "../src/remote/target.ts";
import { gate, llmCalls, makeEnv, spawnDaemon, waitFor, type Env } from "./helpers.ts";
import { remoteBackend } from "./remote-host.ts";

function piBin(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, "node_modules", ".bin", "pi");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pi binary not found");
    dir = parent;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "remote-cli.ts");
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
});

/** A real local Pi session: `pi -p` against the scripted provider, in a repo with dirty and untracked changes. */
interface Local {
  env: Env;
  repo: string;
  info: LocalSessionInfo;
  sessionFile: string;
  stateDir: string;
}

function runPi(local: { env: Env }, cwd: string, args: string[]): string {
  const out = spawnSync(process.execPath, [piBin(), ...args], { cwd, env: { ...process.env, ...local.env.vars }, encoding: "utf8", timeout: 120_000 });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

function makeLocal(overrides: { remote?: string } = {}): Local {
  const env = makeEnv();
  const repo = join(env.root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "gone.txt"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature-x");
  if (overrides.remote) git(repo, "remote", "add", "origin", overrides.remote);
  writeFileSync(join(repo, "a.txt"), "one\nuncommitted edit\n");
  rmSync(join(repo, "gone.txt"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "untracked.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, ".env"), "KEY=nope\n");
  const local = { env };
  runPi(local, repo, ["-p", "hello"]);
  const sessionsDir = join(env.agentDir, "sessions");
  const dir = join(sessionsDir, readdirSync(sessionsDir)[0]!);
  const sessionFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".jsonl"))!);
  const manager = SessionManager.open(sessionFile);
  const info: LocalSessionInfo = { sessionId: manager.getSessionId(), cwd: repo, sessionFile, model: "fake/fake-1", createdAt: manager.getHeader()?.timestamp };
  return { env, repo, info, sessionFile, stateDir: join(env.root, "state") };
}

/** Run `fn` as the user of this local environment: its agent dir decides which providers have credentials. */
async function asLocalUser<T>(local: Local, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = local.env.agentDir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
  }
}

async function startHost(extraVars: Record<string, string> = {}) {
  const env = makeEnv();
  Object.assign(env.vars, extraVars);
  const { child, socketPath } = await spawnDaemon(env);
  children.push(child);
  return { env, child, socketPath };
}

async function sessionsOf(socketPath: string): Promise<any[]> {
  const client = await DaemonClient.connect(socketPath);
  try {
    return (await client.call({ type: "list_sessions" })).data!.sessions;
  } finally {
    client.close();
  }
}

async function assertUntouched(local: Local, before: { file: string; digest: unknown }, host: { socketPath: string }) {
  assert.equal(readLocalRecord(local.stateDir, local.info.sessionId), undefined, "no local fence record");
  assert.equal(readFileSync(local.sessionFile, "utf8"), before.file);
  assert.deepEqual(digestWorktree(local.repo), before.digest);
  assert.equal((await sessionsOf(host.socketPath)).length, 0, "the daemon holds no session");
}

describe("/detach and return between a local session and a daemon", { concurrency: false }, () => {
  it("detaches a live local session with dirty and untracked changes, the agent continues there, and return restores it locally", async () => {
    const local = makeLocal();
    const host = await startHost();
    const digest = digestWorktree(local.repo);
    const transcript = readFileSync(local.sessionFile, "utf8");
    const connect = () => DaemonClient.connect(host.socketPath);

    const detached = await detachSession({ session: local.info, host: "testhost", connect, isBusy: () => false, stateDir: local.stateDir });
    assert.equal(detached.verified, true);
    assert.equal(detached.worktreeFiles, digest.length);
    assert.deepEqual(digestWorktree(detached.cwd), digest);
    assert.equal(git(detached.cwd, "rev-parse", "HEAD"), git(local.repo, "rev-parse", "HEAD"));
    assert.equal(existsSync(join(detached.cwd, ".env")), false);
    assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "moved");
    assert.match(localBlockedReason(local.stateDir, local.info.sessionId) ?? "", /pi-remote return/);

    // Full history is on the daemon and the agent continues with it.
    const client = await connect();
    const { data } = await client.call({ type: "get_messages", sessionId: local.info.sessionId });
    assert.ok(JSON.stringify(data!.messages).includes("echo:hello"));
    await client.call({ type: "prompt", sessionId: local.info.sessionId, message: "continue-on-host" });
    await waitFor("daemon model call", () => llmCalls(host.env).some((call) => call.messages.some((m) => m.text === "continue-on-host")));
    const call = llmCalls(host.env).find((c) => c.messages.some((m) => m.text === "continue-on-host"))!;
    assert.ok(call.messages.some((m) => m.role === "user" && m.text === "hello"), "pre-detach prompt is in the model's context");
    await waitFor("idle", async () => !(await client.call({ type: "get_state", sessionId: local.info.sessionId })).data!.isStreaming);
    // Edit on the host so the way back carries new work.
    writeFileSync(join(detached.cwd, "from-host.txt"), "made on host\n");
    client.close();

    // Return.
    const home = join(local.env.root, "home-again");
    const returned = await asLocalUser(local, () => returnSession({ ref: local.info.sessionId.slice(0, 8), connect, stateDir: local.stateDir, toCwd: home }));
    assert.equal(returned.verified, true);
    assert.equal(returned.cwd, home);
    assert.deepEqual(digestWorktree(home), digestWorktree(detached.cwd));
    assert.equal(readFileSync(join(home, "from-host.txt"), "utf8"), "made on host\n");
    assert.equal(readFileSync(join(home, "a.txt"), "utf8"), "one\nuncommitted edit\n");
    assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "owned");
    assert.equal(localBlockedReason(local.stateDir, local.info.sessionId), undefined);
    const remote = (await sessionsOf(host.socketPath)).find((s) => s.sessionId === local.info.sessionId);
    assert.equal(remote.ownership, "moved", "remote copy retired");
    const refused = await (await connect()).request({ type: "open_session", sessionId: local.info.sessionId });
    assert.equal(refused.success, false);

    // Resume works: real Pi opens the restored transcript and the model sees the whole conversation.
    assert.ok(returned.sessionFile && readFileSync(returned.sessionFile, "utf8").startsWith(transcript.split("\n")[0]!.slice(0, 20)));
    const reopened = SessionManager.open(returned.sessionFile!);
    assert.equal(reopened.getSessionId(), local.info.sessionId);
    assert.equal(reopened.getCwd(), home);
    runPi(local, home, ["-p", "after-return", "--session", returned.sessionFile!]);
    const last = llmCalls(local.env).at(-1)!;
    for (const text of ["hello", "continue-on-host", "after-return"]) assert.ok(last.messages.some((m) => m.role === "user" && m.text === text), `${text} in context after resume`);
  });

  it("refuses cleanly, with the source untouched, for each preflight failure", async () => {
    const local = makeLocal({ remote: "file:///nonexistent/repo.git" });
    const before = { file: readFileSync(local.sessionFile, "utf8"), digest: digestWorktree(local.repo) };
    const refuse = async (host: { socketPath: string }, session = local.info, connect = () => DaemonClient.connect(host.socketPath)) => {
      const error = await detachSession({ session, host: "testhost", connect, isBusy: () => false, stateDir: local.stateDir }).then(() => undefined, (e: unknown) => e);
      assert.ok(error instanceof PreflightError, String(error));
      await assertUntouched(local, before, host);
      return error as PreflightError;
    };

    const plain = await startHost();
    // repo remote unreachable
    let error = await refuse(plain);
    assert.deepEqual(error.checks.filter((c) => !c.ok).map((c) => c.name), ["repo-remote"]);

    // auth missing: the model's provider has no credentials on the target
    git(local.repo, "remote", "remove", "origin");
    error = await refuse(plain, { ...local.info, model: "anthropic/claude-sonnet-4-5" });
    assert.deepEqual(error.checks.filter((c) => !c.ok).map((c) => c.name), ["provider-auth"]);
    assert.match(error.message, /not authenticated/);

    // gh missing on a GitHub-hosted repo
    const noGh = await startHost({ PI_REMOTE_GH: "/nonexistent/gh" });
    git(local.repo, "remote", "add", "origin", "file:///nonexistent/github.com/x.git");
    git(local.repo, "remote", "set-url", "origin", "file:///nonexistent/github.com/x.git");
    error = await refuse(noGh);
    assert.ok(error.checks.some((c) => c.name === "gh-auth" && !c.ok && /not installed/.test(c.detail)), error.message);
    git(local.repo, "remote", "remove", "origin");

    // version mismatch: the target runs another Pi minor
    error = await refuse(plain, local.info, () => DaemonClient.connect(plain.socketPath, { hello: { piVersion: "0.1.0" } }));
    assert.equal(error.checks[0]!.name, "versions");
    assert.match(error.message, /bootstrap-host\.sh/);

    // no daemon at all
    error = await refuse(plain, local.info, () => DaemonClient.connect(join(local.env.root, "nothing.sock")));
    assert.equal(error.checks[0]!.name, "daemon");

    // low disk
    const tight = await startHost({ PI_REMOTE_MIN_FREE_BYTES: String(2 ** 60) });
    error = await refuse(tight);
    assert.deepEqual(error.checks.filter((c) => !c.ok).map((c) => c.name), ["disk"]);
    assert.match(error.message, /free/);

    // And the same session still detaches once nothing is wrong.
    const ok = await detachSession({ session: local.info, host: "testhost", connect: () => DaemonClient.connect(plain.socketPath), isBusy: () => false, stateDir: local.stateDir });
    assert.equal(ok.verified, true);
  });

  it("return refuses into a non-empty directory before fencing the remote session", async () => {
    const local = makeLocal();
    const host = await startHost();
    const connect = () => DaemonClient.connect(host.socketPath);
    await detachSession({ session: local.info, host: "testhost", connect, isBusy: () => false, stateDir: local.stateDir });
    const occupied = join(local.env.root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "x"), "x");
    await assert.rejects(asLocalUser(local, () => returnSession({ ref: local.info.sessionId, connect, stateDir: local.stateDir, toCwd: occupied })), PreflightError);
    const remote = (await sessionsOf(host.socketPath)).find((s) => s.sessionId === local.info.sessionId);
    assert.equal(remote.ownership, undefined, "remote session was never fenced");
    assert.equal(remote.status, "running");
  });

  it("/detach is a registered Pi command; a moved session blocks local input", async () => {
    assert.deepEqual(parseDetachArgs("r9 --remote-dir /x"), { host: "r9", remoteDir: "/x" });
    assert.throws(() => parseDetachArgs(""), /Usage/);
    const commands: string[] = [];
    let onInput: ((event: unknown, ctx: any) => any) | undefined;
    detachExtension({ registerCommand: (name: string) => commands.push(name), on: (event: string, handler: any) => void (event === "input" && (onInput = handler)) } as never);
    assert.deepEqual(commands, ["detach"]);

    const local = makeLocal();
    const host = await startHost();
    process.env.PI_REMOTE_STATE_DIR = join(local.env.root, "pistate");
    try {
      const stateDir = join(process.env.PI_REMOTE_STATE_DIR, "local-sessions");
      const notes: string[] = [];
      const ctx = { sessionManager: { getSessionId: () => local.info.sessionId }, ui: { notify: (m: string) => notes.push(m) } };
      assert.deepEqual(onInput!({}, ctx), { action: "continue" });
      await detachSession({ session: local.info, host: "testhost", connect: () => DaemonClient.connect(host.socketPath), isBusy: () => false, stateDir });
      assert.deepEqual(onInput!({}, ctx), { action: "handled" });
      assert.match(notes[0]!, /moved to testhost/);
    } finally {
      delete process.env.PI_REMOTE_STATE_DIR;
    }
  });

  it("after a detach no local turn runs, including extension-triggered ones, and a later return does not reopen the old process", async () => {
    const local = makeLocal();
    const host = await startHost();
    process.env.PI_REMOTE_STATE_DIR = join(local.env.root, "pistate");
    try {
      const stateDir = join(process.env.PI_REMOTE_STATE_DIR, "local-sessions");
      await asLocalUser(local, async () => {
        const loader = new DefaultResourceLoader({ cwd: local.repo, agentDir: local.env.agentDir, extensionFactories: [detachExtension] });
        await loader.reload();
        const { session } = await createAgentSession({ cwd: local.repo, agentDir: local.env.agentDir, sessionManager: SessionManager.open(local.sessionFile), resourceLoader: loader });
        await session.bindExtensions({});
        const sessionId = local.info.sessionId;
        const trigger = () => session.sendCustomMessage({ customType: "background-task", content: "task finished", display: true }, { triggerTurn: true });
        const connect = () => DaemonClient.connect(host.socketPath);

        // Fenced (a detach in flight): a background callback must not run a turn or append to the transcript.
        const { writeLocalRecord } = await import("../src/detach/local-state.ts");
        writeLocalRecord(stateDir, { sessionId, state: "fenced", epoch: 0, moveId: "m-test", cwd: local.repo, host: "testhost" });
        const before = readFileSync(local.sessionFile, "utf8");
        const llmBefore = llmCalls(local.env).length;
        const digest = digestWorktree(local.repo);
        await trigger();
        assert.equal(readFileSync(local.sessionFile, "utf8"), before, "fenced: transcript untouched");
        assert.equal(llmCalls(local.env).length, llmBefore, "fenced: no model call");
        rmSync(join(stateDir, `${sessionId}.json`));

        // Moved.
        await detachSession({ session: local.info, host: "testhost", connect, isBusy: () => false, stateDir });
        const afterDetach = readFileSync(local.sessionFile, "utf8");
        await trigger();
        assert.equal(readFileSync(local.sessionFile, "utf8"), afterDetach, "moved: transcript untouched");
        assert.equal(llmCalls(local.env).length, llmBefore, "moved: no model call");
        assert.deepEqual(digestWorktree(local.repo), digest);

        // Returned: this process still must not write; the returned copy is the live one.
        await returnSession({ ref: sessionId, connect, stateDir, toCwd: join(local.env.root, "back") });
        assert.equal(readLocalRecord(stateDir, sessionId)?.state, "owned");
        await trigger();
        assert.equal(readFileSync(local.sessionFile, "utf8"), afterDetach, "returned: stale process transcript untouched");
        assert.equal(llmCalls(local.env).length, llmBefore, "returned: no model call");
      });
    } finally {
      delete process.env.PI_REMOTE_STATE_DIR;
    }
  });

  it("return with no --to-cwd works after /detach: it rebuilds beside the untouched original", async () => {
    const local = makeLocal();
    const host = await startHost();
    const connect = () => DaemonClient.connect(host.socketPath);
    const digest = digestWorktree(local.repo);
    await detachSession({ session: local.info, host: "testhost", connect, isBusy: () => false, stateDir: local.stateDir });
    const notes: string[] = [];
    const returned = await asLocalUser(local, () => returnSession({ ref: local.info.sessionId, connect, stateDir: local.stateDir, onProgress: (m) => notes.push(m) }));
    assert.equal(returned.cwd, `${local.repo}-returned`);
    assert.deepEqual(digestWorktree(returned.cwd), digest);
    assert.deepEqual(digestWorktree(local.repo), digest, "original workspace untouched");
    assert.ok(notes.some((m) => m.includes(returned.cwd)), "progress names where it went");
    assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "owned");

    // Detached again, the original is gone: the default is the original path.
    await detachSession({ session: { ...local.info, cwd: returned.cwd, sessionFile: returned.sessionFile }, host: "testhost", connect, isBusy: () => false, stateDir: local.stateDir });
    rmSync(returned.cwd, { recursive: true, force: true });
    const again = await asLocalUser(local, () => returnSession({ ref: local.info.sessionId, connect, stateDir: local.stateDir }));
    assert.equal(again.cwd, returned.cwd);
  });

  it("a detach that leaves the local session fenced prints a recovery command that works on the local record", async () => {
    const host = await startHost();
    const connectOk = () => DaemonClient.connect(host.socketPath);
    // Target drops mid-transfer and cannot even be asked to abort: the source stays fenced.
    const dropAfterBegin = async (): Promise<DaemonClient> => {
      const real = await connectOk();
      return Object.assign(Object.create(real), {
        call: (c: { type: string }) => (c.type === "move_write" || c.type === "move_abort" ? Promise.reject(new Error("ssh forward dropped")) : real.call(c as never)),
      }) as DaemonClient;
    };
    const local = makeLocal();
    local.stateDir = join(local.env.root, "pistate", "local-sessions");
    let message = "";
    await assert.rejects(detachSession({ session: local.info, host: "testhost", connect: dropAfterBegin, isBusy: () => false, stateDir: local.stateDir }), (error: unknown) => {
      message = (error as Error).message;
      return error instanceof MoveError && !error.sourceUnfenced;
    });
    assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "fenced");
    assert.match(localBlockedReason(local.stateDir, local.info.sessionId) ?? "", /pi-remote recover/);
    const printed = /`(pi-remote recover (\S+) --abort --host (\S+))`/.exec(message);
    assert.ok(printed, `message names the local recovery: ${message}`);

    // Run exactly what was printed, from the CLI, against this local record.
    const run = (args: string[]) => spawnSync(process.execPath, [cliPath, ...args], { env: { ...process.env, ...local.env.vars, PI_REMOTE_STATE_DIR: dirname(local.stateDir) }, encoding: "utf8" });
    const out = run(["recover", printed![2]!, "--abort", "--socket", host.socketPath, "--json"]);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "owned");
    assert.equal(localBlockedReason(local.stateDir, local.info.sessionId), undefined);
    assert.equal((await sessionsOf(host.socketPath)).length, 0);
  });

  it("recover refuses when the daemon's state says the other action is the safe one", async () => {
    const host = await startHost();
    const connect = () => DaemonClient.connect(host.socketPath);
    // Reply lost after the target committed, so the source stays fenced while the daemon holds the session.
    const local = makeLocal();
    local.stateDir = join(local.env.root, "pistate", "local-sessions");
    let message = "";
    const { LocalSource } = await import("../src/detach/local-source.ts");
    const { moveSession } = await import("../src/move/orchestrate.ts");
    const source = new LocalSource({ session: local.info, stateDir: local.stateDir, isBusy: () => false, host: "testhost" });
    const flakySource = { recovery: source.recovery, call: (c: { type: string }) => (c.type === "move_retire" ? Promise.reject(new Error("write failed")) : source.call(c as never)) };
    const client = await connect();
    await assert.rejects(moveSession(flakySource, client, { sessionId: local.info.sessionId }), (error: unknown) => {
      message = (error as Error).message;
      return error instanceof MoveError && !error.sourceUnfenced;
    });
    client.close();
    const printed = /`(pi-remote recover (\S+) --retire --move-id (\S+) --moved-to (\S+) --host (\S+))`/.exec(message);
    assert.ok(printed, `message names the local retire: ${message}`);
    await assert.rejects(recoverLocal({ stateDir: local.stateDir, ref: local.info.sessionId, action: "abort", connect }), /two writers/);
    assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "fenced", "still fenced, never reopened");
    const out = spawnSync(process.execPath, [cliPath, "recover", printed![2]!, "--retire", "--move-id", printed![3]!, "--moved-to", printed![4]!, "--socket", host.socketPath, "--json"], { env: { ...process.env, ...local.env.vars, PI_REMOTE_STATE_DIR: dirname(local.stateDir) }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "moved");
    assert.match(localBlockedReason(local.stateDir, local.info.sessionId) ?? "", /pi-remote return/);
  });

  it("work continues on the daemon after the client connection is gone", async () => {
    const local = makeLocal();
    const host = await startHost();
    await detachSession({ session: local.info, host: "testhost", connect: () => DaemonClient.connect(host.socketPath), isBusy: () => false, stateDir: local.stateDir });
    const client = await DaemonClient.connect(host.socketPath);
    await client.call({ type: "prompt", sessionId: local.info.sessionId, message: "tool g1" });
    await waitFor("tool started", () => gate(host.env, "g1").started());
    client.close(); // the laptop goes away mid-turn
    gate(host.env, "g1").release();
    await waitFor("tool finished", () => gate(host.env, "g1").finished());
    const again = await DaemonClient.connect(host.socketPath);
    await waitFor("turn finished", async () => JSON.stringify((await again.call({ type: "get_messages", sessionId: local.info.sessionId })).data!.messages).includes("tool-done:gate:g1"));
    again.close();
  });
});

const remoteHost = process.env.PI_REMOTE_TEST_HOST;
if (remoteHost) {
  describe(`detach and return against ${remoteHost} over an SSH-forwarded socket`, { concurrency: false }, () => {
    it("refuses without auth, detaches, keeps working with the ssh forward gone, and returns", async () => {
      const backend = await remoteBackend(remoteHost);
      const remoteDir = backend.flags[backend.flags.indexOf("--remote-dir") + 1]!;
      const work = dirname(remoteDir);
      const ssh = (script: string) => spawnSync("ssh", ["-o", "BatchMode=yes", "-T", remoteHost, script], { encoding: "utf8" }).stdout;
      const local = makeLocal();
      const opts = { PI_REMOTE_STATE_DIR: backend.env.PI_REMOTE_STATE_DIR! };
      Object.assign(process.env, opts);
      let target: Awaited<ReturnType<typeof resolveTarget>> | undefined;
      const connect = async () => {
        target = await resolveTarget({ host: remoteHost, remoteDir });
        return DaemonClient.connect(target.socketPath);
      };
      try {
        const before = { file: readFileSync(local.sessionFile, "utf8"), digest: digestWorktree(local.repo) };
        // Real absence of auth on the host: provider auth, and gh for a GitHub repo.
        for (const [session, remote, pattern] of [
          [{ ...local.info, model: "anthropic/claude-sonnet-4-5" }, undefined, /not authenticated/],
          [local.info, "https://github.com/1aboveio/pi-better-harness.git", /gh/],
        ] as const) {
          if (remote) git(local.repo, "remote", "add", "origin", remote);
          const error = await detachSession({ session, host: remoteHost, connect, isBusy: () => false, stateDir: local.stateDir }).then(() => undefined, (e: unknown) => e);
          await target?.close();
          assert.ok(error instanceof PreflightError, String(error));
          assert.match((error as Error).message, pattern);
          assert.equal(readLocalRecord(local.stateDir, local.info.sessionId), undefined);
          assert.equal(readFileSync(local.sessionFile, "utf8"), before.file);
          assert.deepEqual(digestWorktree(local.repo), before.digest);
          if (remote) git(local.repo, "remote", "remove", "origin");
        }
        assert.equal(ssh(`ls ${remoteDir}/workspaces 2>/dev/null | wc -l`).trim(), "0", "nothing landed on the host");

        const detached = await detachSession({ session: local.info, host: remoteHost, connect, isBusy: () => false, stateDir: local.stateDir });
        assert.equal(detached.verified, true);
        assert.equal(detached.worktreeFiles, before.digest.length);
        const sum = (file: string) => execFileSync("shasum", ["-a", "256", join(local.repo, file)], { encoding: "utf8" }).split(" ")[0];
        for (const file of ["a.txt", "src/untracked.ts"]) assert.equal(ssh(`sha256sum ${detached.cwd}/${file}`).split(" ")[0], sum(file));
        assert.equal(ssh(`cd ${detached.cwd} && git rev-parse HEAD`).trim(), git(local.repo, "rev-parse", "HEAD"));

        // Start a gated turn on the host, then drop the client and the ssh forward entirely.
        const client = await DaemonClient.connect(target!.socketPath);
        await client.call({ type: "prompt", sessionId: local.info.sessionId, message: "tool g1" });
        await waitFor("gate started on host", () => backend.gateStarted("g1"));
        client.close();
        await target!.close();
        await backend.releaseGate("g1");
        await waitFor("host finished the turn alone", () => ssh(`test -e ${work}/gate/g1.finished && echo yes`).trim() === "yes");
        const log = ssh(`cat ${work}/llm.log`).trim().split("\n").map((l) => JSON.parse(l) as { messages: Array<{ role: string; text: string }> });
        assert.ok(log.at(-1)!.messages.some((m) => m.text.startsWith("gate:g1")), "model on the host saw the tool result with no client attached");
        assert.ok(log.at(-1)!.messages.some((m) => m.role === "user" && m.text === "hello"));

        const home = join(local.env.root, "back");
        const returned = await asLocalUser(local, () => returnSession({ ref: local.info.sessionId, host: remoteHost, connect, stateDir: local.stateDir, toCwd: home }));
        assert.equal(returned.verified, true);
        assert.equal(readFileSync(join(home, "a.txt"), "utf8"), "one\nuncommitted edit\n");
        assert.equal(readLocalRecord(local.stateDir, local.info.sessionId)?.state, "owned");
        runPi(local, home, ["-p", "after-return", "--session", returned.sessionFile!]);
        const last = llmCalls(local.env).at(-1)!;
        assert.ok(last.messages.some((m) => m.text === "hello") && last.messages.some((m) => m.text === "after-return"));
      } finally {
        await target?.close();
        for (const key of Object.keys(opts)) delete process.env[key];
        await backend.cleanup();
      }
    });
  });
} else {
  describe("detach to a real host", () => it("is skipped without PI_REMOTE_TEST_HOST", { skip: "set PI_REMOTE_TEST_HOST (+ PI_REMOTE_TEST_HOST_ROOT) to run against a real host" }, () => undefined));
}
