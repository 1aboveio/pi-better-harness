import { spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { claimDaemonOwner, inspectDaemonOwner } from "../daemon-owner.ts";

/** Recovery only: the child retains all session, writer and domain authority. */
export async function runGuardian(serverDir: string): Promise<void> {
  if (inspectDaemonOwner(serverDir, "guardian-owner").status === "ambiguous") throw new Error("Ambiguous guardian owner; refusing replacement");
  const release = claimDaemonOwner(serverDir, "guardian-owner");
  const budgetPath = join(serverDir, "guardian-restarts.json");
  try {
    let failures: number[] = [];
    try {
      const record = JSON.parse(readFileSync(budgetPath, "utf8"));
      if (!Array.isArray(record) || record.some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid guardian restart budget");
      failures = record;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (;;) {
      failures = failures.filter(time => Date.now() - time < 60_000);
      if (failures.length >= 3) throw new Error("runtime-unavailable: guardian restart budget exhausted (3 failures in 60 seconds)");
      // A live or unverified server cannot be adopted as a new child or replaced.
      const owner = inspectDaemonOwner(serverDir);
      if (owner.status === "live" || owner.status === "ambiguous") throw new Error("runtime-unhealthy: existing server owner was not replaced");
      let cleanToken: string | undefined;
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("../cli.ts", import.meta.url)), "--agent", "pi"], {
        env: { ...process.env, PI_SERVER_GUARDED_CHILD: "1" }, stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      child.on("message", message => {
        const record = message as { type?: string; token?: string };
        if (record?.type === "runtime-clean-stop" && typeof record.token === "string") cleanToken = record.token;
      });
      let stopping = false;
      const stop = () => { stopping = true; child.kill("SIGTERM"); };
      process.on("SIGTERM", stop); process.on("SIGINT", stop);
      try {
        await new Promise<void>(resolve => { child.once("error", () => resolve()); child.once("exit", () => resolve()); });
      } finally { process.off("SIGTERM", stop); process.off("SIGINT", stop); }
      let checkpoint;
      try { checkpoint = JSON.parse(readFileSync(join(serverDir, "clean-stop.json"), "utf8")); } catch { /* Missing proof is a crash. */ }
      if ((cleanToken && checkpoint?.token === cleanToken && checkpoint?.pid === child.pid && checkpoint?.reason === "clean-stop") || stopping) return;
      failures.push(Date.now());
      const temporary = `${budgetPath}.${process.pid}`;
      writeFileSync(temporary, JSON.stringify(failures), { mode: 0o600 });
      renameSync(temporary, budgetPath);
      await delay(1000 * 2 ** (failures.length - 1));
    }
  } finally { release(); }
}
