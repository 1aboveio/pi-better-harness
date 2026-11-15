import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { processMatchesStart } from "../src/daemon-owner.ts";
import { DatabaseSync } from "node:sqlite";

for (const phase of ["before-bootstrap", "before-bridge"] as const) {
test(`replacement ${phase} preserves the exact launch and writer fence`, { timeout: 60000 }, async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "bootstrap-restart-")), agent = join(root, "agent"), cwd = join(root, "workspace");
  const transport = realpathSync(mkdtempSync("/tmp/p761-before-"));
  mkdirSync(agent); mkdirSync(cwd);
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "offline-fixture" } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: {
    defaultTools: "read", providerExtensions: { openai: new URL(phase === "before-bridge" ? "./support/subagent-provider-barrier.mjs" : "./support/subagent-offline-model.ts", import.meta.url).pathname }
  } } }));
  const entered = join(cwd, "entered"), release = join(cwd, "release");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root,
    LAUNCH_WORKSPACE: cwd, LAUNCH_ENTERED: entered, LAUNCH_RELEASE: release, BOOTSTRAP_BARRIER: cwd,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""}${phase === "before-bootstrap" ? ` --import=${new URL("./support/subagent-bootstrap-barrier.mjs", import.meta.url).href}` : ""}` };
  let errors = "";
  let runId: string | undefined;
  const until = async (check: () => boolean, reason: string) => {
    const deadline = Date.now() + 20000;
    while (!check()) { assert.ok(Date.now() < deadline, `${reason}: ${errors}`); await delay(25); }
  };
  const start = async (url: URL) => {
    const child = fork(url, [], { execPath: url.pathname.endsWith("work-daemon.ts") ? process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath : process.execPath,
      execArgv: ["--import", "tsx"], env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", bytes => { errors += bytes; });
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors); })]);
    return child;
  };
  const stop = async (child: ReturnType<typeof fork>, message: unknown) => {
    if (child.exitCode === null) {
      const exited = once(child, "exit"); child.send(message as any);
      try { await Promise.race([exited, delay(10000, undefined, { ref: false }).then(() => { throw new Error("Fixture shutdown timed out"); })]); }
      catch (error) { child.kill("SIGKILL"); await exited; throw error; }
    }
  };
  let daemon = await start(new URL("./support/work-daemon.ts", import.meta.url));
  let parent: ReturnType<typeof fork> | undefined;
  try {
    writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
    parent = await start(new URL("./support/subagent-launch-sdk.mjs", import.meta.url));
    const launch = async () => {
      const reply = once(parent!, "message");
      parent!.send({ key: "before-bootstrap", params: { prompt: "Real bootstrap restart witness", model: "openai/gpt-4.1", tools: "read", callback: false, skills: [] } });
      const [message] = await reply;
      assert.equal(message.error, undefined, message.stack ?? message.error); return message.result;
    };
    const first = await launch(), id = first.details.runId; runId = id;
    const db = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    const attempt = () => {
      const rows = db.prepare("SELECT attempts FROM subagent_launch_intents").all();
      assert.equal(rows.length, 1); const attempts = JSON.parse(String(rows[0]!.attempts));
      assert.equal(attempts.length, 1); return attempts[0];
    };
    try {
      await until(() => existsSync(join(cwd, "waiting")), "Bootstrap barrier not reached");
      const original = attempt(); assert.equal(original.id, id); assert.equal(original.bootstrapped, phase === "before-bootstrap" ? undefined : true);
      await stop(daemon, "stop"); daemon = await start(new URL("./support/work-daemon.ts", import.meta.url));
      const observer = new WorkClient(join(transport, "pi-server.sock"), agent);
      try {
        const deadline = Date.now() + 10000;
        while (!(await observer.request("runtime_get_status")).subagentManagement?.continuationReady) {
          assert.ok(Date.now() < deadline, `Runtime bridge did not recover: ${errors}`); await delay(25);
        }
      } finally { observer.close(); }
      writeFileSync(release, "release");
      const log = join(root, "pi-better-subagents/runs", id, "output.log");
      if (phase === "before-bootstrap") {
        await until(() => readFileSync(log, "utf8").includes("epoch/token is no longer admitted"), "Old epoch was not fenced");
        assert.equal(existsSync(entered), false, "unbootstrapped old epoch cannot execute model code");
      } else {
        await until(() => readFileSync(log, "utf8").includes('"type":"agent_settled"'), "Restored bridge writer did not complete");
        assert.equal(JSON.parse(readFileSync(entered, "utf8")).pid, original.pid, "exact original writer continues");
      }
      const replay = await launch(); assert.equal(replay.details.runId, id);
      const retained = attempt(); assert.equal(retained.token, original.token); assert.equal(retained.bootstrapped, original.bootstrapped);

    } finally { db.close(); }
  } finally {
    writeFileSync(release, "release");
    if (runId) {
      const meta = JSON.parse(readFileSync(join(root, "pi-better-subagents/runs", runId, "meta.json"), "utf8"));
      if (processMatchesStart(meta.pid, meta.pidStartTime)) {
        process.kill(-meta.pid, "SIGKILL");
        await until(() => !processMatchesStart(meta.pid, meta.pidStartTime), "Fixture writer did not exit");
      }
    }
    if (parent) await stop(parent, { stop: true });
    await stop(daemon, "stop");
    rmSync(transport, { recursive: true, force: true });
  }
});
}
