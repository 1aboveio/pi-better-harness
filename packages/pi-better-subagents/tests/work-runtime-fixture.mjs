import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Real query server for registered-extension fixtures; no model or HostedSession. */
export async function startWorkRuntimeFixture(env = process.env) {
    const transport = mkdtempSync("/tmp/p753-");
    mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
    const daemonEnv = { ...env, PI_SERVER_DIR: transport };
    let child, error = "";
    const start = async () => {
        child = fork(new URL("../../pi-better-server/test/support/work-daemon.ts", import.meta.url), [], {
            execPath: daemonEnv.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath,
            execArgv: ["--import", "tsx"], env: daemonEnv, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        child.stderr.on("data", chunk => { error += chunk; });
        const [ready] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Fixture daemon exited: ${error}`); })]);
        return ready;
    };
    const ready = await start();
    const stopChild = async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.send("stop"); await exited; } };
    const stop = async () => {
        await stopChild();
        rmSync(transport, { recursive: true, force: true });
    };
    stop.socketPath = ready.ready;
    stop.restart = async () => { await stopChild(); await start(); };
    stop.pause = stopChild;
    stop.resume = start;
    stop.metrics = async () => { const reply = once(child, "message"); child.send("metrics"); return (await reply)[0]; };
    stop.diagnostics = () => ({ exitCode: child.exitCode, stderr: error });
    return stop;
}
