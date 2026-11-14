import { spawn } from "node:child_process";
import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { connect } from "node:net";
import { claimDaemonOwner, inspectDaemonOwner, ownerIdentityVerified, sameOwner, type DaemonOwnerIdentity } from "../daemon-owner.ts";
import { socketPathFor } from "./socket.ts";

function bindServer(serverDir: string, expected: DaemonOwnerIdentity, guardian: DaemonOwnerIdentity): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPathFor(serverDir));
    let buffer = "", bound = false, stopping = false;
    const timeout = setTimeout(() => socket.destroy(new Error("runtime-unhealthy: guardian bind timed out; live owner was not replaced")), 2000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ id: "hello", type: "hello", protocolVersion: 1, runtimeRoot: realpathSync(process.env.PI_CODING_AGENT_DIR!) }) + "\n"));
    socket.on("error", error => { clearTimeout(timeout); reject(error); });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 65536) return socket.destroy(new Error("Oversized guardian handshake"));
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n"), line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const response = JSON.parse(line);
          if (!response.success) throw new Error(response.error ?? "Guardian bind refused");
          if (response.id === "hello") socket.write(JSON.stringify({ id: "bind", type: "runtime_guardian_bind", server: expected, guardian }) + "\n");
          else if (response.id === "bind" && sameOwner(response.data.server, expected) && sameOwner(response.data.guardian, guardian)) {
            bound = true; clearTimeout(timeout);
          } else throw new Error("Guardian bind identity mismatch");
        } catch (error) { socket.destroy(error as Error); }
      }
    });
    const stop = () => { stopping = true; socket.destroy(); };
    process.once("SIGTERM", stop); process.once("SIGINT", stop);
    socket.on("close", () => {
      clearTimeout(timeout); process.off("SIGTERM", stop); process.off("SIGINT", stop);
      if (bound || stopping) resolve(stopping); else reject(new Error("runtime-unhealthy: guardian disconnected before exact bind acknowledgement"));
    });
  });
}

/** Only the live server owner may ask a replacement to bind; it never spawns another server. */
export function maintainGuardian(serverDir: string, server: DaemonOwnerIdentity): () => void {
  let stopped = false, launching = false;
  const check = () => {
    if (stopped || launching || !server.start) return;
    const owner = inspectDaemonOwner(serverDir, "guardian-owner");
    const current = inspectDaemonOwner(serverDir);
    if (owner.status === "live" || owner.status === "ambiguous" || current.status !== "live" || !sameOwner(current.owner, server)) return;
    // Count reconstruction attempts durably before spawn, so replacing this server cannot reset a spin.
    const path = join(serverDir, "guardian-rebinds.json");
    let attempts: number[] = [];
    try { attempts = JSON.parse(readFileSync(path, "utf8")); if (!Array.isArray(attempts) || attempts.some(value => !Number.isSafeInteger(value))) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
    attempts = attempts.filter(time => Date.now() - time < 60000);
    if (attempts.length >= 3) return;
    attempts.push(Date.now());
    const temporary = `${path}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(attempts), { mode: 0o600 }); renameSync(temporary, path);
    launching = true;
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("../cli.ts", import.meta.url)), "--agent", "pi"], {
      env: { ...process.env, PI_SERVER_GUARDED_CHILD: "", PI_SERVER_GUARDIAN_REBIND: JSON.stringify(server) },
      detached: true, stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", () => { launching = false; }); child.once("exit", () => { launching = false; }); child.unref();
  };
  const timer = setInterval(() => { try { check(); } catch { /* Recovery stays degraded; server ownership is unchanged. */ } }, 1000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

/** Recovery only: the child retains all session, writer and domain authority. */
export async function runGuardian(serverDir: string, rebind?: DaemonOwnerIdentity): Promise<void> {
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
    const receiptsPath = join(serverDir, "guardian-faults.json");
    let receipts: string[] = [];
    try {
      receipts = JSON.parse(readFileSync(receiptsPath, "utf8"));
      if (!Array.isArray(receipts) || receipts.some(token => typeof token !== "string")) throw new Error("Invalid guardian fault receipts");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const fault = (identity?: DaemonOwnerIdentity) => {
      if (identity && receipts.includes(identity.token)) return;
      let idle;
      try { idle = JSON.parse(readFileSync(join(serverDir, "idle-stop-intent.json"), "utf8")); } catch { /* No exact idle-stop intent. */ }
      if (identity && idle?.token === identity.token && idle.pid === identity.pid) {
        const path = join(serverDir, "guardian-idle-restarts.json");
        let attempts: number[] = [];
        try { attempts = JSON.parse(readFileSync(path, "utf8")); if (!Array.isArray(attempts) || attempts.some(value => !Number.isSafeInteger(value))) throw new Error("Invalid idle restart budget"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        attempts = attempts.filter(time => Date.now() - time < 60000);
        if (attempts.length) throw new Error("runtime-unavailable: idle recovery budget exhausted");
        attempts.push(Date.now());
        const temporary = `${path}.${process.pid}`;
        writeFileSync(temporary, JSON.stringify(attempts), { mode: 0o600 }); renameSync(temporary, path);
      }
      failures = failures.filter(time => Date.now() - time < 60000);
      failures.push(Date.now());
      const temporary = `${budgetPath}.${process.pid}`;
      writeFileSync(temporary, JSON.stringify(failures), { mode: 0o600 }); renameSync(temporary, budgetPath);
      if (identity) {
        receipts.push(identity.token);
        const temporary = `${receiptsPath}.${process.pid}`;
        // Budget commits first: interruption can overcount a fault but cannot erase a spent restart.
        writeFileSync(temporary, JSON.stringify(receipts.slice(-64)), { mode: 0o600 }); renameSync(temporary, receiptsPath);
      }
    };
    if (rebind) {
      const current = inspectDaemonOwner(serverDir);
      const guardian = inspectDaemonOwner(serverDir, "guardian-owner");
      if (current.status !== "live" || guardian.status !== "live" || !sameOwner(current.owner, rebind)
        || !ownerIdentityVerified(current.owner) || !ownerIdentityVerified(guardian.owner)) throw new Error("runtime-unhealthy: rebind target changed or identity is unverified");
      if (await bindServer(serverDir, rebind, guardian.owner)) return;
      // Socket loss is not process-death proof. Never signal or replace an adopted live owner.
      while (true) {
        const current = inspectDaemonOwner(serverDir);
        if (current.status === "missing" || current.status === "dead") break;
        if (current.status !== "live" || !sameOwner(current.owner, rebind)) throw new Error("runtime-unhealthy: rebound owner changed or is unverified");
        await delay(100);
      }
      let checkpoint;
      try { checkpoint = JSON.parse(readFileSync(join(serverDir, "clean-stop.json"), "utf8")); } catch { /* Missing proof is a crash. */ }
      if (checkpoint?.token === rebind.token && checkpoint?.pid === rebind.pid) return;
      fault(rebind);
    }
    const previous = inspectDaemonOwner(serverDir);
    if (previous.status === "dead") {
      let checkpoint;
      try { checkpoint = JSON.parse(readFileSync(join(serverDir, "clean-stop.json"), "utf8")); } catch { /* Missing proof is a crash. */ }
      if (checkpoint?.token !== previous.owner.token) fault(previous.owner);
    }
    for (;;) {
      failures = failures.filter(time => Date.now() - time < 60_000);
      if (failures.length >= 3) throw new Error("runtime-unavailable: guardian restart budget exhausted (3 failures in 60 seconds)");
      // A live or unverified server cannot be adopted as a new child or replaced.
      const owner = inspectDaemonOwner(serverDir);
      if (owner.status === "live" || owner.status === "ambiguous") throw new Error("runtime-unhealthy: existing server owner was not replaced");
      let cleanToken: string | undefined;
      const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL("../cli.ts", import.meta.url)), "--agent", "pi"], {
        env: { ...process.env, PI_SERVER_GUARDED_CHILD: "1", PI_SERVER_GUARDIAN_REBIND: "" }, stdio: ["ignore", "inherit", "inherit", "ipc"],
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
      const dead = inspectDaemonOwner(serverDir);
      fault(dead.status === "dead" ? dead.owner : undefined);
      await delay(1000 * 2 ** (failures.length - 1));
    }
  } finally { release(); }
}
