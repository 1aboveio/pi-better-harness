/** Privacy-safe wire contract. Context and identity must be assigned by a trusted adapter. */
export const PERMISSION_RESOURCES = Object.freeze([
  "credential-files", "process-inspection", "project-files", "outside-project-files",
  "runtime-control-files", "command-execution", "network-access", "unknown",
] as const);
export type PermissionResource = typeof PERMISSION_RESOURCES[number];
export interface PermissionBlocker {
  version: 1;
  kind: "permission-blocker";
  context: "worker" | "foreground";
  resource: PermissionResource;
  basis: "policy-refusal" | "os-permission-error" | "agent-reported";
  /** A stable hash or bounded logical identifier, never a command or path. */
  operation: string;
  remoteOutcome: "unknown" | "not-started";
  incidentId?: string;
  runId?: string;
  policySnapshotId?: string;
}
const FIELDS = new Set(["version", "kind", "context", "resource", "basis", "operation", "remoteOutcome", "incidentId", "runId", "policySnapshotId"]);
const LOGICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
// Responses SDK references join call_id and item_id with "|"; these are opaque evidence ids,
// not caller-chosen logical operations. Keep the same bound and exclude paths and prose.
const INCIDENT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:|\-]{0,199}$/;
export function isPermissionResource(value: unknown): value is PermissionResource {
  return typeof value === "string" && (PERMISSION_RESOURCES as readonly string[]).includes(value);
}
/** Pure and strict: no coercion, unknown fields, paths, argv, or free-form prose. */
export function isPermissionBlocker(value: unknown): value is PermissionBlocker {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !FIELDS.has(key))) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || v.kind !== "permission-blocker" || !["worker", "foreground"].includes(v.context as string) ||
    !isPermissionResource(v.resource) || !["policy-refusal", "os-permission-error", "agent-reported"].includes(v.basis as string) ||
    !["unknown", "not-started"].includes(v.remoteOutcome as string) ||
    typeof v.operation !== "string" || v.operation.length > 64 || !LOGICAL_ID.test(v.operation)) return false;
  if (Object.hasOwn(v, "incidentId") && (typeof v.incidentId !== "string" || !INCIDENT_REFERENCE.test(v.incidentId))) return false;
  return ["runId", "policySnapshotId"].every(key => !Object.hasOwn(v, key) ||
    (typeof v[key] === "string" && LOGICAL_ID.test(v[key] as string)));
}
/** Order-independent identity without I/O or a platform-specific crypto dependency. */
export function permissionBlockerKey(blocker: PermissionBlocker): string {
  return JSON.stringify([blocker.version, blocker.kind, blocker.context, blocker.resource, blocker.basis,
    blocker.operation, blocker.remoteOutcome, blocker.incidentId ?? null, blocker.runId ?? null, blocker.policySnapshotId ?? null]);
}
