import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { fork } from "node:child_process";

let captureFailure: (() => Promise<void>) | undefined;
export async function readRpcEvidence(peer: Pick<ReturnType<typeof fork>, 'on' | 'off' | 'send'>, slot: number): Promise<unknown> {
  return new Promise<unknown>(resolve => {
    const finish = (value: unknown) => { clearTimeout(timer); peer.off('message', receive); resolve(value); };
    const receive = (message: any) => { if (message?.rpcEvidence === slot) finish(message.snapshot); };
    const timer = setTimeout(() => finish({ unavailable: true }), 500);
    peer.on('message', receive);
    try { peer.send({ rpcEvidence: slot }, error => { if (error) finish({ unavailable: true }); }); }
    catch { finish({ unavailable: true }); }
  });
}
/** Failure-only capture over the fixture's existing IPC, never a tool submission. */
export async function retainWorkRuntimeFailure(): Promise<void> {
  try { await captureFailure?.(); }
  catch { console.error('[background-rpc-failure]', '{"unavailable":true}'); }
}

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
  let captures = 0;
  const retain = async () => {
    if (captures >= 4 || !daemon.connected) return;
    const slot = ++captures;
    const snapshot = await readRpcEvidence(daemon, slot);
    console.error('[background-rpc-failure]', JSON.stringify(snapshot));
  };
  captureFailure = retain;
  const stop = () => shutdown ??= (async () => {
    if (captureFailure === retain) captureFailure = undefined;
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
