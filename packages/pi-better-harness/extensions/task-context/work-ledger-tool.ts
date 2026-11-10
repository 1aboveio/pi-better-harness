import { type Static, Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  isWorkLedgerId, openWorkLedgerStore, workLedgerTotals, WORK_ITEM_STATUSES, WORK_LEDGER_STATUSES,
  type WorkItemDraft, type WorkItemPatch, type WorkLedger, type WorkLedgerSummary, type WorkLedgerTotals,
} from "./work-ledger.js";

const ItemDraftSchema = Type.Object({
  id: Type.Optional(Type.String({
    description: "Optional stable item id (letters, digits, underscore, hyphen; max 64). Omit to generate one.",
  })),
  title: Type.String({ minLength: 1, description: "Short, plain-language deliverable, usually 3-7 words." }),
  status: Type.Optional(StringEnum(WORK_ITEM_STATUSES, {
    description: "Defaults to pending. completed requires evidence; blocked requires blocker and recovery.",
  })),
  completion: Type.Optional(Type.Array(Type.String(), {
    description: "Conditions that must hold before this item can be completed.",
  })),
  progress: Type.Optional(Type.String({ description: "Current progress, not the next action." })),
  nextStep: Type.Optional(Type.String({ description: "The next concrete action for this item." })),
  blocker: Type.Optional(Type.String({ description: "Why the item cannot proceed while blocked." })),
  recovery: Type.Optional(Type.String({ description: "Condition that clears the blocker." })),
  evidence: Type.Optional(Type.Array(Type.String(), {
    description: "Concrete completion evidence. Required with completed status.",
  })),
});

const ItemPatchSchema = Type.Object({
  id: Type.String({ description: "Stable id of the item to change. Other items are untouched." }),
  title: Type.Optional(Type.String({ minLength: 1 })),
  status: Type.Optional(StringEnum(WORK_ITEM_STATUSES)),
  completion: Type.Optional(Type.Array(Type.String(), { description: "Replaces the completion conditions." })),
  progress: Type.Optional(Type.String({ description: "Replaces current progress." })),
  nextStep: Type.Optional(Type.String({ description: "Replaces the next action." })),
  blocker: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Replaces the blocker; null clears it." })),
  recovery: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Replaces the recovery condition; null clears it." })),
  evidence: Type.Optional(Type.Array(Type.String(), {
    description: "Appends evidence. Existing evidence is retained.",
  })),
});

export const workLedgerParameters = Type.Object({
  action: StringEnum(["create", "list", "read", "update", "attach", "detach"] as const, {
    description: "create a ledger, list this project's ledgers, read one, incrementally update one, or explicitly associate/detach the session.",
  }),
  ledgerId: Type.Optional(Type.String({ description: "Ledger id from create or list. Required for read and update." })),
  revision: Type.Optional(Type.Integer({
    minimum: 1,
    description: "The ledger revision last read. Required for update; stale revisions are refused.",
  })),
  event: Type.Optional(Type.String({ description: "Short history label for this change, e.g. item-progress." })),
  outcome: Type.Optional(Type.String({
    description: "Overall high-level outcome. Required for create; optional replacement on update.",
  })),
  boundaries: Type.Optional(Type.Array(Type.String(), {
    description: "Scope boundaries and exclusions. Ignored when omitted.",
  })),
  status: Type.Optional(StringEnum(WORK_LEDGER_STATUSES, {
    description: "Overall ledger status. Completion is refused while items remain open.",
  })),
  items: Type.Optional(Type.Array(ItemDraftSchema, {
    maxItems: 200,
    description: "Initial high-level items for create. Ignored by other actions.",
  })),
  changes: Type.Optional(Type.Array(ItemPatchSchema, {
    maxItems: 200,
    description: "Partial item updates for update. Omitted items and fields stay unchanged.",
  })),
  addItems: Type.Optional(Type.Array(ItemDraftSchema, {
    maxItems: 200,
    description: "New high-level items to add in an update. Recorded in history; existing items are preserved.",
  })),
});

export type WorkLedgerToolInput = Static<typeof workLedgerParameters>;

export interface WorkLedgerToolDetails {
  ok: true;
  action: WorkLedgerToolInput["action"];
  ledger?: WorkLedger;
  ledgers?: WorkLedgerSummary[];
  totals?: WorkLedgerTotals;
  /** Ledger explicitly associated with the current session, if any. */
  associatedLedgerId?: string | null;
}

/** Session hooks the tool uses only for deliberate associate/detach actions. */
export interface WorkLedgerSessionBinding {
  associatedLedgerId(): string | null;
  associate(ledgerId: string): void;
  detach(): void;
}

export const WORK_LEDGER_TOOL = {
  name: "work_ledger",
  label: "Work Ledger",
  description: "Create, list, read, or incrementally update a durable high-level work ledger for this project. "
    + "The ledger is independent of session history and is not bound to the session automatically. "
    + "Updates require the revision last read; stale revisions are refused atomically.",
  promptSnippet: "Create, inspect, or incrementally update a durable project work ledger",
  promptGuidelines: [
    "Use work_ledger for a durable high-level outcome with stable work items; it is separate from the workflow task plan and does not bind or inject old work into a session.",
    "Only use work_ledger attach when the user explicitly names an existing ledger or asks to continue it. Never infer association from the working directory, project files, or a similar outcome, and never attach while starting unrelated work.",
    "Read a work ledger before updating it, then send its current revision. Never silently retry a stale revision or overwrite newer progress.",
    "In a work_ledger update, send only the items that changed. Omitted items and fields keep their stored progress.",
    "Mark a work_ledger item completed only with concrete evidence. Record both blocker and recovery before marking it blocked.",
    "A plan or item completion does not complete the overall ledger outcome. Complete the ledger explicitly after all unfinished items are resolved; a completed execution plan cannot complete an associated ledger with open items.",
    "After attach, the session keeps only a reference to the same ledger. Detach or switch when the user changes work; do not copy the ledger into session state.",
  ],
  parameters: workLedgerParameters,
};

export function executeWorkLedgerTool(input: WorkLedgerToolInput, cwd: string, session?: WorkLedgerSessionBinding): {
  content: Array<{ type: "text"; text: string }>;
  details: WorkLedgerToolDetails;
} {
  const store = openWorkLedgerStore({ cwd });
  const associatedLedgerId = session?.associatedLedgerId() ?? null;
  switch (input.action) {
    case "create": {
      if (input.ledgerId !== undefined || input.revision !== undefined || input.changes !== undefined || input.addItems !== undefined) {
        throw new Error("work_ledger create uses outcome, boundaries, status, and items; do not send ledgerId, revision, changes, or addItems.");
      }
      if (input.outcome === undefined) throw new Error("work_ledger create requires outcome.");
      const ledger = store.create({
        outcome: input.outcome,
        ...(input.boundaries === undefined ? {} : { boundaries: input.boundaries }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.items === undefined ? {} : { items: input.items as WorkItemDraft[] }),
        ...(input.event === undefined ? {} : { event: input.event }),
      });
      return result(input.action, formatWorkLedger(ledger), { ledger, totals: workLedgerTotals(ledger) });
    }
    case "list": {
      const ledgers = store.list();
      return result(input.action, formatLedgerList(ledgers, associatedLedgerId), { ledgers, associatedLedgerId });
    }
    case "read": {
      const ledger = store.read(requireLedgerId(input));
      return result(input.action, formatWorkLedger(ledger), { ledger, totals: workLedgerTotals(ledger), associatedLedgerId });
    }
    case "update": {
      const ledgerId = requireLedgerId(input);
      if (input.revision === undefined) throw new Error("work_ledger update requires the revision last read.");
      if (input.items !== undefined) throw new Error("work_ledger update takes changes and addItems; items is only for create.");
      if (input.outcome === undefined && input.boundaries === undefined && input.status === undefined &&
          (input.changes === undefined || input.changes.length === 0) &&
          (input.addItems === undefined || input.addItems.length === 0)) {
        throw new Error("work_ledger update needs outcome, boundaries, status, changes, or addItems.");
      }
      const ledger = store.update({
        ledgerId,
        revision: input.revision,
        ...(input.event === undefined ? {} : { event: input.event }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        ...(input.boundaries === undefined ? {} : { boundaries: input.boundaries }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.changes === undefined ? {} : { changes: input.changes as WorkItemPatch[] }),
        ...(input.addItems === undefined ? {} : { addItems: input.addItems as WorkItemDraft[] }),
      });
      return result(input.action, formatWorkLedger(ledger), { ledger, totals: workLedgerTotals(ledger) });
    }
    case "attach": {
      if (!session) throw new Error("This session cannot associate a work ledger.");
      if (input.ledgerId === undefined) throw new Error("work_ledger attach requires ledgerId.");
      if (input.revision !== undefined || input.changes !== undefined || input.addItems !== undefined ||
          input.items !== undefined || input.outcome !== undefined || input.boundaries !== undefined ||
          input.status !== undefined) {
        throw new Error("work_ledger attach takes ledgerId only; update the ledger separately.");
      }
      const ledgerId = requireLedgerId(input);
      if (!isWorkLedgerId(ledgerId)) throw new Error("work_ledger attach requires a valid ledgerId.");
      const ledger = store.read(ledgerId);
      session.associate(ledger.id);
      return result(input.action,
        `Session associated with work ledger ${ledger.id} rev ${ledger.revision}. This only adds a reference; `
          + "it does not start a Goal, grant permissions, or execute old work.",
        { ledger, totals: workLedgerTotals(ledger), associatedLedgerId: ledger.id });
    }
    case "detach": {
      if (!session) throw new Error("This session cannot detach a work ledger.");
      if (associatedLedgerId === null) {
        return result(input.action, "This session has no associated work ledger.", { associatedLedgerId: null });
      }
      session.detach();
      return result(input.action,
        `Session detached from work ledger ${associatedLedgerId}. The ledger and its history remain stored.`,
        { associatedLedgerId: null });
    }
    default:
      throw new Error(`Unknown work_ledger action ${JSON.stringify(input.action)}.`);
  }
}

function requireLedgerId(input: WorkLedgerToolInput): string {
  if (typeof input.ledgerId !== "string" || !input.ledgerId) throw new Error("ledgerId is required for this action.");
  return input.ledgerId;
}

function result(
  action: WorkLedgerToolInput["action"],
  text: string,
  details: Omit<WorkLedgerToolDetails, "ok" | "action">,
): {
  content: Array<{ type: "text"; text: string }>;
  details: WorkLedgerToolDetails;
} {
  const truncation = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  const content = truncation.truncated
    ? `${truncation.content}\n[Work ledger output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines. Read the ledger with a narrower item or use the details.]`
    : text;
  return { content: [{ type: "text", text: content }], details: { ok: true, action, ...details } };
}

export function formatLedgerList(ledgers: WorkLedgerSummary[], associatedLedgerId: string | null = null): string {
  if (ledgers.length === 0) return "No work ledgers exist for this project.";
  return [
    `Work ledgers in this project: ${ledgers.length}`,
    ...ledgers.map((ledger) => {
      const totals = ledger.totals;
      return `- ${ledger.id} rev ${ledger.revision} (${ledger.status}): ${totals.completed}/${totals.total} completed, `
        + `${totals.open} open${ledger.id === associatedLedgerId ? " [associated with this session]" : ""} — ${ledger.outcome}`;
    }),
  ].join("\n");
}

export function formatWorkLedger(ledger: WorkLedger): string {
  const totals = workLedgerTotals(ledger);
  const recentHistory = ledger.history.slice(-10);
  return [
    `Work ledger ${ledger.id} rev ${ledger.revision} (${ledger.status})`,
    `Outcome: ${ledger.outcome}`,
    ...(ledger.boundaries.length === 0 ? [] : [`Boundaries: ${ledger.boundaries.join("; ")}`]),
    `Items: ${totals.total}; completed ${totals.completed}; open ${totals.open}; `
      + `in progress ${totals.inProgress}; pending ${totals.pending}; blocked ${totals.blocked}; cancelled ${totals.cancelled}`,
    ...ledger.items.flatMap((item) => {
      const lines = [`- [${item.status}] ${item.id} ${item.title}`];
      if (item.completion.length > 0) lines.push(`  Done when: ${item.completion.join("; ")}`);
      if (item.progress) lines.push(`  Progress: ${item.progress}`);
      if (item.nextStep) lines.push(`  Next: ${item.nextStep}`);
      if (item.blocker) lines.push(`  Blocker: ${item.blocker}`);
      if (item.recovery) lines.push(`  Recovery: ${item.recovery}`);
      if (item.evidence.length > 0) lines.push(`  Evidence: ${item.evidence.join("; ")}`);
      return lines;
    }),
    ...(ledger.items.length === 0 ? ["- No items yet."] : []),
    `History: ${ledger.history.length} revision(s)${ledger.history.length > recentHistory.length ? ` (last ${recentHistory.length})` : ""}`,
    ...recentHistory.map((entry) => {
      const changes = [
        ...entry.ledgerFields,
        ...entry.items.map((change) => {
          const fields = [...change.fields];
          if (change.fromStatus && change.toStatus) fields.push(`${change.fromStatus} -> ${change.toStatus}`);
          return `${change.id}: ${fields.join(", ")}`;
        }),
      ];
      return `- rev ${entry.revision} ${entry.event}: ${changes.join("; ")}`;
    }),
  ].join("\n");
}
