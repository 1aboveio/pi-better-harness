import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const lockfile = createRequire(import.meta.url)("proper-lockfile") as {
  lockSync(path: string, options: { realpath: boolean }): () => void;
};

export const WORK_LEDGER_SCHEMA = 1 as const;
export const WORK_LEDGER_STATUSES = ["active", "completed", "cancelled"] as const;
export const WORK_ITEM_STATUSES = ["pending", "in_progress", "blocked", "completed", "cancelled"] as const;

export type WorkLedgerStatus = (typeof WORK_LEDGER_STATUSES)[number];
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

const MAX_ITEMS = 200;
const MAX_TITLE_CHARS = 500;
const MAX_TEXT_CHARS = 5_000;
const MAX_LIST_ITEM_CHARS = 500;
const MAX_EVENT_CHARS = 120;
const MAX_LOCK_ATTEMPTS = 100;
const LOCK_WAIT_MS = 20;
const ITEM_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const LEDGER_ID = /^ledger_[a-z0-9]+_[a-f0-9]+$/;

/** True when a value can name a stored ledger. Storage validation still applies on read. */
export function isWorkLedgerId(value: unknown): value is string {
  return typeof value === "string" && LEDGER_ID.test(value);
}

export interface WorkItem {
  id: string;
  title: string;
  status: WorkItemStatus;
  /** Conditions that must hold before this item can be completed. */
  completion: string[];
  progress: string;
  nextStep: string;
  blocker: string | null;
  recovery: string | null;
  /** Evidence retained after completion. New evidence appends; it is never silently replaced. */
  evidence: string[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkLedgerHistoryItemChange {
  id: string;
  fields: string[];
  added?: true;
  fromStatus?: WorkItemStatus;
  toStatus?: WorkItemStatus;
}

export interface WorkLedgerHistoryEntry {
  revision: number;
  at: string;
  event: string;
  /** Ledger-level fields changed in this revision. */
  ledgerFields: string[];
  items: WorkLedgerHistoryItemChange[];
  /** Totals after this revision, so count changes stay inspectable without replaying history. */
  totals: WorkLedgerTotals;
}

export interface WorkLedger {
  schema: typeof WORK_LEDGER_SCHEMA;
  id: string;
  revision: number;
  /** Canonical project working directory. Ledgers are discovered by this scope. */
  project: string;
  status: WorkLedgerStatus;
  outcome: string;
  boundaries: string[];
  items: WorkItem[];
  /** Append-only change history, one entry per accepted revision. */
  history: WorkLedgerHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkLedgerTotals {
  total: number;
  open: number;
  pending: number;
  inProgress: number;
  blocked: number;
  completed: number;
  cancelled: number;
}

export interface WorkLedgerSummary {
  id: string;
  revision: number;
  status: WorkLedgerStatus;
  outcome: string;
  totals: WorkLedgerTotals;
  updatedAt: string;
}

export interface WorkItemDraft {
  id?: string;
  title: string;
  status?: WorkItemStatus;
  completion?: string[];
  progress?: string;
  nextStep?: string;
  blocker?: string | null;
  recovery?: string | null;
  evidence?: string[];
}

export interface WorkItemPatch {
  id: string;
  title?: string;
  status?: WorkItemStatus;
  completion?: string[];
  progress?: string;
  nextStep?: string;
  blocker?: string | null;
  recovery?: string | null;
  /** Additional evidence appended to the item. */
  evidence?: string[];
}

export interface CreateWorkLedgerInput {
  outcome: string;
  boundaries?: string[];
  status?: WorkLedgerStatus;
  items?: WorkItemDraft[];
  event?: string;
}

export interface UpdateWorkLedgerInput {
  ledgerId: string;
  revision: number;
  event?: string;
  outcome?: string;
  boundaries?: string[];
  status?: WorkLedgerStatus;
  changes?: WorkItemPatch[];
  addItems?: WorkItemDraft[];
}

export interface WorkLedgerStore {
  /** Ledgers stored for this project, newest update first. */
  list(): WorkLedgerSummary[];
  create(input: CreateWorkLedgerInput): WorkLedger;
  read(ledgerId: string): WorkLedger;
  update(input: UpdateWorkLedgerInput): WorkLedger;
}

export interface WorkLedgerStoreOptions {
  cwd: string;
  agentDir?: string;
  now?: () => Date;
}

export class WorkLedgerRevisionConflictError extends Error {
  readonly code = "work-ledger-revision-conflict";

  constructor(
    readonly ledgerId: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Work ledger ${ledgerId} revision mismatch: expected ${expected}, found ${actual}. `
        + "Read the ledger again before updating.",
    );
    this.name = "WorkLedgerRevisionConflictError";
  }
}

/** Directory holding this project's durable ledgers. */
export function workLedgerDirectory(cwd: string, agentDir = getAgentDir()): string {
  const project = canonicalProject(cwd);
  const key = createHash("sha256").update(project).digest("hex").slice(0, 24);
  return join(agentDir, "work-ledgers", key);
}

export function workLedgerTotals(ledger: WorkLedger): WorkLedgerTotals {
  const totals: WorkLedgerTotals = {
    total: ledger.items.length,
    open: 0,
    pending: 0,
    inProgress: 0,
    blocked: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const item of ledger.items) {
    if (item.status === "pending") totals.pending += 1;
    else if (item.status === "in_progress") totals.inProgress += 1;
    else if (item.status === "blocked") totals.blocked += 1;
    else if (item.status === "completed") totals.completed += 1;
    else totals.cancelled += 1;
  }
  totals.open = totals.pending + totals.inProgress + totals.blocked;
  return totals;
}

export function openWorkLedgerStore(options: WorkLedgerStoreOptions): WorkLedgerStore {
  const project = canonicalProject(options.cwd);
  const directory = workLedgerDirectory(project, options.agentDir ?? getAgentDir());
  const now = options.now ?? (() => new Date());
  const lockPath = join(directory, "project.lock");

  const read = (ledgerId: string): WorkLedger => {
    const file = ledgerFile(directory, ledgerId);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Work ledger ${ledgerId} was not found in this project.`);
      }
      throw error;
    }
    const ledger = parseLedger(text, file);
    if (ledger.project !== project) {
      throw new Error(`Work ledger ${ledgerId} belongs to a different project.`);
    }
    return ledger;
  };

  return {
    list(): WorkLedgerSummary[] {
      if (!existsSync(directory)) return [];
      const ledgers: WorkLedger[] = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".json")) continue;
        const file = join(directory, entry.name);
        const ledger = parseLedger(readFileSync(file, "utf8"), file);
        if (ledger.project === project) ledgers.push(ledger);
      }
      return ledgers
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
        .map((ledger) => ({
          id: ledger.id,
          revision: ledger.revision,
          status: ledger.status,
          outcome: ledger.outcome,
          totals: workLedgerTotals(ledger),
          updatedAt: ledger.updatedAt,
        }));
    },

    create(input: CreateWorkLedgerInput): WorkLedger {
      const createdAt = now();
      const at = createdAt.toISOString();
      const items: WorkItem[] = [];
      for (const [index, draft] of (input.items ?? []).entries()) {
        items.push(createItem(draft, at, uniqueItemId(items, 1, index + 1)));
      }
      assertUniqueItemIds(items);
      const ledger: WorkLedger = {
        schema: WORK_LEDGER_SCHEMA,
        id: nextLedgerId(createdAt),
        revision: 1,
        project,
        status: input.status ?? "active",
        outcome: requiredText(input.outcome, "outcome"),
        boundaries: stringList(input.boundaries ?? [], "boundaries"),
        items,
        history: [],
        createdAt: at,
        updatedAt: at,
      };
      ledger.history.push({
        revision: 1,
        at,
        event: normalizeEvent(input.event, "created"),
        ledgerFields: ["outcome", "boundaries", ...(input.status === undefined ? [] : ["status"])],
        items: items.map((item) => ({ id: item.id, fields: ["created"], added: true })),
        totals: workLedgerTotals(ledger),
      });
      validateLedger(ledger);

      mkdirSync(directory, { recursive: true });
      const release = acquire(lockPath);
      try {
        if (existsSync(join(directory, `${ledger.id}.json`))) {
          throw new Error(`Work ledger ${ledger.id} already exists.`);
        }
        writeAtomic(join(directory, `${ledger.id}.json`), ledger);
      } finally {
        release();
      }
      return ledger;
    },

    read,

    update(input: UpdateWorkLedgerInput): WorkLedger {
      if (!LEDGER_ID.test(input.ledgerId)) throw new Error("A valid ledgerId is required.");
      if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
        throw new Error("A positive revision is required to update a work ledger.");
      }
      mkdirSync(directory, { recursive: true });
      const release = acquire(lockPath);
      try {
        const current = read(input.ledgerId);
        if (input.revision !== current.revision) {
          throw new WorkLedgerRevisionConflictError(input.ledgerId, input.revision, current.revision);
        }
        const next = applyUpdate(current, input, now().toISOString());
        validateLedger(next);
        writeAtomic(join(directory, `${next.id}.json`), next);
        return next;
      } finally {
        release();
      }
    },
  };
}

function canonicalProject(cwd: string): string {
  const absolute = resolve(cwd);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function ledgerFile(directory: string, ledgerId: string): string {
  if (!LEDGER_ID.test(ledgerId)) throw new Error("A valid ledgerId is required.");
  return join(directory, `${ledgerId}.json`);
}

function nextLedgerId(now: Date): string {
  return `ledger_${now.getTime().toString(36)}_${randomBytes(4).toString("hex")}`;
}

function applyUpdate(current: WorkLedger, input: UpdateWorkLedgerInput, at: string): WorkLedger {
  const revision = current.revision + 1;
  const next: WorkLedger = structuredClone(current);
  const ledgerFields: string[] = [];
  const itemChanges: WorkLedgerHistoryItemChange[] = [];

  if (input.outcome !== undefined) {
    next.outcome = requiredText(input.outcome, "outcome");
    ledgerFields.push("outcome");
  }
  if (input.boundaries !== undefined) {
    next.boundaries = stringList(input.boundaries, "boundaries");
    ledgerFields.push("boundaries");
  }
  if (input.status !== undefined) {
    assertWorkLedgerStatus(input.status);
    next.status = input.status;
    ledgerFields.push("status");
  }

  const changes = input.changes ?? [];
  const seen = new Set<string>();
  for (const patch of changes) {
    if (!patch || typeof patch !== "object") throw new Error("Each change must be an item update object.");
    if (seen.has(patch.id)) throw new Error(`Work item ${patch.id} is changed more than once in one update.`);
    seen.add(patch.id);
    const item = next.items.find((candidate) => candidate.id === patch.id);
    if (!item) throw new Error(`Unknown work item ${JSON.stringify(patch.id)}.`);
    itemChanges.push(applyItemPatch(item, patch, at));
  }

  const added: WorkItem[] = [];
  for (const [index, draft] of (input.addItems ?? []).entries()) {
    added.push(createItem(draft, at, uniqueItemId([...next.items, ...added], revision, index + 1)));
  }
  assertUniqueItemIds([...next.items, ...added]);
  for (const item of added) {
    next.items.push(item);
    itemChanges.push({ id: item.id, fields: ["created"], added: true });
  }

  if (ledgerFields.length === 0 && itemChanges.length === 0) {
    throw new Error("A work ledger update needs outcome, boundaries, status, changes, or addItems.");
  }

  next.revision = revision;
  next.updatedAt = at;
  next.history.push({
    revision,
    at,
    event: normalizeEvent(input.event, "updated"),
    ledgerFields,
    items: itemChanges,
    totals: workLedgerTotals(next),
  });
  return next;
}

function applyItemPatch(item: WorkItem, patch: WorkItemPatch, at: string): WorkLedgerHistoryItemChange {
  const fields: string[] = [];
  const fromStatus = item.status;

  if (patch.title !== undefined) {
    item.title = requiredText(patch.title, `item ${item.id} title`, MAX_TITLE_CHARS);
    fields.push("title");
  }
  if (patch.status !== undefined) {
    assertWorkItemStatus(patch.status);
    item.status = patch.status;
    fields.push("status");
  }
  if (patch.completion !== undefined) {
    item.completion = stringList(patch.completion, `item ${item.id} completion`, MAX_LIST_ITEM_CHARS);
    fields.push("completion");
  }
  if (patch.progress !== undefined) {
    item.progress = optionalText(patch.progress, `item ${item.id} progress`);
    fields.push("progress");
  }
  if (patch.nextStep !== undefined) {
    item.nextStep = optionalText(patch.nextStep, `item ${item.id} nextStep`);
    fields.push("nextStep");
  }
  if (patch.blocker !== undefined) {
    item.blocker = nullableText(patch.blocker, `item ${item.id} blocker`);
    fields.push("blocker");
  }
  if (patch.recovery !== undefined) {
    item.recovery = nullableText(patch.recovery, `item ${item.id} recovery`);
    fields.push("recovery");
  }
  if (patch.evidence !== undefined && patch.evidence.length > 0) {
    item.evidence.push(...stringList(patch.evidence, `item ${item.id} evidence`, MAX_LIST_ITEM_CHARS));
    fields.push("evidence");
  }

  if (fields.length === 0) throw new Error(`Work item ${item.id} change sets no fields.`);
  if (item.status === "blocked" && (!item.blocker || !item.recovery)) {
    throw new Error(`Work item ${item.id} is blocked; record both blocker and recovery before updating it.`);
  }
  if (item.status === "completed" && item.evidence.length === 0) {
    throw new Error(`Work item ${item.id} cannot be completed without evidence.`);
  }
  item.updatedAt = at;
  return {
    id: item.id,
    fields,
    ...(fromStatus === item.status ? {} : { fromStatus, toStatus: item.status }),
  };
}

function createItem(draft: WorkItemDraft, at: string, fallbackId: string): WorkItem {
  if (!draft || typeof draft !== "object") throw new Error("Each item must be an object.");
  const id = draft.id ?? fallbackId;
  if (!ITEM_ID.test(id)) {
    throw new Error(`Work item id ${JSON.stringify(id)} must use letters, digits, underscore, or hyphen (max 64).`);
  }
  const item: WorkItem = {
    id,
    title: requiredText(draft.title, `item ${id} title`, MAX_TITLE_CHARS),
    status: draft.status ?? "pending",
    completion: stringList(draft.completion ?? [], `item ${id} completion`, MAX_LIST_ITEM_CHARS),
    progress: optionalText(draft.progress, `item ${id} progress`),
    nextStep: optionalText(draft.nextStep, `item ${id} nextStep`),
    blocker: nullableText(draft.blocker, `item ${id} blocker`),
    recovery: nullableText(draft.recovery, `item ${id} recovery`),
    evidence: stringList(draft.evidence ?? [], `item ${id} evidence`, MAX_LIST_ITEM_CHARS),
    createdAt: at,
    updatedAt: at,
  };
  assertWorkItemStatus(item.status);
  if (item.status === "blocked" && (!item.blocker || !item.recovery)) {
    throw new Error(`Work item ${item.id} is blocked; record both blocker and recovery.`);
  }
  if (item.status === "completed" && item.evidence.length === 0) {
    throw new Error(`Work item ${item.id} cannot be completed without evidence.`);
  }
  return item;
}

function assertUniqueItemIds(items: WorkItem[]): void {
  if (items.length > MAX_ITEMS) throw new Error(`A work ledger cannot contain more than ${MAX_ITEMS} items.`);
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`Work item id ${item.id} is duplicated.`);
    ids.add(item.id);
  }
}

function uniqueItemId(items: WorkItem[], revision: number, index: number): string {
  const ids = new Set(items.map((item) => item.id));
  const base = `item_${revision}_${index}`;
  let candidate = base;
  let suffix = 2;
  while (ids.has(candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

function validateLedger(ledger: WorkLedger): void {
  if (ledger.schema !== WORK_LEDGER_SCHEMA) throw new Error("Unsupported work ledger schema.");
  if (!LEDGER_ID.test(ledger.id)) throw new Error("Invalid work ledger id.");
  if (!Number.isSafeInteger(ledger.revision) || ledger.revision < 1) throw new Error("Invalid work ledger revision.");
  if (typeof ledger.project !== "string" || !ledger.project) throw new Error("Invalid work ledger project.");
  assertWorkLedgerStatus(ledger.status);
  requiredText(ledger.outcome, "outcome");
  stringList(ledger.boundaries, "boundaries");
  if (typeof ledger.createdAt !== "string" || !ledger.createdAt ||
      typeof ledger.updatedAt !== "string" || !ledger.updatedAt) {
    throw new Error("Invalid work ledger timestamps.");
  }
  if (!Array.isArray(ledger.items)) throw new Error("Invalid work ledger items.");
  assertUniqueItemIds(ledger.items);
  for (const item of ledger.items) {
    if (!item || typeof item !== "object") throw new Error("Invalid work ledger item.");
    if (!ITEM_ID.test(item.id)) throw new Error("Invalid work item id.");
    requiredText(item.title, `item ${item.id} title`, MAX_TITLE_CHARS);
    assertWorkItemStatus(item.status);
    stringList(item.completion, `item ${item.id} completion`, MAX_LIST_ITEM_CHARS);
    optionalText(item.progress, `item ${item.id} progress`);
    optionalText(item.nextStep, `item ${item.id} nextStep`);
    nullableText(item.blocker, `item ${item.id} blocker`);
    nullableText(item.recovery, `item ${item.id} recovery`);
    stringList(item.evidence, `item ${item.id} evidence`, MAX_LIST_ITEM_CHARS);
    if (typeof item.createdAt !== "string" || !item.createdAt ||
        typeof item.updatedAt !== "string" || !item.updatedAt) {
      throw new Error(`Invalid work item ${item.id} timestamps.`);
    }
    if (item.status === "blocked" && (!item.blocker || !item.recovery)) {
      throw new Error(`Work item ${item.id} is blocked without blocker and recovery conditions.`);
    }
    if (item.status === "completed" && item.evidence.length === 0) {
      throw new Error(`Work item ${item.id} is completed without evidence.`);
    }
  }
  if (ledger.status === "completed" && ledger.items.some((item) =>
    item.status === "pending" || item.status === "in_progress" || item.status === "blocked")) {
    throw new Error("A work ledger cannot be completed while items remain open; complete or cancel them first.");
  }
  if (!Array.isArray(ledger.history) || ledger.history.length === 0) {
    throw new Error("Invalid work ledger history.");
  }
  let lastRevision = 0;
  for (const entry of ledger.history) {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.revision) ||
        entry.revision !== lastRevision + 1 || typeof entry.at !== "string" ||
        typeof entry.event !== "string" || !Array.isArray(entry.ledgerFields) || !Array.isArray(entry.items) ||
        !validTotals(entry.totals)) {
      throw new Error("Invalid work ledger history entry.");
    }
    lastRevision = entry.revision;
  }
  if (lastRevision !== ledger.revision) {
    throw new Error("Work ledger revision does not match its change history.");
  }
  if (JSON.stringify(ledger.history[ledger.history.length - 1]!.totals) !== JSON.stringify(workLedgerTotals(ledger))) {
    throw new Error("Work ledger totals do not match its latest history entry.");
  }
}

function validTotals(value: unknown): value is WorkLedgerTotals {
  if (!value || typeof value !== "object") return false;
  const totals = value as WorkLedgerTotals;
  return ["total", "open", "pending", "inProgress", "blocked", "completed", "cancelled"]
    .every((key) => Number.isSafeInteger(totals[key as keyof WorkLedgerTotals]) &&
      totals[key as keyof WorkLedgerTotals] >= 0);
}

function parseLedger(text: string, file: string): WorkLedger {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Work ledger at ${file} is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Work ledger at ${file} is not a JSON object.`);
  }
  const ledger = value as WorkLedger;
  try {
    validateLedger(ledger);
  } catch (error) {
    throw new Error(
      `Work ledger at ${file} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (basename(file) !== `${ledger.id}.json`) {
    throw new Error(`Work ledger at ${file} has a mismatched id.`);
  }
  return ledger;
}

function requiredText(value: unknown, label: string, max = MAX_TEXT_CHARS): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Work ledger ${label} must not be empty.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`Work ledger ${label} cannot exceed ${max} characters.`);
  return text;
}

function optionalText(value: unknown, label: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`Work ledger ${label} must be a string.`);
  if (value.length > MAX_TEXT_CHARS) throw new Error(`Work ledger ${label} cannot exceed ${MAX_TEXT_CHARS} characters.`);
  return value.trim();
}

function nullableText(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`Work ledger ${label} must be a string or null.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_TEXT_CHARS) throw new Error(`Work ledger ${label} cannot exceed ${MAX_TEXT_CHARS} characters.`);
  return text;
}

function stringList(value: unknown, label: string, itemMax = MAX_TEXT_CHARS): string[] {
  if (!Array.isArray(value)) throw new Error(`Work ledger ${label} must be a list of strings.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`Work ledger ${label}[${index}] must not be empty.`);
    }
    const text = entry.trim();
    if (text.length > itemMax) {
      throw new Error(`Work ledger ${label}[${index}] cannot exceed ${itemMax} characters.`);
    }
    return text;
  });
}

function normalizeEvent(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return requiredText(value, "event", MAX_EVENT_CHARS);
}

function assertWorkLedgerStatus(value: unknown): asserts value is WorkLedgerStatus {
  if (!WORK_LEDGER_STATUSES.includes(value as WorkLedgerStatus)) {
    throw new Error(`Invalid work ledger status ${JSON.stringify(value)}.`);
  }
}

function assertWorkItemStatus(value: unknown): asserts value is WorkItemStatus {
  if (!WORK_ITEM_STATUSES.includes(value as WorkItemStatus)) {
    throw new Error(`Invalid work item status ${JSON.stringify(value)}.`);
  }
}

function acquire(path: string): () => void {
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    try {
      return lockfile.lockSync(path, { realpath: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === MAX_LOCK_ATTEMPTS - 1) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  throw new Error(`Cannot lock work ledger at ${path}.`);
}

function writeAtomic(file: string, ledger: WorkLedger): void {
  const temp = join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(ledger, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  try {
    const directoryFd = openSync(dirname(file), "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch {
    // Some platforms refuse fsync on a directory fd; atomicity is unaffected.
  }
}
