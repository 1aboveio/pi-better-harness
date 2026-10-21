import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface DaemonOwnerIdentity {
  pid: number;
  token: string;
  boot?: string;
  start?: string;
}

type Owner = DaemonOwnerIdentity;

export function currentOwnerIdentity(token = randomUUID()): DaemonOwnerIdentity {
  return { pid: process.pid, token, ...linuxIdentity(process.pid) };
}

export function ownerIsAlive(owner: DaemonOwnerIdentity): boolean {
  return alive(owner);
}

export type OwnerInspection =
  | { status: "missing" | "ambiguous"; reason?: string }
  | { status: "live" | "dead"; owner: DaemonOwnerIdentity };

/** Read-only, fail-closed inspection using the same PID-reuse checks as claiming. */
export function inspectDaemonOwner(serverDir: string, lockName = "daemon-owner"): OwnerInspection {
  const lock = join(serverDir, lockName);
  try {
    const names = readdirSync(lock);
    if (names.length !== 1) return { status: "ambiguous", reason: "Ownership directory is empty or has multiple entries" };
    const owner: Owner = JSON.parse(readFileSync(join(lock, names[0]!), "utf8"));
    validateOwner(owner, names[0]!, lock);
    return { status: alive(owner) ? "live" : "dead", owner };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      // A disappearing file inside a published directory is not proof of no owner.
      try { readdirSync(lock); } catch (again) {
        if ((again as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
      }
    }
    return { status: "ambiguous", reason: String(error) };
  }
}

export function validateDaemonOwnerIdentity(value: unknown): asserts value is DaemonOwnerIdentity {
  const owner = value as Owner;
  validateOwner(owner, `owner-${owner?.token}.json`, "activation journal");
}

function validateOwner(previous: Owner, name: string, lock: string): void {
  if (!previous || typeof previous !== "object" || Array.isArray(previous)
    || !Number.isSafeInteger(previous.pid) || previous.pid <= 0 || previous.pid > 2_147_483_647
    || typeof previous.token !== "string" || !UUID.test(previous.token) || name !== `owner-${previous.token}.json`
    || (previous.boot !== undefined && (typeof previous.boot !== "string" || !UUID.test(previous.boot)))
    || (previous.start !== undefined && (typeof previous.start !== "string" || !/^\d+$/.test(previous.start)))) throw new Error(`Invalid daemon ownership in ${lock}`);
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function linuxIdentity(pid: number): Pick<Owner, "boot" | "start"> {
  if (process.platform !== "linux") return {};
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return { boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), start: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] };
  } catch { return {}; }
}

function alive(owner: Owner): boolean {
  const identity = linuxIdentity(owner.pid);
  if (owner.boot && identity.boot && owner.boot !== identity.boot) return false;
  if (owner.start && identity.start && owner.start !== identity.start) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Claim ownership before reading the index. A live owner is never reclaimed on a timer. */
export function claimDaemonOwner(serverDir: string, lockName = "daemon-owner"): () => void {
  const token = randomUUID();
  const owner = currentOwnerIdentity(token);
  const lock = join(serverDir, lockName);
  const candidate = join(serverDir, `.${lockName}-${token}`);
  const name = `owner-${token}.json`;
  mkdirSync(candidate, { mode: 0o700 });
  let claimed = false;
  try {
    writeFileSync(join(candidate, name), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        // Publishing a fully populated directory avoids an ownerless mkdir/write window.
        renameSync(candidate, lock);
        claimed = true;
        let released = false;
        return () => {
          if (released) return;
          try { unlinkSync(join(lock, name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
          try { rmdirSync(lock); }
          catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
          released = true;
        };
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      let names: string[];
      try { names = readdirSync(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (names.length === 0) continue;
      if (names.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(names[0]!)) throw new Error(`Unrecognized daemon ownership in ${lock}; refusing to remove it`);
      const path = join(lock, names[0]!);
      let previous: Owner;
      try { previous = JSON.parse(readFileSync(path, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      validateOwner(previous, names[0]!, lock);
      if (alive(previous)) throw new Error(`Daemon owner ${previous.pid} is already running for ${serverDir}; refusing another writer`);
      // Remove only the exact stale owner's file. A competing claimant publishes a different token.
      try { unlinkSync(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try { rmdirSync(lock); }
      catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    throw new Error(`Daemon ownership changed repeatedly for ${serverDir}; retry connecting`);
  } finally {
    if (!claimed) {
      try { unlinkSync(join(candidate, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      rmdirSync(candidate);
    }
  }
}