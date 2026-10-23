import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../client.ts";
import { claimDaemonOwner, inspectDaemonOwner, ownerIsAlive, validateDaemonOwnerIdentity, type DaemonOwnerIdentity } from "../daemon-owner.ts";
import { socketPathFor } from "../paths.ts";
import type { Readiness } from "./ensure.ts";
import type { ActivationResult, IdleSessionsLease, ServerBuild, StagedRuntime, UpgradeRequest } from "./managed-types.ts";
import { homedir } from "node:os";
import { absolutePath, registeredRuntime, shellQuote } from "./runtime.ts";

export type ActivationPhase = "staged" | "prepared" | "stopping" | "starting" | "adopted" | "ready" | "recovery-required";
export interface ActivationJournal extends UpgradeRequest {
  version: 1;
  phase: ActivationPhase;
  desiredBuild: ServerBuild;
  previousBuild?: ServerBuild;
  previousCompatibility?: Pick<ServerBuild, "piSdkVersion" | "protocolVersion">;
  previousRuntime?: StagedRuntime;
  previousOwner?: DaemonOwnerIdentity;
  candidateOwner?: DaemonOwnerIdentity;
  coordinator?: DaemonOwnerIdentity;
  emptyNamespace: boolean;
  reason?: string;
  readiness?: Readiness;
  rollbackPermit?: PreAdoptionRollbackPermit;
}

export interface PreAdoptionRollbackPermit {
  version: 1;
  operationId: string;
  serverDir: string;
  agentDir: string;
  previousBuild: ServerBuild;
  coordinator: DaemonOwnerIdentity;
  token: string;
  consumedBy?: DaemonOwnerIdentity;
}
export interface RollbackStartupRequest {
  serverDir: string;
  agentDir: string;
  operationId: string;
  build: ServerBuild;
  permitToken: string;
}

export type ActivationProbe =
  | { kind: "ready"; readiness: Readiness }
  | { kind: "absent" }
  | { kind: "ambiguous"; reason: string };

/** Process and transport boundaries. No session execution implementation lives here. */
export interface ActivationPorts {
  probe(serverDir: string): Promise<ActivationProbe>;
  schedule(request: UpgradeRequest): Promise<void>;
  launch(request: UpgradeRequest, options?: { adopt: boolean; rollbackPermitToken?: string }): Promise<{ exited(): boolean }>;
  pause(): Promise<void>;
  ready?(journal: ActivationJournal): Promise<void>;
}
export interface ActivateOptions extends UpgradeRequest {
  signal?: AbortSignal;
  /** Tests can exercise the transaction without a process supervisor or transport. */
  ports?: ActivationPorts;
  timeoutMs?: number;
}

const JOURNAL = "activation.json";
const POINTER = "active-runtime.json";
const LOCK = "activation-owner";
const RESERVATIONS = "activation-reservations";
const committed = (phase: ActivationPhase) => ["stopping", "starting", "adopted", "ready", "recovery-required"].includes(phase);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function canonicalStateDir(path: string): string {
  absolutePath(path, "serverDir");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export function readActivationJournal(serverDir: string): ActivationJournal | undefined {
  let value: ActivationJournal;
  try { value = JSON.parse(readFileSync(join(serverDir, JOURNAL), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!value || value.version !== 1 || !["staged", "prepared", "stopping", "starting", "adopted", "ready", "recovery-required"].includes(value.phase)
    || typeof value.emptyNamespace !== "boolean" || typeof value.operationId !== "string"
    || value.serverDir !== realpathSync(serverDir) || !value.operationId || !value.runtime?.build?.contentId
    || value.desiredBuild?.contentId !== value.runtime.build.contentId) throw new Error("Invalid activation journal; manual recovery required");
  absolutePath(value.agentDir, "journal.agentDir");
  for (const identity of [value.previousOwner, value.candidateOwner, value.coordinator]) if (identity !== undefined) validateDaemonOwnerIdentity(identity);
  return value;
}

function save(journal: ActivationJournal): void { atomicJson(join(journal.serverDir, JOURNAL), journal); }
function reservationPath(serverDir: string, operationId: string): string {
  return join(serverDir, RESERVATIONS, createHash("sha256").update(operationId).digest("hex"));
}
function reserve(options: UpgradeRequest): () => void {
  mkdirSync(join(options.serverDir, RESERVATIONS), { recursive: true, mode: 0o700 });
  // Every observer has its own reservation, including callers reusing an operation id.
  const path = reservationPath(options.serverDir, `${options.operationId}:${randomUUID()}`);
  const journal = readActivationJournal(options.serverDir);
  atomicJson(path, { buildId: options.runtime.build.contentId, operationId: options.operationId, baseOperationId: journal?.operationId ?? null,
    // Only a caller arriving after successful rollback can authorize another attempt.
    rollbackToken: journal?.phase === "staged" ? journal.rollbackPermit?.token : undefined });
  return () => { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } };
}
export function hasActivationReservations(journal: Pick<ActivationJournal, "serverDir" | "desiredBuild">): boolean {
  try {
    return readdirSync(join(journal.serverDir, RESERVATIONS)).some(name => {
      if (!/^[a-f0-9]{64}$/.test(name)) return false;
      try { return JSON.parse(readFileSync(join(journal.serverDir, RESERVATIONS, name), "utf8")).buildId === journal.desiredBuild.contentId; }
      catch { return false; }
    });
  } catch { return false; }
}
function reservedAgainst(request: UpgradeRequest, operationId: string, rollbackToken?: string): boolean {
  return readdirSync(join(request.serverDir, RESERVATIONS)).some(name => {
    if (!/^[a-f0-9]{64}$/.test(name)) return false;
    try {
      const reservation = JSON.parse(readFileSync(join(request.serverDir, RESERVATIONS, name), "utf8"));
      return reservation.operationId === request.operationId && reservation.buildId === request.runtime.build.contentId && reservation.baseOperationId === operationId
        && (rollbackToken === undefined || reservation.rollbackToken === rollbackToken);
    } catch { return false; }
  });
}

function clearReservations(journal: ActivationJournal): void {
  for (const name of readdirSync(join(journal.serverDir, RESERVATIONS))) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const path = join(journal.serverDir, RESERVATIONS, name);
    try {
      const reservation = JSON.parse(readFileSync(path, "utf8"));
      if (reservation.buildId === journal.desiredBuild.contentId
        && !(journal.rollbackPermit && reservation.rollbackToken === journal.rollbackPermit.token && reservation.operationId !== journal.operationId)) unlinkSync(path);
    } catch { /* observer already detached */ }
  }
}

export function readActiveRuntime(serverDir: string): StagedRuntime | undefined {
  try {
    const pointer = JSON.parse(readFileSync(join(serverDir, POINTER), "utf8"));
    if (pointer.version !== 1 || pointer.serverDir !== realpathSync(serverDir) || !pointer.runtime?.build?.contentId) throw new Error("Invalid active runtime pointer");
    return pointer.runtime;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function result(journal: ActivationJournal): ActivationResult {
  if (journal.phase === "ready" && journal.readiness) return { status: "ready", operationId: journal.operationId, readiness: journal.readiness };
  return { status: journal.phase === "recovery-required" ? "recovery-required" : "deferred", operationId: journal.operationId,
    reason: journal.reason ?? `Activation ${journal.phase}` };
}
export interface ActivationConflict { code: "activation-conflict"; pendingBuildId: string }

function conflict(journal: ActivationJournal): Extract<ActivationResult, { status: "deferred" }> & ActivationConflict {
  return { status: "deferred", code: "activation-conflict", pendingBuildId: journal.desiredBuild.contentId, operationId: journal.operationId, reason: `activation-conflict: ${journal.desiredBuild.contentId} is already pending for this state directory` };
}
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError"); }

/** Stage verification is the caller's prerequisite. This never imports agent extensions. */
export async function activateStagedRuntime(options: ActivateOptions): Promise<ActivationResult> {
  checkAbort(options.signal);
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000)) throw new Error("Activation timeout must be an integer from 1 to 120000 ms");
  if (!options.operationId || options.operationId.length > 256) throw new Error("operationId must contain 1 to 256 characters");
  const serverDir = canonicalStateDir(options.serverDir);
  const request = { ...options, serverDir, agentDir: realpathSync(absolutePath(options.agentDir, "agentDir")) };
  const unreserve = reserve(request);
  const abort = () => unreserve();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    checkAbort(options.signal);
    if (options.ports) {
      const outcome = await runActivationWorker(request, options.ports);
      const pending = readActivationJournal(serverDir);
      if (pending && freshRollbackRequest(pending, request)) return { status: "deferred", operationId: request.operationId, reason: "Waiting for verified rollback retirement" };
      if (outcome.status === "ready" || (outcome.status === "deferred" && outcome.reason.startsWith("activation-conflict:"))
        || pending?.rollbackPermit !== undefined) unreserve();
      return outcome;
    }
    const existing = readActivationJournal(serverDir);
    if (existing?.rollbackPermit !== undefined && !freshRollbackRequest(existing, request)) {
      unreserve();
      return result(existing);
    }
    if (existing?.phase === "ready" && existing.desiredBuild.contentId === options.runtime.build.contentId) {
      const probe = await defaultActivationPorts.probe(serverDir);
      checkAbort(options.signal);
      if (matches(probe, existing)) { unreserve(); return result(existing); }
    }
    if (existing && !["ready", "staged"].includes(existing.phase) && existing.desiredBuild.contentId !== options.runtime.build.contentId) {
      unreserve();
      return conflict(existing);
    }
    // The worker owns the transaction. SSH exit or a cancelled observer cannot kill it.
    const worker = spawnDetached(process.execPath, [fileURLToPath(new URL("../cli.ts", import.meta.url)), "activation-worker", "--agent", "pi",
      "--runtime", options.runtime.manifestPath, "--server-dir", serverDir, "--agent-dir", request.agentDir, "--operation-id", options.operationId], serverDir);
    await new Promise<void>((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    while (Date.now() < deadline) {
      checkAbort(options.signal);
      const journal = readActivationJournal(serverDir);
      if (journal && !freshRollbackRequest(journal, request)) {
        if (journal.desiredBuild.contentId !== options.runtime.build.contentId) {
          // The detached worker may still be replacing a ready journal or retiring
          // a stale staged activation. Keep its caller reservation until it decides.
          const awaitingWorker = journal.phase === "staged" && worker.exitCode === null && worker.signalCode === null;
          if ((journal.phase !== "ready" && !awaitingWorker) || !reservedAgainst(request, journal.operationId)) { unreserve(); return conflict(journal); }
        } else if (journal.phase === "ready") {
          const probe = await defaultActivationPorts.probe(serverDir);
          if (matches(probe, journal)) { unreserve(); return result(journal); }
        } else if (journal.phase === "recovery-required" || journal.reason) {
          if (journal.rollbackPermit !== undefined) unreserve();
          return result(journal);
        }
      }
      await delay(50, undefined, { signal: options.signal });
    }
    const journal = readActivationJournal(serverDir);
    if (journal?.rollbackPermit !== undefined) {
      if (freshRollbackRequest(journal, request)) return { status: "deferred", operationId: request.operationId, reason: "Waiting for verified rollback retirement" };
      unreserve();
      return result(journal);
    }
    if (!journal || journal.desiredBuild.contentId !== options.runtime.build.contentId) return { status: "deferred", operationId: options.operationId, reason: "Host activation coordinator is starting" };
    if (journal.phase === "ready") return { status: "deferred", operationId: journal.operationId, reason: "Waiting for verified daemon readiness" };
    return result(journal);
  } catch (error) { unreserve(); throw error; }
  finally { options.signal?.removeEventListener("abort", abort); }
}

function spawnDetached(node: string, args: string[], serverDir: string, env: NodeJS.ProcessEnv = process.env): ReturnType<typeof spawn> {
  const fd = openSync(join(serverDir, "activation.log"), "a", 0o600);
  try {
    const child = spawn(node, args, { detached: true, cwd: serverDir, env, stdio: ["ignore", fd, fd] });
    child.on("error", () => {}); // Callers attach their own rejection handler; never emit an unhandled event.
    child.unref();
    return child;
  } finally { closeSync(fd); }
}

export async function probeActivationDaemon(serverDir: string): Promise<ActivationProbe> {
  try {
    // Upgrade discovery can cross SDK minors; ordinary client handshakes still enforce major.minor.
    const client = await DaemonClient.connect(socketPathFor(serverDir), { signal: AbortSignal.timeout(1_000), hello: { piVersion: undefined } });
    try {
      if (!client.server || !Array.isArray(client.server.capabilities)) return { kind: "ambiguous", reason: "Invalid daemon hello" };
      return { kind: "ready", readiness: { version: 1, agent: "pi", serverDir, socketPath: socketPathFor(serverDir), hello: client.server } };
    } finally { client.close(); }
  } catch (error) {
    return ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")
      ? { kind: "absent" } : { kind: "ambiguous", reason: message(error) };
  }
}

export const defaultActivationPorts: ActivationPorts = {
  probe: probeActivationDaemon,
  async schedule(request) {
    const client = await DaemonClient.connect(socketPathFor(request.serverDir), { signal: AbortSignal.timeout(1_000), hello: { piVersion: undefined } });
    const timer = setTimeout(() => client.close(), 2_000);
    try { await client.call({ type: "runtime_upgrade", ...request }); }
    finally { clearTimeout(timer); client.close(); }
  },
  async launch(request, options = { adopt: true }) {
    const env: NodeJS.ProcessEnv = { ...process.env, PI_SERVER_AGENT: "pi", PI_SERVER_DIR: request.serverDir, PI_CODING_AGENT_DIR: request.agentDir,
      PI_SERVER_RUNTIME_MANIFEST: request.runtime.manifestPath };
    delete env.PI_SERVER_ACTIVATION_ID;
    delete env.PI_SERVER_ROLLBACK_OPERATION_ID;
    delete env.PI_SERVER_ROLLBACK_PERMIT;
    if (options.adopt) env.PI_SERVER_ACTIVATION_ID = request.operationId;
    else {
      if (!options.rollbackPermitToken) throw new Error("Pre-adoption rollback requires a durable startup permit");
      checkPreAdoptionRollbackPermit({ ...request, build: request.runtime.build, permitToken: options.rollbackPermitToken });
      env.PI_SERVER_ROLLBACK_OPERATION_ID = request.operationId;
      env.PI_SERVER_ROLLBACK_PERMIT = options.rollbackPermitToken;
    }
    const child = spawnDetached(request.runtime.node, [request.runtime.entrypoint, "--agent", "pi"], request.serverDir, env);
    let failed = false;
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", error => { failed = true; reject(error); }); });
    return { exited: () => failed || child.exitCode !== null || child.signalCode !== null };
  },
  pause: () => delay(100),
  ready: async journal => publishReadyRegistration(journal),
};

/** Executed in a detached host process; the exclusive lock is never aged out. */
export async function runActivationWorker(request: UpgradeRequest, ports: ActivationPorts = defaultActivationPorts): Promise<ActivationResult> {
  const serverDir = canonicalStateDir(request.serverDir);
  let release: () => void;
  for (let attempt = 0; ; attempt++) {
    try { release = claimDaemonOwner(serverDir, LOCK); break; }
    catch (error) {
      const journal = readActivationJournal(serverDir);
      // A staged journal can still name the abandoned build while the coordinator
      // awaits stale-owner proof. Keep this worker alive so its caller keeps waiting.
      if (journal?.phase === "staged" && journal.desiredBuild.contentId !== request.runtime.build.contentId
        && journal.rollbackPermit === undefined && reservedAgainst(request, journal.operationId)
        && inspectDaemonOwner(serverDir, LOCK).status === "live" && attempt < 300) {
        await ports.pause();
        continue;
      }
      if (journal) return journal.desiredBuild.contentId === request.runtime.build.contentId ? result(journal) : conflict(journal);
      return { status: "deferred", operationId: request.operationId, reason: `Activation coordinator already owns this directory: ${message(error)}` };
    }
  }
  let journal: ActivationJournal | undefined;
  try {
    journal = readActivationJournal(serverDir);
    if (journal?.rollbackPermit !== undefined) {
      if (!freshRollbackRequest(journal, request)) return result(journal);
      const probe = await ports.probe(serverDir);
      journal = readActivationJournal(serverDir)!;
      // Never repurpose an issued permit, even if a stale journal says prepared.
      // Replacement is synchronous with the final restored-owner and reservation checks.
      if (!freshRollbackRequest(journal, request) || !verifiedRollback(journal, request, probe)) return result(journal);
      journal = { ...request, serverDir, version: 1, phase: "staged", desiredBuild: request.runtime.build,
        previousBuild: journal.previousBuild, previousRuntime: journal.previousRuntime, previousOwner: journal.previousOwner, emptyNamespace: false };
      save(journal);
    }
    if ((!journal || !committed(journal.phase)) && !hasActivationReservations({ serverDir, desiredBuild: request.runtime.build })) return { status: "deferred", operationId: request.operationId, reason: "Activation caller reservation is no longer present" };
    if (journal && journal.desiredBuild.contentId !== request.runtime.build.contentId && journal.phase === "ready" && !reservedAgainst(request, journal.operationId)) return conflict(journal);
    if (journal?.phase === "ready" && journal.desiredBuild.contentId === request.runtime.build.contentId) {
      const probe = await ports.probe(serverDir);
      if (probe.kind === "ready" && matches(probe, journal)) { clearReservations(journal); return result(journal); }
    }
    // A legacy daemon may have exited after deferring a staged build. Its durable
    // reservation must not block every later build. Only the exclusive coordinator
    // can retire it, after proving no writer remains and preserving compatibility.
    if (journal?.phase === "staged" && journal.desiredBuild.contentId !== request.runtime.build.contentId
      && journal.rollbackPermit === undefined && !journal.candidateOwner
      && realpathSync(journal.agentDir) === realpathSync(request.agentDir)
      && reservedAgainst(request, journal.operationId)) {
      const probe = await ports.probe(serverDir);
      const owner = inspectDaemonOwner(serverDir);
      const previous = journal.previousBuild ?? journal.previousCompatibility;
      if (probe.kind === "absent" && (owner.status === "missing" || owner.status === "dead")
        && journal.previousOwner && !ownerIsAlive(journal.previousOwner)
        && previous && compatibleUpgrade(previous, request.runtime.build)
        && reservedAgainst(request, journal.operationId)) {
        const retired = journal;
        journal = { ...request, serverDir, version: 1, phase: "staged", desiredBuild: request.runtime.build,
          previousBuild: retired.previousBuild, previousRuntime: retired.previousRuntime,
          previousCompatibility: retired.previousCompatibility, previousOwner: retired.previousOwner,
          emptyNamespace: retired.emptyNamespace };
        save(journal);
        clearReservations(retired);
      }
    }
    if (journal && journal.desiredBuild.contentId !== request.runtime.build.contentId && journal.phase !== "ready"
      && (committed(journal.phase) || hasActivationReservations(journal))) return conflict(journal);
    if (journal?.phase === "recovery-required") {
      const probe = await ports.probe(serverDir);
      if (probe.kind === "ready" && journal.candidateOwner?.token === probe.readiness.hello.instanceId && matches(probe, journal)) {
        return await finishReady(journal, probe.readiness, ports);
      }
      return result(journal);
    }
    if (journal?.phase === "starting" || journal?.phase === "adopted") {
      const probe = await ports.probe(serverDir);
      // Adoption can publish the candidate identity while the probe is pending.
      journal = readActivationJournal(serverDir)!;
      if (probe.kind === "ready" && matches(probe, journal)) return await finishReady(journal, probe.readiness, ports);
      // A crash between spawn and adoption is ambiguous. Never launch a second candidate.
      journal.phase = "recovery-required";
      journal.reason = "Activation coordinator restarted after candidate launch; candidate ownership must be reconciled";
      save(journal);
      return result(journal);
    }
    if (!journal || journal.phase === "ready" || journal.desiredBuild.contentId !== request.runtime.build.contentId) {
      const previous = readActiveRuntime(serverDir);
      const previouslyReady = journal?.phase === "ready" ? journal : undefined;
      const emptyNamespace = readdirSync(serverDir).every(name => [LOCK, RESERVATIONS, "activation.log"].includes(name));
      journal = { ...request, serverDir, version: 1, phase: "staged", desiredBuild: request.runtime.build,
        previousBuild: previous?.build ?? previouslyReady?.desiredBuild, previousRuntime: previous ?? previouslyReady?.runtime,
        previousOwner: previouslyReady?.candidateOwner, emptyNamespace };
      save(journal);
    }
    const coordinator = inspectDaemonOwner(serverDir, LOCK);
    if (coordinator.status === "live") journal.coordinator = coordinator.owner;
    save(journal);
    let scheduled = false;
    while (!committed(journal.phase)) {
      if (!hasActivationReservations(journal)) {
        journal.reason = "Activation cancelled before stop commitment";
        save(journal);
        return result(journal);
      }
      const probe = await ports.probe(serverDir);
      journal = readActivationJournal(serverDir)!;
      if (committed(journal.phase)) break;
      const owner = inspectDaemonOwner(serverDir);
      if (owner.status === "live") journal.previousOwner ??= owner.owner;
      if (probe.kind === "ready" && matches(probe, journal)) return await finishReady(journal, probe.readiness, ports);
      if (probe.kind === "ambiguous") return defer(journal, `Owner is ambiguous: ${probe.reason}`);
      if (probe.kind === "ready") {
        journal.previousCompatibility = { piSdkVersion: probe.readiness.hello.piVersion, protocolVersion: probe.readiness.hello.protocolVersion };
        if (!probe.readiness.hello.capabilities?.includes("safe-upgrade-v1") || owner.status !== "live"
          || probe.readiness.hello.instanceId !== owner.owner.token) return defer(journal, "Legacy or unverified live daemon; staged runtime is pending verified owner exit");
        const old = probe.readiness.hello.build;
        if (!old || !compatibleUpgrade(old, journal.desiredBuild)) return defer(journal, "Unsafe SDK downgrade or incompatible protocol; activation deferred");
        journal.previousBuild = old;
        journal.previousOwner = owner.owner;
        journal.phase = "prepared";
        journal.reason = "Waiting for idle sessions and reconnect-capable controllers";
        save(journal);
        if (!scheduled) { await ports.schedule(journal); scheduled = true; }
        await ports.pause();
        journal = readActivationJournal(serverDir)!;
        continue;
      }
      if (owner.status === "live" || owner.status === "ambiguous") return defer(journal, "Daemon owner is live or ambiguous; missing socket is not permission to replace it");
      if (owner.status === "missing" && !journal.emptyNamespace && !(journal.previousOwner && !ownerIsAlive(journal.previousOwner))) {
        return defer(journal, "No verifiable owner exit in a nonempty state directory; legacy activation remains pending");
      }
      const previousCompatibility = journal.previousBuild ?? journal.previousCompatibility;
      if ((previousCompatibility && !compatibleUpgrade(previousCompatibility, journal.desiredBuild)) || (!journal.emptyNamespace && !previousCompatibility)) {
        return defer(journal, "Previous SDK compatibility is unknown or would be downgraded; activation remains pending");
      }
      // Keep the final reservation/owner checks and durable stop commitment synchronous.
      // The last observer may have cancelled while the probe was pending.
      if (!hasActivationReservations(journal)) return defer(journal, "Activation cancelled before stop commitment");
      journal.previousOwner ??= owner.status === "dead" ? owner.owner : undefined;
      journal.phase = "stopping";
      delete journal.reason;
      save(journal);
    }
    // A committed daemon may still be flushing. Only its release permits successor startup.
    for (let attempts = 0; ; attempts++) {
      const owner = inspectDaemonOwner(serverDir);
      const probe = await ports.probe(serverDir);
      if (probe.kind === "absent" && (owner.status === "missing" || owner.status === "dead")) break;
      if (attempts >= 300) return recovery(journal, "Previous daemon has not verifiably released ownership");
      await ports.pause();
    }
    journal.phase = "starting";
    delete journal.reason;
    save(journal); // Persist launch intent before spawn, so a crashed coordinator cannot launch twice.
    let candidate: { exited(): boolean };
    try { candidate = await ports.launch(journal); }
    catch (error) { return recovery(readActivationJournal(serverDir)!, `Candidate launch failed: ${message(error)}`); }
    for (let attempts = 0; attempts < 300; attempts++) {
      journal = readActivationJournal(serverDir)!;
      const probe = await ports.probe(serverDir);
      if (probe.kind === "ready" && matches(probe, journal)) return await finishReady(journal, probe.readiness, ports);
      if (candidate.exited()) {
        if (journal.phase === "adopted") return recovery(journal, "Adopted runtime exited; automatic rollback is forbidden");
        return await rollbackBeforeAdoption(journal, ports, candidate);
      }
      await ports.pause();
    }
    return recovery(readActivationJournal(serverDir)!, "Candidate readiness is ambiguous; no process was killed and no session state was restored");
  } catch (error) {
    if (journal && committed(journal.phase)) return recovery(readActivationJournal(serverDir) ?? journal, message(error));
    if (journal) return defer(journal, message(error));
    throw error;
  } finally { release(); }
}

async function rollbackBeforeAdoption(journal: ActivationJournal, ports: ActivationPorts, candidate: { exited(): boolean }): Promise<ActivationResult> {
  const probe = await ports.probe(journal.serverDir);
  const latest = readActivationJournal(journal.serverDir)!;
  const owner = inspectDaemonOwner(journal.serverDir);
  const coordinator = inspectDaemonOwner(journal.serverDir, LOCK);
  if (!candidate.exited() || latest.operationId !== journal.operationId || latest.agentDir !== journal.agentDir
    || !sameBuild(latest.desiredBuild, journal.desiredBuild) || latest.phase !== "starting" || latest.candidateOwner || latest.rollbackPermit !== undefined
    || !latest.previousRuntime || !latest.previousBuild
    || !sameBuild(latest.previousRuntime.build, latest.previousBuild)
    || !compatibleUpgrade(latest.previousBuild, latest.desiredBuild) || probe.kind !== "absent"
    || (owner.status !== "dead" && owner.status !== "missing")
    || coordinator.status !== "live" || coordinator.owner.pid !== process.pid || !sameOwner(coordinator.owner, latest.coordinator)) {
    return recovery(latest, "Candidate exited, but pre-adoption rollback ownership or compatibility could not be proven");
  }
  // Issue only after the process handle, probe, released owner and live coordinator agree.
  // Persist before launch. Issuance itself permanently fences candidate adoption for this attempt.
  latest.rollbackPermit = { version: 1, operationId: latest.operationId, serverDir: latest.serverDir, agentDir: latest.agentDir,
    previousBuild: latest.previousBuild, coordinator: coordinator.owner, token: randomUUID() };
  save(latest);
  journal = latest;
  const previous = await ports.launch({ ...latest, runtime: latest.previousRuntime }, { adopt: false, rollbackPermitToken: latest.rollbackPermit.token });
  for (let attempt = 0; attempt < 300; attempt++) {
    const previousProbe = await ports.probe(journal.serverDir);
    const oldOwner = inspectDaemonOwner(journal.serverDir);
    journal = readActivationJournal(journal.serverDir)!;
    if (journal.phase !== "starting" || journal.operationId !== latest.operationId) return result(journal);
    if (previousProbe.kind === "ready" && previousProbe.readiness.hello.build?.contentId === journal.previousBuild?.contentId
      && oldOwner.status === "live" && previousProbe.readiness.hello.instanceId === oldOwner.owner.token) {
      journal.phase = "staged";
      journal.previousOwner = oldOwner.owner;
      const outcome = defer(journal, "Candidate failed before adoption; previous compatible runtime restored. Session and agent files were not restored.");
      clearReservations(journal);
      return outcome;
    }
    if (previous.exited()) break;
    await ports.pause();
  }
  return recovery(readActivationJournal(journal.serverDir)!, "Previous runtime did not become ready; no further launches attempted");
}

function freshRollbackRequest(journal: ActivationJournal, request: UpgradeRequest): boolean {
  return journal.phase === "staged" && !!journal.rollbackPermit && request.operationId !== journal.operationId
    && request.agentDir === journal.agentDir && reservedAgainst(request, journal.operationId, journal.rollbackPermit.token);
}

/** The old attempt stays fenced until this proof permits an entirely new journal. */
function verifiedRollback(journal: ActivationJournal, request: UpgradeRequest, probe: ActivationProbe): boolean {
  const permit = journal.rollbackPermit;
  const active = readActiveRuntime(journal.serverDir);
  if (journal.phase !== "staged" || journal.candidateOwner || !permit || permit.version !== 1 || !permit.consumedBy
    || permit.operationId !== journal.operationId || permit.serverDir !== journal.serverDir || permit.agentDir !== journal.agentDir
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(permit.token)
    || !sameOwner(permit.coordinator, journal.coordinator) || !sameOwner(permit.consumedBy, journal.previousOwner)
    || !journal.previousBuild || !journal.previousRuntime || !active
    || !sameBuild(permit.previousBuild, journal.previousBuild) || !sameBuild(journal.previousRuntime.build, journal.previousBuild)
    || !sameBuild(active.build, journal.previousBuild) || !compatibleUpgrade(journal.previousBuild, journal.desiredBuild)
    || !compatibleUpgrade(journal.previousBuild, request.runtime.build)) return false;
  validateDaemonOwnerIdentity(permit.consumedBy);
  validateDaemonOwnerIdentity(permit.coordinator);
  const owner = inspectDaemonOwner(journal.serverDir);
  if (owner.status === "live") return sameOwner(owner.owner, permit.consumedBy) && probe.kind === "ready"
    && probe.readiness.hello.instanceId === owner.owner.token && !!probe.readiness.hello.build
    && sameBuild(probe.readiness.hello.build, journal.previousBuild);
  return probe.kind === "absent" && !ownerIsAlive(permit.consumedBy)
    && (owner.status === "missing" || (owner.status === "dead" && sameOwner(owner.owner, permit.consumedBy)));
}

function sameOwner(a?: DaemonOwnerIdentity, b?: DaemonOwnerIdentity): boolean {
  return !!a && !!b && a.pid === b.pid && a.token === b.token && a.boot === b.boot && a.start === b.start;
}
function sameBuild(a: ServerBuild, b: ServerBuild): boolean {
  return a.contentId === b.contentId && a.sourceDigest === b.sourceDigest && a.dependencyLockDigest === b.dependencyLockDigest
    && a.piSdkVersion === b.piSdkVersion && a.protocolVersion === b.protocolVersion && a.nodeVersion === b.nodeVersion
    && a.platform === b.platform && a.serverVersion === b.serverVersion && a.format === b.format;
}

/** Read-only check; authoritative consumption follows the rollback child's owner claim. */
export function checkPreAdoptionRollbackPermit(request: RollbackStartupRequest): ActivationJournal {
  const journal = readActivationJournal(request.serverDir);
  const permit = journal?.rollbackPermit;
  const coordinator = inspectDaemonOwner(request.serverDir, LOCK);
  if (!journal || journal.phase !== "starting" || journal.candidateOwner || journal.operationId !== request.operationId
    || !permit || permit.version !== 1 || permit.consumedBy !== undefined || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(permit.token)
    || !request.permitToken || permit.token !== request.permitToken
    || permit.operationId !== journal.operationId || permit.serverDir !== journal.serverDir || permit.serverDir !== request.serverDir
    || permit.agentDir !== journal.agentDir || realpathSync(request.agentDir) !== permit.agentDir
    || !journal.previousBuild || !journal.previousRuntime || !sameBuild(permit.previousBuild, journal.previousBuild)
    || !sameBuild(request.build, permit.previousBuild) || !sameBuild(journal.previousRuntime.build, permit.previousBuild)
    || !compatibleUpgrade(permit.previousBuild, journal.desiredBuild)
    || coordinator.status !== "live" || !sameOwner(coordinator.owner, journal.coordinator) || !sameOwner(coordinator.owner, permit.coordinator)) {
    throw new Error("Startup admission: invalid, stale or consumed pre-adoption rollback permit");
  }
  return journal;
}

/** Synchronous, under the exclusive daemon claim, before any registry or hook work. */
export function consumePreAdoptionRollbackPermit(request: RollbackStartupRequest): void {
  const journal = checkPreAdoptionRollbackPermit(request);
  const owner = inspectDaemonOwner(request.serverDir);
  if (owner.status !== "live" || owner.owner.pid !== process.pid) throw new Error("Startup admission: rollback child must own the daemon claim");
  journal.rollbackPermit!.consumedBy = owner.owner;
  save(journal);
}

function matches(probe: ActivationProbe, journal: ActivationJournal): boolean {
  if (probe.kind !== "ready" || probe.readiness.hello.build?.contentId !== journal.desiredBuild.contentId) return false;
  const owner = inspectDaemonOwner(journal.serverDir);
  return owner.status === "live" && probe.readiness.hello.instanceId === owner.owner.token;
}
function defer(journal: ActivationJournal, reason: string): ActivationResult { journal.reason = reason; save(journal); return result(journal); }
function recovery(journal: ActivationJournal, reason: string): ActivationResult { journal.phase = "recovery-required"; return defer(journal, reason); }

export function compatibleUpgrade(previous: Pick<ServerBuild, "piSdkVersion" | "protocolVersion">, desired: Pick<ServerBuild, "piSdkVersion" | "protocolVersion">): boolean {
  const parts = (value: string) => /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value)?.slice(1).map(Number);
  const old = parts(previous.piSdkVersion), next = parts(desired.piSdkVersion);
  if (!old || !next || previous.protocolVersion !== desired.protocolVersion) return false;
  for (let i = 0; i < 3; i++) { if (next[i]! > old[i]!) return true; if (next[i]! < old[i]!) return false; }
  return true;
}

async function finishReady(journal: ActivationJournal, readiness: Readiness, ports: ActivationPorts): Promise<ActivationResult> {
  const owner = inspectDaemonOwner(journal.serverDir);
  if (owner.status !== "live" || readiness.hello.instanceId !== owner.owner.token) return recovery(journal, "Ready daemon ownership could not be verified");
  journal.candidateOwner = owner.owner;
  // Pointer only changes after a verified hello. Agent/auth/packages/session files are untouched.
  atomicJson(join(journal.serverDir, POINTER), { version: 1, serverDir: journal.serverDir, agentDir: journal.agentDir, runtime: journal.runtime });
  await ports.ready?.(journal);
  journal.phase = "ready";
  journal.readiness = readiness;
  delete journal.reason;
  clearReservations(journal);
  save(journal);
  return result(journal);
}

/** Only the registered default state's successful activation may update global discovery. */
export function publishReadyRegistration(journal: ActivationJournal): void {
  const registrationHome = process.env.HOME || homedir();
  const registered = registeredRuntime();
  if (!registered && resolve(journal.agentDir) !== join(registrationHome, ".pi", "agent")) return;
  const defaultDir = registered?.defaultServerDir ?? join(journal.agentDir, "server");
  // An explicit different state directory never becomes the global default.
  if (resolve(defaultDir) !== journal.serverDir && (!existsSync(defaultDir) || realpathSync(defaultDir) !== journal.serverDir)) return;
  if (registered && realpathSync(registered.agentDir) !== realpathSync(journal.agentDir)) throw new Error("Registered agent directory changed during activation");
  const launcher = join(journal.serverDir, "managed-pi-server");
  const temp = `${launcher}.${randomUUID()}.tmp`;
  const agentDir = registered?.agentDir ?? journal.agentDir;
  const script = `#!/bin/sh\nexport PI_SERVER_LAUNCHER=${shellQuote(launcher)}\nif [ -z "\${PI_CODING_AGENT_DIR:-}" ]; then export PI_CODING_AGENT_DIR=${shellQuote(agentDir)}; fi\nif [ -z "\${PI_SERVER_DIR:-}" ]; then export PI_SERVER_DIR=${shellQuote(defaultDir)}; fi\nexec ${shellQuote(journal.runtime.node)} ${shellQuote(journal.runtime.entrypoint)} "$@"\n`;
  const fd = openSync(temp, "wx", 0o700);
  try { writeFileSync(fd, script); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, launcher);
  const registrationDir = join(registrationHome, ".pi");
  mkdirSync(registrationDir, { recursive: true, mode: 0o700 });
  atomicJson(join(registrationDir, "remote-server.json"), {
    version: 1, agent: "pi", launcher, agentDir, defaultServerDir: defaultDir,
  });
}

/** Called after claimDaemonOwner and BEFORE constructing a registry or running hooks. */
export function adoptActivation(serverDir: string, operationId: string, build: ServerBuild): void {
  const journal = readActivationJournal(serverDir);
  const owner = inspectDaemonOwner(serverDir);
  if (!journal || journal.rollbackPermit !== undefined || journal.operationId !== operationId || journal.phase !== "starting" || journal.desiredBuild.contentId !== build.contentId
    || owner.status !== "live" || owner.owner.pid !== process.pid) throw new Error("Candidate cannot adopt this activation journal");
  journal.phase = "adopted";
  journal.candidateOwner = owner.owner;
  delete journal.reason;
  save(journal);
}

/** No await is allowed between the final lease check, stop fence, and draining commitment. */
export function commitActivationStop(request: UpgradeRequest, lease: IdleSessionsLease, drain: () => void): void {
  const journal = readActivationJournal(request.serverDir);
  const owner = inspectDaemonOwner(request.serverDir);
  const coordinator = inspectDaemonOwner(request.serverDir, LOCK);
  if (!journal || journal.rollbackPermit !== undefined || journal.operationId !== request.operationId || journal.phase !== "prepared" || !hasActivationReservations(journal)
    || owner.status !== "live" || owner.owner.token !== journal.previousOwner?.token
    || coordinator.status !== "live" || coordinator.owner.token !== journal.coordinator?.token) throw new Error("Activation reservation, coordinator or daemon ownership changed");
  lease.assertIdle();
  // This durable intent precedes irreversible admission fencing. Recovery waits for owner release.
  journal.phase = "stopping";
  delete journal.reason;
  save(journal);
  lease.commitStop();
  drain();
}
