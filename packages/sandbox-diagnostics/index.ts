import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync,
} from "node:fs";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { harnessSettingsPath, readHarnessSetting, updateHarnessSetting } from "../harness-settings/index.ts";
import { isPermissionResource, type PermissionResource } from "../failure-observations/permission-blocker.ts";

export type DiagnosticResource = PermissionResource | "tool-admission" | "sandbox-backend";
export type DiagnosticContext = "foreground" | "worker" | "background";
type Basis = "policy-refusal" | "os-permission-error" | "agent-reported";
export interface DiagnosticsSeams { agentDir?: () => string }
export interface DiagnosticObservation {
  tool: string; operation: unknown; resource: DiagnosticResource; basis: Basis;
  outcome: "denied" | "succeeded";
}
/** Redacted transport only: a worker log is never policy authority. */
export interface DiagnosticReport {
  schema: 1; type: "sandbox_diagnostic_report"; tool: string; resource: DiagnosticResource;
  version: string; platform: string; backend: string;
  outcome: "denied" | "succeeded";
  operationFingerprint: string; policyFingerprint: string; idFingerprint: string;
}
export interface DiagnosticRecord {
  schema: 1; timestamp: number; version: string; platform: string; backend: string;
  tool: string; resource: DiagnosticResource; basis: Basis; outcome: "denied" | "succeeded";
  context: DiagnosticContext; operationFingerprint: string; policyFingerprint: string;
  fingerprint: string; recoveryOf?: string;
}
export interface DiagnosticLosses { age: number; count: number; bytes: number; malformed: number; tampered: number }
export type DiagnosticIssue = "retention-loss" | "malformed-data" | "tampered-data" | "unsafe-storage" | "unavailable";
export interface DiagnosticsData {
  schema: 1; enabled: boolean; records: DiagnosticRecord[]; losses: DiagnosticLosses; issues: DiagnosticIssue[];
}
export interface DiagnosticGroup {
  version: string; backend: string; tool: string; resource: DiagnosticResource; basis: Basis;
  policyFingerprint: string; denied: number; succeeded: number;
}
export interface DiagnosticsAnalysis {
  groups: DiagnosticGroup[]; observedOperations: number; recovered: number; outstanding: number;
}

const MAX_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const TOOLS = new Set([
  "read", "write", "edit", "bash", "grep", "find", "ls", "process_list", "powershell", "remote_bash",
  "subagent", "subagent_spawn", "subagent_spawn_batch", "bg_task", "bg_status", "bg_task_spawn", "bg_task_watch",
  "apply_patch", "failure_disposition", "extension-tool",
]);
const BACKENDS = new Set(["macos-seatbelt", "linux-bubblewrap", "unknown", "unavailable"]);
const PLATFORMS = new Set(["aix", "android", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "unknown"]);
const CONTEXTS = new Set(["foreground", "worker", "background"]);
const BASES = new Set(["policy-refusal", "os-permission-error", "agent-reported"]);
// Do not accept arbitrary prerelease/build labels: they can contain paths or caller IDs.
const VERSION = /^\d{1,6}(?:\.\d{1,6}){0,2}(?:-(?:alpha|beta|rc)(?:\.\d{1,6})?)?$/;
const FP = /^[A-Za-z0-9_-]{43}$/;
const REPORT_FIELDS = ["schema", "type", "tool", "resource", "version", "platform", "backend", "outcome", "operationFingerprint", "policyFingerprint", "idFingerprint"];
const RECORD_FIELDS = ["schema", "timestamp", "version", "platform", "backend", "tool", "resource", "basis", "outcome", "context", "operationFingerprint", "policyFingerprint", "fingerprint", "recoveryOf"];
const LOSS_FIELDS = ["age", "count", "bytes", "malformed", "tampered"] as const;

class UnsafeStorage extends Error { constructor() { super("Unsafe diagnostics storage."); } }
const emptyLosses = (): DiagnosticLosses => ({ age: 0, count: 0, bytes: 0, malformed: 0, tampered: 0 });
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT";
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function fields(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key));
}
function resource(value: unknown): value is DiagnosticResource {
  return isPermissionResource(value) || value === "tool-admission" || value === "sandbox-backend";
}
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function digest(key: Buffer, domain: string, value: string): string {
  return createHmac("sha256", key).update(domain).update("\0").update(value).digest("base64url");
}
function authentic(key: Buffer, domain: string, value: string, mac: unknown): boolean {
  return typeof mac === "string" && FP.test(mac) && timingSafeEqual(Buffer.from(mac), Buffer.from(digest(key, domain, value)));
}

// Canonicalize only data, without invoking getters/toJSON or persisting any of it.
function identity(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 32) throw new Error("Diagnostics identity is too large.");
    if (v === undefined) return ["undefined"];
    if (v === null || typeof v === "boolean" || typeof v === "string") return [typeof v, v];
    if (typeof v === "number" && Number.isFinite(v)) return ["number", v];
    if (!Array.isArray(v) && !plain(v)) throw new Error("Unsupported diagnostics identity.");
    if (seen.has(v as object)) throw new Error("Cyclic diagnostics identity.");
    seen.add(v as object);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(v as object).some(k => typeof k !== "string")) throw new Error("Unsupported diagnostics identity.");
    const keys = Object.keys(descriptors).filter(k => !(Array.isArray(v) && k === "length")).sort();
    const result = [Array.isArray(v) ? "array" : "object", Array.isArray(v) ? v.length : null, keys.map(k => {
      const d = descriptors[k];
      if (!d || !Object.hasOwn(d, "value")) throw new Error("Unsupported diagnostics identity.");
      return [k, visit(d.value, depth + 1)];
    })];
    seen.delete(v as object);
    return result;
  }
  const result = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(result) > MAX_BYTES) throw new Error("Diagnostics identity is too large.");
  return result;
}

export function diagnosticsEnabled(seams: DiagnosticsSeams = {}): boolean {
  const value = readHarnessSetting("sandboxDiagnostics", seams);
  return fields(value, ["version", "enabled"]) && value.version === 1 && value.enabled === true;
}
export function diagnosticPackageVersion(manifest: URL): string {
  try {
    const value: unknown = JSON.parse(readFileSync(manifest, "utf8"));
    return plain(value) && typeof value.version === "string" && VERSION.test(value.version) ? value.version : "unknown";
  } catch { return "unknown"; }
}
// Settings are atomically replaced by the parent. Workers must not acquire a writable settings lock.
function relayEnabled(seams: DiagnosticsSeams): boolean {
  let settings: unknown;
  try { settings = JSON.parse(readFileSync(harnessSettingsPath(seams), "utf8")); }
  catch (error) { if (missing(error)) return false; throw error; }
  if (!plain(settings) || (Object.hasOwn(settings, "piBetterHarness") && !plain(settings.piBetterHarness))) {
    throw new Error("Invalid diagnostics settings.");
  }
  const value = (settings.piBetterHarness as Record<string, unknown> | undefined)?.sandboxDiagnostics;
  return fields(value, ["version", "enabled"]) && value.version === 1 && value.enabled === true;
}
export function isDiagnosticReport(value: unknown): value is DiagnosticReport {
  if (!fields(value, REPORT_FIELDS) || Reflect.ownKeys(value).length !== REPORT_FIELDS.length ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, "value"))) return false;
  return value.schema === 1 && value.type === "sandbox_diagnostic_report" && TOOLS.has(value.tool as string) &&
    typeof value.version === "string" && (VERSION.test(value.version) || value.version === "unknown") &&
    PLATFORMS.has(value.platform as string) && BACKENDS.has(value.backend as string) &&
    resource(value.resource) && ["denied", "succeeded"].includes(value.outcome as string) &&
    [value.operationFingerprint, value.policyFingerprint, value.idFingerprint].every(f => typeof f === "string" && FP.test(f));
}
export function setDiagnosticsEnabled(enabled: boolean, seams: DiagnosticsSeams = {}): void {
  if (typeof enabled !== "boolean") throw new TypeError("Diagnostics enabled must be boolean.");
  updateHarnessSetting("sandboxDiagnostics", () => ({ version: 1, enabled }), seams);
}

function stat(path: string) {
  try { return lstatSync(path); } catch (error) { if (missing(error)) return undefined; throw error; }
}
function safeFile(path: string): void {
  const s = stat(path);
  if (s && (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)) throw new UnsafeStorage();
}
function directory(seams: DiagnosticsSeams, create: boolean): string | undefined {
  let root = (seams.agentDir ?? getAgentDir)();
  if (create && !stat(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
  const s = stat(root);
  if (!s) return undefined;
  if (!s.isDirectory() || s.isSymbolicLink()) throw new UnsafeStorage();
  root = realpathSync(root);
  for (const component of ["diagnostics", "sandbox"]) {
    root = join(root, component);
    if (create && !stat(root)) {
      try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const entry = stat(root);
    if (!entry) return undefined;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new UnsafeStorage();
    if (create) chmodSync(root, 0o700);
  }
  return root;
}
function readSafe(path: string, bound: number): string {
  safeFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1) throw new UnsafeStorage();
    if (s.size > bound) throw new Error("Diagnostics file exceeds its bound.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function atomic(path: string, contents: string): void {
  safeFile(path);
  const pending = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  try {
    writeFileSync(pending, contents, { mode: 0o600, flag: "wx" });
    safeFile(path);
    renameSync(pending, path);
  } finally { rmSync(pending, { force: true }); }
}
function locked<T>(dir: string, action: () => T): T {
  const path = join(dir, "events.jsonl");
  const lockPath = `${path}.lock`;
  for (let attempt = 0; attempt < 500; attempt++) {
    // A stopped synchronous writer cannot renew a lease. Never evict by age:
    // an orphan blocks sampling until the human removes it with collectors stopped.
    try { mkdirSync(lockPath, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const s = stat(lockPath);
      if (s && (!s.isDirectory() || s.isSymbolicLink())) throw new UnsafeStorage();
      if (attempt === 499) throw Object.assign(new Error("Diagnostics storage is locked."), { code: "ELOCKED" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      continue;
    }
    try {
      const lock = lstatSync(lockPath);
      if (!lock.isDirectory() || lock.isSymbolicLink()) throw new UnsafeStorage();
      for (const name of ["events.jsonl", "installation.key", "export.json"]) safeFile(join(dir, name));
      return action();
    } finally { rmdirSync(lockPath); }
  }
  throw new Error("Cannot lock diagnostics.");
}
function installationKey(dir: string, create: boolean): Buffer {
  const path = join(dir, "installation.key");
  safeFile(path);
  if (!stat(path)) {
    if (!create || stat(join(dir, "events.jsonl"))) throw new Error("Missing diagnostics installation key.");
    atomic(path, `${randomBytes(32).toString("hex")}\n`);
  }
  const raw = readSafe(path, 65);
  if (!/^[a-f0-9]{64}\n$/.test(raw)) throw new Error("Invalid diagnostics installation key.");
  chmodSync(path, 0o600);
  return Buffer.from(raw.trim(), "hex");
}
function selectRecord(v: Record<string, unknown>): DiagnosticRecord | undefined {
  if (!fields(v, [...RECORD_FIELDS, "mac"]) || v.schema !== 1 || !integer(v.timestamp) ||
    typeof v.version !== "string" || !(VERSION.test(v.version) || v.version === "unknown") ||
    !PLATFORMS.has(v.platform as string) || !BACKENDS.has(v.backend as string) || !TOOLS.has(v.tool as string) ||
    !resource(v.resource) || !BASES.has(v.basis as string) || !CONTEXTS.has(v.context as string) ||
    !["denied", "succeeded"].includes(v.outcome as string) ||
    ![v.operationFingerprint, v.policyFingerprint, v.fingerprint].every(f => typeof f === "string" && FP.test(f)) ||
    (v.outcome === "denied" ? Object.hasOwn(v, "recoveryOf") : typeof v.recoveryOf !== "string" || !FP.test(v.recoveryOf))) return undefined;
  const record: DiagnosticRecord = {
    schema: 1, timestamp: v.timestamp, version: v.version, platform: v.platform as string,
    backend: v.backend as string, tool: v.tool as string, resource: v.resource,
    basis: v.basis as Basis, outcome: v.outcome as DiagnosticRecord["outcome"], context: v.context as DiagnosticContext,
    operationFingerprint: v.operationFingerprint as string, policyFingerprint: v.policyFingerprint as string, fingerprint: v.fingerprint as string,
  };
  if (record.outcome === "succeeded") record.recoveryOf = v.recoveryOf as string;
  return record;
}
function sameOperation(a: DiagnosticRecord, b: DiagnosticRecord): boolean {
  return a.context === b.context && a.tool === b.tool && a.operationFingerprint === b.operationFingerprint;
}
interface Journal { records: DiagnosticRecord[]; losses: DiagnosticLosses }
function load(dir: string, key: Buffer): Journal {
  const path = join(dir, "events.jsonl");
  if (!stat(path)) return { records: [], losses: emptyLosses() };
  chmodSync(path, 0o600);
  const raw = readSafe(path, MAX_BYTES);
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const first = lines.shift();
  const losses = emptyLosses();
  let header: Record<string, unknown> | undefined;
  try {
    const v: unknown = JSON.parse(first ?? "");
    const candidateLosses = plain(v) ? v.losses : undefined;
    if (fields(v, ["schema", "kind", "losses", "count", "digest", "mac"]) && v.schema === 1 && v.kind === "journal" &&
      fields(candidateLosses, LOSS_FIELDS) && LOSS_FIELDS.every(k => integer(candidateLosses[k])) && integer(v.count) &&
      typeof v.digest === "string" && FP.test(v.digest)) {
      const l = candidateLosses;
      const selected = { schema: 1, kind: "journal", losses: { age: l.age, count: l.count, bytes: l.bytes, malformed: l.malformed, tampered: l.tampered }, count: v.count, digest: v.digest };
      if (authentic(key, "header", JSON.stringify(selected), v.mac)) {
        header = v;
        for (const k of LOSS_FIELDS) losses[k] = l[k] as number;
      } else losses.tampered++;
    } else losses.malformed++;
  } catch { losses.malformed++; }
  if (header && (header.count !== lines.length || header.digest !== digest(key, "journal", lines.join("\n")))) losses.tampered++;
  const records: DiagnosticRecord[] = [];
  const seen = new Set<string>();
  const denied = new Map<string, DiagnosticRecord>();
  for (const line of lines) {
    let v: unknown;
    try { v = JSON.parse(line); } catch { losses.malformed++; continue; }
    const record = plain(v) ? selectRecord(v) : undefined;
    if (!record) { losses.malformed++; continue; }
    if (!authentic(key, "event", JSON.stringify(record), (v as Record<string, unknown>).mac) || seen.has(record.fingerprint)) {
      losses.tampered++; continue;
    }
    if (record.outcome === "succeeded") {
      const prior = denied.get(record.recoveryOf!);
      if (!prior || !sameOperation(prior, record) || prior.timestamp > record.timestamp) { losses.tampered++; continue; }
      denied.delete(prior.fingerprint);
    } else denied.set(record.fingerprint, record);
    seen.add(record.fingerprint);
    records.push(record);
  }
  return { records, losses };
}
function encode(journal: Journal, key: Buffer): string {
  const lines = journal.records.map(record => JSON.stringify({ ...record, mac: digest(key, "event", JSON.stringify(record)) }));
  const header = { schema: 1, kind: "journal", losses: journal.losses, count: lines.length, digest: digest(key, "journal", lines.join("\n")) };
  return `${JSON.stringify({ ...header, mac: digest(key, "header", JSON.stringify(header)) })}\n${lines.length ? `${lines.join("\n")}\n` : ""}`;
}
function retain(journal: Journal, key: Buffer, now: number): boolean {
  let changed = false;
  function remove(index: number, reason: "age" | "count" | "bytes") {
    const [removed] = journal.records.splice(index, 1);
    if (!removed) return;
    journal.losses[reason]++;
    // Recovery cannot outlive its evidence; count both discarded records.
    if (removed.outcome === "denied") {
      const recovery = journal.records.findIndex(r => r.recoveryOf === removed.fingerprint);
      if (recovery !== -1) { journal.records.splice(recovery, 1); journal.losses[reason]++; }
    }
    changed = true;
  }
  for (let i = 0; i < journal.records.length;) {
    if (journal.records[i]!.timestamp < now - MAX_AGE) remove(i, "age"); else i++;
  }
  while (journal.records.length > MAX_ENTRIES) remove(0, "count");
  // The full signed header and UTF-8 newlines count towards the byte limit.
  while (Buffer.byteLength(encode(journal, key)) > MAX_BYTES && journal.records.length) remove(0, "bytes");
  return changed;
}
function issues(losses: DiagnosticLosses): DiagnosticIssue[] {
  const result: DiagnosticIssue[] = [];
  if (losses.age || losses.count || losses.bytes) result.push("retention-loss");
  if (losses.malformed) result.push("malformed-data");
  if (losses.tampered) result.push("tampered-data");
  return result;
}

export class SandboxDiagnostics {
  constructor(private readonly options: {
    context: DiagnosticContext; version: string; policy: () => unknown; backend: () => string | undefined;
    agentDir?: () => string; onError?: (error: unknown) => void; now?: () => number;
    relay?: (report: DiagnosticReport) => void;
  }) {}
  private relayKey?: Buffer;
  private readonly pending = new Map<string, DiagnosticResource>();
  private report(error: unknown): void { try { this.options.onError?.(error); } catch { /* Diagnostics never change tool outcomes. */ } }
  observe(input: DiagnosticObservation): void {
    this.collect(input);
  }
  /** Caller must gate this on parent-authored task runtime provenance, not a claim in the log. */
  observeReport(value: unknown, runIdentity: string): void {
    try {
      if (!isDiagnosticReport(value) || typeof runIdentity !== "string" || !runIdentity || this.options.context !== "worker" || this.options.relay) return;
      this.collect({ tool: value.tool, resource: value.resource, basis: "agent-reported", outcome: value.outcome,
        operation: { run: runIdentity, fingerprint: value.operationFingerprint } }, { value, runIdentity });
    } catch { this.report(new Error("Diagnostics collection has gaps.")); }
  }
  private emit(input: DiagnosticObservation, tool: string, operation: string): void {
    const key = this.relayKey ??= randomBytes(32);
    const operationFingerprint = digest(key, "operation", operation);
    const prior = this.pending.get(operationFingerprint);
    if (input.outcome === "succeeded" && !prior) return;
    const backend = this.options.backend();
    const report: DiagnosticReport = {
      schema: 1, type: "sandbox_diagnostic_report", tool, resource: prior && input.outcome === "succeeded" ? prior : input.resource,
      version: typeof this.options.version === "string" && VERSION.test(this.options.version) ? this.options.version : "unknown",
      platform: PLATFORMS.has(process.platform) ? process.platform : "unknown",
      backend: typeof backend === "string" && BACKENDS.has(backend) ? backend : "unknown",
      outcome: input.outcome, operationFingerprint, policyFingerprint: digest(key, "policy", identity(this.options.policy())),
      idFingerprint: digest(key, "report-identity", randomBytes(32).toString("hex")),
    };
    this.options.relay!(report);
    if (input.outcome === "succeeded") this.pending.delete(operationFingerprint);
    else {
      this.pending.delete(operationFingerprint);
      this.pending.set(operationFingerprint, input.resource);
      while (this.pending.size > MAX_ENTRIES) this.pending.delete(this.pending.keys().next().value!);
    }
  }
  private collect(input: DiagnosticObservation, imported?: { value: DiagnosticReport; runIdentity: string }): void {
    try {
      if (!(this.options.relay ? relayEnabled(this.options) : diagnosticsEnabled(this.options))) return;
      if (!CONTEXTS.has(this.options.context) || !resource(input.resource) || !BASES.has(input.basis) ||
        !["denied", "succeeded"].includes(input.outcome)) throw new Error("Invalid diagnostic observation.");
      const now = (this.options.now ?? Date.now)();
      if (!integer(now)) throw new Error("Invalid diagnostics clock.");
      const tool = TOOLS.has(input.tool) ? input.tool : "extension-tool";
      const operation = identity({ tool: input.tool, input: input.operation });
      if (this.options.relay) { this.emit(input, tool, operation); return; }
      // Unrelated successes must not initialize diagnostics storage or evaluate policy.
      const dir = directory(this.options, input.outcome === "denied");
      if (!dir) return;
      if (input.outcome === "succeeded" && !stat(join(dir, "events.jsonl"))) return;
      locked(dir, () => {
        const key = installationKey(dir, input.outcome === "denied");
        const journal = load(dir, key);
        const before = JSON.stringify(journal.losses);
        const pruned = retain(journal, key, now);
        const fingerprint = imported ? digest(key, "relay-event-identity", identity([imported.runIdentity, imported.value.idFingerprint])) :
          digest(key, "event-identity", randomBytes(32).toString("hex"));
        // Signed record identities survive parent reloads and full log rescans.
        if (imported && journal.records.some(r => r.fingerprint === fingerprint)) {
          if (pruned || journal.losses.malformed || journal.losses.tampered) atomic(join(dir, "events.jsonl"), encode(journal, key));
          if (issues(journal.losses).length) this.report(new Error("Diagnostics collection has gaps."));
          return;
        }
        const operationFingerprint = digest(key, "operation", operation);
        const recovered = new Set(journal.records.flatMap(r => r.recoveryOf ? [r.recoveryOf] : []));
        const prior = [...journal.records].reverse().find(r => r.outcome === "denied" && r.context === this.options.context &&
          r.tool === tool && r.operationFingerprint === operationFingerprint && r.timestamp <= now);
        if (input.outcome === "succeeded" && (!prior || recovered.has(prior.fingerprint))) {
          if (pruned || issues(journal.losses).some(i => i !== "retention-loss")) atomic(join(dir, "events.jsonl"), encode(journal, key));
          if (issues(journal.losses).length) this.report(new Error("Diagnostics collection has gaps."));
          return;
        }
        const backend = imported?.value.backend ?? this.options.backend();
        const version = imported?.value.version ?? this.options.version;
        const record: DiagnosticRecord = {
          schema: 1, timestamp: now,
          version: typeof version === "string" && VERSION.test(version) ? version : "unknown",
          platform: imported?.value.platform ?? (PLATFORMS.has(process.platform) ? process.platform : "unknown"),
          backend: typeof backend === "string" && BACKENDS.has(backend) ? backend : "unknown",
          tool, resource: input.outcome === "succeeded" && prior ? prior.resource : input.resource,
          basis: input.outcome === "succeeded" && prior ? prior.basis : input.basis,
          outcome: input.outcome, context: this.options.context,
          operationFingerprint, policyFingerprint: imported ? digest(key, "relay-policy", identity([imported.runIdentity, imported.value.policyFingerprint])) :
            digest(key, "policy", identity(this.options.policy())),
          fingerprint,
        };
        if (prior && input.outcome === "succeeded") record.recoveryOf = prior.fingerprint;
        journal.records.push(record);
        retain(journal, key, now);
        atomic(join(dir, "events.jsonl"), encode(journal, key));
        if (before !== JSON.stringify(journal.losses) || journal.losses.malformed || journal.losses.tampered) this.report(new Error("Diagnostics collection has gaps."));
      });
    } catch (error) { this.report(this.options.relay || imported ? new Error("Diagnostics collection has gaps.") : error); }
  }
}

export function readDiagnostics(seams: DiagnosticsSeams = {}): DiagnosticsData {
  const data: DiagnosticsData = { schema: 1, enabled: false, records: [], losses: emptyLosses(), issues: [] };
  try { data.enabled = diagnosticsEnabled(seams); } catch { data.issues.push("unavailable"); }
  try {
    const dir = directory(seams, false);
    if (!dir || !stat(join(dir, "events.jsonl"))) return data;
    locked(dir, () => {
      const key = installationKey(dir, false);
      const journal = load(dir, key);
      if (retain(journal, key, Date.now())) atomic(join(dir, "events.jsonl"), encode(journal, key));
      data.records = journal.records;
      data.losses = journal.losses;
      data.issues.push(...issues(journal.losses));
    });
  } catch (error) { data.issues.push(error instanceof UnsafeStorage ? "unsafe-storage" : "unavailable"); }
  return data;
}
export function analyzeDiagnostics(data: DiagnosticsData): DiagnosticsAnalysis {
  const groups = new Map<string, DiagnosticGroup>();
  const operations = new Map<string, { latestDenial: string; recovered: boolean }>();
  for (const r of data.records) {
    const key = JSON.stringify([r.version, r.backend, r.tool, r.resource, r.basis, r.policyFingerprint]);
    let group = groups.get(key);
    if (!group) {
      group = { version: r.version, backend: r.backend, tool: r.tool, resource: r.resource, basis: r.basis, policyFingerprint: r.policyFingerprint, denied: 0, succeeded: 0 };
      groups.set(key, group);
    }
    if (r.outcome === "denied") group.denied++; else group.succeeded++;
    const opKey = JSON.stringify([r.context, r.tool, r.operationFingerprint]);
    if (r.outcome === "denied") operations.set(opKey, { latestDenial: r.fingerprint, recovered: false });
    else {
      const operation = operations.get(opKey);
      if (operation && operation.latestDenial === r.recoveryOf) operation.recovered = true;
    }
  }
  const recovered = [...operations.values()].filter(op => op.recovered).length;
  return { groups: [...groups.values()], observedOperations: operations.size, recovered, outstanding: operations.size - recovered };
}
export function formatDiagnosticsSummary(data: DiagnosticsData): string {
  const analysis = analyzeDiagnostics(data);
  const l = data.losses;
  const lines = [
    `Sandbox diagnostics: ${data.enabled ? "enabled" : "disabled"}; ${data.records.length} retained observations.`,
    `Observed operations: ${analysis.observedOperations}; recovered: ${analysis.recovered}; outstanding: ${analysis.outstanding}.`,
    `Journal gaps: ${data.issues.length ? data.issues.join(", ") : "none recorded"}. Losses: age=${l.age}, count=${l.count}, bytes=${l.bytes}, malformed=${l.malformed}, tampered=${l.tampered}.`,
    "Observations only; not a security verdict. Collection errors may not persist; shell output is not classified.",
  ];
  for (const g of analysis.groups.slice(0, 20)) lines.push(`${g.version} ${g.backend} ${g.tool} ${g.resource} ${g.basis} policy=${g.policyFingerprint.slice(0, 12)}: denied=${g.denied}, succeeded=${g.succeeded}`);
  if (analysis.groups.length > 20) lines.push(`${analysis.groups.length - 20} additional groups in the local JSON export.`);
  return lines.join("\n");
}
export function exportDiagnostics(seams: DiagnosticsSeams = {}): string {
  const data = readDiagnostics(seams);
  const dir = directory(seams, true)!;
  const path = join(dir, "export.json");
  locked(dir, () => atomic(path, `${JSON.stringify({ schema: 1, enabled: data.enabled, records: data.records, losses: data.losses, issues: data.issues, coverage: { sampling: true, shellOutputClassified: false, collectionErrorsMayNotPersist: true }, analysis: analyzeDiagnostics(data) }, null, 2)}\n`));
  return path;
}
