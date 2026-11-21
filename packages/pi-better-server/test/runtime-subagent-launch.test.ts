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
import { readBoundedTail } from "../../pi-better-subagents/shared-log-utils.ts";

for (const journalOnly of [false, true]) test(`registered SDK launch survives parent exit and ${journalOnly ? "journal-only crash recovery" : "ordinary restart"}`, { timeout: 60000 }, async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "launch-")), transport = realpathSync(mkdtempSync("/tmp/p761-"));
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
  let bootstrapProof: Record<string, unknown> | undefined;
  let preRestartTarget: unknown;
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
      bootstrapProof = { path: join(agent, "operation-coordinator.sqlite"), owner: rows[0].owner,
        key: rows[0].request_key, epoch: rows[0].epoch, id: attempts[0].id, token: attempts[0].token };
    } finally { db.close(); }
    const rejected = once(parent, "message"); parent.send({ key: "over-owner-capacity", params });
    assert.match((await rejected)[0].error, /Max concurrent subagents/);
    const admission = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    try {
      assert.equal(admission.prepare("SELECT state FROM subagent_launch_intents WHERE request_key='over-owner-capacity'").get()?.state,
        "returned", "a refused launch without an attempt cannot leave a permanent upgrade obligation");
    } finally { admission.close(); }
    sibling = fork(new URL("./support/subagent-launch-sdk.mjs", import.meta.url), [], { execPath: process.execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    sibling.stderr!.on("data", data => { errors += data; });
    await Promise.race([once(sibling, "message"), once(sibling, "exit").then(() => { throw new Error(errors); })]);
    const independent = await launch({ ...params, role: undefined }, "independent-owner", sibling);
    attempts.push(independent.details.runId);
    assert.notEqual(independent.details.runId, first.details.runId, "server PID does not combine owner capacity");
    assert.notEqual(metaFor(first.details.runId).spawnPid, metaFor(independent.details.runId).spawnPid);
    assert.equal(metaFor(first.details.runId).cwd, cwd);
    await waitFile(entered);
    for (const id of attempts) await waitFile(`${entered}.${metaFor(id).pid}`);
    const duplicateBootstrap = () => spawnSync(execPath, [new URL("../src/runtime/domain/subagents/managed-worker.mjs", import.meta.url).pathname], {
      env: { ...env, PI_MANAGED_SUBAGENT: JSON.stringify(bootstrapProof) }, encoding: "utf8",
    });
    const duplicate = duplicateBootstrap();
    assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /already has a writer/);
    const exited = once(parent, "exit"); parent.send({ stop: true }); await exited; parent = undefined;
    const worker = JSON.parse(readFileSync(entered, "utf8")); process.kill(worker.pid, 0);
    assert.equal(metaFor(first.details.runId).supervisionInterruptedAt, undefined, "frontend shutdown leaves server supervision intact");
    const observer = new WorkClient(join(transport, "pi-server.sock"), agent);
    try {
      preRestartTarget = await observer.ready;
      const snapshot = await observer.get({ cwd, sessionId: ready.sessionId });
      assert.ok(snapshot.rows.some((row: any) => row.meta.id === first.details.runId), "original session scope reconnects without a writer");
      assert.equal(snapshot.rows.some((row: any) => row.meta.id === independent.details.runId), false);
      const runtime = await observer.request("runtime_get_status");
      assert.equal(runtime.subagentManagement.owner, "server");
      assert.equal(runtime.subagentManagement.instanceId, runtime.instanceId);
    } finally { observer.close(); }
    const originalWriter = metaFor(first.details.runId).pid;
    const beforeRestart = JSON.stringify(metaFor(first.details.runId).recipe);
    const daemonExit = once(daemon, "exit");
    if (journalOnly) daemon.kill("SIGKILL"); else daemon.send("stop");
    await daemonExit;
    if (journalOnly) {
      // Restore the durable crash window after bootstrap but before metadata and
      // receipt publication; the real detached writer stays alive throughout.
      const crashed = new DatabaseSync(join(agent, "operation-coordinator.sqlite"));
      try {
        crashed.prepare("UPDATE subagent_launch_intents SET state='accepted', result=NULL WHERE json_array_length(attempts)>0").run();
      } finally { crashed.close(); }
      for (const id of attempts) rmSync(join(root, "pi-better-subagents/runs", id, "meta.json"));
    }
    daemon = fork(new URL("./support/work-daemon.ts", import.meta.url), [], { execPath, execArgv: ["--import", "tsx"], env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    daemon.stderr!.on("data", data => { errors += data; });
    await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    const recovered = await launch({ ...params, role: undefined }, "independent-owner", sibling);
    if (journalOnly) {
      assert.equal(recovered.details.status, "recovered");
      assert.deepEqual(recovered.details.attempts, [independent.details.runId]);
      assert.equal(recovered.details.runs[0].sessionId, independent.details.sessionId);
    } else assert.equal(recovered.details.runId, independent.details.runId);
    assert.equal(metaFor(first.details.runId).pid, originalWriter, "recovery keeps the exact original writer");
    assert.equal(JSON.stringify(metaFor(first.details.runId).recipe), beforeRestart, "runtime replacement retains the frozen execution recipe");
    const stale = duplicateBootstrap(); assert.equal(stale.status, 1); assert.match(stale.stderr, /epoch\/token is no longer admitted/);
    const journal = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    try {
      const records = journal.prepare("SELECT attempts FROM subagent_launch_intents").all() as any[];
      assert.equal(records.flatMap(row => JSON.parse(row.attempts)).length, 2, "replacement does not create another attempt/token");
      assert.equal(journal.prepare("SELECT count(*) AS n FROM subagent_launch_intents WHERE state='accepted'").get()?.n, 0,
        "reconciled attempts and empty admissions do not leave permanent upgrade obligations");
    } finally { journal.close(); }
    writeFileSync(release, "release");
    for (const id of attempts) {
      const meta = await terminal(id);
      assert.equal(meta.status, "completed", `${id}: ${meta.lifecycleClassification}\n${errors}`);
    }
    const outcomes = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    try {
      const binding = metaFor(first.details.runId).assignment;
      assert.ok(binding, "real launch retains assignment authority");
      const publication = outcomes.prepare("SELECT 1 FROM assignment_outcomes WHERE assignment_id=?");
      const deadline = Date.now() + 2000;
      // The metadata file is visible before the following SQLite transaction
      // commits. Observe that distinct durable publication explicitly.
      while (!publication.get(binding.assignmentId)) {
        assert.ok(Date.now() < deadline, "server publishes a terminal outcome while the original recipient is absent");
        await delay(25);
      }
    } finally { outcomes.close(); }
    const prior = metaFor(independent.details.runId);
    const followup = await launch({ prompt: "Continue in the saved worker conversation", session_id: independent.details.sessionId, callback: false }, "saved-followup", sibling);
    attempts.push(followup.details.runId);
    assert.equal(followup.details.sessionId, prior.sessionId);
    assert.equal(followup.details.rootRunId, prior.rootRunId);
    const continued = await terminal(followup.details.runId);
    assert.equal(continued.resumedFrom, prior.id);
    assert.equal(continued.recipe.tools, prior.recipe.tools);
    assert.equal(continued.recipe.model, prior.recipe.model);
    assert.equal(continued.cwd, prior.cwd);
    assert.equal(continued.status, "completed");
  } catch (error) {
    console.error("Managed launch scenario failed:", error, errors);
    // Preserve the pre-cleanup writer/journal evidence, not just a terminal label.
    try {
      const { readConversationLease } = await import(new URL("../../pi-better-subagents/continuation.ts", import.meta.url).href);
      const db = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
      try {
        const intents = db.prepare("SELECT request_key, epoch, state, attempts FROM subagent_launch_intents").all() as any[];
        const evidence = { scenario: journalOnly ? "journal-only" : "ordinary", execPath, preRestartTarget,
          currentManagement: db.prepare("SELECT * FROM subagent_management WHERE singleton=1").get(), attempts: attempts.map(id => {
          const meta = metaFor(id);
          const lease = readConversationLease(meta.sessionId);
          const journal = intents.flatMap(intent => JSON.parse(intent.attempts).filter((attempt: any) => attempt.id === id)
            .map((attempt: any) => ({ requestKey: intent.request_key, epoch: intent.epoch, state: intent.state,
              attemptState: attempt.state, sessionId: attempt.sessionId, pid: attempt.pid, pidStartTime: attempt.pidStartTime,
              writerPid: attempt.writerPid, writerStartTime: attempt.writerStartTime, bootstrapped: attempt.bootstrapped,
              lease: attempt.lease, recoveryManagement: attempt.recoveryMeta?.management })));
          return { id, status: meta.status, lifecycleClassification: meta.lifecycleClassification, failureReason: meta.failureReason,
            pid: meta.pid, pidStartTime: meta.pidStartTime, pgid: meta.pgid, spawnPid: meta.spawnPid,
            management: meta.management, supervisionInterruptedAt: meta.supervisionInterruptedAt,
            supervisionInterruptedReason: meta.supervisionInterruptedReason, probeMisses: meta.probeMisses,
            lostAt: meta.lostAt, endedAt: meta.endedAt, exitCode: meta.exitCode, sessionId: meta.sessionId,
            writerLease: lease && { token: lease.token, attemptId: lease.attemptId, pid: lease.pid, start: lease.start },
            journal, log: readBoundedTail(meta.logPath, 16384) };
        }) };
        writeFileSync(join(root, "registered-launch-failure.json"), JSON.stringify(evidence));
        console.error("[registered-launch-failure]", JSON.stringify(evidence));
      } finally { db.close(); }
    } catch (evidenceError) {
      console.error("[registered-launch-failure-evidence-error]", evidenceError);
    }
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
