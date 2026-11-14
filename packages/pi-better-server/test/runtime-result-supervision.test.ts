import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorkClient } from "../src/runtime/work-client.mjs";
const { openStore } = await import(new URL("../../operation-coordinator/index.ts", import.meta.url).href);
const { createLocalSupervisor } = await import(new URL("../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);

test("server imports independent runner evidence after every frontend exits and retains exact-recipient wait delivery", { timeout: 30000 }, async () => {
  mkdirSync(resolve(".work/760"), { recursive: true });
  const root = mkdtempSync(resolve(".work/760/flow-"));
  const transport = mkdtempSync("/tmp/p760-");
  const children: ReturnType<typeof fork>[] = [];
  const clients: WorkClient[] = [];
  let taskId: string | undefined;
  const start = async (file: string) => {
    const child = fork(new URL(file, import.meta.url), [], { execArgv: ["--import", "tsx"],
      env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    children.push(child);
    let errors = ""; child.stderr!.on("data", chunk => { errors += chunk; });
    const [ready] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors); })]);
    return { child, ready };
  };
  try {
    const server = await start("./support/work-daemon.ts");
    const frontend = await start("./support/result-frontend.ts");
    taskId = frontend.ready.taskId;
    const wait = frontend.ready.wait;
    const exited = once(frontend.child, "exit"); frontend.child.kill("SIGKILL"); await exited;
    writeFileSync(join(root, "finish"), "finish");
    const store = openStore({ path: join(root, "operation-coordinator.sqlite") });
    try {
      const deadline = Date.now() + 10000;
      while (store.getWait({ waitId: wait.waitId })?.phase !== "ready" && Date.now() < deadline) await delay(20);
      const settled = store.getWait({ waitId: wait.waitId })!;
      assert.equal(settled.phase, "ready");
      const operation = store.listOperations({ taskId })[0]!;
      assert.equal(operation.terminalOutcome, "succeeded");
      assert.equal(operation.terminalRevision, 1);
      assert.equal(operation.owner.sessionId, "exact-recipient-760");
      const events = store.listOutbox({ owner: operation.owner });
      assert.equal(events.length, 1);
      assert.equal(events[0].deliveredAt, null);
      assert.equal(readFileSync(join(root, "executions"), "utf8"), "start\n");
      for (let i = 0; i < 2; i++) {
        const client = new WorkClient(server.ready.ready, root, ["runtime-result-supervision-v1"]); clients.push(client);
        await client.ready; await client.request("runtime_result_supervision"); client.close();
      }
      assert.equal(store.getOperation(operation.operationId)?.terminalRevision, 1);
      assert.equal(store.listOutbox({ owner: operation.owner }).length, 1);
      assert.equal(readFileSync(join(root, "executions"), "utf8"), "start\n");
    } finally { store.close(); }
  } finally {
    for (const client of clients) client.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.send("stop"); await exited;
    }
    if (taskId) await createLocalSupervisor({ directory: join(root, "supervisor") }).stop(taskId);
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  }
});
