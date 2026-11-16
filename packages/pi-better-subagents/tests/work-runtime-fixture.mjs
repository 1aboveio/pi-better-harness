import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "../../pi-better-server/src/runtime/work-client.mjs";
import { observeFixtureChild, stopFixtureChild } from "./fixture-child.mjs";

/** Real query server for registered-extension fixtures; no model or HostedSession. */
export async function startWorkRuntimeFixture(env = process.env) {
    const transport = mkdtempSync("/tmp/p753-");
    mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
    const daemonEnv = { ...env, PI_SERVER_DIR: transport };
    let child, retention, error = "";
    const start = async () => {
        child = fork(new URL("../../pi-better-server/test/support/work-daemon.ts", import.meta.url), [], {
            execPath: daemonEnv.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath,
            execArgv: ["--import", "tsx"], env: daemonEnv, stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        observeFixtureChild(child);
        child.stderr.on("data", chunk => { error += chunk; });
        const [ready] = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Fixture daemon exited: ${error}`); })]);
        // This file-scoped query fixture outlives individual recipients and
        // other-root native journeys. Retain it through the real protocol;
        // daemonIdleMs:0 does not disable runtime-only automatic idle exit.
        retention = new WorkClient(ready.ready, realpathSync(daemonEnv.PI_CODING_AGENT_DIR));
        await retention.ready;
        return ready;
    };
    const ready = await start();
    let stopping;
    const stopChild = () => stopping ??= (async () => {
        // Keep retention until the explicit stop is sent; closing it first can
        // race the daemon's idle shutdown and its IPC channel teardown.
        try { await stopFixtureChild(child); }
        finally { retention?.close(); retention = undefined; }
    })();
    const stop = async () => {
        await stopChild();
        rmSync(transport, { recursive: true, force: true });
    };
    stop.socketPath = ready.ready;
    stop.restart = async () => { await stopChild(); stopping = undefined; await start(); };
    stop.pause = stopChild;
    stop.resume = async () => { stopping = undefined; return start(); };
    stop.metrics = async () => { const reply = once(child, "message"); child.send("metrics"); return (await reply)[0]; };
    stop.diagnostics = () => ({ exitCode: child.exitCode, stderr: error });
    return stop;
}
