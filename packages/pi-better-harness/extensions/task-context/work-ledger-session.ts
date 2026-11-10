import {
  isWorkLedgerId, openWorkLedgerStore, workLedgerTotals,
  type WorkItem, type WorkLedger, type WorkLedgerStatus, type WorkLedgerTotals,
} from "./work-ledger.js";

/**
 * Session association stored as a custom entry. The entry is only a reference;
 * the ledger itself stays in its project-scoped durable store.
 */
export const WORK_LEDGER_ASSOCIATION_ENTRY = "pi-better-harness:work-ledger";

/**
 * Custom message type used for bounded recovery reminders. `details.ledgerId`
 * lets the context hook remove reminders that no longer match the session.
 */
export const WORK_LEDGER_REMINDER_MESSAGE = "pi-better-harness:work-ledger-reminder";

const MAX_REMINDER_CHARS = 1_600;
const MAX_REMINDER_OPEN_ITEMS = 5;
const MAX_SUMMARY_ITEMS = 8;

interface SessionEntryLike {
  type: string;
  customType?: string;
  data?: unknown;
}

export type WorkLedgerAssociationEntry =
  | { version: 1; kind: "attach"; ledgerId: string }
  | { version: 1; kind: "detach" };

export interface WorkLedgerOpenItem {
  id: string;
  title: string;
  status: WorkItem["status"];
  progress: string;
  nextStep: string;
  blocker: string | null;
}

export interface WorkLedgerTodoSummary {
  id: string;
  revision: number;
  status: WorkLedgerStatus;
  outcome: string;
  totals: WorkLedgerTotals;
  openItems: WorkLedgerOpenItem[];
}

export function workLedgerAssociationEntry(ledgerId: string | null): WorkLedgerAssociationEntry {
  if (ledgerId === null) return { version: 1, kind: "detach" };
  if (!isWorkLedgerId(ledgerId)) throw new Error("A valid ledger id is required to associate a session.");
  return { version: 1, kind: "attach", ledgerId };
}

/**
 * Reconstruct the explicit association from the active branch. A malformed entry
 * is ignored, like malformed outcome state: it cannot erase a valid association.
 */
export function restoreWorkLedgerAssociation(entries: Iterable<SessionEntryLike>): string | null {
  let ledgerId: string | null = null;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== WORK_LEDGER_ASSOCIATION_ENTRY) continue;
    const data = entry.data as { version?: unknown; kind?: unknown; ledgerId?: unknown } | null;
    if (data?.version !== 1) continue;
    if (data.kind === "detach") ledgerId = null;
    else if (data.kind === "attach" && isWorkLedgerId(data.ledgerId)) ledgerId = data.ledgerId;
  }
  return ledgerId;
}

/** Read the associated ledger, refusing missing or cross-project records. */
export function readAssociatedWorkLedger(cwd: string, ledgerId: string): WorkLedger {
  return openWorkLedgerStore({ cwd }).read(ledgerId);
}

export function workLedgerOpenItems(ledger: WorkLedger): WorkItem[] {
  return ledger.items.filter((item) =>
    item.status === "pending" || item.status === "in_progress" || item.status === "blocked");
}

export function workLedgerTodoSummary(ledger: WorkLedger): WorkLedgerTodoSummary {
  return {
    id: ledger.id,
    revision: ledger.revision,
    status: ledger.status,
    outcome: ledger.outcome,
    totals: workLedgerTotals(ledger),
    openItems: workLedgerOpenItems(ledger).map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      progress: item.progress,
      nextStep: item.nextStep,
      blocker: item.blocker,
    })),
  };
}

/** One compact line for the existing Todo surface, never a second widget. */
export function workLedgerHeader(ledger: WorkLedger): string {
  const totals = workLedgerTotals(ledger);
  const open = workLedgerOpenItems(ledger);
  const counts = totals.total === 0
    ? `ledger ${ledger.status} · no items`
    : `ledger ${totals.completed}/${totals.total} complete · ${totals.open} open`;
  const blocked = totals.blocked > 0 ? ` · ${totals.blocked} blocked` : "";
  const next = open[0];
  const nextLabel = next ? ` · next: ${clip(next.title, 80)}` : "";
  return `${counts}${blocked}${nextLabel}`;
}

export function formatWorkLedgerTodo(ledger: WorkLedger, full = false): string {
  const totals = workLedgerTotals(ledger);
  const open = workLedgerOpenItems(ledger);
  const shown = full ? ledger.items : [...open, ...ledger.items.filter((item) =>
    item.status === "completed" || item.status === "cancelled")].slice(0, MAX_SUMMARY_ITEMS);
  return [
    `Associated work ledger ${ledger.id} rev ${ledger.revision} (${ledger.status})`,
    `Outcome: ${ledger.outcome}`,
    ...(ledger.boundaries.length === 0 ? [] : [`Boundaries: ${ledger.boundaries.join("; ")}`]),
    `Items: ${totals.completed}/${totals.total} completed; ${totals.open} open; `
      + `${totals.inProgress} in progress; ${totals.blocked} blocked; ${totals.pending} pending`,
    ...shown.flatMap((item) => {
      const lines = [`- [${item.status}] ${item.id} ${item.title}`];
      if (item.nextStep) lines.push(`  Next: ${item.nextStep}`);
      if (item.blocker) lines.push(`  Blocker: ${item.blocker}`);
      if (item.evidence.length > 0) lines.push(`  Evidence: ${item.evidence.join("; ")}`);
      return lines;
    }),
    ...(shown.length < ledger.items.length ? [`... ${ledger.items.length - shown.length} more item(s) in the ledger.`] : []),
  ].join("\n");
}

/**
 * Bounded recovery context rebuilt from the durable record. It deliberately
 * carries no execution instruction: a restored reference never authorizes work.
 */
export function formatWorkLedgerReminder(
  ledger: WorkLedger,
  maxChars = MAX_REMINDER_CHARS,
): string {
  const totals = workLedgerTotals(ledger);
  const open = workLedgerOpenItems(ledger);
  const shown = open.slice(0, MAX_REMINDER_OPEN_ITEMS);
  const header = [
    `Durable work ledger ${ledger.id} rev ${ledger.revision} (${ledger.status})`,
    `Outcome: ${clip(ledger.outcome, 360)}`,
    ...(ledger.boundaries.length === 0 ? [] : [`Boundaries: ${clip(ledger.boundaries.join("; "), 360)}`]),
    `Items: ${totals.completed}/${totals.total} completed; ${totals.open} open; `
      + `${totals.blocked} blocked; ${totals.inProgress} in progress`,
    ...(shown.length === 0 ? ["Open high-level items: none."] : ["Open high-level items:"]),
  ];
  const itemLines = shown.map((item) => {
    const details = [
      item.progress ? `progress: ${clip(item.progress, 120)}` : "",
      item.nextStep ? `next: ${clip(item.nextStep, 120)}` : "",
      item.blocker ? `blocked: ${clip(item.blocker, 120)}` : "",
    ].filter(Boolean);
    return `- [${item.status}] ${item.id} ${clip(item.title, 120)}${details.length ? ` — ${details.join("; ")}` : ""}`;
  });
  const footer = [
    ledger.status === "completed"
      ? "The overall ledger is completed. Completed items, evidence, and history remain stored."
      : open.length === 0
        ? "All high-level items are closed, but the overall ledger is still active. Confirm delivery and complete it explicitly."
        : "This reminder is rebuilt from durable state, not the conversation summary.",
    "It is reference only: it does not authorize work, resume a paused Goal, change permissions, or supersede the workflow's canonical plan. Confirm the current human instruction before acting; use get_todo with ledger {action:'read'} for full detail.",
  ];
  for (let count = itemLines.length; count >= 0; count -= 1) {
    const omitted = open.length - count;
    const candidate = [
      ...header,
      ...itemLines.slice(0, count),
      ...(omitted > 0 ? [`... ${omitted} more open item(s); read the ledger for the rest.`] : []),
      ...footer,
    ].join("\n");
    if (candidate.length <= maxChars) return candidate;
  }
  return clip([...header, ...footer].join("\n"), maxChars);
}

function clip(value: string, max: number): string {
  const text = value.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}
