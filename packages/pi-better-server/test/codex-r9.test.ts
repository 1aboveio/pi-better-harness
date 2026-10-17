/**
 * Steer, ls and return against a real machine over real ssh (PI_REMOTE_TEST_HOST), with the Codex plugin
 * driving the whole loop. The host's Codex has no login (a human has to run `codex login` there), so its
 * model is a mock on this machine, reached through an ssh reverse forward: no credential is involved.
 * Turns against the real model on the host stay pending until that login exists.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { DaemonClient } from "../src/client.ts";
import { moveSession } from "../src/move/orchestrate.ts";
import { resolveTarget } from "../src/remote/target.ts";
import { CODEX_BIN, createThread, git, installPlugin, makeRepo, pkgRoot, remote, run, runCleanups, cleanups, shortDir, startHost, writePiRemoteWrapper, type Host } from "./codex-host.ts";
import { startMockModel, type MockModel } from "./codex-mock-model.ts";
import { waitFor } from "./helpers.ts";

const remoteHost = process.env.PI_REMOTE_TEST_HOST;
const hostRoot = process.env.PI_REMOTE_TEST_HOST_ROOT;
const remoteCodex = process.env.PI_REMOTE_TEST_CODEX_BIN;

if (!remoteHost) {
  describe("Codex steer / return / plugin against a real host", () => it("is skipped without PI_REMOTE_TEST_HOST", { skip: "set PI_REMOTE_TEST_HOST, PI_REMOTE_TEST_HOST_ROOT and PI_REMOTE_TEST_CODEX_BIN" }, () => undefined));
} else {
  after(runCleanups);
  const ssh = (script: string) => spawnSync("ssh", ["-o", "BatchMode=yes", "-T", remoteHost, script], { encoding: "utf8" });

  describe(`Codex steer, ls, return and plugin against ${remoteHost} (real ssh, real Codex on both ends)`, { concurrency: false }, () => {
    let work = "";
    let hostModel: MockModel;
    let tunnel: ChildProcess;
    const remoteArgs = (): string[] => ["--host", remoteHost, "--remote-dir", `${work}/srv`];
    const remoteSha = (path: string) => ssh(`sha256sum ${path}`).stdout.split(" ")[0];
    const localSha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

    before(async () => {
      assert.ok(hostRoot && remoteCodex, "PI_REMOTE_TEST_HOST_ROOT and PI_REMOTE_TEST_CODEX_BIN are required");
      work = `${hostRoot}/sr-${randomBytes(4).toString("hex")}`;
      const nodeBin = ssh(`ls -d ${hostRoot}/node-v*/bin/node | head -1`).stdout.trim();
      hostModel = await startMockModel();
      cleanups.push(() => hostModel.close());

      // The host's model: a mock here, reached from the host through a reverse forward.
      const remotePort = 20_000 + Math.floor(Math.random() * 20_000);
      tunnel = spawn("ssh", ["-N", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${remotePort}:127.0.0.1:${hostModel.port}`, remoteHost], { stdio: "ignore" });
      cleanups.push(() => void tunnel.kill());
      await waitFor("reverse forward", () => ssh(`bash -c 'exec 3<>/dev/tcp/127.0.0.1/${remotePort}' && echo up`).stdout.trim() === "up", 30_000);

      ssh(`mkdir -p ${work}/home`);
      const config = [
        'model = "mock-model"', 'model_provider = "mock"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', "check_for_update_on_startup = false", "",
        "[model_providers.mock]", 'name = "mock"', `base_url = "http://127.0.0.1:${remotePort}/v1"`, 'wire_api = "responses"', "requires_openai_auth = false", "request_max_retries = 0", "stream_max_retries = 0", "",
      ].join("\n");
      execFileSync("ssh", ["-o", "BatchMode=yes", remoteHost, `cat > ${work}/home/config.toml`], { input: config });
      execFileSync("sh", ["-c", `COPYFILE_DISABLE=1 tar -C ${pkgRoot} -cf - src | ssh -o BatchMode=yes ${remoteHost} 'tar -C ${work} -xf - 2>/dev/null'`]);
      ssh(`printf '{ "type": "module" }\\n' > ${work}/package.json`);
      const pid = ssh(
        `cd ${work} && (PATH=$(dirname ${nodeBin}):$PATH PI_SERVER_DIR=${work}/srv CODEX_HOME=${work}/home PI_CODEX_BIN=${remoteCodex} setsid nohup ${nodeBin} src/cli.ts --agent codex > daemon.log 2>&1 < /dev/null & echo $!)`,
      ).stdout.trim();
      cleanups.push(() => {
        ssh(`PATH=$(dirname ${nodeBin}):$PATH CODEX_HOME=${work}/home ${remoteCodex} app-server daemon stop >/dev/null 2>&1; kill -9 ${pid} 2>/dev/null; pkill -f '${work.slice(0, -1)}[${work.slice(-1)}]'; sleep 1; rm -rf ${work}; true`);
      });
      await waitFor("remote codex daemon to listen", () => ssh(`grep -c 'listening on' ${work}/daemon.log || true`).stdout.trim() !== "0", 90_000);
    });

    const plugin = async (laptop: Host, tool: string, args: Record<string, unknown>) => {
      const wrapper = writePiRemoteWrapper(shortDir("cx-bin-"));
      const mark = laptop.model.requests.length;
      laptop.model.queueToolCall(tool, args, "mcp__pi_remote");
      const result = await run(
        [CODEX_BIN, "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", shortDir("cx-exec-"), `use ${tool}`],
        { ...laptop.env, PI_REMOTE_BIN: wrapper, PI_REMOTE_SERVER_DIR: `${work}/srv`, PI_REMOTE_TMP: shortDir("cx-fw-") },
      );
      assert.equal(result.code, 0, result.stderr);
      const raw = laptop.model.requests.slice(mark).flatMap((r) => r.input).filter((i) => i.type === "function_call_output").at(-1)?.output;
      const text = Array.isArray(raw) ? raw.map((p: { text: string }) => p.text).filter((t: string) => !t.startsWith("Wall time")).join("\n") : String(raw);
      assert.ok(!/^\[stderr\]/.test(text) || !/pi-remote:/.test(text), text);
      return text;
    };

    it("the Codex plugin drives detach, ls, steer and return across the host; steering reaches the host's Codex", async () => {
      const laptop = await startHost("rl1");
      const repo = makeRepo(shortDir("cx-ws-"));
      const id = await createThread(laptop, repo);
      await installPlugin(laptop);

      // detach
      const detached = JSON.parse(await plugin(laptop, "remote_detach", { session: id, to: remoteHost })) as { cwd: string; verified: boolean; worktreeFiles: number };
      assert.equal(detached.verified, true);
      for (const file of ["a.txt", "src/untracked.ts", "run.sh"]) assert.equal(remoteSha(`${detached.cwd}/${file}`), localSha(join(repo, file)), `${file} differs on the host`);
      assert.equal(ssh(`cd ${detached.cwd} && git rev-parse HEAD`).stdout.trim(), git(repo, "rev-parse", "HEAD"));
      assert.equal(ssh(`ls ${work}/home | grep -c '^auth.json$' || true`).stdout.trim(), "0");

      // ls on the host
      const listed = JSON.parse(await plugin(laptop, "remote_ls", { host: remoteHost })) as Array<{ sessionId: string; displayStatus: string; cwd: string }>;
      assert.deepEqual(listed.map((t) => [t.sessionId, t.displayStatus, t.cwd]), [[id, "idle", detached.cwd]]);

      // steer on the host while idle: the host's Codex runs a turn against its (mock) model with the carried-over history
      const mark = hostModel.requests.length;
      const steered = JSON.parse(await plugin(laptop, "remote_steer", { host: remoteHost, session: id, message: "work on the server" }));
      assert.equal(steered.delivered, "prompt");
      await waitFor("host turn", () => hostModel.requests.length > mark);
      const sent = JSON.stringify(hostModel.requests.at(-1)?.input);
      assert.ok(sent.includes("hello from the laptop") && sent.includes("work on the server"), "history and new text reached the host's model");
      ssh(`echo 'edited on the host' >> ${detached.cwd}/a.txt`);

      // return
      await waitFor("host thread idle", async () => {
        const rows = JSON.parse((await remote(["ls", "--json", ...remoteArgs()])).stdout || "[]") as Array<{ displayStatus: string }>;
        return rows[0]?.displayStatus === "idle";
      });
      const back = join(shortDir("cx-back-"), "ws");
      const returned = JSON.parse(await plugin(laptop, "remote_return", { host: remoteHost, session: id, to_cwd: back })) as { cwd: string; verified: boolean };
      assert.equal(returned.cwd, back);
      assert.equal(returned.verified, true);
      assert.equal(localSha(join(back, "a.txt")), remoteSha(`${detached.cwd}/a.txt`));
      assert.match(readFileSync(join(back, "a.txt"), "utf8"), /edited on the host/);
      assert.equal(git(back, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));

      // Single writer: the host retired it (still listed, but shown as moved, not idle) and refuses messages;
      // the laptop owns it and resumes with the host's turn in the history.
      const hostRows = JSON.parse((await remote(["ls", "--json", ...remoteArgs()])).stdout) as Array<{ sessionId: string; displayStatus: string; ownership?: string }>;
      assert.deepEqual(hostRows.map((t) => [t.sessionId, t.displayStatus, t.ownership]), [[id, "moved", "moved"]]);
      const refused = await remote(["steer", "--json", ...remoteArgs(), id, "x"]);
      assert.notEqual(refused.code, 0);
      assert.match(refused.stderr, /moved on this host/);
      const lmark = laptop.model.requests.length;
      const resumed = await remote(["steer", "--json", "--socket", laptop.daemon.socketPath, id, "back on the laptop"]);
      assert.equal(JSON.parse(resumed.stdout).delivered, "prompt");
      await waitFor("local turn", () => laptop.model.requests.length > lmark);
      const localSent = JSON.stringify(laptop.model.requests.at(-1)?.input);
      for (const text of ["hello from the laptop", "work on the server", "back on the laptop"]) assert.ok(localSent.includes(text), text);
    });

    it("steers a thread that is mid-turn on the host", async () => {
      const laptop = await startHost("rl2");
      const repo = makeRepo(shortDir("cx-ws-"));
      const id = await createThread(laptop, repo);
      const destination = await resolveTarget({ host: remoteHost, remoteDir: `${work}/srv`, controlPathRoot: shortDir("cx-ctl-") });
      cleanups.push(() => destination.close());
      const client = await DaemonClient.connect(destination.socketPath);
      cleanups.push(() => client.close());
      await moveSession(laptop.client, client, { sessionId: id });

      const hold = hostModel.holdNext();
      const started = await remote(["steer", "--json", ...remoteArgs(), id, "start a long job"]);
      assert.equal(JSON.parse(started.stdout).delivered, "prompt");
      await hold.arrived;
      const running = JSON.parse((await remote(["ls", "--json", ...remoteArgs()])).stdout) as Array<{ displayStatus: string }>;
      assert.equal(running[0]?.displayStatus, "running");

      const mark = hostModel.requests.length;
      const mid = await remote(["steer", "--json", ...remoteArgs(), id, "actually, stop and report"]);
      assert.equal(JSON.parse(mid.stdout).delivered, "steer");
      hold.release();
      await waitFor("steer to reach the host's model", () => hostModel.requests.length > mark);
      assert.ok(JSON.stringify(hostModel.requests.at(-1)?.input).includes("actually, stop and report"));
      await waitFor("host turn to end", async () => (JSON.parse((await remote(["ls", "--json", ...remoteArgs()])).stdout) as Array<{ displayStatus: string }>)[0]?.displayStatus === "idle");
      // Bring it home so the host is left clean.
      const back = await remote(["return", "--json", ...remoteArgs(), id, "--to-cwd", join(shortDir("cx-back-"), "ws")], laptop.env);
      assert.equal(back.code, 0, back.stderr);
    });
  });
}
