import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Real query server for registered-extension fixtures; no model or HostedSession. */
export async function startWorkRuntimeFixture(env = process.env) {
    const transport = mkdtempSync("/tmp/p753-");
    mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
    const child = fork(new URL("../../pi-better-server/test/support/work-daemon.ts", import.meta.url), [], {
        execPath: env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath,
        execArgv: ["--import", "tsx"], env: { ...env, PI_SERVER_DIR: transport }, stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let error = ""; child.stderr.on("data", chunk => { error += chunk; });
    await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(`Fixture daemon exited: ${error}`); })]);
    return async () => {
        if (child.exitCode === null) { child.send("stop"); await once(child, "exit"); }
        rmSync(transport, { recursive: true, force: true });
    };
}
