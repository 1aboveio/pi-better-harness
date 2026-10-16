import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSshMuxController, resolveSshCommand } from "../src/shared-ssh-core/index.ts";
import { createProcessRunner } from "../src/remote/process-runner.ts";
import type { Backend } from "./backend.ts";
import { makeEnv, waitFor } from "./helpers.ts";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

function ssh(host: string, script: string, input?: string): string {
  const result = spawnSync("ssh", ["-o", "BatchMode=yes", "-T", host, script], { encoding: "utf8", input });
  if (result.status !== 0) throw new Error(`ssh ${host} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}

/**
 * A real daemon on another machine, reached the way a user would: `pi-remote --host`.
 * Needs PI_REMOTE_TEST_HOST_ROOT, a directory on the host that holds a Node (`node-v*`)
 * and a `node_modules` with Pi, i.e. what scripts/bootstrap-host.sh installs. The daemon
 * and its scratch files live in a fresh directory under it and are removed afterwards.
 * The scripted model runs on the host; no provider credentials are involved.
 */
export async function remoteBackend(host: string): Promise<Backend> {
  const hostRoot = process.env.PI_REMOTE_TEST_HOST_ROOT;
  if (!hostRoot) throw new Error("PI_REMOTE_TEST_HOST_ROOT is required with PI_REMOTE_TEST_HOST");
  const work = `${hostRoot}/pbs-${randomBytes(4).toString("hex")}`;
  const local = makeEnv(); // local scratch for the CLI's own state and ssh ControlPath

  // Ship the daemon source and the scripted-provider agent dir.
  ssh(host, `mkdir -p ${work}/gate && printf '{ "type": "module" }\\n' > ${work}/package.json`);
  execFileSync("sh", ["-c", `tar -C ${pkgRoot} -cf - src test/fixtures/agent | ssh -o BatchMode=yes ${host} 'tar -C ${work} -xf -'`]);
  ssh(host, `mv ${work}/test/fixtures/agent ${work}/agent && printf '{"defaultProvider":"fake","defaultModel":"fake-1"}' > ${work}/agent/settings.json && mkdir -p ${work}/repo && cd ${work}/repo && git init -q -b feature-x`);
  const pid = ssh(
    host,
    `cd ${work} && (PI_SERVER_DIR=${work}/srv PI_CODING_AGENT_DIR=${work}/agent PI_FAKE_GATE_DIR=${work}/gate PI_FAKE_LOG=${work}/llm.log setsid nohup $(ls -d ${hostRoot}/node-v*/bin/node | head -1) src/cli.ts > daemon.log 2>&1 < /dev/null & echo $!)`,
  ).trim();
  await waitFor("remote daemon to listen", () => ssh(host, `grep -c 'listening on' ${work}/daemon.log || true`).trim() !== "0", 60_000);

  const controlPathRoot = join(local.agentDir, "ssh-control");
  return {
    flags: ["--host", host, "--remote-dir", `${work}/srv`],
    cwd: `${work}/repo`,
    env: { ...local.vars, PI_REMOTE_STATE_DIR: join(local.root, "state") },
    userTexts: async () => {
      const raw = ssh(host, `cat ${work}/llm.log 2>/dev/null || true`);
      return raw.split("\n").filter(Boolean).map((line) => (JSON.parse(line).messages as Array<{ role: string; text: string }>).filter((m) => m.role === "user").at(-1)?.text ?? "");
    },
    gateStarted: async (name) => ssh(host, `test -e ${work}/gate/${name}.started && echo yes || true`).trim() === "yes",
    releaseGate: async (name) => void ssh(host, `touch ${work}/gate/${name}.release`),
    cleanup: async () => {
      ssh(host, `kill -9 ${pid} 2>/dev/null; rm -rf ${work}; true`);
      await createSshMuxController({ ...resolveSshCommand({ command: "true", ssh: { host } }), runner: createProcessRunner(), sessionScope: "pi-remote", controlPathRoot }).cleanup();
    },
  };
}
