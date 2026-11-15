import test from "node:test";
import assert from "node:assert/strict";
import { fork, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { WorkClient } from "../src/runtime/work-client.mjs";
import { processMatchesStart } from "../src/daemon-owner.ts";

test("managed worker parks and continues after its foreground parent exits", { timeout: 60000 }, async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "launch-")), transport = realpathSync(mkdtempSync("/tmp/p761-"));
  const agent = join(root, "agent"), cwd = join(root, "workspace"); mkdirSync(join(agent, "agents/roles"), { recursive: true }); mkdirSync(cwd);
  const entered = join(cwd, "entered.json"), release = join(cwd, "release");
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "offline-fixture" } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { providerExtensions: { openai: new URL("./support/subagent-park-model.ts", import.meta.url).pathname }, defaultTools: "read", maxConcurrent: 1 } } }));
  writeFileSync(join(agent, "agents/roles/fixture.md"), "---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4.1\n---\nFrozen launch instructions.\n");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root,
    LAUNCH_WORKSPACE: cwd, LAUNCH_ENTERED: entered, LAUNCH_RELEASE: release };
  const execPath = process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath;
  let daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = ""; daemon.stderr!.on("data", data => { errors += data; });
  let parent: ReturnType<typeof fork> | undefined;
  let sibling: ReturnType<typeof fork> | undefined;
  const attempts: string[] = [];
  let bootstrapProof: Record<string, unknown> | undefined;
  const metaFor = (id: string) => JSON.parse(readFileSync(join(root, "pi-better-subagents/runs", id, "meta.json"), "utf8"));
  const terminal = async (id: string) => {
    // Recovered children have no exit listener; the current health pass is 15 s.
    const deadline = Date.now() + 20000;
    while (["running", "orphaned"].includes(metaFor(id).status)) {
      assert.ok(Date.now() < deadline, `Terminal publication timed out for ${id}: ${errors}`);
      await delay(25);
    }
    return metaFor(id);
  };
  const waitFile = async (path: string) => {
    if (existsSync(path)) return;
    const watcher = watch(cwd);
    try { while (!existsSync(path)) await once(watcher, "change"); } finally { watcher.close(); }
  };
  try {
    await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
    parent = fork(new URL("./support/subagent-launch-sdk.mjs", import.meta.url), [], { execPath: process.execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    parent.stderr!.on("data", data => { errors += data; });
    const [ready] = await Promise.race([once(parent, "message"), once(parent, "exit").then(() => { throw new Error(errors); })]);
    const launch = async (params: object, key = "same-launch", child = parent!, goalComplete = false) => {
      const reply = once(child, "message"); child.send({ key, params, goalComplete }); const [message] = await reply;
      assert.equal(message.error, undefined, `${message.stack ?? message.error}\n${errors}`); return message.result;
    };
    const params = { prompt: "Execute fixture", role: "fixture", model: "openai/gpt-4.1", callback: false, tools: "read,bg_task_spawn,bg_task_status,wait_for_operations", skills: [] };
    const first = await launch(params);
    assert.equal(first.details.launched, true);
    attempts.push(first.details.runId);
    const exited = once(parent, "exit"); parent.send({ stop: true }); await exited; parent = undefined;
    const parkedDeadline = Date.now() + 20000;
    while (!existsSync(join(root, "pi-better-subagents/runs", first.details.runId, "park.json"))) {
      assert.ok(Date.now() < parkedDeadline, `Worker did not park: ${errors}`);
      await delay(50);
    }
    writeFileSync(release, "release");
    const continuedDeadline = Date.now() + 25000;
    while (!existsSync(`${entered}.continued`)) {
      assert.ok(Date.now() < continuedDeadline, `Worker did not continue: ${errors}`);
      await delay(50);
    }
    const park = JSON.parse(readFileSync(join(root, "pi-better-subagents/runs", first.details.runId, "park.json"), "utf8"));
    attempts.push(park.resumedBy);
    const resumed = await terminal(park.resumedBy);
    assert.equal(resumed.status, "completed");
    assert.equal(resumed.sessionId, metaFor(first.details.runId).sessionId);
    assert.equal(resumed.spawnPid, metaFor(first.details.runId).spawnPid);
    assert.notEqual(JSON.parse(readFileSync(`${entered}.continued`, "utf8")).pid, metaFor(first.details.runId).pid);
  } catch (error) {
    console.error("Managed launch scenario failed:", error, errors);
    throw error;
  } finally {
    writeFileSync(release, "release");
    if (parent?.exitCode === null) { const exit = once(parent, "exit"); parent.send({ stop: true }); await exit; }
    if (sibling?.exitCode === null) { const exit = once(sibling, "exit"); sibling.send({ stop: true }); await exit; }
    if (daemon.exitCode === null) { const exit = once(daemon, "exit"); daemon.send("stop"); await exit; }
    for (const id of attempts) {
      const meta = metaFor(id);
      if (processMatchesStart(meta.pid, meta.pidStartTime)) {
        try { process.kill(-meta.pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        const deadline = Date.now() + 2000;
        while (processMatchesStart(meta.pid, meta.pidStartTime)) {
          assert.ok(Date.now() < deadline, `Fixture worker ${id} did not exit`);
          await delay(25);
        }
      }
    }
    // Runtime artifacts remain owned evidence until every worker has been verified exited.
    rmSync(transport, { recursive: true, force: true });
  }
});
