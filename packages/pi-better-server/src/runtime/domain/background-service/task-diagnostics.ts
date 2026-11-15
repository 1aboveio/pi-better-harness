import { execFileSync } from "node:child_process";
import type { BackgroundTaskMeta } from "./types.js";

export interface ProcessSample {
  uid: number;
  startTime: string;
  state: string;
  cpuTime: string;
  waitChannel: string;
}

export interface TaskProcessDiagnostics {
  availability: "available" | "blocked" | "unavailable";
  identity?: "matches" | "absent" | "mismatch" | "unverified";
  state?: string;
  cpuTime?: string;
  waitChannel?: string;
  reason?: string;
  limit: string;
}

const LIMIT = "One process snapshot cannot prove useful work or a hang; descendants and network requests are not inspected.";
const normalized = (value: string) => value.trim().replace(/\s+/g, " ");

/** Fixed, bounded probe of one registered task PID. Never reads argv, environment or paths. */
function sampleProcess(pid: number): ProcessSample | undefined {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new Error("unsupported platform");
  const file = process.platform === "darwin" ? "/bin/ps" : "/usr/bin/ps";
  let output: string;
  try {
    output = execFileSync(file, ["-p", String(pid), "-o", "uid=,lstart=,state=,time=,wchan="], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 4096,
      stdio: ["ignore", "pipe", "pipe"], env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
    }).trim();
  } catch (error) {
    const failure = error as { status?: number; stdout?: unknown; stderr?: unknown };
    if (failure.status === 1 && !String(failure.stdout ?? "").trim() && !String(failure.stderr ?? "").trim()) return undefined;
    throw new Error("process snapshot unavailable");
  }
  if (!output) return undefined;
  const match = /^(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+([A-Za-z+<>NsLslWXZRTIDUP?-]+)\s+([\d:.\-]+)\s*(\S*)$/.exec(output);
  if (!match || match[5]!.length > 128) throw new Error("unsupported process snapshot");
  return { uid: Number(match[1]), startTime: normalized(match[2]!), state: match[3]!, cpuTime: match[4]!, waitChannel: match[5] || "unavailable" };
}

export function inspectTaskProcess(
  meta: BackgroundTaskMeta,
  access: "read" | "off" | "unknown" | "confined",
  probe: (pid: number) => ProcessSample | undefined = sampleProcess,
): TaskProcessDiagnostics {
  const unavailable = (reason: string, identity?: TaskProcessDiagnostics["identity"]): TaskProcessDiagnostics =>
    ({ availability: "unavailable", reason, ...(identity ? { identity } : {}), limit: LIMIT });
  if (access === "confined") return unavailable("Process activity adapter is unavailable under Main confinement; no unconfined process probe was run. Process access Read does not bypass kernel rules.");
  if (access !== "read") return { availability: "blocked", reason: access === "off"
    ? "Process access is Off in Main or Background tasks. Enable Read in /sandbox; this does not describe task confinement."
    : "Current process-access policy is unavailable; no process probe was run.", limit: LIMIT };
  if (meta.ssh) return unavailable("Remote activity is unavailable; no remote diagnostic command was run.");
  if (meta.kind !== "process") return unavailable("Watch poll PID is not retained; last completed check is progress evidence only.");
  if (!Number.isSafeInteger(meta.pid) || meta.pid! <= 0) return unavailable("Task PID is unavailable.");
  try {
    const sample = probe(meta.pid!);
    if (!sample) return { availability: "available", identity: "absent", reason: "Recorded PID is absent; the execution result may still be unavailable.", limit: LIMIT };
    if (sample.uid !== process.getuid?.()) return unavailable("Recorded PID is not a current-user process.", "mismatch");
    if (!meta.pidStartTime) return unavailable("Launch-time process identity is missing; sampled activity cannot be attributed to this task.", "unverified");
    if (normalized(sample.startTime) !== normalized(meta.pidStartTime)) return unavailable("Recorded PID has been reused; sampled activity is not this task.", "mismatch");
    return { availability: "available", identity: "matches", state: sample.state, cpuTime: sample.cpuTime,
      waitChannel: sample.waitChannel, limit: LIMIT };
  } catch {
    return unavailable("OS process activity/wait evidence is unavailable or unsupported; no command output is disclosed.");
  }
}