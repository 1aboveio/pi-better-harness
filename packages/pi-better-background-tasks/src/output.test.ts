import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { recordFailure } from "./failures.js";
import { pageTaskLog, readLog, retainLogTail } from "./logs.js";
import {
  BACKGROUND_OUTPUT_BUDGET_BYTES,
  BACKGROUND_OUTPUT_HARD_CAP_BYTES,
  backgroundBudget,
  formatLaunch,
  formatList,
  formatLog,
  formatStatus,
  utf8ByteLength,
} from "./output.js";
import { inspectMeta, logPathFor, metaPathFor, taskDir, writeMeta } from "./registry.js";
import { registerTools } from "./tools.js";
import type { BackgroundTaskCallbackOrigin, BackgroundTaskMeta, Condition } from "./types.js";

const createdIds: string[] = [];
const origin: BackgroundTaskCallbackOrigin = { cwd: "/tmp/output-scope", sessionId: "session-a" };
const otherOrigin: BackgroundTaskCallbackOrigin = { cwd: "/tmp/output-scope", sessionId: "session-b" };

afterEach(() => {
  for (const id of createdIds.splice(0)) rmSync(taskDir(id), { recursive: true, force: true });
});

function fixture(overrides: Partial<BackgroundTaskMeta> & { logLines?: string[] } = {}): BackgroundTaskMeta {
  const { logLines, ...rest } = overrides;
  const id = rest.id ?? `bg_output_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  createdIds.push(id);
  mkdirSync(taskDir(id), { recursive: true });
  const logPath = rest.logPath ?? logPathFor(id);
  if (logLines) writeFileSync(logPath, `${logLines.join("\n")}\n`);
  else writeFileSync(logPath, "");
  const meta: BackgroundTaskMeta = {
    id,
    kind: "command_watch",
    status: "succeeded",
    startedAt: 1,
    endedAt: 2,
    logPath,
    cwd: origin.cwd,
    spawnPid: process.pid,
    callback: false,
    callbackOrigin: origin,
    ...rest,
  };
  writeMeta(meta);
  return meta;
}

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

function register(): Record<string, any> {
  const tools: Record<string, any> = {};
  registerTools({
    on() {},
    registerTool(tool: any) { tools[tool.name] = tool; },
  } as any);
  return tools;
}

const ctx = {
  cwd: origin.cwd,
  sessionManager: { getSessionId: () => origin.sessionId },
};

describe("background output budgets", () => {
  it("uses revised consumer defaults and clamps explicit pages to the core hard cap", () => {
    expect(BACKGROUND_OUTPUT_BUDGET_BYTES).toEqual({ status: 1024, log: 1024, list: 1024, rawPage: 16 * 1024 });
    expect(backgroundBudget("status")).toBe(1024);
    expect(backgroundBudget("log", 512)).toBe(512);
    expect(backgroundBudget("rawPage", 32 * 1024)).toBe(32 * 1024);
    expect(backgroundBudget("rawPage", 99_999)).toBe(BACKGROUND_OUTPUT_HARD_CAP_BYTES.rawPage);
    expect(backgroundBudget("status", 99_999)).toBe(BACKGROUND_OUTPUT_HARD_CAP_BYTES.status);
  });

  it("keeps default status, log, and list payloads within 1 KiB including headers and continuation", async () => {
    const meta = fixture({
      name: "budget",
      logLines: [JSON.stringify({ terminalFailure: true, blob: "x".repeat(4000) })],
      result: {
        reason: "failure condition matched",
        matchedCondition: { type: "json_path_equals", path: "$.terminalFailure", value: true },
        matchedValue: true,
      },
      lastExitCode: 0,
      captureDiscardedBytes: 1_200_012,
      captureOverflowEvents: 1,
    });
    recordFailure(meta, "failure_when", "failure condition matched", "poll", { category: "condition" });
    const tools = register();
    const status = textOf(await tools.bg_task_status.execute("tc", { id: meta.id }, undefined, undefined, ctx));
    const log = textOf(await tools.bg_task_log.execute("tc", { id: meta.id }, undefined, undefined, ctx));
    const list = textOf(await tools.bg_task_list.execute("tc", {}, undefined, undefined, ctx));
    expect(utf8ByteLength(status)).toBeLessThanOrEqual(1024);
    expect(utf8ByteLength(log)).toBeLessThanOrEqual(1024);
    expect(utf8ByteLength(list)).toBeLessThanOrEqual(1024);
    expect(status).toMatch(/^Unresolved failure/);
    expect(status).toContain("Condition matched: $.terminalFailure = true");
    expect(status).toContain("observed: true");
    expect(status).toContain("capture overflow discarded 1200012");
    expect(status).not.toContain("PATH=");
    expect(status).not.toContain("success_when");
  });

  it("pages a long unicode JSON line without exceeding the status budget", () => {
    const line = `{"msg":"${"你好🌟".repeat(400)}"}`;
    const meta = fixture({ lastState: JSON.parse(line), logLines: [line] });
    const status = formatStatus(inspectMeta(meta.id), { origin });
    expect(utf8ByteLength(status)).toBeLessThanOrEqual(1024);
    expect(status).toContain(`Background task ${meta.id} is succeeded`);
  });
});

describe("matched condition, stop error, and missing evidence", () => {
  it("renders the matched condition and observed value before progress", () => {
    const condition: Condition = { type: "json_path_equals", path: "$.status", value: "done" };
    const meta = fixture({
      result: { reason: "success condition matched", matchedCondition: condition, matchedValue: "done" },
      lastExitCode: 0,
    });
    const text = formatStatus(inspectMeta(meta.id), { origin });
    expect(text).toContain("Condition matched: $.status = done");
    expect(text).toContain("observed: done");
    expect(text.indexOf("Condition matched")).toBeLessThan(text.indexOf("kind:"));
  });

  it("surfaces a stop error while the task remains running", () => {
    const meta = fixture({
      status: "running",
      endedAt: undefined,
      stopError: "Permission denied while terminating process tree.",
      error: "Permission denied while terminating process tree.",
    });
    const text = formatStatus(inspectMeta(meta.id), { origin });
    expect(text).toContain("stop failed");
    expect(text).toContain("Permission denied while terminating process tree.");
    expect(text).toContain("The task may still be executing.");
    expect(text).toContain("is running");
  });

  it("does not treat unreadable metadata as missing or healthy", () => {
    const meta = fixture();
    writeFileSync(metaPathFor(meta.id), "{broken");
    const text = formatStatus(inspectMeta(meta.id), { origin });
    expect(text).toContain("metadata is unreadable");
    expect(text).toContain("invalid JSON");
    expect(text).not.toMatch(/No background task found/);
    expect(text).not.toContain("is succeeded");
    expect(text).toContain("gap read");
  });

  it("does not treat a missing log as an empty healthy log", () => {
    const meta = fixture();
    rmSync(meta.logPath, { force: true });
    const text = formatLog(meta.id, { origin });
    expect(text).toMatch(/log unreadable/);
    expect(text).not.toContain("(log is empty)");
    expect(text).toContain("Cannot treat this as an empty healthy log");
  });

  it("distinguishes a readable empty log from a missing log", () => {
    const meta = fixture({ logLines: [] });
    writeFileSync(meta.logPath, "");
    const empty = formatLog(meta.id, { origin });
    expect(empty).toContain("(log is empty)");
    expect(empty).not.toContain("log unreadable");
  });
});

describe("session scope", () => {
  it("defaults list and direct reads to the current session", async () => {
    const now = Date.now() + 50_000;
    const ours = fixture({ name: "ours", startedAt: now });
    const foreign = fixture({ name: "foreign", callbackOrigin: otherOrigin, startedAt: now });
    const unknown = fixture({ name: "unknown", callbackOrigin: undefined, startedAt: now });
    const tools = register();
    const list = textOf(await tools.bg_task_list.execute("tc", {}, undefined, undefined, ctx));
    expect(list).toContain(ours.id);
    expect(list).not.toContain(foreign.id);
    expect(list).toMatch(/unavailable ownership/);
    expect(list).not.toMatch(new RegExp(`^${unknown.id} `));

    const foreignStatus = textOf(await tools.bg_task_status.execute("tc", { id: foreign.id }, undefined, undefined, ctx));
    expect(foreignStatus).toContain("outside the current session scope");
    expect(foreignStatus).not.toContain("is succeeded");
    expect(foreignStatus).not.toMatch(/No background task found/);

    const unknownStatus = textOf(await tools.bg_task_status.execute("tc", { id: unknown.id }, undefined, undefined, ctx));
    expect(unknownStatus).toContain("ownership is unavailable");
    expect(unknownStatus).not.toMatch(/No background task found/);

    const allList = textOf(await tools.bg_task_list.execute("tc", { all: true, limit: 20 }, undefined, undefined, ctx));
    expect(allList).toContain(ours.id);
    expect(allList).toContain(foreign.id);

    const allStatus = textOf(await tools.bg_task_status.execute("tc", { id: foreign.id, all: true }, undefined, undefined, ctx));
    expect(allStatus).toContain(`Background task ${foreign.id} is succeeded`);
  });

  it("binds status cursors to the selected session scope", () => {
    const meta = fixture();
    const scoped = formatStatus(inspectMeta(meta.id), { origin });
    const cursor = scoped.match(/cursor=(\S+)/)?.[1];
    expect(cursor).toBeTruthy();
    const replay = formatStatus(inspectMeta(meta.id), { origin, cursor });
    expect(replay).toContain("No new evidence since cursor");
    const crossed = formatStatus(inspectMeta(meta.id), { origin: otherOrigin, all: true, cursor });
    expect(crossed).not.toContain("No new evidence since cursor");
    expect(crossed).toMatch(/reset=stale-cursor|Background task/);
  });
});

describe("failure-only revisions and wrapper identity", () => {
  it("returns failure-only updates when log bytes are unchanged", () => {
    const meta = fixture({ logLines: ["same"] });
    const first = formatStatus(inspectMeta(meta.id), { origin });
    const cursor = first.match(/cursor=(\S+)/)?.[1];
    expect(cursor).toBeTruthy();
    recordFailure(meta, "poll", "poll failed", "1", { category: "operation" });
    const second = formatStatus(inspectMeta(meta.id), { origin, cursor });
    expect(second).toContain("Unresolved failure");
    expect(second).toContain("poll failed");
    expect(second).toContain("change=failure");
    expect(second).not.toContain("No new evidence since cursor");
  });

  it("uses the same assembler for standalone tools and action wrappers", async () => {
    const meta = fixture({
      result: {
        matchedCondition: { type: "exit_code", equals: 0 },
        matchedValue: 0,
      },
      lastExitCode: 0,
      logLines: ["wrapper-same"],
    });
    const tools = register();
    const status = textOf(await tools.bg_task_status.execute("tc", { id: meta.id }, undefined, undefined, ctx));
    const wrapped = textOf(await tools.bg_status.execute("tc", { action: "status", id: meta.id }, undefined, undefined, ctx));
    expect(wrapped).toBe(status);
    const log = textOf(await tools.bg_task_log.execute("tc", { id: meta.id }, undefined, undefined, ctx));
    const wrappedLog = textOf(await tools.bg_task.execute("tc", { action: "log", id: meta.id }, undefined, undefined, ctx));
    expect(wrappedLog).toBe(log);
  });

  it("keeps launch failures ahead of the started line", () => {
    const meta = fixture({ status: "failed" });
    recordFailure(meta, "execution", "Process exited with code 9", "close", { category: "exit" });
    expect(formatLaunch(inspectMeta(meta.id)!.meta!)).toMatch(/^Unresolved failure.*Process exited with code 9/);
  });
});

describe("retained log paging and capture/retention disclosure", () => {
  it("reconstructs retained raw bytes without skipping unread snapshot ranges", () => {
    const payload = Array.from({ length: 40 }, (_, index) => `row-${String(index).padStart(2, "0")}-${"ab".repeat(40)}`).join("\n");
    const meta = fixture({ logLines: payload.split("\n"), logGeneration: 0 });
    const pages: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i += 1) {
      const page = pageTaskLog(meta, { cursor, maxBytes: 200 });
      pages.push(page.text);
      if (page.reset) expect(page.reset).not.toBe("stale-cursor");
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(pages.join("")).toBe(payload + "\n");
  });

  it("discloses capture and retention loss and resets after same-inode compaction", () => {
    const meta = fixture({
      logLines: [`${"discarded\n".repeat(12_000)}final diagnostic`],
      logGeneration: 0,
    });
    const before = pageTaskLog(meta, { maxBytes: 64 });
    expect(before.text.length).toBeGreaterThan(0);
    const compacted = retainLogTail(meta.logPath, 64 * 1024);
    expect(compacted?.discardedBytes).toBeGreaterThan(0);
    writeMeta({
      ...inspectMeta(meta.id).meta!,
      logDiscardedBytes: compacted!.discardedBytes,
      logRetentionEvents: 1,
      logGeneration: 1,
    });
    const after = pageTaskLog(inspectMeta(meta.id).meta!, { cursor: before.cursor, maxBytes: 64 });
    expect(after.reset).toBe("compacted");
    expect(after.gaps.some((gap) => gap.kind === "retention" && (gap.bytes ?? 0) > 0)).toBe(true);
    const formatted = formatLog(meta.id, { origin, raw: true });
    expect(formatted).toContain("not recoverable");
    expect(formatted).not.toMatch(/full history recovered/i);
  });

  it("defaults log tails to 10 display rows and pages raw bytes at tail_lines 0", () => {
    const lines = Array.from({ length: 25 }, (_, index) => `tail-line-${String(index + 1).padStart(2, "0")}`);
    const meta = fixture({ logLines: lines });
    const compact = formatLog(meta.id, { origin });
    expect(compact).not.toContain("tail-line-15");
    expect(compact).toContain("tail-line-16");
    expect(compact).toContain("tail-line-25");
    expect(utf8ByteLength(compact)).toBeLessThanOrEqual(1024);
    const raw = formatLog(meta.id, { origin, tailLines: 0 });
    expect(raw).toContain("tail-line-01");
    expect(raw).toContain("tail-line-25");
  });
});

describe("list defaults", () => {
  it("shows 10 compact rows by default and omits full failure paragraphs per task", () => {
    const ids = Array.from({ length: 12 }, (_, index) => fixture({
      id: `bg_list_${index}_${Date.now()}`,
      name: `row${index}`,
      startedAt: 1000 - index,
    }).id);
    const listed = formatList({ origin });
    expect(listed).toContain("10 background tasks");
    expect(listed).toContain("2 more task");
    expect(listed).toContain(ids[0]);
    expect(listed).not.toContain(ids[11]);
    expect(listed).not.toMatch(/Unresolved failure[\s\S]*Unresolved failure/);
    const wider = formatList({ origin, limit: 20, maxBytes: 4096 });
    expect(wider).toContain(ids[11]);
  });
});
