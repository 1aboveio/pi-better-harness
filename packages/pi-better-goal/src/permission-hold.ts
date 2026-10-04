import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { isPermissionBlocker, permissionBlockerKey, type PermissionBlocker } from "./shared-permission-blocker.js";
import { EXTENSION_NAME } from "./types.js";

export const MAX_PERMISSION_BLOCKERS = 32;
export const MAX_PERMISSION_RECORDS = 128;

export type PermissionRecord =
  | { version: 1; kind: "permission-hold"; goalId: string; blocker: PermissionBlocker; at: number }
  | { version: 1; kind: "permission-release" | "permission-retry-finished" | "permission-gap"; goalId: string; at: number };

export interface PermissionHold {
  blockers: PermissionBlocker[];
  retryPending: boolean;
  recordCount: number;
  saturated: boolean;
}

/** Worker/incident references describe evidence, not authority for a different retry scope. */
export function logicalPermissionBlockerKey(blocker: PermissionBlocker): string {
  return permissionBlockerKey({
    version: 1, kind: "permission-blocker", context: blocker.context, resource: blocker.resource,
    basis: blocker.basis, operation: blocker.operation, remoteOutcome: "unknown",
  });
}

/** Replay only compact goal-owned authority records, independently of progress resets. */
export function currentPermissionHold(ctx: ExtensionContext, goalId: string): PermissionHold {
  const blockers = new Map<string, PermissionBlocker>();
  let retryPending = false;
  let recordCount = 0;
  let saturated = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== EXTENSION_NAME || !entry.data || typeof entry.data !== "object") continue;
    const data = entry.data as Partial<PermissionRecord>;
    // Only attributable authority records can make this goal's retry scope incomplete.
    if (data.goalId !== goalId || (data.kind !== "permission-hold" && data.kind !== "permission-release" &&
        data.kind !== "permission-retry-finished" && data.kind !== "permission-gap")) continue;
    if (data.version !== 1 || typeof data.at !== "number" || !Number.isFinite(data.at) ||
        (data.kind === "permission-hold" && !isPermissionBlocker(data.blocker))) {
      saturated = true;
      retryPending = false;
      recordCount += 1;
      continue;
    }
    if (data.kind === "permission-hold" && isPermissionBlocker(data.blocker)) {
      const key = logicalPermissionBlockerKey(data.blocker);
      if (blockers.has(key) || blockers.size < MAX_PERMISSION_BLOCKERS) blockers.set(key, compactBlocker(data.blocker));
      else saturated = true;
      retryPending = false;
    } else if (data.kind === "permission-release" && blockers.size > 0) {
      retryPending = !saturated;
    } else if (data.kind === "permission-retry-finished") {
      retryPending = false;
    } else if (data.kind === "permission-gap") {
      saturated = true;
      retryPending = false;
    } else continue;
    recordCount += 1;
    // Reserve room to record an incomplete scope and consume an outstanding release.
    if (recordCount >= MAX_PERMISSION_RECORDS - 2) saturated = true;
  }
  return { blockers: [...blockers.values()], retryPending, recordCount, saturated };
}

function compactBlocker(blocker: PermissionBlocker): PermissionBlocker {
  return {
    version: 1, kind: "permission-blocker", context: blocker.context,
    resource: blocker.resource, basis: blocker.basis, operation: blocker.operation, remoteOutcome: blocker.remoteOutcome,
    ...(blocker.incidentId ? { incidentId: blocker.incidentId } : {}),
    ...(blocker.runId ? { runId: blocker.runId } : {}),
    ...(blocker.policySnapshotId ? { policySnapshotId: blocker.policySnapshotId } : {}),
  };
}

function packageName(root: string): unknown {
  try {
    return (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: unknown }).name;
  } catch {
    return undefined;
  }
}

function isSubagentEntry(path: string): boolean {
  const root = dirname(path);
  const name = packageName(root);
  return (name === "pi-better-subagents" || name === "@vanillagreen/pi-better-subagents") &&
    path === realpathSync(join(root, "index.ts"));
}

/** Trust the registered parent producer's canonical entry, never a tool name alone. */
export function isParentBlockerProducer(pi: ExtensionAPI, toolName: string): boolean {
  if (toolName !== "subagent_result" && toolName !== "subagent_output") return false;
  try {
    const source = pi.getAllTools().find((tool) => tool.name === toolName)?.sourceInfo.path;
    if (!source) return false;
    const path = realpathSync(source);
    if (isSubagentEntry(path)) return true;
    const root = dirname(dirname(dirname(path)));
    if (packageName(root) !== "pi-better-harness" || path !== join(root, "extensions/subagents/index.ts")) return false;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      pi?: { extensions?: unknown }; dependencies?: Record<string, unknown>; bundledDependencies?: unknown;
    };
    if (!Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes("extensions/subagents/index.ts") ||
        typeof manifest.dependencies?.["pi-better-subagents"] !== "string" ||
        !Array.isArray(manifest.bundledDependencies) || !manifest.bundledDependencies.includes("pi-better-subagents")) return false;
    // The SDK attributes tools to the loaded wrapper. Admit only the shipped literal shim, not arbitrary imports.
    if (readFileSync(path, "utf8").trim() !== 'export { default } from "../../node_modules/pi-better-subagents/index.ts";') return false;
    return isSubagentEntry(realpathSync(join(root, "node_modules/pi-better-subagents/index.ts")));
  } catch {
    return false;
  }
}

/** The parent emits actionable open reports; child errors/prose are not this contract. */
export function reportedPermissionBlockers(pi: ExtensionAPI, toolName: string, details: unknown): PermissionBlocker[] {
  if (!isParentBlockerProducer(pi, toolName) || !details || typeof details !== "object") return [];
  const reports = (details as { permissionBlockers?: unknown }).permissionBlockers;
  if (!Array.isArray(reports) || reports.length > MAX_PERMISSION_BLOCKERS) return [];
  // Reject a malformed batch whole rather than accidentally widening a partial retry scope.
  if (!reports.every((report) => isPermissionBlocker(report) && report.context === "worker")) return [];
  return reports.map(compactBlocker);
}

export function reportedPermissionGap(pi: ExtensionAPI, toolName: string, details: unknown): boolean {
  if (!isParentBlockerProducer(pi, toolName) || !details || typeof details !== "object") return false;
  const omitted = (details as { permissionBlockersOmitted?: unknown }).permissionBlockersOmitted;
  return typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted > 0;
}

export function permissionRecord(goalId: string, kind: "permission-release" | "permission-retry-finished" | "permission-gap"): PermissionRecord {
  return { version: 1, kind, goalId, at: Math.floor(Date.now() / 1000) };
}

export function permissionHoldRecord(goalId: string, blocker: PermissionBlocker): PermissionRecord {
  return { version: 1, kind: "permission-hold", goalId, blocker: compactBlocker(blocker), at: Math.floor(Date.now() / 1000) };
}

export function permissionInstruction(hold: PermissionHold): string {
  return [
    hold.retryPending
      ? "The human explicitly released ONE bounded retry of the held operation and scope below. This is not a permission grant or evidence of success."
      : "The goal is paused for a permission blocker. Answer ordinary questions, but do not advance goal or workflow work. Only /goal resume or alt+g releases one bounded retry; goal_resume cannot release it.",
    ...hold.blockers.map((blocker) => `- ${blocker.context}: ${blocker.resource}; operation=${blocker.operation}; basis=${blocker.basis}; remoteOutcome=${blocker.remoteOutcome}` +
      (blocker.runId ? `; runId=${blocker.runId}` : "") + (blocker.policySnapshotId ? `; policySnapshotId=${blocker.policySnapshotId}` : "")),
    "Keep the same operation and scope. Do not switch to foreground execution, copy credentials, change authentication, or broaden permissions. Changed worker settings require a fresh worker; retain the logical operation identity. Runtime-observed refusals and agent-reported blockers are distinct. Unknown remote outcome is never evidence of success.",
  ].join("\n");
}
