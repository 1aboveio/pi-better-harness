/**
 * Codex stores a thread as one append-only rollout file,
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<threadId>.jsonl`. The app-server
 * rebuilds its own indexes (state db, paginated history) from that file, so the rollout
 * is the whole portable thread. This module finds, reads and re-homes it.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";

export const ROLLOUT_NAME = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export interface RolloutMeta {
  id: string;
  cwd: string;
  createdAt?: string;
  cliVersion?: string;
  modelProvider?: string;
}

function dirs(parent: string): string[] {
  try {
    return readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    return [];
  }
}

/** Absolute path of the thread's rollout under `<root>` (sessions/ or archived_sessions/), or undefined. */
export function findRollout(root: string, threadId: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const suffix = `-${threadId}.jsonl`;
  const check = (dir: string): string | undefined => {
    try {
      return readdirSync(dir).find((name) => name.startsWith("rollout-") && name.endsWith(suffix));
    } catch {
      return undefined;
    }
  };
  // archived_sessions is flat; sessions/ is year/month/day.
  const flat = check(root);
  if (flat) return join(root, flat);
  for (const year of dirs(root)) for (const month of dirs(join(root, year))) for (const day of dirs(join(root, year, month))) {
    const found = check(join(root, year, month, day));
    if (found) return join(root, year, month, day, found);
  }
  return undefined;
}

/** First line of a rollout, without reading the whole file. */
export function readFirstLine(file: string): string {
  const fd = openSync(file, "r");
  try {
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      const newline = buffer.subarray(0, read).indexOf(10);
      chunks.push(Buffer.from(buffer.subarray(0, newline === -1 ? read : newline)));
      if (newline !== -1) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function readRolloutMeta(file: string): RolloutMeta {
  const first = JSON.parse(readFirstLine(file)) as { type?: string; payload?: Record<string, any> };
  const payload = first.payload ?? {};
  if (first.type !== "session_meta" || typeof payload.id !== "string" || typeof payload.cwd !== "string") throw new Error(`${file} does not start with a Codex session_meta record`);
  return {
    id: payload.id,
    cwd: payload.cwd,
    ...(typeof payload.timestamp === "string" ? { createdAt: payload.timestamp } : {}),
    ...(typeof payload.cli_version === "string" ? { cliVersion: payload.cli_version } : {}),
    ...(typeof payload.model_provider === "string" ? { modelProvider: payload.model_provider } : {}),
  };
}

/** The object holding the workspace fields in a record, if it is one that does. */
function workspaceHolder(record: { type?: string; payload?: Record<string, any> }): Record<string, unknown> | undefined {
  if (record.type === "session_meta" || record.type === "turn_context") return record.payload;
  // The app-server resumes a thread with the last settings it recorded, and those name the workspace too.
  if (record.type === "event_msg" && record.payload?.type === "thread_settings_applied") return record.payload.thread_settings;
  return undefined;
}

/**
 * Point a rollout at the workspace's new location. Only the structured working
 * directory fields (`cwd`, `runtime_workspace_roots`, `workspace_roots`) of the
 * session_meta, turn_context and thread_settings_applied records change; conversation content stays byte for
 * byte what was said, even where it mentions the old path.
 */
export function rewriteRolloutCwd(text: string, from: string, to: string): { text: string; changed: number } {
  if (from === to) return { text, changed: 0 };
  let changed = 0;
  const swap = (value: unknown): unknown => (value === from ? ((changed += 1), to) : value);
  const lines = text.split("\n").map((line) => {
    if (!line || !line.includes(from)) return line;
    let record: { type?: string; payload?: Record<string, any> };
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    const holder = workspaceHolder(record);
    if (!holder) return line;
    holder.cwd = swap(holder.cwd);
    for (const key of ["runtime_workspace_roots", "workspace_roots"]) {
      const roots = holder[key];
      if (Array.isArray(roots)) holder[key] = roots.map(swap);
    }
    return JSON.stringify(record);
  });
  return { text: lines.join("\n"), changed };
}

/**
 * Bind a rollout to another model provider. Two records carry it: `model_provider` of session_meta, and
 * `model_provider_id` of every `thread_settings_applied` event (the app-server resumes a thread with the last
 * settings it recorded, so leaving them behind would keep the old provider). Everything else, including the
 * turns already recorded under the old provider, stays byte for byte.
 */
export function rewriteRolloutProvider(text: string, provider: string): { text: string; changed: number } {
  let changed = 0;
  const lines = text.split("\n").map((line) => {
    if (!line.includes("model_provider")) return line;
    let record: { type?: string; payload?: Record<string, any> };
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    const holder = record.type === "session_meta" ? record.payload : record.type === "event_msg" && record.payload?.type === "thread_settings_applied" ? record.payload.thread_settings : undefined;
    const key = record.type === "session_meta" ? "model_provider" : "model_provider_id";
    if (!holder || typeof holder[key] !== "string" || holder[key] === provider) return line;
    holder[key] = provider;
    changed += 1;
    return JSON.stringify(record);
  });
  return { text: lines.join("\n"), changed };
}

/** Latest name recorded for a thread in session_index.jsonl, if any. */
export function readThreadName(home: string, threadId: string): string | undefined {
  const file = join(home, "session_index.jsonl");
  if (!existsSync(file)) return undefined;
  let name: string | undefined;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes(threadId)) continue;
    try {
      const entry = JSON.parse(line) as { id?: string; thread_name?: string };
      if (entry.id === threadId && entry.thread_name) name = entry.thread_name;
    } catch {
      /* skip a damaged line */
    }
  }
  return name;
}
