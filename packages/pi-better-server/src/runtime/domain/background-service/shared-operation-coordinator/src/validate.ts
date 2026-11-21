// Generated from packages/operation-coordinator/src/validate.ts. Do not edit directly.
/**
 * Input validation for the coordinator store.
 *
 * Two rules matter for durability:
 *
 * 1. Every stored string is bounded and single-line, so one record cannot grow
 *    without limit or smuggle structured data into a column that is read back.
 * 2. Credential material is refused instead of stored. The API has no field for
 *    a token, key or environment value; these checks close the free-text and
 *    reference channels (`continuationNote`, `reason`, `summary`, `authorityRef`)
 *    that a caller could otherwise use to persist a secret.
 */
import { isAbsolute } from "node:path";
import { StoreError } from "./errors.ts";
import type { EvidenceKind, OwnerIdentity, OwnerKind } from "./types.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,199}$/;
const ID_LIMITS: Record<string, number> = {
    operationId: 200,
    taskId: 200,
    launchToken: 200,
    sessionId: 200,
    branchId: 200,
    goalId: 200,
    waitId: 200,
    claimId: 200,
    claimToken: 200,
    eventId: 200,
    attemptId: 200,
    checkpointId: 200,
    writerLeaseId: 200,
    hostId: 200,
    runnerId: 200,
    processStartToken: 200,
    ownerId: 200,
    reservedCheckpointId: 200,
};

const TEXT_LIMITS = {
    workspace: 1024,
    ref: 1024,
    continuationNote: 8192,
    note: 8192,
    reason: 1024,
    summary: 2048,
    observerField: 200,
    authorityRef: 512,
    intentRef: 200,
} as const;

const OWNER_KINDS: readonly OwnerKind[] = ["parent-session", "worker-conversation"];
const EVIDENCE_KINDS: readonly EvidenceKind[] = [
    "terminal-record",
    "log",
    "summary",
    "artifact",
];
const IDENTIFIER_FIELD = /^[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * High-confidence secret shapes. Prose notes stay usable; only material that is
 * unambiguously a credential is refused, with the field named in the message.
 */
const SECRET_PATTERNS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
    { label: "a private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
    { label: "a bearer token", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
    { label: "a provider api key", pattern: /\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[abp])[-_][A-Za-z0-9_-]{12,}/ },
    { label: "an AWS access key id", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
    { label: "a JSON web token", pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./ },
    {
        label: "an environment assignment",
        // Only a name that actually denotes credential material. Generic
        // `NAME=value` evidence (for example `HTTP_STATUS=500`) stays usable.
        pattern: /(?:^|[\s;,(])(?:[A-Za-z0-9]+[_-])*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH[_-]?KEY|SIGNING[_-]?KEY|ENCRYPTION[_-]?KEY)(?:[_-][A-Za-z0-9]+)*\s*[=:]\s*\S+/i,
    },
    {
        label: "a credential file path",
        pattern: /(?:^|[\s"'(])(?:\.ssh\/id_[a-z0-9]+|\.aws\/credentials|\.netrc|\.npmrc|id_rsa\b)/i,
    },
];

function fail(field: string, detail: string): never {
    throw new StoreError("validation", `Invalid ${field}: ${detail}`);
}

function assertPlainString(field: string, value: unknown, max: number): string {
    if (typeof value !== "string") fail(field, "must be a string");
    if (value.length === 0) fail(field, "must not be empty");
    if (value.length > max) fail(field, `must be at most ${max} characters`);
    // Control characters would corrupt a single-line record and hide content.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) fail(field, "must be a single line without control characters");
    for (const { label, pattern } of SECRET_PATTERNS) {
        if (pattern.test(value)) fail(field, `must not contain ${label}`);
    }
    return value;
}

/** Bounded, single-line, secret-free text for notes, reasons and summaries. */
export function requireText(field: string, value: unknown, max: number): string {
    return assertPlainString(field, value, max).trim();
}

/** Optional free text: `undefined`, `null` and `""` are recorded as null. */
export function optionalText(field: string, value: unknown, max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") fail(field, "must be a string");
    if (value.trim() === "") return null;
    return assertPlainString(field, value, max).trim();
}

/** Identifier-shaped string (session ids, task ids, operation ids, tokens). */
export function requireId(field: string, value: unknown): string {
    if (typeof value !== "string") fail(field, "must be a string");
    if (!ID_PATTERN.test(value)) {
        fail(
            field,
            "must start with a letter or digit and contain only letters, digits, and . _ : @ / + -",
        );
    }
    const max = ID_LIMITS[field] ?? 200;
    if (value.length > max) fail(field, `must be at most ${max} characters`);
    for (const { label, pattern } of SECRET_PATTERNS) {
        if (pattern.test(value)) fail(field, `must not contain ${label}`);
    }
    return value;
}

/** Filesystem path for the store itself. Absolute or `:memory:`. */
export function requirePath(field: string, value: unknown): string {
    if (typeof value !== "string") fail(field, "must be a string");
    if (value === ":memory:") return value;
    if (value.trim() === "") fail(field, "must not be empty");
    if (value.length > 4096) fail(field, "must be at most 4096 characters");
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(value)) fail(field, "must not contain control characters");
    for (const { label, pattern } of SECRET_PATTERNS) {
        if (pattern.test(value)) fail(field, `must not contain ${label}`);
    }
    return value;
}

/** Workspace binding: an absolute path that may contain spaces. */
export function requireWorkspace(value: unknown): string {
    const workspace = assertPlainString("owner.workspace", value, TEXT_LIMITS.workspace).trim();
    // Platform-aware: a Windows workspace is "C:\...", which never starts with "/".
    if (!isAbsolute(workspace)) fail("owner.workspace", "must be an absolute path");
    return workspace;
}

export function requireOwnerKind(field: string, value: unknown): OwnerKind {
    if (!OWNER_KINDS.includes(value as OwnerKind)) {
        fail(field, `must be one of ${OWNER_KINDS.join(", ")}`);
    }
    return value as OwnerKind;
}

export function requireEvidenceKind(field: string, value: unknown): EvidenceKind {
    if (!EVIDENCE_KINDS.includes(value as EvidenceKind)) {
        fail(field, `must be one of ${EVIDENCE_KINDS.join(", ")}`);
    }
    return value as EvidenceKind;
}

export function requireEnum<T extends string>(
    field: string,
    value: unknown,
    allowed: readonly T[],
): T {
    if (!allowed.includes(value as T)) fail(field, `must be one of ${allowed.join(", ")}`);
    return value as T;
}

/** Counters are non-negative integers; SQLite stores them as INTEGER. */
export function requireCounter(field: string, value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        fail(field, "must be a non-negative integer");
    }
    return value;
}

export function requireOptionalCounter(field: string, value: unknown): number | null {
    if (value === undefined || value === null) return null;
    return requireCounter(field, value);
}

export function requireBoolean(field: string, value: unknown): boolean {
    if (typeof value !== "boolean") fail(field, "must be a boolean");
    return value;
}

/** Normalised owner identity. Branch and goal bindings are optional but stable. */
export function normalizeOwner(field: string, value: unknown): OwnerIdentity {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(field, "must be an object");
    }
    const owner = value as Partial<OwnerIdentity>;
    return {
        kind: requireOwnerKind(`${field}.kind`, owner.kind),
        sessionId: requireId(`${field}.sessionId`, owner.sessionId),
        workspace: requireWorkspace(owner.workspace),
        branchId: owner.branchId === undefined || owner.branchId === null
            ? null
            : requireId(`${field}.branchId`, owner.branchId),
        goalId: owner.goalId === undefined || owner.goalId === null
            ? null
            : requireId(`${field}.goalId`, owner.goalId),
    };
}

export function requireObserver(field: string, value: unknown): { kind: string; version: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail(field, "must be an object with kind and version");
    }
    const observer = value as { kind?: unknown; version?: unknown };
    const kind = requireText(`${field}.kind`, observer.kind, TEXT_LIMITS.observerField);
    const version = requireText(`${field}.version`, observer.version, TEXT_LIMITS.observerField);
    if (!IDENTIFIER_FIELD.test(kind)) fail(`${field}.kind`, "must be an identifier");
    return { kind, version };
}

/** Stable key for one owner identity; the wait uniqueness index uses the same parts. */
export function ownerKey(owner: OwnerIdentity): string {
    return [owner.kind, owner.sessionId, owner.branchId ?? ""].join("\u0000");
}

/** Full identity comparison, including the workspace and goal bindings. */
export function sameOwner(a: OwnerIdentity, b: OwnerIdentity): boolean {
    return a.kind === b.kind
        && a.sessionId === b.sessionId
        && a.workspace === b.workspace
        && (a.branchId ?? null) === (b.branchId ?? null)
        && (a.goalId ?? null) === (b.goalId ?? null);
}

export function describeOwnerDiff(a: OwnerIdentity, b: OwnerIdentity): string {
    const fields: Array<keyof OwnerIdentity> = ["kind", "sessionId", "workspace", "branchId", "goalId"];
    const differing = fields.filter((field) => (a[field] ?? null) !== (b[field] ?? null));
    return differing.length === 0 ? "none" : differing.join(", ");
}
