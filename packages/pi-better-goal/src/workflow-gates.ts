import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { WorkflowOwner } from "./workflow.js";

/** Branch entry the plan extension writes when it binds a workflow-owned task plan. */
const WORKFLOW_PLAN_ENTRY = "pi-better-workflow-plan";
const WORKFLOW_ENTRY = "pi-better-workflow";
export const SCHEDULER_TIMEOUT_MS = 20_000;
// Live tree queries allow three 60-second attempts plus follow-ups; cached probes stay cheap.
const SCHEDULER_SYNC_TIMEOUT_MS = 240_000;
const DETAIL_LIMIT = 200;

/** Scheduler locations relative to the owner's skill directory, in precedence order. */
const SCHEDULER_SCRIPTS = [
  join("scripts", "next-actions.mjs"),
  join("..", "resolve-issues", "scripts", "next-actions.mjs"),
];

/** Units in these states are done; every other unit is unfinished work. */
const FINISHED_STATUSES = new Set(["succeeded", "cancelled", "canceled"]);
/** `humanItem` values 2-5 are genuine holds only a human can lift; item 1 is a decision the run takes itself. */
const HUMAN_HOLD_ITEMS = new Set([2, 3, 4, 5]);

export interface SchedulerAction {
  action: string;
  unit: string | null;
  detail: string;
}

export type SchedulerRun =
  | { ok: true; due: SchedulerAction[] }
  | { ok: false; reason: string };

/** A gate either lets the call through (optionally with a warning when it could not check) or refuses it. */
export type GateVerdict =
  | { allow: true; warning?: string }
  | { allow: false; message: string; due?: SchedulerAction[] };

interface EntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The first next-actions scheduler the owner's skill ships, or undefined when it ships none. */
export function findScheduler(owner: WorkflowOwner): string | undefined {
  const skillDir = dirname(owner.path);
  for (const relative of SCHEDULER_SCRIPTS) {
    const candidate = join(skillDir, relative);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing or unreadable: try the next location.
    }
  }
  return undefined;
}

/**
 * The task-plan.json the session bound for `owner`, or undefined before a plan is bound.
 * Invoking a workflow skill again starts a new run, so a later owner entry drops the old binding.
 */
export function boundPlanPath(entries: Iterable<EntryLike>, owner: WorkflowOwner): string | undefined {
  let path: string | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom") continue;
    const data = entry.data;
    if (entry.customType === WORKFLOW_ENTRY && isRecord(data) && data.version === 1 && data.kind === "set") path = undefined;
    if (entry.customType !== WORKFLOW_PLAN_ENTRY || !isRecord(data) || data.version !== 1) continue;
    if (data.kind === "clear") path = undefined;
    else if (data.kind === "set" && data.owner === owner.name && typeof data.path === "string") path = data.path;
  }
  return path;
}

function parseSchedulerOutput(stdout: string): SchedulerRun {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "the scheduler printed output that is not JSON" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.due)) return { ok: false, reason: "the scheduler output has no due list" };
  const due = parsed.due.flatMap((item): SchedulerAction[] => isRecord(item) && typeof item.action === "string"
    ? [{
      action: item.action,
      unit: item.unit === null || item.unit === undefined ? null : String(item.unit),
      detail: typeof item.detail === "string" ? item.detail : "",
    }]
    : []);
  return { ok: true, due };
}

/**
 * Runs the scheduler read-only (`--peek`) for a run directory. The scheduler exits 1 when actions
 * are due and 2 on a usage or plan error, so only the latter, a timeout, or bad output is a failure.
 */
export function runScheduler(script: string, runDir: string, timeoutMs = SCHEDULER_TIMEOUT_MS): Promise<SchedulerRun> {
  return executeScheduler(script, runDir, timeoutMs);
}

function executeScheduler(script: string, runDir: string, timeoutMs: number, live = false, cwd = runDir): Promise<SchedulerRun> {
  return new Promise((resolve) => {
    execFile("node", [script, "--run", runDir, "--slots", "1", "--peek", "--json", ...(live ? ["--sync"] : [])],
      { cwd, timeout: timeoutMs, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          // An exit status of 1 means "actions due"; any other failure (exit 2, timeout, spawn error) is real.
          if ((error as { code?: unknown }).code !== 1) {
            const detail = String(stderr).trim().split("\n")[0] || error.message;
            resolve({ ok: false, reason: `the scheduler failed (${detail.slice(0, DETAIL_LIMIT)})` });
            return;
          }
        }
        resolve(parseSchedulerOutput(stdout));
      });
  });
}

async function settlementScheduler(script: string, runDir: string, timeoutMs?: number): Promise<SchedulerRun> {
  const cached = await runScheduler(script, runDir, timeoutMs);
  if (!cached.ok || cached.due.length !== 1 || cached.due[0]!.action !== "sync") return cached;

  // --peek suppresses seen bookkeeping, not syncRun's issue-tree write. Give the live
  // probe private inputs; keep cwd so relative workspace paths retain their meaning.
  let snapshot: string | undefined;
  try {
    snapshot = mkdtempSync(join(tmpdir(), "pi-goal-scheduler-"));
    for (const name of ["task-plan.json", "issue-tree.json", "next-actions-seen.json", "reviews", "results"]) {
      const source = join(runDir, name);
      if (existsSync(source)) cpSync(source, join(snapshot, name), { recursive: true, dereference: true });
    }
    return await executeScheduler(script, snapshot, timeoutMs ?? SCHEDULER_SYNC_TIMEOUT_MS, true, runDir);
  } catch (error) {
    return { ok: false, reason: `could not prepare the live scheduler check (${String(error).slice(0, DETAIL_LIMIT)})` };
  } finally {
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  }
}

interface PlannedRun {
  runDir: string;
  script: string;
}

function locateRun(entries: Iterable<EntryLike>, owner: WorkflowOwner): PlannedRun | { warning: string } {
  const script = findScheduler(owner);
  if (!script) return { warning: `${owner.name} ships no scheduler, so the run was not checked` };
  const plan = boundPlanPath(entries, owner);
  if (!plan) return { warning: `no task plan is bound for ${owner.name} yet, so the run was not checked` };
  return { runDir: dirname(plan), script };
}

function unchecked(warning: string): GateVerdict {
  return { allow: true, warning: `Warning: ${warning}. The gate is open so nothing deadlocks.` };
}

function describe(action: SchedulerAction): string {
  const detail = action.detail.length > DETAIL_LIMIT ? `${action.detail.slice(0, DETAIL_LIMIT)}...` : action.detail;
  return `- ${action.action}${action.unit ? ` (unit ${action.unit})` : ""}: ${detail}`;
}

/** Completion is allowed only when the scheduler reports `finish` and nothing else is due. */
export async function completionGate(
  entries: Iterable<EntryLike>,
  owner: WorkflowOwner,
  options: { timeoutMs?: number } = {},
): Promise<GateVerdict> {
  const located = locateRun(entries, owner);
  if ("warning" in located) return unchecked(located.warning);
  const run = await settlementScheduler(located.script, located.runDir, options.timeoutMs);
  if (!run.ok) return unchecked(`could not check the ${owner.name} run (${run.reason})`);
  const open = run.due.filter((action) => action.action !== "finish");
  if (open.length === 0 && run.due.length > 0) return { allow: true };
  if (open.length === 0) {
    // Nothing due means workers are still running, not that the run is done.
    return {
      allow: false,
      due: [],
      message: `Goal not marked complete: the ${owner.name} run's workers are still running; the scheduler has not reported finish. ` +
        "Wait for them, then call update_goal again once the scheduler reports finish.",
    };
  }
  return {
    allow: false,
    due: open,
    message: `Goal not marked complete: the ${owner.name} scheduler still has work due, so the run is not finished. ` +
      `Do the due actions, then call update_goal again once the scheduler reports finish.\n${open.map(describe).join("\n")}`,
  };
}

function readUnits(runDir: string): Array<Record<string, unknown>> | null {
  try {
    const plan: unknown = JSON.parse(readFileSync(join(runDir, "task-plan.json"), "utf8"));
    return isRecord(plan) && Array.isArray(plan.units) ? plan.units.filter(isRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Releasing (pausing the goal) is allowed only for genuine human holds. Every unfinished unit must be
 * either quiet (the scheduler has nothing due for it) or blocked on human-decision item 2-5.
 */
export async function pauseGate(
  entries: Iterable<EntryLike>,
  owner: WorkflowOwner,
  options: { timeoutMs?: number } = {},
): Promise<GateVerdict> {
  const located = locateRun(entries, owner);
  if ("warning" in located) return unchecked(located.warning);
  const units = readUnits(located.runDir);
  if (!units) return unchecked(`could not read the ${owner.name} task plan`);
  const run = await settlementScheduler(located.script, located.runDir, options.timeoutMs);
  if (!run.ok) return unchecked(`could not check the ${owner.name} run (${run.reason})`);

  const refusals: string[] = [];
  const unfinished = new Set<string>();
  for (const unit of units) {
    const id = String(unit.id);
    const status = typeof unit.status === "string" ? unit.status : "";
    if (FINISHED_STATUSES.has(status)) continue;
    unfinished.add(id);
    const due = run.due.filter((action) => action.unit === id && action.action !== "finish");
    if (due.length === 0) continue;
    const humanHold = status === "blocked" && unit.blockedReason === "human-decision" &&
      typeof unit.humanItem === "number" && HUMAN_HOLD_ITEMS.has(unit.humanItem);
    if (humanHold) continue;
    refusals.push(status === "blocked" && typeof unit.blockedReason === "string"
      ? unit.blockedReason === "human-decision"
        ? `unit ${id} is blocked human-decision${unit.humanItem === undefined ? "" : ` item ${String(unit.humanItem)}`}; only items 2-5 are genuine holds, so decide it yourself (${due[0]!.action})`
        : `unit ${id} is blocked ${unit.blockedReason}; the run retries it itself (${due[0]!.action})`
      : `unit ${id} is ${status || "unfinished"} with ${due[0]!.action} due`);
  }
  for (const action of run.due) {
    if (action.action !== "finish" && (action.unit === null || !unfinished.has(action.unit))) {
      refusals.push(`${action.unit ? `unit ${action.unit}` : "the run"} has ${action.action} due: ${action.detail.slice(0, DETAIL_LIMIT)}`);
    }
  }
  if (refusals.length === 0) return { allow: true };
  return {
    allow: false,
    message: `Workflow not released: the ${owner.name} run still has work it can do itself, so the goal stays active.\n` +
      refusals.map((line) => `- ${line}`).join("\n"),
  };
}

/** The instant of the scheduler's `wait` heartbeat, when it is the only thing due. */
export function waitUntil(due: readonly SchedulerAction[]): number | undefined {
  if (due.length === 0 || due.some((action) => action.action !== "wait")) return undefined;
  const times = due.map((action) => {
    const match = /next automatic attempt is at (\d{4}-\d{2}-\d{2}T[0-9:.]+Z?)/.exec(action.detail);
    return match ? Date.parse(match[1]!) : Number.NaN;
  }).filter(Number.isFinite);
  return times.length > 0 ? Math.min(...times) : undefined;
}

/** When the bound run next wants a continuation, or undefined when it is not only waiting. */
export async function schedulerWaitUntil(
  entries: Iterable<EntryLike>,
  owner: WorkflowOwner,
  options: { timeoutMs?: number } = {},
): Promise<number | undefined> {
  const located = locateRun(entries, owner);
  if ("warning" in located) return undefined;
  const run = await runScheduler(located.script, located.runDir, options.timeoutMs);
  return run.ok ? waitUntil(run.due) : undefined;
}
