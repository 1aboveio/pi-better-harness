import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

test("supervised stall reaches the native parent during single and multi-task waits", { timeout: 125_000 }, async t => {
  const root = realpathSync(mkdtempSync("/tmp/bg-stall-"));
  const agent = join(root, "agent"), cwd = join(root, "workspace"), transport = join(root, "sock");
  for (const dir of [agent, cwd, transport]) mkdirSync(dir);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ piBetterHarness: { backgroundReviewIntervalMinutes: 1 } }));
  const sessionFile = join(root, "session.jsonl"), sessionId = randomUUID();
  const header = { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd };
  const branch = { type: "custom", customType: "test-anchor", id: "123abcde", parentId: null, timestamp: header.timestamp };
  writeFileSync(sessionFile, [header, branch].map(v => JSON.stringify(v)).join("\n") + "\n");
  const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, TMP: root, TEMP: root, PI_CODING_AGENT_DIR: agent,
    PI_SERVER_DIR: transport, LAUNCH_WORKSPACE: cwd, BACKGROUND_ONLY: "1", BACKGROUND_TEST_NAVIGATOR: "1", BACKGROUND_SESSION_FILE: sessionFile,
    PI_BETTER_STALL_QUIET_MS: "500", PI_BETTER_STALL_MS: "1600" };
  const children: ChildProcess[] = [];
  let diagnostics = "", sequence = 0;
  async function start(path: string, overrides = {}) {
    const child = fork(new URL(path, import.meta.url), [], { env: { ...env, ...overrides }, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    child.stderr!.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw Error(diagnostics); })]);
    return child;
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  t.after(async () => {
    writeFileSync(join(cwd, "finish"), "stop");
    writeFileSync(join(cwd, "release"), "go");
    if (children.some(child => child.exitCode)) t.diagnostic(diagnostics);
    const dbPath = join(agent, "operation-coordinator.sqlite");
    try {
      if (existsSync(dbPath)) {
        const cleanupDb = new DatabaseSync(dbPath, { readOnly: true });
        try {
          const grants = cleanupDb.prepare("SELECT o.task_id, s.value FROM operations o JOIN coordinator_state s ON s.key='result-supervision-v1:'||o.operation_id").all();
          const deadline = Date.now() + 8000;
          for (const grant of grants) {
            const dir = join(JSON.parse(String(grant.value)).directory, "tasks", String(grant.task_id));
            while (!existsSync(join(dir, "result.json")) && !existsSync(join(dir, "lost.json"))) {
              assert.ok(Date.now() < deadline, "fixture runner did not exit: " + grant.task_id);
              await delay(50);
            }
          }
        } finally { cleanupDb.close(); }
      }
    } finally {
      await Promise.all(children.map(stop));
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    }
  });
  const serverPath = "./support/work-daemon.ts", frontendPath = "../scripts/measure-full-runtime/frontend.ts";
  let daemon = await start(serverPath);
  writeFileSync(join(agent, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: agent, serverDir: transport }));
  let parent = await start(frontendPath);
  async function request(params: Record<string, unknown>, recipient = parent) {
    assert.ok(recipient.connected, diagnostics);
    const next = once(recipient, "message");
    recipient.send({ id: ++sequence, key: randomUUID(), ...params });
    const [reply] = await next;
    assert.equal(reply.error, undefined, reply.stack ?? diagnostics);
    return reply.result;
  }
  const call = (tool: string, params: Record<string, unknown>) => request({ tool, params });
  const spawn = async (name: string, script: string, callback = true) => {
    const reply = await call("bg_task_spawn", { name, shell: false, callback, timeout_seconds: 110, argv: [process.execPath, "-e", script] });
    assert.ok(reply.details?.id, JSON.stringify(reply));
    return reply.details;
  };
  const spin = (line: string) => `const fs=require('node:fs'); console.log(${JSON.stringify(line)}); const t=setInterval(()=>{if(fs.existsSync('finish'))clearInterval(t)},100)`;
  const register = async (ids: string[]) => {
    const reply = await call("wait_for_operations", { task_ids: ids, continuation_note: "Inspect exact terminal evidence" });
    assert.ok(reply.details?.waitId, JSON.stringify(reply));
    return reply.details;
  };
  const gradle = await spawn("Gradle", spin("resolving dependency"));
  const single = await register([gradle.id]);
  const stale = await spawn("Resumed output", "const fs=require('node:fs');let n=0;const t=setInterval(()=>{if(fs.existsSync('finish'))clearInterval(t);if(fs.existsSync('resume'))console.log('progress '+ ++n)},200)");
  const finished = await spawn("Finished offline", "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('finish')||fs.existsSync('resume'))clearInterval(t)},100)");
  const singleEntries = await request({ entries: true });
  await stop(parent);
  const groupFile = join(root, "group.jsonl");
  const groupHeader = { ...header, id: randomUUID() };
  const groupSeed = [groupHeader, branch].map(v => JSON.stringify(v)).join("\n") + "\n";
  writeFileSync(groupFile, groupSeed);
  const groupEnv = { BACKGROUND_SESSION_FILE: groupFile };
  parent = await start(frontendPath, groupEnv);
  const pg = await spawn("PostgreSQL", spin("waiting on PostgreSQL"));
  const android = await spawn("Android", "const fs=require('node:fs');const t=setInterval(()=>{if(fs.existsSync('release')||fs.existsSync('finish'))process.exit(1)},100)");
  const ci = await call("bg_task_watch", { name: "CI", shell: false, interval_seconds: 1, timeout_seconds: 110,
    argv: [process.execPath, "-e", "console.log(require('node:fs').existsSync('release')?'CI completed: failed':'pending')"],
    success_when: { type: "stdout_contains", value: "CI completed" } });
  assert.ok(ci.details?.id, JSON.stringify(ci));
  const group = await register([android.id, ci.details.id, pg.id]);
  const muted = await spawn("Muted", spin("no callback requested"), false);
  const groupEntries = await request({ entries: true });
  writeFileSync(join(cwd, "release"), "go");

  const db = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
  t.after(() => db.close());
  const phase = (wait: any) => db.prepare("SELECT phase FROM waits WHERE wait_id=? AND generation=?").get(wait.waitId, wait.generation)?.phase;
  const entries = () => request({ entries: true });
  const stalls = (rows: any[]) => rows.filter(e => e.customType === "background-task-stall");
  async function until<T>(read: () => Promise<T>, match: (value: T) => boolean, ms: number, reason: string) {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (match(value)) return value;
      assert.ok(Date.now() < deadline, reason + " " + JSON.stringify(value).slice(-1800) + " " + diagnostics);
      await delay(150);
    }
  }
  // Only inspect the native transcript. No tool call or manual reconciliation can drive delivery.
  const delivered = stalls(await until(entries, rows => stalls(rows).length > 0, 76_000, "missing automatic stall handoff"));
  assert.equal(delivered.length, 1);
  const pgAlert = delivered.find(e => e.content.includes("waiting on PostgreSQL")).content;
  for (const expected of [pg.id, group.waitId, android.id + " failed", ci.details.id + " succeeded"]) assert.ok(pgAlert.includes(expected), pgAlert);
  const waitReviews = (rows: any[]) => rows.filter(e => e.customType === "background-wait-review");
  const reviews = waitReviews(await until(entries, items => waitReviews(items).length > 0, 5000,
    "missing automatic wait review at the configured interval"));
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].content.includes(pg.id));
  assert.match(reviews[0].content, /Task has run for 1m\d{2}s\. No observed progress for 1m\d{2}s/);
  assert.ok(reviews[0].content.includes("waiting on PostgreSQL"));
  for (const wait of [single, group]) assert.equal(phase(wait), "waiting");
  assert.match(JSON.stringify(await call("bg_task_status", { id: muted.id })), /suspected stall/);
  const rows = await request({ navigatorRows: true });
  assert.match(JSON.stringify(rows.find((row: any) => row.id === pg.id)?.facts), /suspected stall/);
  const grant = db.prepare("SELECT value FROM coordinator_state WHERE key=?").get("result-supervision-v1:" + pg.operationId);
  const directory = JSON.parse(String(grant?.value)).directory;
  for (const id of [pg.id]) await until(async () => existsSync(join(directory, "tasks", id, "stall-receipt")), Boolean, 5000, "missing durable receipt");

  await stop(parent); await stop(daemon);
  writeFileSync(join(cwd, "resume"), "go");
  await until(async () => existsSync(join(directory, "tasks", finished.id, "result.json")), Boolean, 5000, "offline task still running");
  const freshTmp = join(root, "after-restart");
  mkdirSync(freshTmp);
  daemon = await start(serverPath, { TMPDIR: freshTmp, TMP: freshTmp, TEMP: freshTmp });
  // The same session ID on a sibling branch cannot receive the pending Gradle alert.
  const foreignFile = join(root, "sibling.jsonl");
  writeFileSync(foreignFile, [header, { ...branch, id: "456abcde" }].map(v => JSON.stringify(v)).join("\n") + "\n");
  parent = await start(frontendPath, { BACKGROUND_SESSION_FILE: foreignFile });
  await request({ barrier: true });
  assert.equal(stalls(await entries()).length, 0);
  await stop(parent);
  const copyFile = join(root, "second-frontend.jsonl");
  writeFileSync(copyFile, [header, ...singleEntries].map(v => JSON.stringify(v)).join("\n") + "\n");
  const recipients = await Promise.all([start(frontendPath), start(frontendPath, { BACKGROUND_SESSION_FILE: copyFile })]);
  parent = recipients[0]!;
  const restoredEntries = async () => (await Promise.all(recipients.map(child => request({ entries: true }, child)))).flat();
  const recovered = stalls(await until(restoredEntries, items => stalls(items).length > 0, 5000, "missing offline stall"));
  assert.equal(recovered.length, 1, "only one eligible native frontend receives the incident");
  assert.ok(recovered[0].content.includes(gradle.id));
  assert.match(recovered[0].content, /resolving dependency/);
  assert.ok(!recovered[0].content.includes(stale.id));
  assert.equal(phase(single), "waiting");
  await until(async () => existsSync(join(directory, "tasks", gradle.id, "stall-receipt")), Boolean, 5000, "missing Gradle receipt");
  assert.match(JSON.stringify(await call("bg_task_status", { id: gradle.id })), /suspected stall/);
  assert.match(JSON.stringify(await call("bg_task_log", { id: gradle.id })), /resolving dependency/);
  await Promise.all(recipients.map(stop));
  await stop(daemon);
  daemon = await start(serverPath);
  // Restore the exact pre-alert branch. No local receipt can mask a missing server receipt.
  writeFileSync(groupFile, [groupHeader, ...groupEntries].map(v => JSON.stringify(v)).join("\n") + "\n");
  parent = await start(frontendPath, groupEnv);
  await request({ barrier: true });
  assert.equal(stalls(await entries()).length, 0, "continued silence was already receipted");
  await call("bg_task_stop", { id: pg.id });
  await until(entries, items => {
    const batch = items.filter((item: any) => item.customType === "background-completion-batch" && item.content.includes(group.waitId))
      .map((item: any) => item.content).join("\n");
    return [android.id, ci.details.id, pg.id].every(id => batch.includes(id));
  }, 12_000, "missing an all-settled result");
  assert.equal(phase(group), "ready");
  const revisions: Record<string, number> = {};
  for (const [id, outcome] of [[android.id, "failed"], [ci.details.id, "succeeded"], [pg.id, "cancelled"]]) {
    assert.match(JSON.stringify(await call("bg_task_status", { id })), new RegExp(outcome));
    const op = db.prepare("SELECT operation_id, terminal_revision, terminal_outcome FROM operations WHERE task_id=?").get(id)!;
    assert.equal(op.terminal_outcome, outcome);
    revisions[String(op.operation_id)] = Number(op.terminal_revision);
  }
  const ack = await call("acknowledge_operation_result", { wait_id: group.waitId, generation: group.generation, terminal_revisions: revisions,
    disposition: "continue", note: "Android failed, CI observed failure, PostgreSQL cancelled" });
  assert.equal(ack.details?.phase, "consumed", JSON.stringify(ack));
});
