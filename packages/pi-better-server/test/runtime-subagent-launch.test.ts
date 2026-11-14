import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WorkClient } from "../src/runtime/work-client.mjs";

test("registered SDK launch freezes shared catalog, retries one intent, and survives parent exit", { timeout: 30000 }, async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "launch-")), transport = mkdtempSync("/tmp/p761-");
  const agent = join(root, "agent"), cwd = join(root, "workspace"); mkdirSync(join(agent, "agents/roles"), { recursive: true }); mkdirSync(cwd);
  const entered = join(cwd, "entered.json"), release = join(cwd, "release");
  writeFileSync(join(agent, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "offline-fixture" } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { subagents: { providerExtensions: { openai: new URL("./support/subagent-offline-model.ts", import.meta.url).pathname }, defaultTools: "read", maxConcurrent: 1 } } }));
  writeFileSync(join(agent, "agents/roles/fixture.md"), "---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Fixture\ndefaults:\n  model: openai/gpt-4.1\n---\nFrozen launch instructions.\n");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agent, PI_SERVER_DIR: transport, TMPDIR: root,
    LAUNCH_WORKSPACE: cwd, LAUNCH_ENTERED: entered, LAUNCH_RELEASE: release };
  const execPath = process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath;
  let daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = ""; daemon.stderr!.on("data", data => { errors += data; });
  let parent: ReturnType<typeof fork> | undefined;
  let sibling: ReturnType<typeof fork> | undefined;
  const attempts: string[] = [];
  const metaFor = (id: string) => JSON.parse(readFileSync(join(root, "pi-better-subagents/runs", id, "meta.json"), "utf8"));
  const terminal = async (id: string) => {
    const directory = join(root, "pi-better-subagents/runs", id), watcher = watch(directory);
    try { while (["running", "orphaned"].includes(metaFor(id).status)) await once(watcher, "change"); }
    finally { watcher.close(); }
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
    parent = fork(new URL("./support/subagent-launch-sdk.mjs", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    parent.stderr!.on("data", data => { errors += data; });
    const [ready] = await Promise.race([once(parent, "message"), once(parent, "exit").then(() => { throw new Error(errors); })]);
    const launch = async (params: object, key = "same-launch", child = parent!, goalComplete = false) => {
      const reply = once(child, "message"); child.send({ key, params, goalComplete }); const [message] = await reply;
      assert.equal(message.error, undefined, `${message.stack ?? message.error}\n${errors}`); return message.result;
    };
    const params = { prompt: "Execute fixture", role: "fixture", model: "openai/gpt-4.1", callback: false, tools: "read", skills: [] };
    const first = await launch(params);
    assert.equal(first.details.launched, true);
    attempts.push(first.details.runId);
    const frozen = JSON.stringify(metaFor(first.details.runId).recipe);
    writeFileSync(join(agent, "agents/roles/fixture.md"), "---\nschema: pi-agent/v1\nkind: role\nid: role.fixture\nname: Edited\n---\nChanged future instructions.\n");
    const repeated = await launch(params, "same-launch", parent!, true);
    assert.equal(repeated.details.runId, first.details.runId);
    assert.equal(JSON.stringify(metaFor(first.details.runId).recipe), frozen, "Goal and template edits cannot rewrite the accepted recipe");
    const db = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM subagent_launch_intents").all() as any[];
      assert.equal(rows.length, 1); const attempts = JSON.parse(rows[0].attempts); assert.equal(attempts.length, 1);
      assert.equal(attempts[0].id, first.details.runId); assert.equal(attempts[0].token.length, 64);
    } finally { db.close(); }
    const rejected = once(parent, "message"); parent.send({ key: "over-owner-capacity", params });
    assert.match((await rejected)[0].error, /Max concurrent subagents/);
    sibling = fork(new URL("./support/subagent-launch-sdk.mjs", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    sibling.stderr!.on("data", data => { errors += data; });
    await Promise.race([once(sibling, "message"), once(sibling, "exit").then(() => { throw new Error(errors); })]);
    const independent = await launch({ ...params, role: undefined }, "independent-owner", sibling);
    attempts.push(independent.details.runId);
    assert.notEqual(independent.details.runId, first.details.runId, "server PID does not combine owner capacity");
    assert.notEqual(metaFor(first.details.runId).spawnPid, metaFor(independent.details.runId).spawnPid);
    assert.equal(metaFor(first.details.runId).cwd, cwd);
    await waitFile(entered);
    const exited = once(parent, "exit"); parent.send({ stop: true }); await exited; parent = undefined;
    const worker = JSON.parse(readFileSync(entered, "utf8")); process.kill(worker.pid, 0);
    assert.equal(metaFor(first.details.runId).supervisionInterruptedAt, undefined, "frontend shutdown leaves server supervision intact");
    const observer = new WorkClient(join(transport, "pi-server.sock"), agent);
    try {
      const snapshot = await observer.get({ cwd, sessionId: ready.sessionId });
      assert.ok(snapshot.rows.some((row: any) => row.meta.id === first.details.runId), "original session scope reconnects without a writer");
      assert.equal(snapshot.rows.some((row: any) => row.meta.id === independent.details.runId), false);
    } finally { observer.close(); }
    const beforeRestart = JSON.stringify(metaFor(first.details.runId).recipe);
    const daemonExit = once(daemon, "exit"); daemon.send("stop"); await daemonExit;
    daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    daemon.stderr!.on("data", data => { errors += data; });
    await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    const recovered = await launch({ ...params, role: undefined }, "independent-owner", sibling);
    assert.equal(recovered.details.runId, independent.details.runId);
    assert.equal(JSON.stringify(metaFor(first.details.runId).recipe), beforeRestart, "runtime replacement retains the frozen execution recipe");
    const journal = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    try {
      const records = journal.prepare("SELECT attempts FROM subagent_launch_intents").all() as any[];
      assert.equal(records.flatMap(row => JSON.parse(row.attempts)).length, 2, "replacement does not create another attempt/token");
    } finally { journal.close(); }
    writeFileSync(release, "release");
    for (const id of attempts) {
      const meta = await terminal(id);
      assert.equal(meta.status, "completed", `${id}: ${meta.lifecycleClassification}\n${errors}`);
    }
  } finally {
    writeFileSync(release, "release");
    if (parent?.exitCode === null) { const exit = once(parent, "exit"); parent.send({ stop: true }); await exit; }
    if (sibling?.exitCode === null) { const exit = once(sibling, "exit"); sibling.send({ stop: true }); await exit; }
    for (const id of attempts) await terminal(id);
    if (daemon.exitCode === null) { const exit = once(daemon, "exit"); daemon.send("stop"); await exit; }
    // Runtime artifacts remain owned evidence until every worker has been verified exited.
    rmSync(transport, { recursive: true, force: true });
  }
});
