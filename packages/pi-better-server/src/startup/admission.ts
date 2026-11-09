import { existsSync, realpathSync } from "node:fs";
import { inspectDaemonOwner } from "../daemon-owner.ts";
import { stable, validateBuild, validateStaged } from "../../scripts/private-runtime/format.ts";
import {
  adoptActivation, checkPreAdoptionRollbackPermit, consumePreAdoptionRollbackPermit,
  readActivationJournal, readActiveRuntime,
} from "./activation.ts";
import type { ServerBuild } from "./managed-types.ts";

export type StartupIntent =
  | { kind: "ordinary" }
  | { kind: "activation"; operationId: string }
  | { kind: "pre-adoption-rollback"; operationId: string; permitToken: string };

export interface StartupRequest {
  canonicalServerDir: string;
  agentDir: string;
  /** The executing runtime's readOwnBuild identity; ensure preflights the selected runtime. */
  build: ServerBuild | undefined;
  intent: StartupIntent;
}

function refuse(reason: string): never { throw new Error(`Startup admission: ${reason}`); }
function sameBuild(a: ServerBuild | undefined, b: ServerBuild | undefined): boolean {
  return !!a && !!b && stable(validateBuild(a)) === stable(validateBuild(b));
}

/** Only direct daemon launches interpret these variables. Ordinary ensure never does. */
export function startupIntentFromEnv(env: NodeJS.ProcessEnv): StartupIntent {
  const activation = env.PI_SERVER_ACTIVATION_ID;
  const rollback = env.PI_SERVER_ROLLBACK_OPERATION_ID;
  const permit = env.PI_SERVER_ROLLBACK_PERMIT;
  if (rollback !== undefined || permit !== undefined) {
    if (!rollback || !permit || activation !== undefined) return refuse("conflicting or incomplete startup intent");
    return { kind: "pre-adoption-rollback", operationId: rollback, permitToken: permit };
  }
  if (activation !== undefined) {
    if (!activation) return refuse("empty activation operation");
    return { kind: "activation", operationId: activation };
  }
  return { kind: "ordinary" };
}

/** Read-only. A successful preflight is never a permit: the child must read disk again. */
export function checkStartupAdmission(request: StartupRequest): void {
  try { check(request); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("Startup admission:")) throw error;
    refuse(`invalid startup state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function check(request: StartupRequest): void {
  const { canonicalServerDir: serverDir, agentDir, build, intent } = request;
  if (existsSync(serverDir) && realpathSync(serverDir) !== serverDir) refuse("server directory must be canonical");
  const journal = readActivationJournal(serverDir);
  const active = readActiveRuntime(serverDir);
  const owner = inspectDaemonOwner(serverDir);
  const coordinator = inspectDaemonOwner(serverDir, "activation-owner");
  if (owner.status === "ambiguous" || coordinator.status === "ambiguous") refuse("ownership is ambiguous");
  if (!journal) {
    if (active || coordinator.status !== "missing") refuse("managed namespace has no activation journal");
    if (intent.kind !== "ordinary") refuse("startup intent has no activation journal");
    return; // Preserve fresh and legacy unmanaged startup.
  }
  validateStaged(journal.runtime);
  if (!sameBuild(journal.desiredBuild, journal.runtime.build)) refuse("journal runtime identity differs from desired build");
  if (realpathSync(agentDir) !== journal.agentDir || realpathSync(journal.agentDir) !== journal.agentDir) refuse("agent directory differs from activation journal");
  if (active) validateStaged(active);
  if (!build) refuse("managed namespace requires an executing build identity");
  validateBuild(build);
  if (journal.phase === "adopted" || journal.phase === "recovery-required") refuse(`${journal.phase} forbids any new registry writer`);
  if (intent.kind === "ordinary") {
    if (journal.phase !== "ready") refuse(`${journal.phase} forbids ordinary startup`);
    if (!sameBuild(build, journal.desiredBuild) || !sameBuild(build, active?.build)) refuse("ready journal, active pointer and executing build must match");
    return;
  }
  if (intent.kind === "pre-adoption-rollback") {
    checkPreAdoptionRollbackPermit({ serverDir, agentDir, build, operationId: intent.operationId, permitToken: intent.permitToken });
    return;
  }
  if (journal.phase !== "starting" || journal.operationId !== intent.operationId || !sameBuild(build, journal.desiredBuild)
    || journal.candidateOwner || journal.rollbackPermit !== undefined) refuse("candidate does not match an unadopted starting activation");
  if (coordinator.status !== "live" || stable(coordinator.owner) !== stable(journal.coordinator)) refuse("activation coordinator identity changed or is not live");
}

/** After claimDaemonOwner and the last awaited socket probe, immediately before SessionRegistry. */
export function admitDaemonStartup(request: StartupRequest): void {
  checkStartupAdmission(request);
  const owner = inspectDaemonOwner(request.canonicalServerDir);
  if (owner.status !== "live" || owner.owner.pid !== process.pid) refuse("daemon must hold its own exclusive owner claim");
  if (request.intent.kind === "activation") {
    adoptActivation(request.canonicalServerDir, request.intent.operationId, request.build!);
  } else if (request.intent.kind === "pre-adoption-rollback") {
    consumePreAdoptionRollbackPermit({ serverDir: request.canonicalServerDir, agentDir: request.agentDir, build: request.build!,
      operationId: request.intent.operationId, permitToken: request.intent.permitToken });
  }
}
