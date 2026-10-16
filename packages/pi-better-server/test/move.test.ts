import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../src/client.ts";
import { createBundle, digestWorktree, materializeWorkspace, sha256File, verifyBundle } from "../src/core/bundle.ts";
import { MoveError, moveSession } from "../src/move/orchestrate.ts";
import { gate, llmCalls, makeEnv, spawnDaemon, waitFor, type Env } from "./helpers.ts";
import { remoteBackend } from "./remote-host.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "remote-cli.ts");

const SECRET = "SUPER-SECRET-VALUE-9f3a";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

/** A repo on feature-x with history, a dirty tracked change, untracked files, and plenty of things that must stay behind. */
function makeRepo(root: string): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".env\nnode_modules/\ndist/\n");
  writeFileSync(join(repo, "a.txt"), "one\n");
  writeFileSync(join(repo, "gone.txt"), "will be deleted\n");
  writeFileSync(join(repo, "old-name.txt"), "rename me\n");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3, 255]));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature-x");
  writeFileSync(join(repo, "b.txt"), "feature work\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "feature");
  // dirty tracked: modified, deleted, renamed, binary, staged new file
  writeFileSync(join(repo, "a.txt"), "one\nuncommitted edit\n");
  rmSync(join(repo, "gone.txt"));
  git(repo, "mv", "old-name.txt", "new-name.txt");
  writeFileSync(join(repo, "bin.dat"), Buffer.from([9, 8, 7, 0, 255]));
  writeFileSync(join(repo, "staged-new.txt"), "staged\n");
  git(repo, "add", "staged-new.txt");
  // untracked, travels
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "untracked.ts"), "export const x = 1;\n");
  writeFileSync(join(repo, "run.sh"), "#!/bin/sh\necho hi\n");
  chmodSync(join(repo, "run.sh"), 0o755);
  symlinkSync("a.txt", join(repo, "link-to-a"));
  // stays behind: ignored secret, unignored secrets, dependencies, build output
  writeFileSync(join(repo, ".env"), `API_KEY=${SECRET}\n`);
  writeFileSync(join(repo, ".env.local"), `TOKEN=${SECRET}\n`);
  for (const name of [".envrc", ".env-prod", ".env_local", ".ENV.staging"]) writeFileSync(join(repo, name), `export KEY=${SECRET}\n`);
  writeFileSync(join(repo, "auth.json"), `{"token":"${SECRET}"}\n`);
  writeFileSync(join(repo, "id_rsa"), `-----BEGIN KEY-----${SECRET}\n`);
  mkdirSync(join(repo, "config"), { recursive: true });
  writeFileSync(join(repo, "config", "server.pem"), SECRET);
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  mkdirSync(join(repo, "dist"));
  writeFileSync(join(repo, "dist", "out.js"), "built\n");
  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build", "out.js"), "built unignored\n");
  return repo;
}

function tarEntries(archive: string): string[] {
  return execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split("\n").filter(Boolean);
}

const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill("SIGKILL");
});

interface Host {
  env: Env;
  child: ChildProcess;
  socketPath: string;
  client: DaemonClient;
}

async function startHost(): Promise<Host> {
  const env = makeEnv();
  const { child, socketPath } = await spawnDaemon(env);
  children.push(child);
  return { env, child, socketPath, client: await DaemonClient.connect(socketPath) };
}

async function newSession(host: Host, cwd: string, prompt = "hello"): Promise<string> {
  const created = await host.client.call({ type: "create_session", cwd, model: { provider: "fake", modelId: "fake-1" } });
  const sessionId = created.sessionId as string;
  await host.client.call({ type: "prompt", sessionId, message: prompt });
  await idle(host, sessionId);
  return sessionId;
}

async function idle(host: Host, sessionId: string): Promise<void> {
  await waitFor("session idle", async () => {
    const state = await host.client.request({ type: "get_state", sessionId });
    return state.success && !state.data.isStreaming && state.data.messageCount >= 2;
  });
}

async function history(client: DaemonClient, sessionId: string): Promise<Array<{ role: string; text: string }>> {
  const { data } = await client.call({ type: "get_messages", sessionId });
  return data.messages.map((m: { role: string; content: unknown }) => ({
    role: m.role,
    text: typeof m.content === "string" ? m.content : (m.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join(""),
  }));
}

async function summary(client: DaemonClient, sessionId: string): Promise<any> {
  const { data } = await client.call({ type: "list_sessions" });
  return data.sessions.find((s: any) => s.sessionId === sessionId);
}

describe("move: local daemon to local daemon", { concurrency: false }, () => {
  it("transfers a session with dirty and untracked changes; checksums match, history is intact, the agent continues on the target", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    const sessionId = await newSession(a, repo);
    const before = await history(a.client, sessionId);
    assert.ok(before.some((m) => m.text === "echo:hello"));
    const sourceDigest = digestWorktree(repo);

    const result = await moveSession(a.client, b.client, { sessionId, chunkBytes: 4096 });
    assert.equal(result.verified, true);
    assert.ok(result.chunks > 1, "the archive crossed in several chunks");

    // Worktree: same history, same dirty state, same files by checksum.
    const target = result.cwd;
    assert.notEqual(target, repo);
    assert.equal(git(target, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));
    assert.equal(git(target, "branch", "--show-current"), "feature-x");
    assert.equal(git(target, "rev-parse", "main"), git(repo, "rev-parse", "main"), "base ref travels too");
    assert.equal(git(target, "log", "--format=%s", "-3"), git(repo, "log", "--format=%s", "-3"));
    assert.deepEqual(digestWorktree(target), sourceDigest);
    assert.equal(readFileSync(join(target, "a.txt"), "utf8"), "one\nuncommitted edit\n");
    assert.deepEqual([...readFileSync(join(target, "bin.dat"))], [9, 8, 7, 0, 255]);
    assert.equal(existsSync(join(target, "gone.txt")), false);
    assert.equal(readFileSync(join(target, "new-name.txt"), "utf8"), "rename me\n");
    assert.equal(readFileSync(join(target, "src", "untracked.ts"), "utf8"), "export const x = 1;\n");
    assert.ok(statSync(join(target, "run.sh")).mode & 0o100, "executable bit survives");
    assert.equal(readFileSync(join(target, "link-to-a"), "utf8"), "one\nuncommitted edit\n");

    // Nothing sensitive or generated came along.
    for (const left of [".env", ".env.local", ".envrc", ".env-prod", ".env_local", ".ENV.staging", "auth.json", "id_rsa", "config/server.pem", "node_modules", "dist", "build"]) {
      assert.equal(existsSync(join(target, left)), false, `${left} must stay behind`);
    }

    // Exactly one live owner: the source refuses commands, the target serves the session.
    const refused = await a.client.request({ type: "prompt", sessionId, message: "still there?" });
    assert.equal(refused.success, false);
    assert.match(refused.error ?? "", /moved to another daemon/);
    assert.equal((await summary(a.client, sessionId)).ownership, "moved");
    assert.equal((await summary(a.client, sessionId)).live, false);
    const onTarget = await summary(b.client, sessionId);
    assert.equal(onTarget.live, true);
    assert.equal(onTarget.cwd, target);

    // Full history present, and the agent continues with it.
    assert.deepEqual(await history(b.client, sessionId), before);
    await b.client.call({ type: "open_session", sessionId });
    await b.client.call({ type: "prompt", sessionId, message: "after the move" });
    await waitFor("reply on target", async () => (await history(b.client, sessionId)).some((m) => m.text === "echo:after the move"));
    const lastCall = llmCalls(b.env).at(-1)!;
    assert.ok(lastCall.messages.some((m) => m.role === "user" && m.text === "hello"), "the target model saw the pre-move conversation");
    assert.equal(lastCall.messages.at(-1)!.text, "after the move");
  });

  it("an injected transfer failure leaves the source unfenced, resumable, and the target empty", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    const sessionId = await newSession(a, repo);
    const before = await history(a.client, sessionId);

    await assert.rejects(
      moveSession(a.client, b.client, { sessionId, chunkBytes: 2048, faults: { failAtChunk: 2 } }),
      (error: unknown) => error instanceof MoveError && error.sourceUnfenced && /injected transfer failure/.test(error.message),
    );

    assert.equal((await b.client.call({ type: "list_sessions" })).data.sessions.length, 0, "target never held the session");
    assert.equal(existsSync(join(b.env.serverDir, "workspaces")), false, "target workspace was not left behind");
    assert.deepEqual(readdirSync(join(b.env.serverDir, "moves")), [], "target scratch cleaned");
    const after = await summary(a.client, sessionId);
    assert.equal(after.ownership, undefined);
    assert.equal(after.live, true);
    assert.deepEqual(await history(a.client, sessionId), before);
    await a.client.call({ type: "prompt", sessionId, message: "still mine" });
    await waitFor("reply on source", async () => (await history(a.client, sessionId)).some((m) => m.text === "echo:still mine"));
  });

  it("a checksum mismatch in transit is caught before anything is materialized and unfences the source", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    const sessionId = await newSession(a, repo);

    await assert.rejects(
      moveSession(a.client, b.client, { sessionId, chunkBytes: 4096, faults: { corruptChunk: 1 } }),
      (error: unknown) => error instanceof MoveError && error.sourceUnfenced && /checksum mismatch/.test(error.message),
    );

    assert.equal((await b.client.call({ type: "list_sessions" })).data.sessions.length, 0);
    assert.equal(existsSync(join(b.env.serverDir, "workspaces")), false);
    assert.equal((await summary(a.client, sessionId)).live, true);
    // The same session can still move once the fault is gone.
    const result = await moveSession(a.client, b.client, { sessionId, chunkBytes: 64 * 1024 });
    assert.equal(result.verified, true);
    assert.equal((await summary(b.client, sessionId)).live, true);
  });

  it("when the target dies before acknowledging, the source stays fenced (never two writers) until an operator unfences it", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    const sessionId = await newSession(a, repo);

    await assert.rejects(
      moveSession(a.client, b.client, {
        sessionId,
        onProgress: (message) => {
          if (message.startsWith("transferred")) b.child.kill("SIGKILL");
        },
      }),
      (error: unknown) => error instanceof MoveError && !error.sourceUnfenced && /stays fenced/.test(error.message),
    );
    const refused = await a.client.request({ type: "prompt", sessionId, message: "x" });
    assert.equal(refused.success, false);
    assert.match(refused.error ?? "", /fenced for a move/);
    // The fence survives a source restart: the session is not resumed behind the operator's back.
    a.child.kill("SIGKILL");
    await new Promise((r) => a.child.once("close", r));
    const restarted = await spawnDaemon(a.env);
    children.push(restarted.child);
    const client = await DaemonClient.connect(restarted.socketPath);
    const row = await summary(client, sessionId);
    assert.equal(row.ownership, "fenced");
    assert.equal(row.live, false);
    // Operator recovery.
    await client.call({ type: "move_unfence", sessionId });
    assert.equal((await summary(client, sessionId)).live, true);
    await client.call({ type: "prompt", sessionId, message: "back" });
    await waitFor("reply after unfence", async () => (await history(client, sessionId)).some((m) => m.text === "echo:back"));
  });

  it("waits for a safe boundary: a session mid-turn is not fenced", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    const sessionId = await newSession(a, repo);
    await a.client.call({ type: "prompt", sessionId, message: "tool g1" });
    await waitFor("gate to start", () => gate(a.env, "g1").started());

    await assert.rejects(moveSession(a.client, b.client, { sessionId, waitMs: 200 }), /mid-turn/);
    assert.equal((await summary(a.client, sessionId)).ownership, undefined);

    gate(a.env, "g1").release();
    await waitFor("turn to end", async () => (await history(a.client, sessionId)).some((m) => m.text.startsWith("tool-done")));
    const result = await moveSession(a.client, b.client, { sessionId });
    assert.equal(result.verified, true);
    assert.ok((await history(b.client, sessionId)).some((m) => m.text.startsWith("tool-done")));
  });

  it("when only the retire step fails, the printed recovery retires the source and never reopens it", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    const sessionId = await newSession(a, repo);
    const flaky = { call: (command: { type: string }) => (command.type === "move_retire" ? Promise.reject(new Error("connection lost")) : a.client.call(command as never)) } as unknown as DaemonClient;

    let message = "";
    await assert.rejects(moveSession(flaky, b.client, { sessionId }), (error: unknown) => {
      message = (error as Error).message;
      return error instanceof MoveError && !error.sourceUnfenced;
    });
    assert.equal((await summary(a.client, sessionId)).ownership, "fenced");
    assert.doesNotMatch(message, /rerun/);
    const printed = /(pi-remote move \[--host <source>\] --retire \S+ --move-id (\S+) --moved-to (\S+))\)?/.exec(message);
    assert.ok(printed, `message names the retire command: ${message}`);
    assert.match(message, /do not use --abort/);

    const out = spawnSync(process.execPath, [cliPath, "move", "--retire", sessionId, "--move-id", printed![2]!, "--moved-to", printed![3]!, "--json"], { env: { ...process.env, ...a.env.vars }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    assert.equal((await summary(a.client, sessionId)).ownership, "moved");
    assert.equal((await summary(b.client, sessionId)).live, true);
  });

  it("a workspace with a nested git repo is refused, not moved with the repo silently missing", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    mkdirSync(join(repo, "nested"));
    git(join(repo, "nested"), "init", "-q");
    writeFileSync(join(repo, "nested", "work.txt"), "unsaved work\n");
    const sessionId = await newSession(a, repo);

    await assert.rejects(
      moveSession(a.client, b.client, { sessionId }),
      (error: unknown) => error instanceof MoveError && error.sourceUnfenced && /nested\/ is a nested git repository/.test(error.message),
    );
    assert.equal((await b.client.call({ type: "list_sessions" })).data.sessions.length, 0);
    assert.equal((await summary(a.client, sessionId)).live, true);
  });

  it("pi-remote move drives the same transfer from the command line", async () => {
    const [a, b] = [await startHost(), await startHost()];
    const repo = makeRepo(a.env.root);
    const sessionId = await newSession(a, repo);
    const out = spawnSync(process.execPath, [cliPath, "move", sessionId.slice(0, 8), "--to-socket", b.socketPath, "--json"], { env: { ...process.env, ...a.env.vars }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    const result = JSON.parse(out.stdout);
    assert.equal(result.verified, true);
    assert.deepEqual(digestWorktree(result.cwd), digestWorktree(repo));
    assert.equal((await summary(b.client, sessionId)).live, true);
    assert.equal((await summary(a.client, sessionId)).ownership, "moved");
  });
});

describe("session bundle", { concurrency: false }, () => {
  function bundleOf(repo: string, outFile: string) {
    return createBundle({
      cwd: repo,
      outFile,
      agent: { kind: "test", version: "0.0.0", extensions: {} },
      session: { id: "s-1" },
      ownership: { epoch: 0, from: "d", moveId: "m" },
      sessionFiles: [{ name: "s.jsonl", path: join(repo, "a.txt") }],
      stateFiles: [{ name: "state.json", content: "{}" }],
    });
  }

  it("never contains credential files, dependencies, or build output (asserted over the produced archive)", () => {
    const env = makeEnv();
    const repo = makeRepo(env.root);
    const archive = join(env.root, "bundle.tar");
    const manifest = bundleOf(repo, archive);

    const entries = tarEntries(archive).map((e) => e.replace(/\/$/, ""));
    for (const entry of entries) {
      const base = entry.split("/").at(-1)!;
      assert.ok(!/^\.env/.test(base), `.env* in archive: ${entry}`);
      assert.ok(!/(^|\/)(auth\.json|id_rsa)$/.test(entry), `credential file in archive: ${entry}`);
      assert.ok(!/\.pem$/.test(entry), `pem in archive: ${entry}`);
      assert.ok(!/(^|\/)(node_modules|dist|build)(\/|$)/.test(entry), `generated output in archive: ${entry}`);
    }
    // The positive side: the legitimate untracked files are there.
    assert.ok(entries.includes("untracked/src/untracked.ts"));
    assert.ok(entries.includes("untracked/run.sh"));
    // Content, not just names: the secret string is nowhere in any member, including the git bundle and patch.
    const extractDir = join(env.root, "x");
    mkdirSync(extractDir);
    execFileSync("tar", ["-xf", archive, "-C", extractDir]);
    const grep = spawnSync("grep", ["-rla", SECRET, extractDir], { encoding: "utf8" });
    assert.equal(grep.status, 1, `secret found in: ${grep.stdout}`);
    assert.deepEqual(
      manifest.excluded.map((e) => e.path),
      ["auth.json", "build/out.js", "config/server.pem", "id_rsa", ".env.local", ".envrc", ".env-prod", ".env_local", ".ENV.staging"].sort((x, y) => x.localeCompare(y)),
    );
    assert.deepEqual(manifest.excluded.filter((e) => e.reason === "credential").length, 8);
  });

  it("verifyBundle rejects a member that changed after the manifest was written", () => {
    const env = makeEnv();
    const repo = makeRepo(env.root);
    const archive = join(env.root, "bundle.tar");
    bundleOf(repo, archive);
    const ok = verifyBundle(archive, join(env.root, "w1"));
    assert.equal(ok.manifest.formatVersion, 1);

    const tampered = join(env.root, "tampered");
    mkdirSync(tampered);
    execFileSync("tar", ["-xf", archive, "-C", tampered]);
    writeFileSync(join(tampered, "untracked", "src", "untracked.ts"), "export const x = 2;\n");
    const bad = join(env.root, "bad.tar");
    execFileSync("tar", ["-cf", bad, "-C", tampered, ...readdirSync(tampered)]);
    assert.throws(() => verifyBundle(bad, join(env.root, "w2")), /Checksum mismatch for untracked\/src\/untracked\.ts/);

    writeFileSync(join(tampered, "extra.txt"), "smuggled");
    const extra = join(env.root, "extra.tar");
    execFileSync("tar", ["-cf", extra, "-C", tampered, ...readdirSync(tampered)]);
    assert.throws(() => verifyBundle(extra, join(env.root, "w3")), /Checksum mismatch|does not list/);
  });

  it("materialize refuses a non-empty destination and fails loudly when the rebuilt tree differs", () => {
    const env = makeEnv();
    const repo = makeRepo(env.root);
    const archive = join(env.root, "bundle.tar");
    bundleOf(repo, archive);
    const extracted = verifyBundle(archive, join(env.root, "w"));
    const occupied = join(env.root, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "x"), "x");
    assert.throws(() => materializeWorkspace(extracted, occupied), /not empty/);

    extracted.manifest.worktree[0]!.sha256 = "0".repeat(64);
    const dest = join(env.root, "dest");
    assert.throws(() => materializeWorkspace(extracted, dest), /differs from the bundle/);
    assert.equal(existsSync(dest), false, "a failed restore leaves no half-built workspace");
  });

  describe("refuses bundles that write into .git or outside the workspace", () => {
    type Edit = (manifest: ReturnType<typeof bundleOf>, stage: string) => void;
    /** Re-pack a valid bundle after `edit` changed its manifest or members; checksums are refreshed so only the path policy can refuse it. */
    function forge(env: Env, edit: Edit): string {
      const repo = makeRepo(env.root);
      const archive = join(env.root, "bundle.tar");
      bundleOf(repo, archive);
      const stage = join(env.root, "forge");
      mkdirSync(stage);
      execFileSync("tar", ["-xf", archive, "-C", stage]);
      const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
      edit(manifest, stage);
      manifest.totals.files = manifest.files.length;
      manifest.totals.bytes = manifest.files.reduce((sum: number, f: { size: number }) => sum + f.size, 0);
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
      const forged = join(env.root, "forged.tar");
      execFileSync("tar", ["-cf", forged, "-C", stage, ...readdirSync(stage)]);
      return forged;
    }
    function addUntracked(manifest: any, stage: string, path: string, content: string): void {
      const full = join(stage, "untracked", path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      manifest.files.push({ path: `untracked/${path}`, role: "untracked", sha256: sha256File(full), size: Buffer.byteLength(content) });
      manifest.worktree.push({ path, sha256: sha256File(full), mode: "644" });
    }
    function expectRefused(env: Env, edit: Edit, pattern: RegExp, marker?: string): void {
      const forged = forge(env, edit);
      const dest = join(env.root, "dest");
      assert.throws(() => {
        const extracted = verifyBundle(forged, join(env.root, "w"));
        materializeWorkspace(extracted, dest);
      }, pattern);
      assert.equal(existsSync(dest), false, "nothing is materialized");
      if (marker) assert.equal(existsSync(marker), false, "the planted command never ran");
    }
    const fsmonitor = (marker: string) => `[core]\n\tfsmonitor = touch ${marker}\n`;

    it("refuses untracked/.git/config carrying core.fsmonitor, in any case", () => {
      for (const dir of [".git", ".GIT", ".Git"]) {
        const env = makeEnv();
        const marker = join(env.root, "pwned");
        expectRefused(env, (m, stage) => addUntracked(m, stage, `${dir}/config`, fsmonitor(marker)), /writes into \.git/, marker);
      }
    });

    it("refuses a .git segment nested deeper, and a .git entry only listed in the worktree", () => {
      expectRefused(makeEnv(), (m, stage) => addUntracked(m, stage, "sub/.git/hooks/post-checkout", "#!/bin/sh\n"), /writes into \.git/);
      expectRefused(makeEnv(), (m) => m.worktree.push({ path: ".git/config", sha256: "0".repeat(64), mode: "644" }), /writes into \.git/);
    });

    it("refuses a symlink whose path is under .git, so the fsmonitor config never lands", () => {
      const env = makeEnv();
      const marker = join(env.root, "pwned");
      writeFileSync(join(env.root, "evil-config"), fsmonitor(marker));
      expectRefused(env, (m) => m.symlinks.push({ path: ".git/config", target: join(env.root, "evil-config") }), /writes into \.git/, marker);
      expectRefused(makeEnv(), (m) => m.symlinks.push({ path: ".GIT/hooks", target: "x" }), /writes into \.git/);
    });

    it("refuses symlinks that point into .git, outside the workspace, or at an absolute path", () => {
      expectRefused(makeEnv(), (m) => m.symlinks.push({ path: "gl", target: ".git" }), /into \.git/);
      expectRefused(makeEnv(), (m) => m.symlinks.push({ path: "d/gl", target: "../.GIT/hooks" }), /into \.git/);
      expectRefused(makeEnv(), (m) => m.symlinks.push({ path: "esc", target: "../../outside" }), /outside the workspace/);
      expectRefused(makeEnv(), (m) => m.symlinks.push({ path: "abs", target: "/etc" }), /absolute target/);
    });

    it("refuses a member written through another bundled symlink", () => {
      expectRefused(
        makeEnv(),
        (m, stage) => {
          m.symlinks.push({ path: "sneaky", target: "src" });
          addUntracked(m, stage, "sneaky/x.txt", "x");
        },
        /runs through symlink/,
      );
    });

    it("refuses an untracked file that would be written through a tracked symlink into .git", () => {
      const env = makeEnv();
      const repo = makeRepo(env.root);
      symlinkSync(".git", join(repo, "gitlink"));
      git(repo, "add", "gitlink");
      git(repo, "commit", "-q", "-m", "link");
      const archive = join(env.root, "bundle.tar");
      bundleOf(repo, archive);
      const stage = join(env.root, "forge");
      mkdirSync(stage);
      execFileSync("tar", ["-xf", archive, "-C", stage]);
      const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
      const marker = join(env.root, "pwned");
      addUntracked(manifest, stage, "gitlink/config", fsmonitor(marker));
      manifest.totals.files = manifest.files.length;
      manifest.totals.bytes = manifest.files.reduce((sum: number, f: { size: number }) => sum + f.size, 0);
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
      const forged = join(env.root, "forged.tar");
      execFileSync("tar", ["-cf", forged, "-C", stage, ...readdirSync(stage)]);
      const dest = join(env.root, "dest");
      assert.throws(() => materializeWorkspace(verifyBundle(forged, join(env.root, "w")), dest), /runs through symlink gitlink/);
      assert.equal(existsSync(dest), false);
      assert.equal(existsSync(marker), false);
    });

    it("refuses an untracked file that replaces a tracked symlink pointing into .git/config", () => {
      const env = makeEnv();
      const repo = makeRepo(env.root);
      symlinkSync(".git/config", join(repo, "cfg"));
      git(repo, "add", "cfg");
      git(repo, "commit", "-q", "-m", "cfg link");
      const archive = join(env.root, "bundle.tar");
      bundleOf(repo, archive);
      const stage = join(env.root, "forge");
      mkdirSync(stage);
      execFileSync("tar", ["-xf", archive, "-C", stage]);
      const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
      const marker = join(env.root, "pwned");
      addUntracked(manifest, stage, "cfg", fsmonitor(marker));
      manifest.totals.files = manifest.files.length;
      manifest.totals.bytes = manifest.files.reduce((sum: number, f: { size: number }) => sum + f.size, 0);
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
      const forged = join(env.root, "forged.tar");
      execFileSync("tar", ["-cf", forged, "-C", stage, ...readdirSync(stage)]);
      const dest = join(env.root, "dest");
      assert.throws(() => materializeWorkspace(verifyBundle(forged, join(env.root, "w")), dest), /runs through symlink cfg/);
      assert.equal(existsSync(dest), false);
      assert.equal(existsSync(marker), false);
    });

    it("refuses symlinks that only escape once other links are followed (b -> '.', a -> 'b/..')", () => {
      expectRefused(
        makeEnv(),
        (m) => {
          m.symlinks.push({ path: "b", target: "." }, { path: "a", target: "b/.." });
        },
        /points outside the workspace/,
      );
    });

    /** Commit `links` (name -> target) into the bundled history, then forge the bundle with `edit`. */
    function expectRefusedWithTracked(links: Record<string, string>, edit: Edit, pattern: RegExp, marker?: string): void {
      const env = makeEnv();
      const repo = makeRepo(env.root);
      for (const [name, target] of Object.entries(links)) {
        symlinkSync(target, join(repo, name));
        git(repo, "add", name);
      }
      git(repo, "commit", "-q", "-m", "links");
      const archive = join(env.root, "bundle.tar");
      bundleOf(repo, archive);
      const stage = join(env.root, "forge");
      mkdirSync(stage);
      execFileSync("tar", ["-xf", archive, "-C", stage]);
      const manifest = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8"));
      edit(manifest, stage);
      manifest.totals.files = manifest.files.length;
      manifest.totals.bytes = manifest.files.reduce((sum: number, f: { size: number }) => sum + f.size, 0);
      writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest));
      const forged = join(env.root, "forged.tar");
      execFileSync("tar", ["-cf", forged, "-C", stage, ...readdirSync(stage)]);
      const dest = join(env.root, "dest");
      assert.throws(() => materializeWorkspace(verifyBundle(forged, join(env.root, "w")), dest), pattern);
      assert.equal(existsSync(dest), false, "nothing is materialized");
      if (marker) assert.equal(existsSync(marker), false);
    }

    it("refuses a manifest symlink that reaches .git through a tracked symlink (t -> .git, u -> t/hooks)", () => {
      expectRefusedWithTracked({ t: ".git" }, (m) => m.symlinks.push({ path: "u", target: "t/hooks" }), /points into \.git/);
    });

    it("refuses tracked symlinks into .git or out of the workspace, and one added by tracked.patch", () => {
      expectRefusedWithTracked({ t: ".git" }, () => {}, /points into \.git/);
      expectRefusedWithTracked({ up: "../.." }, () => {}, /points outside the workspace/);
      expectRefusedWithTracked(
        {},
        (m, stage) => {
          const patchPath = join(stage, "tracked.patch");
          const patch = `${readFileSync(patchPath, "utf8")}diff --git a/hk b/hk\nnew file mode 120000\n--- /dev/null\n+++ b/hk\n@@ -0,0 +1 @@\n+.git/hooks\n\\ No newline at end of file\n`;
          writeFileSync(patchPath, patch);
          const entry = m.files.find((f: { path: string }) => f.path === "tracked.patch")!;
          entry.sha256 = sha256File(patchPath);
          entry.size = Buffer.byteLength(patch);
        },
        /points into \.git/,
      );
    });

    const linkDigest = (target: string) => createHash("sha256").update(target).digest("hex");
    /** A manifest symlink plus its worktree entry, so the restored digest matches and only the path policy can refuse it. */
    function addLink(manifest: any, path: string, target: string): void {
      manifest.symlinks.push({ path, target });
      manifest.worktree.push({ path, sha256: linkDigest(target), mode: "symlink" });
    }
    // On POSIX '\' is an ordinary filename character: `a\b/../..` names a directory `a\b`, so two '..' climb out.
    it("refuses a backslash in an untracked path even when it makes a real directory a link climbs out of", () => {
      expectRefused(
        makeEnv(),
        (m, stage) => {
          addUntracked(m, stage, "a\\b/f", "x");
          addLink(m, "x", "a\\b/../..");
        },
        /backslash/,
      );
    });

    it("refuses a backslash in a worktree entry", () => {
      expectRefused(makeEnv(), (m) => m.worktree.push({ path: "a\\b", sha256: "0".repeat(64), mode: "644" }), /backslash/);
    });

    it("refuses a backslash in a symlink path", () => {
      expectRefused(makeEnv(), (m) => addLink(m, "a\\b", "src"), /backslash/);
    });

    it("refuses a backslash in a symlink target", () => {
      expectRefused(makeEnv(), (m) => addLink(m, "x", "a\\b/../.."), /backslash/);
    });

    it("refuses a tracked symlink whose target holds a backslash", () => {
      expectRefusedWithTracked({ x: "a\\b/../.." }, () => {}, /points outside the workspace/);
    });

    it("refuses a patch-created symlink whose target holds a backslash", () => {
      expectRefusedWithTracked(
        {},
        (m, stage) => {
          const patchPath = join(stage, "tracked.patch");
          const patch = `${readFileSync(patchPath, "utf8")}diff --git a/hk b/hk\nnew file mode 120000\n--- /dev/null\n+++ b/hk\n@@ -0,0 +1 @@\n+a\\b/../..\n\\ No newline at end of file\n`;
          writeFileSync(patchPath, patch);
          const entry = m.files.find((f: { path: string }) => f.path === "tracked.patch")!;
          entry.sha256 = sha256File(patchPath);
          entry.size = Buffer.byteLength(patch);
          m.worktree.push({ path: "hk", sha256: linkDigest("a\\b/../.."), mode: "symlink" });
        },
        /points outside the workspace/,
      );
    });

    it("still restores an ordinary bundle, including a relative symlink", () => {
      const env = makeEnv();
      const repo = makeRepo(env.root);
      const archive = join(env.root, "bundle.tar");
      bundleOf(repo, archive);
      const result = materializeWorkspace(verifyBundle(archive, join(env.root, "w")), join(env.root, "dest"));
      assert.ok(result.files > 0);
    });
  });
});

const remoteHost = process.env.PI_REMOTE_TEST_HOST;
if (remoteHost) {
  describe(`move to ${remoteHost} over an SSH-forwarded socket`, { concurrency: false }, () => {
    it("moves a dirty+untracked session to the host; checksums match and the agent continues there", async () => {
      const backend = await remoteBackend(remoteHost);
      try {
        const a = await startHost();
        const repo = makeRepo(a.env.root);
        const sessionId = await newSession(a, repo);
        const before = await history(a.client, sessionId);
        const remoteDir = backend.flags[backend.flags.indexOf("--remote-dir") + 1]!;
        const work = dirname(remoteDir);

        const out = spawnSync(process.execPath, [cliPath, "move", sessionId, "--to", remoteHost, "--to-remote-dir", remoteDir, "--json"], {
          env: { ...process.env, ...a.env.vars, PI_REMOTE_STATE_DIR: backend.env.PI_REMOTE_STATE_DIR! },
          encoding: "utf8",
          timeout: 180_000,
        });
        assert.equal(out.status, 0, out.stderr);
        const result = JSON.parse(out.stdout);
        assert.equal(result.verified, true);
        assert.equal(result.worktreeFiles, digestWorktree(repo).length);

        // Independent check on the host with its own sha256sum.
        const ssh = (script: string) => spawnSync("ssh", ["-o", "BatchMode=yes", "-T", remoteHost, script], { encoding: "utf8" }).stdout;
        const local = (file: string) => execFileSync("shasum", ["-a", "256", join(repo, file)], { encoding: "utf8" }).split(" ")[0];
        for (const file of ["a.txt", "bin.dat", "new-name.txt", "src/untracked.ts", "run.sh", "b.txt"]) {
          assert.equal(ssh(`sha256sum ${result.cwd}/${file}`).split(" ")[0], local(file), `${file} differs on the host`);
        }
        assert.equal(ssh(`cd ${result.cwd} && git rev-parse HEAD`).trim(), git(repo, "rev-parse", "HEAD"));
        assert.equal(ssh(`cd ${result.cwd} && ls -A | grep -c -E '^(\\.env|auth\\.json|id_rsa|node_modules|dist|build)' || true`).trim(), "0");

        // The host's daemon serves the session; steering it reaches the model with the earlier conversation.
        const steer = spawnSync(process.execPath, [cliPath, "steer", sessionId, "continue-on-host", ...backend.flags], { env: { ...process.env, ...backend.env }, encoding: "utf8" });
        assert.equal(steer.status, 0, steer.stderr);
        await waitFor("model on the host to see the steer", async () => (await backend.userTexts()).includes("continue-on-host"));
        const log = ssh(`cat ${work}/llm.log`).trim().split("\n").map((l) => JSON.parse(l) as { messages: Array<{ role: string; text: string }> });
        const last = log.at(-1)!;
        for (const m of before.filter((x) => x.role === "user")) assert.ok(last.messages.some((x) => x.role === "user" && x.text === m.text), "pre-move prompt is in the host model's context");
        assert.equal(await summary(a.client, sessionId).then((s) => s.ownership), "moved");
      } finally {
        await backend.cleanup();
      }
    });
  });
} else {
  describe("move to a real host", () => it("is skipped without PI_REMOTE_TEST_HOST", { skip: "set PI_REMOTE_TEST_HOST (+ PI_REMOTE_TEST_HOST_ROOT) to run against a real host" }, () => undefined));
}
