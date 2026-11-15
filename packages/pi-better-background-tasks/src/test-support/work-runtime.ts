import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { fork } from "node:child_process";

/** The actual daemon owns registration, query dispatch and socket drain in tests. */
export async function startWorkRuntime() {
  mkdirSync(resolve(".work/754"), { recursive: true });
  const root = mkdtempSync(resolve(".work/754/output-"));
  const transport = mkdtempSync("/tmp/p754-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const daemon = fork(new URL("../../../pi-better-server/test/support/work-daemon.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"], env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_SERVER_DIR: transport },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  daemon.stderr!.on("data", chunk => { errors += chunk; });
  let shutdown: Promise<void> | undefined;
  const stop = () => shutdown ??= (async () => {
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, "exit"); daemon.send("stop"); await exited;
    }
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  })();
  try {
    await Promise.race([once(daemon, "message"), once(daemon, "exit").then(() => { throw new Error(errors); })]);
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
