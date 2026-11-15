import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

for (const phase of ["before-bootstrap", "before-bridge"] as const) {
test(`replacement ${phase} refuses unavailable authority without replaying an accepted launch`, { timeout: 30000 }, async () => {
  const base = resolve("../../.work/761"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "bootstrap-restart-")), agent = join(root, "agent"), cwd = join(root, "workspace");
  const transport = mkdtempSync("/tmp/p761-before-");
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
  const start = async (url: URL) => {
    const child = fork(url, [], { execArgv: ["--import", "tsx"], env, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    child.stderr!.on("data", bytes => { errors += bytes; });
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors); })]);
    return child;
  };
  const stop = async (child: ReturnType<typeof fork>, message: unknown) => {
    if (child.exitCode === null) { const exited = once(child, "exit"); child.send(message as any); await exited; }
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
    const first = await launch(), id = first.details.runId;
    const db = new DatabaseSync(join(agent, "operation-coordinator.sqlite"), { readOnly: true });
    const attempt = () => {
      const rows = db.prepare("SELECT attempts FROM subagent_launch_intents").all();
      assert.equal(rows.length, 1); const attempts = JSON.parse(String(rows[0]!.attempts));
      assert.equal(attempts.length, 1); return attempts[0];
    };
    try {
      const barrier = watch(cwd);
      try { while (!existsSync(join(cwd, "waiting"))) await once(barrier, "change"); }
      finally { barrier.close(); }
      const original = attempt(); assert.equal(original.id, id); assert.equal(original.bootstrapped, phase === "before-bootstrap" ? undefined : true);
      await stop(daemon, "stop"); daemon = await start(new URL("./support/work-daemon.ts", import.meta.url));
      writeFileSync(release, "release");
      const log = join(root, "pi-better-subagents/runs", id, "output.log");
      const watcher = watch(join(root, "pi-better-subagents/runs", id));
      const refusal = phase === "before-bootstrap" ? "epoch/token is no longer admitted" : "Child requested tool report_assignment_result is unavailable";
      try { while (!readFileSync(log, "utf8").includes(refusal)) await once(watcher, "change"); }
      finally { watcher.close(); }
      assert.equal(existsSync(entered), false, "stale worker never reaches model execution");
      const replay = await launch(); assert.equal(replay.details.runId, id);
      const retained = attempt(); assert.equal(retained.token, original.token); assert.equal(retained.bootstrapped, original.bootstrapped);
      assert.ok(readFileSync(log, "utf8").includes(refusal));
    } finally { db.close(); }
  } finally {
    writeFileSync(release, "release");
    if (parent) await stop(parent, { stop: true });
    await stop(daemon, "stop");
    rmSync(transport, { recursive: true, force: true });
  }
});
}
