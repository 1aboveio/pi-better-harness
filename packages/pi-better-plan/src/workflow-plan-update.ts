import { randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync,
  ftruncateSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { isRecord, projectRushPlan, resolveRushPlanFile, type RushPlan } from "./workflow-plan.js";

export type RushRowTarget = "unit" | "component" | "fleet" | "run";

export interface RushRowChange {
  id?: string | undefined;
  target?: RushRowTarget | undefined;
  set?: Record<string, unknown> | undefined;
  add?: Record<string, unknown> | undefined;
}

export interface RushDecisionInput {
  id: string;
  humanWords: string;
  changes: string;
  supersedes?: string | undefined;
}

export interface RushPlanUpdate {
  event: string;
  revision?: number | undefined;
  changes?: RushRowChange[] | undefined;
  decision?: RushDecisionInput | undefined;
  profiling?: Record<string, unknown> | undefined;
}

export interface RushPlanUpdateResult {
  plan: RushPlan;
  revision: number;
  profilingPath: string;
  changed: Array<{ target: RushRowTarget; id: string | null; added?: true }>;
  /** Last planRevision in the profiling log when it was ahead of the saved plan (an earlier write crashed after logging). */
  logAheadRevision?: number | undefined;
}

/** Contract values from rush-issues references/task-plan.md. */
export const RUSH_UNIT_STATUSES = ["pending", "in-flight", "diagnosing", "succeeded", "blocked", "cancelled"] as const;
export const RUSH_UNIT_STAGES = ["pending", "implement", "validate", "self-review", "diagnose", "done"] as const;
export const RUSH_COMPONENT_STATUSES = ["building", "combining", "review", "cicd", "merged", "blocked"] as const;
export const RUSH_FLEET_STATUSES = [
  "pending", "in-flight", "diagnosing", "succeeded", "failed", "blocked", "cancelled", "not-applicable", "merged",
] as const;
/** Input spellings accepted for a fleet status and the contract value saved in their place. */
const FLEET_STATUS_ALIASES: Record<string, string> = { "n/a": "not-applicable" };

const ROW_PROTECTED = new Set(["id"]);
const RUN_PROTECTED = new Set([
  "runId", "planRevision", "updatedAt", "startedAt", "units", "issues", "components", "fleet", "decisions",
]);
const PROFILING_RESERVED = new Set([
  "ts", "runId", "planRevision", "event", "changes", "decision", "scope", "unit", "component", "stage", "logAheadRevision",
]);
const MAX_PROFILING_TAIL = 64 * 1024;

/**
 * Apply one Rush transition to a bound task-plan.json: every row change or
 * added row, the optional decision, planRevision + 1, and updatedAt land in one
 * atomic rename, paired with one profiling event carrying the same planRevision.
 */
export function applyRushPlanUpdate(
  path: string,
  cwd: string,
  expectedRunId: string,
  update: RushPlanUpdate,
  now: Date = new Date(),
): RushPlanUpdateResult {
  const { file, runId } = resolveRushPlanFile(path, cwd);
  if (runId !== expectedRunId) throw new Error("Rush run identity changed; sync the plan again.");
  const event = typeof update.event === "string" ? update.event.trim() : "";
  if (!event) throw new Error("workflow.event must name the transition, e.g. unit-validated.");
  const changes = update.changes ?? [];
  if (changes.length === 0 && !update.decision) throw new Error("workflow needs at least one change or a decision.");

  const originalText = readFileSync(file, "utf8");
  const original: unknown = JSON.parse(originalText);
  const current = projectRushPlan(original, runId);
  if (update.revision !== undefined && update.revision !== current.planRevision) {
    throw new Error(`Rush plan revision mismatch: expected ${update.revision}, found ${current.planRevision}. Read the plan with get_plan and retry.`);
  }

  const next = structuredClone(original) as Record<string, unknown>;
  const changed: RushPlanUpdateResult["changed"] = [];
  const profiledChanges: Array<Record<string, unknown>> = [];
  const touched = new Set<string>();
  for (const [index, change] of changes.entries()) {
    if (!isRecord(change)) throw new Error(`changes[${index}] must be an object.`);
    if (change.add !== undefined) {
      if (change.set !== undefined) throw new Error(`changes[${index}]: send either set or add, not both.`);
      const added = addRow(next, change, index);
      // A later change in this call may still set fields on the new row (e.g. a component's units).
      changed.push({ target: added.target, id: added.id, added: true });
      profiledChanges.push({ scope: added.target, id: added.id, add: added.row });
      continue;
    }
    const row = locateRow(next, change, index);
    const key = `${row.target}:${row.id ?? ""}`;
    if (touched.has(key)) throw new Error(`changes[${index}] repeats ${describe(row.target, row.id)}; put all its fields in one change.`);
    touched.add(key);
    const set = applyFields(next, row.target, row.id, row.record, change.set as Record<string, unknown>, index, row.replaceString);
    changed.push({ target: row.target, id: row.id });
    profiledChanges.push({ scope: row.target, ...(row.id === null ? {} : { id: row.id }), set });
  }

  const ts = now.toISOString();
  let decisionId: string | undefined;
  if (update.decision) decisionId = appendDecision(next, update.decision, ts);

  const revision = current.planRevision + 1;
  next.planRevision = revision;
  next.updatedAt = ts;
  const projected = projectRushPlan(next, runId);

  const extra = update.profiling ?? {};
  if (!isRecord(extra)) throw new Error("workflow.profiling must be an object of extra event fields.");
  for (const key of Object.keys(extra)) {
    if (PROFILING_RESERVED.has(key)) throw new Error(`workflow.profiling cannot set ${key}; it is filled in from the changes.`);
  }

  const runDir = dirname(file);
  const profilingPath = profilingLogPath(runDir);
  // The log is appended before the plan is renamed, so a crash between the two
  // leaves the log one revision ahead. Say so in the next event instead of hiding it.
  const logged = isFile(profilingPath) ? lastRevision(profilingPath) : -1;
  const logAheadRevision = logged > current.planRevision ? logged : undefined;

  const single = changed.length === 1 ? changed[0]! : null;
  const profilingEvent: Record<string, unknown> = {
    ts, runId, planRevision: revision, event,
    ...(single ? { scope: single.target, ...singleIdField(single) } : {}),
    ...extra,
    ...(profiledChanges.length ? { changes: profiledChanges } : {}),
    ...(decisionId ? { decision: decisionId } : {}),
    ...(logAheadRevision !== undefined ? { logAheadRevision } : {}),
  };

  writeTransition(file, originalText, serializeLike(originalText, next), profilingPath, JSON.stringify(profilingEvent) + "\n");
  return { plan: projected, revision, profilingPath, changed, ...(logAheadRevision !== undefined ? { logAheadRevision } : {}) };
}

interface LocatedRow {
  target: RushRowTarget;
  id: string | null;
  record: Record<string, unknown>;
  /** Set when a fleet stage is persisted as a bare status string. */
  replaceString?: ((value: Record<string, unknown> | string) => void) | undefined;
}

function unitList(plan: Record<string, unknown>): unknown[] {
  return Array.isArray(plan.issues) ? plan.issues : Array.isArray(plan.units) ? plan.units : [];
}

function unitIds(plan: Record<string, unknown>): Set<string> {
  return new Set(unitList(plan).flatMap((u) => isRecord(u) && typeof u.id === "string" ? [u.id] : []));
}

function componentIds(plan: Record<string, unknown>): Set<string> {
  return new Set(Array.isArray(plan.components)
    ? plan.components.flatMap((c) => isRecord(c) && typeof c.id === "string" ? [c.id] : [])
    : []);
}

function locateRow(plan: Record<string, unknown>, change: RushRowChange, index: number): LocatedRow {
  if (!isRecord(change.set) || Object.keys(change.set).length === 0) {
    throw new Error(`changes[${index}] needs set (fields to change) or add (a new unit or component row).`);
  }
  const target = change.target;
  const id = typeof change.id === "string" ? change.id.trim() : undefined;
  if (target === "run" || (target === undefined && id === undefined)) {
    if (id !== undefined) throw new Error(`changes[${index}]: run-level changes take no id.`);
    return { target: "run", id: null, record: plan };
  }
  if (!id) throw new Error(`changes[${index}] needs the id of a unit, component, or fleet stage.`);

  const matches: LocatedRow[] = [];
  const units = unitList(plan);
  if (target === undefined || target === "unit") {
    for (const unit of units) if (isRecord(unit) && unit.id === id) matches.push({ target: "unit", id, record: unit });
  }
  if ((target === undefined || target === "component") && Array.isArray(plan.components)) {
    for (const component of plan.components) {
      if (isRecord(component) && component.id === id) matches.push({ target: "component", id, record: component });
    }
  }
  if ((target === undefined || target === "fleet") && isRecord(plan.fleet) && Object.hasOwn(plan.fleet, id)) {
    const fleet = plan.fleet;
    const value = fleet[id];
    if (isRecord(value)) matches.push({ target: "fleet", id, record: value });
    else if (typeof value === "string") {
      matches.push({ target: "fleet", id, record: { status: value }, replaceString: (next) => { fleet[id] = next; } });
    }
  }
  if (matches.length === 0) {
    throw new Error(`changes[${index}]: unknown ${target ?? "unit, component, or fleet stage"} id ${JSON.stringify(id)}. Known: ${knownIds(plan, units, target)}. To create a row, send add.`);
  }
  if (matches.length > 1) {
    throw new Error(`changes[${index}]: id ${JSON.stringify(id)} names more than one row (${matches.map((m) => m.target).join(", ")}); add target.`);
  }
  return matches[0]!;
}

function knownIds(plan: Record<string, unknown>, units: unknown[], target: RushRowTarget | undefined): string {
  const ids: string[] = [];
  if (target === undefined || target === "unit") ids.push(...units.flatMap((u) => isRecord(u) && typeof u.id === "string" ? [u.id] : []));
  if (target === undefined || target === "component") ids.push(...componentIds(plan));
  if ((target === undefined || target === "fleet") && isRecord(plan.fleet)) ids.push(...Object.keys(plan.fleet));
  const shown = ids.slice(0, 30).join(", ");
  return ids.length > 30 ? `${shown}, … (${ids.length - 30} more)` : shown || "none";
}

/** Append a new unit or component row (mid-run scope change). Existing rows are never removed or renamed. */
function addRow(plan: Record<string, unknown>, change: RushRowChange, index: number): { target: "unit" | "component"; id: string; row: Record<string, unknown> } {
  const target = change.target;
  if (target !== "unit" && target !== "component") throw new Error(`changes[${index}]: add needs target unit or component.`);
  if (!isRecord(change.add)) throw new Error(`changes[${index}].add must be the new row's fields.`);
  const row = structuredClone(change.add);
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) throw new Error(`changes[${index}].add.id is required.`);
  if (change.id !== undefined && change.id.trim() !== id) throw new Error(`changes[${index}]: id and add.id differ.`);
  row.id = id;
  const where = `changes[${index}] (new ${target} ${id})`;
  const taken = [...unitIds(plan), ...componentIds(plan), ...(isRecord(plan.fleet) ? Object.keys(plan.fleet) : [])];
  if (taken.includes(id)) throw new Error(`${where}: id ${JSON.stringify(id)} is already used by another row.`);
  const required = target === "unit" ? ["title", "stage", "status"] : ["status"];
  for (const field of required) if (row[field] === undefined) throw new Error(`${where}: ${field} is required.`);
  if (row.dependsOn === undefined) row.dependsOn = [];
  if (target === "component" && row.units === undefined) row.units = [];
  const { id: _id, ...fields } = row;
  checkFields(plan, target, id, fields, where);
  if (target === "unit") {
    if (Array.isArray(plan.issues)) plan.issues.push(row);
    else if (Array.isArray(plan.units)) plan.units.push(row);
    else plan.units = [row];
  } else if (Array.isArray(plan.components)) plan.components.push(row);
  else plan.components = [row];
  return { target, id, row };
}

function applyFields(
  plan: Record<string, unknown>,
  target: RushRowTarget,
  id: string | null,
  record: Record<string, unknown>,
  input: Record<string, unknown>,
  index: number,
  replaceString: ((value: Record<string, unknown> | string) => void) | undefined,
): Record<string, unknown> {
  const where = `changes[${index}] (${describe(target, id)})`;
  const set = { ...input };
  for (const field of Object.keys(set)) {
    if (target === "run" ? RUN_PROTECTED.has(field) : ROW_PROTECTED.has(field)) {
      throw new Error(`${where}: ${field} cannot be changed through update_plan.`);
    }
  }
  checkFields(plan, target, id, set, where);
  Object.assign(record, set);
  if (replaceString) {
    const keys = Object.keys(record);
    replaceString(keys.length === 1 && keys[0] === "status" ? record.status as string : record);
  }
  return set;
}

/** Validate (and normalize aliases in) the fields being written to one row. */
function checkFields(
  plan: Record<string, unknown>,
  target: RushRowTarget,
  id: string | null,
  set: Record<string, unknown>,
  where: string,
): void {
  for (const [field, value] of Object.entries(set)) {
    if (value === undefined) throw new Error(`${where}: ${field} has no value; send null to clear it.`);
  }
  if ("status" in set) {
    if (target === "fleet" && typeof set.status === "string" && Object.hasOwn(FLEET_STATUS_ALIASES, set.status)) {
      set.status = FLEET_STATUS_ALIASES[set.status];
    }
    checkValue(where, "status", set.status, statusesFor(target));
  }
  if ("stage" in set) {
    if (target !== "unit") throw new Error(`${where}: stage applies to units only.`);
    checkValue(where, "stage", set.stage, RUSH_UNIT_STAGES);
  }
  if (target === "unit") {
    if ("title" in set && (typeof set.title !== "string" || !set.title.trim())) throw new Error(`${where}: title must be non-empty text.`);
    if ("dependsOn" in set) checkIds(where, "dependsOn", set.dependsOn, unitIds(plan), id, "unit");
    if ("worker" in set && set.worker !== null && !(Number.isInteger(set.worker) && (set.worker as number) >= 1 && (set.worker as number) <= 4)) {
      throw new Error(`${where}: worker must be a slot 1-4, or null when no worker holds the unit.`);
    }
    if ("component" in set && set.component !== null && !(typeof set.component === "string" && componentIds(plan).has(set.component))) {
      throw new Error(`${where}: component ${JSON.stringify(set.component)} is not a component in this plan; add the component first.`);
    }
  }
  if (target === "component") {
    if ("dependsOn" in set) checkIds(where, "dependsOn", set.dependsOn, componentIds(plan), id, "component");
    if ("units" in set) checkIds(where, "units", set.units, unitIds(plan), null, "unit");
  }
}

function checkIds(where: string, field: string, value: unknown, known: Set<string>, self: string | null, kind: string): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${where}: ${field} must be a list of ${kind} ids.`);
  }
  for (const item of value) {
    if (item === self) throw new Error(`${where}: ${field} cannot name the row itself.`);
    if (!known.has(item)) throw new Error(`${where}: ${field} names unknown ${kind} ${JSON.stringify(item)}.`);
  }
}

function statusesFor(target: RushRowTarget): readonly string[] {
  switch (target) {
    case "unit": return RUSH_UNIT_STATUSES;
    case "component": return RUSH_COMPONENT_STATUSES;
    case "fleet": return RUSH_FLEET_STATUSES;
    case "run": throw new Error("A run has no status; set status on a unit, component, or fleet stage.");
  }
}

function checkValue(where: string, field: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${where}: invalid ${field} ${JSON.stringify(value)}; use one of ${allowed.join(", ")}.`);
  }
}

function describe(target: RushRowTarget, id: string | null): string {
  return id === null ? "run" : `${target} ${id}`;
}

function singleIdField(change: { target: RushRowTarget; id: string | null }): Record<string, string> {
  if (change.id === null) return {};
  if (change.target === "unit") return { unit: change.id };
  if (change.target === "component") return { component: change.id };
  return { stage: change.id };
}

function appendDecision(plan: Record<string, unknown>, decision: RushDecisionInput, ts: string): string {
  if (!isRecord(decision)) throw new Error("workflow.decision must be an object.");
  const id = typeof decision.id === "string" ? decision.id.trim() : "";
  if (!id) throw new Error("workflow.decision.id is required.");
  for (const field of ["humanWords", "changes"] as const) {
    if (typeof decision[field] !== "string" || !decision[field].trim()) throw new Error(`workflow.decision.${field} is required.`);
  }
  const decisions = plan.decisions === undefined || plan.decisions === null ? [] : plan.decisions;
  if (!Array.isArray(decisions)) throw new Error("The saved plan's decisions field is not a list.");
  const known = new Set(decisions.flatMap((entry) => isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []));
  if (known.has(id)) throw new Error(`Decision ${id} already exists; give the new decision its own id and set supersedes.`);
  if (decision.supersedes !== undefined && !known.has(decision.supersedes)) {
    throw new Error(`workflow.decision.supersedes names unknown decision ${JSON.stringify(decision.supersedes)}.`);
  }
  decisions.push({
    id, timestamp: ts, humanWords: decision.humanWords, changes: decision.changes,
    supersedes: decision.supersedes ?? null,
  });
  plan.decisions = decisions;
  return id;
}

/**
 * The run's profiling log. Rush documents profiling/run.jsonl; some runs write
 * profiling.jsonl. When both exist, the one whose last event has the higher
 * planRevision is the live one. When neither exists, profiling/run.jsonl.
 */
export function profilingLogPath(runDir: string): string {
  const canonical = join(runDir, "profiling", "run.jsonl");
  const flat = join(runDir, "profiling.jsonl");
  const present = [canonical, flat].filter(isFile);
  if (present.length === 0) return canonical;
  if (present.length === 1) return present[0]!;
  return lastRevision(flat) > lastRevision(canonical) ? flat : canonical;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function lastRevision(path: string): number {
  const size = statSync(path).size;
  const length = Math.min(size, MAX_PROFILING_TAIL);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buffer.toString("utf8").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value: unknown = JSON.parse(lines[index]!);
      if (isRecord(value) && Number.isSafeInteger(value.planRevision)) return value.planRevision as number;
    } catch { /* partial or non-JSON line */ }
  }
  return -1;
}

/** Keep the file's existing indentation and trailing newline. */
function serializeLike(originalText: string, value: unknown): string {
  const indent = originalText.match(/^\{\r?\n([ \t]+)"/)?.[1];
  const body = indent ? JSON.stringify(value, null, indent) : JSON.stringify(value);
  return originalText.endsWith("\n") ? `${body}\n` : body;
}

function writeTransition(file: string, originalText: string, planText: string, profilingPath: string, eventLine: string): void {
  const temp = join(dirname(file), `.task-plan.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const mode = statSync(file).mode & 0o777;
  let tempWritten = false;
  let profilingFd: number | undefined;
  let profilingSize = 0;
  let appended = false;
  try {
    writeWhole(temp, planText, mode);
    tempWritten = true;
    if (readFileSync(file, "utf8") !== originalText) {
      throw new Error("task-plan.json changed while this update was being prepared; read the plan with get_plan and retry.");
    }
    mkdirSync(dirname(profilingPath), { recursive: true });
    profilingFd = openSync(profilingPath, "a");
    profilingSize = statSync(profilingPath).size;
    const prefix = profilingSize > 0 && !endsWithNewline(profilingPath, profilingSize) ? "\n" : "";
    appended = true;
    writeSync(profilingFd, prefix + eventLine);
    fsyncSync(profilingFd);
    renameSync(temp, file);
    tempWritten = false;
  } catch (error) {
    if (appended && profilingFd !== undefined) {
      try {
        ftruncateSync(profilingFd, profilingSize);
      } catch { /* best effort: the plan was not replaced */ }
    }
    throw error;
  } finally {
    if (profilingFd !== undefined) closeSync(profilingFd);
    if (tempWritten && existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch { /* best effort */ }
    }
  }
}

function writeWhole(path: string, text: string, mode: number): void {
  const fd = openSync(path, "wx", mode);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function endsWithNewline(path: string, size: number): boolean {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1);
    readSync(fd, buffer, 0, 1, size - 1);
    return buffer[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}
