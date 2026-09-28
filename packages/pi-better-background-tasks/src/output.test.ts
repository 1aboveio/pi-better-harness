import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { recordFailure } from "./failures.js";
import { packCallbackBatch } from "./shared-callback-batcher.js";
import { pageTaskLog, readLog, retainLogTail } from "./logs.js";
import {
  BACKGROUND_OUTPUT_BUDGET_BYTES,
  BACKGROUND_OUTPUT_HARD_CAP_BYTES,
  backgroundBudget,
  formatCallbackFacts,
  formatLaunch,
  formatList,
  formatLog,
  formatStatus,
  utf8ByteLength,
} from "./output.js";
import { inspectMeta, logPathFor, metaPathFor, taskDir, writeMeta } from "./registry.js";
import { registerTools } from "./tools.js";
import { ensureBackgroundTasksNavigator, ensureBackgroundTasksNavigatorProvider } from "./navigator-provider.js";
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
    expect(BACKGROUND_OUTPUT_HARD_CAP_BYTES).toEqual({ status: 2 * 1024, log: 4 * 1024, list: 4 * 1024, rawPage: 64 * 1024 });
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
    expect(status).toMatch(/^Action required/);
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
    const cursor = scoped.match(/statusCursor=(\S+)/)?.[1];
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
    const cursor = first.match(/statusCursor=(\S+)/)?.[1];
    expect(cursor).toBeTruthy();
    recordFailure(meta, "poll", "poll failed", "1", { category: "operation" });
    const second = formatStatus(inspectMeta(meta.id), { origin, cursor });
    expect(second).toContain("Action required");
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
    expect(formatLaunch(inspectMeta(meta.id)!.meta!)).toMatch(/^Action required.*Process exited with code 9/);
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

  it("does not replace UTF-8 in a clipped long-line tail and pages omitted incidents", () => {
    const line = `{"msg":"${"你好🌟".repeat(800)}","end":"TAIL_MARK"}`;
    const meta = fixture({ logLines: [line] });
    for (let i = 0; i < 12; i += 1) {
      recordFailure(meta, `poll-${i}`, `bg-incident-${i}`, `event-${i}`, { category: "operation" });
    }
    const status = formatStatus(inspectMeta(meta.id), { origin });
    expect(utf8ByteLength(status)).toBeLessThanOrEqual(1024);
    expect(status).not.toContain("\uFFFD");
    expect(status).toMatch(/incidentCursor=i1\./);
    const shownCount = Number(status.match(/(\d+) shown/)?.[1]);
    expect(status).toMatch(new RegExp(`12 active failure observations · ${shownCount} shown · ${12 - shownCount} omitted`));
    let cursor = status.match(/incidentCursor=(i1\.\S+)/)?.[1];
    expect(cursor).toBeTruthy();
    const seen = new Set<string>();
    for (const match of status.matchAll(/bg-incident-(\d+)/g)) seen.add(match[1]!);
    expect(seen.size).toBe(shownCount);
    for (let pages = 0; pages < 20 && cursor; pages += 1) {
      const page = formatStatus(inspectMeta(meta.id), { origin, cursor });
      expect(utf8ByteLength(page)).toBeLessThanOrEqual(1024);
      expect(page).toContain("Incident page of 12 active failure observations");
      for (const match of page.matchAll(/bg-incident-(\d+)/g)) {
        expect(seen.has(match[1]!), `incident ${match[1]} repeated`).toBe(false);
        seen.add(match[1]!);
      }
      cursor = page.includes("hasMore=true") ? page.match(/nextCursor=(i1\.\S+)/)?.[1] : undefined;
    }
    expect([...seen].sort()).toEqual(Array.from({ length: 12 }, (_, i) => String(i)).sort());
    const log = formatLog(meta.id, { origin });
    expect(utf8ByteLength(log)).toBeLessThanOrEqual(1024);
    expect(log).not.toContain("\uFFFD");
    const rawPages: string[] = [];
    let rawCursor: string | undefined;
    for (let i = 0; i < 30; i += 1) {
      const pageText = formatLog(meta.id, { origin, tailLines: 0, cursor: rawCursor, maxBytes: 4096 });
      rawPages.push(pageText);
      const next = pageText.match(/nextCursor=(\S+)/)?.[1];
      if (!next || !pageText.includes("hasMore=true")) break;
      rawCursor = next;
    }
    expect(rawPages.join("")).toContain("TAIL_MARK");
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
    expect(utf8ByteLength(listed)).toBeLessThanOrEqual(1024);
    expect(listed).toContain("12 background tasks (current session)");
    // Rows shown depend on the byte budget left after registry-wide notes
    // (another file's unreadable record adds one), so assert the split, not
    // a fixed count: at most the 10-row default, newest first, the rest omitted.
    const shown = ids.filter((id) => listed.includes(id)).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThanOrEqual(10);
    expect(ids.slice(0, shown).every((id) => listed.includes(id))).toBe(true);
    expect(listed).toContain(`hasMore=true omittedRows=${12 - shown}`);
    expect(listed).not.toContain(ids[11]);
    expect(listed).not.toMatch(/Action required[\s\S]*Action required/);
    const next = formatList({ origin, cursor: listed.match(/nextCursor=(\S+)/)?.[1] });
    for (const id of ids.slice(shown)) expect(next).toContain(id);
    expect(next).not.toContain(ids[shown - 1]);
    expect(next).not.toContain("hasMore=true");
    const wider = formatList({ origin, limit: 20, maxBytes: 4096 });
    expect(wider).toContain(ids[11]);
  });
});

describe("callback facts", () => {
  it("exposes matched-condition and gap facts without env dumps or tool histories", () => {
    const meta = fixture({
      status: "failed",
      env: { SECRET: "should-not-appear" },
      result: {
        reason: "failure condition matched",
        matchedCondition: { type: "json_path_equals", path: "$.terminalFailure", value: true },
        matchedValue: true,
      },
      lastExitCode: 0,
      captureDiscardedBytes: 1200,
      captureOverflowEvents: 1,
    });
    recordFailure(meta, "failure_when", "failure condition matched", "poll", { category: "condition" });
    const facts = formatCallbackFacts(meta);
    expect(facts.outcome).toBe("failed");
    expect(facts.decision).toContain("Condition matched: $.terminalFailure = true");
    expect(facts.decision).toContain("capture overflow discarded 1200 bytes");
    expect(facts.failureRows?.[0]).toMatch(/Action required/);
    expect(facts.incidentCount).toBe(1);
    expect(JSON.stringify(facts)).not.toContain("SECRET");
    expect(JSON.stringify(facts)).not.toMatch(/tools used:/);
  });
});

describe("quiet failure history", () => {
  it("counts expected failures as history without an incident cursor and lists them only on request", async () => {
    const meta = fixture({ status: "failed", lastExitCode: 1, callbackOrigin: origin });
    recordFailure(meta, "exit", "process exited with code 1 (declared expected)", "exit", { category: "exit", expected: true, evidence: `${meta.logPath}#exit` });
    const status = formatStatus(meta, { origin });
    expect(status).toContain("No failures need action · 1 expected (history)");
    expect(status).not.toMatch(/incidentCursor=|Expected failure ·/);
    const facts = formatCallbackFacts(meta);
    expect(facts.failureRows).toBeUndefined();
    expect(facts.decision).toContain("No failures need action · 1 expected (history)");
    const tools = register();
    const history = textOf(await tools.bg_task_status.execute("x", { id: meta.id, history: true }, undefined, undefined, { cwd: origin.cwd, sessionManager: { getSessionId: () => origin.sessionId } }));
    expect(history).toMatch(/History page of 1 failure observation/);
    expect(history).toMatch(/^Expected failure · .*declared expected\) · evidence: output\.log#exit$/m);
  });

  it("#332 a tight callback budget keeps the history line whenever it shows any decision", () => {
    const meta = fixture({ status: "failed", lastExitCode: 1, callbackOrigin: origin, captureDiscardedBytes: 4096,
      result: { reason: `process exited with code 1: ${"a long reason ".repeat(20)}` } });
    recordFailure(meta, "exit", "process exited with code 1 (declared expected)", "exit", { category: "exit", expected: true });
    const facts = formatCallbackFacts(meta);
    const event = { source: "background-task" as const, id: meta.id, label: meta.id, status: "failed", detailTool: "bg_task_status" as const,
      outcome: facts.outcome, decision: facts.decision, callback: true };
    let clipped = 0;
    for (let maxBytes = 200; maxBytes <= 1200; maxBytes += 10) {
      const text = packCallbackBatch([event], { maxBytes }).text;
      if (!text.includes("decision: ")) continue;
      if (!text.includes("capture overflow")) clipped += 1;
      expect(text, `budget ${maxBytes}`).toContain("No failures need action · 1 expected (history)");
    }
    expect(clipped, "some budgets keep only a prefix of the decision").toBeGreaterThan(0);
  });

  it("completion callback facts count history beside actionable rows", () => {
    const meta = fixture({ status: "failed", lastExitCode: 7, callbackOrigin: origin });
    recordFailure(meta, "probe", "probe exited with code 1 (declared expected)", "probe", { category: "exit", expected: true });
    recordFailure(meta, "poll", "evaluator failed", "poll-1", { category: "condition" });
    const facts = formatCallbackFacts(meta);
    expect(facts.failureRows).toHaveLength(1);
    expect(facts.decision).toContain("Also in history: 1 expected");
  });

  it("renders compact rows on status and keeps full evidence paths on the raw log", () => {
    const meta = fixture({ status: "failed", lastExitCode: 7, callbackOrigin: origin });
    recordFailure(meta, "poll", `evaluator failed: ${"界".repeat(80)}`, "poll-1", { category: "condition", evidence: `${meta.logPath}#poll=1` });
    const status = formatStatus(meta, { origin });
    const row = status.split("\n").find((line) => line.startsWith("Action required · "))!;
    expect(row).toMatch(/ · evidence: output\.log#poll=1$/);
    expect(Buffer.byteLength(row.split(" · ")[2]!)).toBeLessThanOrEqual(120);
    const raw = formatLog(meta.id, { raw: true, origin });
    expect(raw).toContain(`evidence: ${meta.logPath}#poll=1`);
    expect(raw).toContain("界".repeat(80));
  });
});

describe("review regressions (#312)", () => {
  it("reports a deleted log after a status cursor instead of 'no new evidence'", () => {
    const meta = fixture({ logLines: ["ok"] });
    const first = formatStatus(inspectMeta(meta.id), { origin });
    const cursor = first.match(/statusCursor=(\S+)/)?.[1];
    expect(formatStatus(inspectMeta(meta.id), { origin, cursor })).toContain("No new evidence since cursor");
    rmSync(meta.logPath);
    const after = formatStatus(inspectMeta(meta.id), { origin, cursor });
    expect(after).not.toContain("No new evidence since cursor");
    expect(after).toContain("log unreadable");
    expect(after).toContain("gap read");
  });

  it("returns a repeated failure of the same operation as a failure-only change", () => {
    const meta = fixture({ logLines: ["same"] });
    recordFailure(meta, "poll", "poll failed once", "1", { category: "operation" });
    const first = formatStatus(inspectMeta(meta.id), { origin });
    const cursor = first.match(/statusCursor=(\S+)/)?.[1];
    recordFailure(meta, "poll", "poll failed again", "2", { category: "operation" });
    const second = formatStatus(inspectMeta(meta.id), { origin, cursor });
    expect(second).toContain("change=failure");
    expect(second).toContain("poll failed again");
  });

  it("pages lists past 100 tasks and across the standalone tool and the action wrapper", async () => {
    const base = Date.now() + 1_000_000;
    const ids = Array.from({ length: 105 }, (_, index) => fixture({ id: `bg_page_${String(index).padStart(3, "0")}_${base}`, startedAt: base + index }).id);
    const tools = register();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 30; page += 1) {
      const tool = page % 2 === 0 ? tools.bg_task_list : tools.bg_status;
      const params = page % 2 === 0 ? { cursor, limit: 25, max_bytes: 4096 } : { action: "list", cursor, limit: 25, max_bytes: 4096 };
      const text = textOf(await tool.execute("tc", params, undefined, undefined, ctx));
      expect(utf8ByteLength(text)).toBeLessThanOrEqual(4096);
      for (const match of text.matchAll(/^(bg_page_\d+_\d+) /gm)) {
        expect(seen.includes(match[1]!), `${match[1]} repeated`).toBe(false);
        seen.push(match[1]!);
      }
      if (!text.includes("hasMore=true")) break;
      cursor = text.match(/nextCursor=(\S+)/)?.[1];
    }
    expect(seen.length).toBe(105);
    expect(seen[0]).toBe(ids[104]);
    expect(seen.at(-1)).toBe(ids[0]);
  });

  it("#332 a bg_task_list page cursor passed to status gets a clear note, not a stale status reset", () => {
    for (let index = 0; index < 12; index += 1) fixture({ id: `bg_listcursor_${Date.now()}_${index}` });
    const listed = formatList({ origin, limit: 2 });
    const listCursor = listed.match(/nextCursor=(\S+)/)?.[1];
    expect(listCursor).toMatch(/^l1\./);
    const meta = fixture();
    const status = formatStatus(inspectMeta(meta.id), { origin, cursor: listCursor });
    expect(status).toContain("cursor ignored: it is a bg_task_list page cursor");
    expect(status).not.toContain("reset=stale-cursor");
  });

  it("resets a raw cursor when the session scope changes", () => {
    const meta = fixture({ logLines: ["0123456789".repeat(4_000)] });
    const own = formatLog(meta.id, { origin, raw: true });
    const cursor = own.match(/nextCursor=(\S+)/)?.[1];
    expect(cursor).toBeTruthy();
    const crossed = formatLog(meta.id, { origin, all: true, raw: true, cursor });
    expect(crossed).toContain("reset=stale-cursor");
    const continued = formatLog(meta.id, { origin, raw: true, cursor });
    expect(continued).not.toContain("reset=");
  });

  it("discloses rows omitted from the compact tail and pages them from the oldest retained byte", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line-${String(index).padStart(2, "0")}`);
    const meta = fixture({ logLines: lines });
    const compact = formatLog(meta.id, { origin });
    expect(compact).toContain("line-49");
    expect(compact).not.toContain("line-39");
    expect(compact).toMatch(/hasMore=true omittedBytes=\d+ nextCursor=\S+ \(pass to bg_task_log/);
    expect(compact).toContain("40 earlier display row(s)");
    let cursor = compact.match(/nextCursor=(\S+)/)?.[1];
    let rebuilt = "";
    for (let page = 0; page < 20 && cursor; page += 1) {
      const text = formatLog(meta.id, { origin, cursor, maxBytes: 1024 });
      expect(utf8ByteLength(text)).toBeLessThanOrEqual(1024);
      const [head] = text.split("\n---\n");
      const marker = "Raw retained bytes; capture/retention loss is not recoverable as full history.\n";
      rebuilt += head!.slice(head!.indexOf(marker) + marker.length);
      cursor = text.includes("hasMore=true") ? text.match(/nextCursor=(\S+)/)?.[1] : undefined;
    }
    expect(rebuilt).toBe(`${lines.join("\n")}\n`);
  });

  it("bounds verbose metadata to the requested page and pages the rest", async () => {
    const meta = fixture({ command: `echo ${"c".repeat(100_000)}`, env: { SECRET: "hidden" } });
    const tools = register();
    for (const [tool, extra] of [[tools.bg_task_status, {}], [tools.bg_status, { action: "status" }]] as const) {
      const pages: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 200; page += 1) {
        const text = textOf(await tool.execute("tc", { ...extra, id: meta.id, verbose: true, max_bytes: 2048, cursor }, undefined, undefined, ctx));
        expect(utf8ByteLength(text)).toBeLessThanOrEqual(2048);
        pages.push(text.split("\n---\n")[0]!.split("\n").slice(1).join("\n"));
        if (!text.includes("hasMore=true")) break;
        cursor = text.match(/nextCursor=(\S+)/)?.[1];
      }
      const json = JSON.parse(pages.join("")) as { command: string; env: unknown };
      expect(json.command.length).toBe(100_005);
      expect(JSON.stringify(json.env)).not.toContain("hidden");
    }
  });

  it("shows a recorded runtime error (timeout stop EPERM) in the compact status", () => {
    const meta = fixture({
      status: "running",
      endedAt: undefined,
      kind: "process",
      error: "timeout; could not terminate local process tree: EPERM",
      stopError: "timeout; could not terminate local process tree: EPERM",
    });
    expect(formatStatus(inspectMeta(meta.id), { origin })).toContain("stop failed: timeout; could not terminate local process tree: EPERM");
    const failed = fixture({ status: "failed", error: "poll transport failed: EPERM", result: { reason: "failure" } });
    expect(formatStatus(inspectMeta(failed.id), { origin })).toContain("error: poll transport failed: EPERM");
  });

  it("treats metadata without identifying fields as corrupt, not as a task", () => {
    const meta = fixture();
    writeFileSync(metaPathFor(meta.id), "{}");
    const text = formatStatus(inspectMeta(meta.id), { origin });
    expect(text).toContain(`Background task ${meta.id} metadata is unreadable`);
    expect(text).toContain("invalid metadata");
    expect(text).not.toContain("undefined");
    const list = formatList({ origin, all: true, limit: 100, maxBytes: 4096 });
    expect(list).toMatch(/\d+ task record\(s\) with unreadable metadata/);
  });

  it("does not expose tasks when the current session identity is unavailable", async () => {
    const meta = fixture({ logLines: ["LEGACY_EVIDENCE"], callbackOrigin: undefined, cwd: origin.cwd });
    const tools = register();
    const broken = { cwd: origin.cwd, sessionManager: { getSessionId: () => { throw new Error("session store offline"); } } };
    const status = textOf(await tools.bg_task_status.execute("tc", { id: meta.id }, undefined, undefined, broken));
    expect(status).toContain("current session identity is unavailable");
    expect(status).not.toContain("LEGACY_EVIDENCE");
    const log = textOf(await tools.bg_task_log.execute("tc", { id: meta.id }, undefined, undefined, broken));
    expect(log).not.toContain("LEGACY_EVIDENCE");
    const list = textOf(await tools.bg_task_list.execute("tc", {}, undefined, undefined, broken));
    expect(list).not.toContain(`${meta.id} `);
    expect(list).toMatch(/task\(s\) with unavailable ownership hidden/);
    expect(list).toContain("Current session identity is unavailable");
    expect(list).not.toContain("No background tasks found");
    const override = textOf(await tools.bg_task_log.execute("tc", { id: meta.id, all: true }, undefined, undefined, broken));
    expect(override).toContain("LEGACY_EVIDENCE");
  });

  it("keeps the matched condition and stop error visible beside many long incidents", () => {
    const meta = fixture({
      status: "running",
      endedAt: undefined,
      stopError: "Permission denied while terminating process tree.",
      result: { matchedCondition: { type: "json_path_equals", path: "$.terminalFailure", value: true }, matchedValue: true },
    });
    for (let i = 0; i < 8; i += 1) {
      recordFailure(meta, `op-${i}`, `incident-${i} ${"界".repeat(150)}`, `e-${i}`, { category: "operation", evidence: `evidence-${i}` });
    }
    const status = formatStatus(inspectMeta(meta.id), { origin });
    expect(utf8ByteLength(status)).toBeLessThanOrEqual(1024);
    expect(status).toContain("Condition matched: $.terminalFailure = true");
    expect(status).toContain("stop failed: Permission denied");
    expect(status).toMatch(/8 active failure observations · \d+ shown · \d+ omitted · incidentCursor=/);
  });

  it("always shows a row or a usable cursor on a default list led by a long incident", async () => {
    const base = Date.now() + 5_000_000;
    const ids = Array.from({ length: 21 }, (_, index) => fixture({ id: `bg_lead_${String(index).padStart(2, "0")}_${base}`, startedAt: base + index }).id);
    const newest = inspectMeta(ids[20]!).meta!;
    recordFailure(newest, "deploy", `deploy failed ${"e".repeat(450)}`, "1", { category: "operation" });
    const tools = register();
    const first = textOf(await tools.bg_task_list.execute("tc", {}, undefined, undefined, ctx));
    expect(utf8ByteLength(first)).toBeLessThanOrEqual(1024);
    expect(first).toMatch(new RegExp(`^${ids[20]} `, "m"));
    expect(first).toContain(`Full incidents: bg_task_status id=${ids[20]}`);
    const seen = new Set<string>();
    let text = first;
    for (let page = 0; page < 30; page += 1) {
      for (const match of text.matchAll(/^(bg_lead_\d+_\d+) /gm)) seen.add(match[1]!);
      if (!text.includes("hasMore=true")) break;
      const cursor = text.match(/nextCursor=(\S+)/)?.[1];
      expect(cursor, text).toBeTruthy();
      const next = textOf(await tools.bg_task_list.execute("tc", { cursor }, undefined, undefined, ctx));
      expect(next).not.toBe(text);
      text = next;
    }
    expect(seen.size).toBe(21);
  });

  it("keeps change and read-gap facts beside many long incidents", () => {
    const meta = fixture({ status: "running", endedAt: undefined, logLines: ["x"] });
    for (let i = 0; i < 8; i += 1) recordFailure(meta, `op-${i}`, `incident-${i} ${"界".repeat(150)}`, `e-${i}`, { category: "operation" });
    const first = formatStatus(inspectMeta(meta.id), { origin });
    const cursor = first.match(/statusCursor=(\S+)/)?.[1];
    recordFailure(meta, "op-late", `late ${"界".repeat(150)}`, "late", { category: "operation" });
    const second = formatStatus(inspectMeta(meta.id), { origin, cursor });
    expect(utf8ByteLength(second)).toBeLessThanOrEqual(1024);
    expect(second).toContain("change=failure");
    rmSync(meta.logPath);
    const third = formatStatus(inspectMeta(meta.id), { origin, cursor: "p1.garbage" });
    expect(utf8ByteLength(third)).toBeLessThanOrEqual(1024);
    expect(third).toContain("reset=stale-cursor");
    expect(third).toContain("log unreadable");
  });

  it("does not treat a legacy no-origin task as owned when the session id is absent", async () => {
    const legacy = fixture({ logLines: ["LEGACY_NO_ORIGIN"], callbackOrigin: undefined });
    const ours = fixture({ logLines: ["OWN_SESSIONLESS"], callbackOrigin: { cwd: origin.cwd } });
    const tools = register();
    const sessionless = { cwd: origin.cwd, sessionManager: { getSessionId: () => undefined } };
    const legacyLog = textOf(await tools.bg_task_log.execute("tc", { id: legacy.id }, undefined, undefined, sessionless));
    expect(legacyLog).not.toContain("LEGACY_NO_ORIGIN");
    expect(legacyLog).toContain("ownership is unavailable");
    const ownLog = textOf(await tools.bg_task_log.execute("tc", { id: ours.id }, undefined, undefined, sessionless));
    expect(ownLog).toContain("OWN_SESSIONLESS");
    const list = textOf(await tools.bg_task_list.execute("tc", { limit: 100, max_bytes: 4096 }, undefined, undefined, sessionless));
    expect(list).not.toContain(`${legacy.id} `);
    expect(list).toContain(`${ours.id} `);
  });
});

describe("output-control aliases (#321)", () => {
  it("accepts lines/tail_lines and max_bytes/maxBytes on every log surface; the canonical name wins", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `alias-line-${String(index + 1).padStart(2, "0")} ${"x".repeat(40)}`);
    const meta = fixture({ logLines: lines });
    const tools = register();
    const surfaces = [[tools.bg_task_log, {}], [tools.bg_task, { action: "log" }], [tools.bg_status, { action: "log" }]] as const;
    for (const [tool, extra] of surfaces) {
      const run = async (params: Record<string, unknown>) => textOf(await tool.execute("tc", { ...extra, id: meta.id, ...params }, undefined, undefined, ctx));
      const canonical = await run({ lines: 3 });
      expect(canonical).toContain("newest 3 display rows");
      expect(canonical).toContain("alias-line-30");
      expect(canonical).not.toContain("alias-line-27");
      expect(await run({ tail_lines: 3 })).toBe(canonical);
      expect(await run({ lines: 2, tail_lines: 5 })).toContain("newest 2 display rows");
      const rawCanonical = await run({ lines: 0 });
      expect(rawCanonical).toContain("raw log");
      expect(await run({ tail_lines: 0 })).toBe(rawCanonical);

      const small = await run({ max_bytes: 300 });
      expect(utf8ByteLength(small)).toBeLessThanOrEqual(300);
      expect(await run({ maxBytes: 300 })).toBe(small);
      const bothBytes = await run({ max_bytes: 300, maxBytes: 4096 });
      expect(bothBytes).toBe(small);
    }
    const list = textOf(await tools.bg_task_list.execute("tc", { maxBytes: 200 }, undefined, undefined, ctx));
    expect(utf8ByteLength(list)).toBeLessThanOrEqual(200);
    const status = textOf(await tools.bg_task_status.execute("tc", { id: meta.id, maxBytes: 400 }, undefined, undefined, ctx));
    expect(utf8ByteLength(status)).toBeLessThanOrEqual(400);
  });

  it("declares canonical and deprecated names in every read schema", () => {
    const tools = register();
    for (const name of ["bg_task_list", "bg_task_status", "bg_task_log", "bg_task_stop", "bg_task", "bg_status"]) {
      const properties = tools[name].parameters.properties as Record<string, { description?: string }>;
      expect(properties.max_bytes, name).toBeTruthy();
      expect(properties.maxBytes?.description, name).toContain("Deprecated alias for max_bytes");
    }
    for (const name of ["bg_task_log", "bg_task", "bg_status"]) {
      const properties = tools[name].parameters.properties as Record<string, { description?: string }>;
      expect(properties.lines, name).toBeTruthy();
      expect(properties.tail_lines?.description, name).toContain("Deprecated alias for lines");
    }
  });
});

describe("mutation ownership matches reads (#322)", () => {
  const sessionless = { cwd: origin.cwd, sessionManager: { getSessionId: () => undefined } };
  const foreignCtx = { cwd: origin.cwd, sessionManager: { getSessionId: () => otherOrigin.sessionId } };
  const unavailableCtx = { cwd: origin.cwd, sessionManager: { getSessionId: () => { throw new Error("session store offline"); } } };

  it("refuses to stop a foreign-session or unverifiable task on every stop surface", async () => {
    const foreign = fixture({ status: "running", endedAt: undefined, callbackOrigin: otherOrigin });
    const legacy = fixture({ status: "running", endedAt: undefined, callbackOrigin: undefined });
    const tools = register();
    for (const [tool, extra] of [[tools.bg_task_stop, {}], [tools.bg_task, { action: "stop" }], [tools.bg_status, { action: "stop" }]] as const) {
      const refused = textOf(await tool.execute("tc", { ...extra, id: foreign.id }, undefined, undefined, ctx));
      expect(refused).toContain("outside the current session scope; not stopped");
      expect(refused).toContain("belongs to another session");
      const gap = textOf(await tool.execute("tc", { ...extra, id: legacy.id }, undefined, undefined, sessionless));
      expect(gap).toContain("not stopped");
      expect(gap).toContain("ownership is unavailable");
      const unavailable = textOf(await tool.execute("tc", { ...extra, id: foreign.id }, undefined, undefined, unavailableCtx));
      expect(unavailable).toContain("current session identity is unavailable");
    }
    expect(inspectMeta(foreign.id).meta?.stopRequestedAt).toBeUndefined();
    expect(inspectMeta(foreign.id).meta?.status).toBe("running");
    expect(inspectMeta(legacy.id).meta?.stopRequestedAt).toBeUndefined();
  });

  it("clears one task by id only when owned, or with all:true like a read by id", async () => {
    const own = fixture({ status: "failed" });
    const foreign = fixture({ status: "failed", callbackOrigin: otherOrigin });
    const running = fixture({ status: "running", endedAt: undefined });
    const tools = register();
    const refused = textOf(await tools.bg_task.execute("tc", { action: "clear", id: foreign.id }, undefined, undefined, ctx));
    expect(refused).toContain("not dismissed");
    expect(inspectMeta(foreign.id).meta?.dismissedAt).toBeUndefined();
    const explicit = textOf(await tools.bg_status.execute("tc", { action: "clear", id: foreign.id, all: true }, undefined, undefined, ctx));
    expect(explicit).toContain(`Dismissed terminal background task ${foreign.id}`);
    expect(inspectMeta(foreign.id).meta?.dismissedAt).toBeTypeOf("number");
    const mine = textOf(await tools.bg_task.execute("tc", { action: "clear", id: own.id }, undefined, undefined, ctx));
    expect(mine).toContain(`Dismissed terminal background task ${own.id}`);
    const live = textOf(await tools.bg_task.execute("tc", { action: "clear", id: running.id }, undefined, undefined, ctx));
    expect(live).toContain("only terminal tasks can be dismissed");
    expect(inspectMeta(running.id).meta?.dismissedAt).toBeUndefined();
    // The owner's view: another session's task is still refused from that session too.
    const other = fixture({ status: "failed" });
    const fromOther = textOf(await tools.bg_task.execute("tc", { action: "clear", id: other.id }, undefined, undefined, foreignCtx));
    expect(fromOther).toContain("belongs to another session");
    expect(inspectMeta(other.id).meta?.dismissedAt).toBeUndefined();
  });

  it("a sessionless bulk clear dismisses only its own tasks and counts the ownership gaps", async () => {
    const cwd = `/tmp/output-scope-sessionless-${Date.now()}`;
    const own = fixture({ status: "failed", cwd, callbackOrigin: { cwd } });
    const legacy = fixture({ status: "failed", cwd, callbackOrigin: undefined });
    const otherProcess = fixture({ status: "failed", cwd, callbackOrigin: { cwd }, spawnPid: process.pid + 100_000 });
    const tools = register();
    const caller = { cwd, sessionManager: { getSessionId: () => undefined } };
    const cleared = textOf(await tools.bg_status.execute("tc", { action: "clear" }, undefined, undefined, caller));
    expect(cleared).toContain("Dismissed 1 terminal background task.");
    expect(cleared).toContain("2 terminal tasks with unverifiable ownership were not dismissed");
    expect(inspectMeta(own.id).meta?.dismissedAt).toBeTypeOf("number");
    expect(inspectMeta(legacy.id).meta?.dismissedAt).toBeUndefined();
    expect(inspectMeta(otherProcess.id).meta?.dismissedAt).toBeUndefined();
    // Bulk clear never crosses scopes, even with all:true (stricter than reads).
    const all = textOf(await tools.bg_status.execute("tc", { action: "clear", all: true }, undefined, undefined, caller));
    expect(all).toContain("Dismissed 0 terminal background tasks.");
    expect(inspectMeta(legacy.id).meta?.dismissedAt).toBeUndefined();
    const unavailable = textOf(await tools.bg_status.execute("tc", { action: "clear" }, undefined, undefined, unavailableCtx));
    expect(unavailable).toContain("Dismissed 0 terminal background tasks: the current session identity is unavailable");
  });
});

describe("status cursor delegation (#323)", () => {
  it("continues a raw log page when bg_task_status receives a raw log cursor", async () => {
    const lines = Array.from({ length: 200 }, (_, index) => `raw-line-${String(index).padStart(3, "0")}`);
    const meta = fixture({ logLines: lines });
    const tools = register();
    const first = textOf(await tools.bg_task_log.execute("tc", { id: meta.id, lines: 0, max_bytes: 1024 }, undefined, undefined, ctx));
    const cursor = first.match(/nextCursor=(p1\.\S+)/)?.[1];
    expect(cursor).toBeTruthy();
    const viaLog = textOf(await tools.bg_task_log.execute("tc", { id: meta.id, cursor, max_bytes: 1024 }, undefined, undefined, ctx));
    for (const [tool, extra] of [[tools.bg_task_status, {}], [tools.bg_status, { action: "status" }]] as const) {
      const viaStatus = textOf(await tool.execute("tc", { ...extra, id: meta.id, cursor, max_bytes: 1024 }, undefined, undefined, ctx));
      expect(viaStatus).not.toContain("reset=");
      expect(viaStatus).toBe(viaLog);
    }
    const shownFirst = [...first.matchAll(/raw-line-(\d{3})/g)].map((match) => Number(match[1]));
    const shownNext = [...viaLog.matchAll(/raw-line-(\d{3})/g)].map((match) => Number(match[1]));
    expect(shownNext[0]).toBe(Math.max(...shownFirst) + 1);
  });

  it("continues verbose metadata pages from a verbose cursor without verbose:true", async () => {
    const meta = fixture({ command: `echo ${"v".repeat(20_000)}` });
    const tools = register();
    const first = textOf(await tools.bg_task_status.execute("tc", { id: meta.id, verbose: true, max_bytes: 2048 }, undefined, undefined, ctx));
    const cursor = first.match(/nextCursor=(p1\.\S+)/)?.[1];
    expect(cursor).toBeTruthy();
    const withFlag = textOf(await tools.bg_task_status.execute("tc", { id: meta.id, verbose: true, cursor, max_bytes: 2048 }, undefined, undefined, ctx));
    const withoutFlag = textOf(await tools.bg_task_status.execute("tc", { id: meta.id, cursor, max_bytes: 2048 }, undefined, undefined, ctx));
    expect(withoutFlag).toBe(withFlag);
    expect(withoutFlag).not.toContain("reset=");
  });
});

describe("#332 navigator rows", () => {
  it("history-only failures keep the command in the row; an actionable incident still leads it", () => {
    ensureBackgroundTasksNavigatorProvider({} as any);
    ensureBackgroundTasksNavigator({ cwd: origin.cwd, hasUI: false, sessionManager: { getSessionId: () => origin.sessionId } } as any);
    const provider = (globalThis as any)[Symbol.for("pi-better-harness.navigator.state")].providers.get("background-tasks");
    const quiet = fixture({ status: "running", endedAt: undefined, command: "rg needle src" });
    recordFailure(quiet, "exit", "exited with declared expected code 1", "q1", { expected: true });
    let row = provider.listRows(Date.now()).find((x: any) => x.id === quiet.id);
    expect(row.primary).toBe("rg needle src");
    expect(row.facts.join("\n")).not.toMatch(/Expected failure|No failures need action/);
    expect(provider.detail(quiet.id, Date.now()).subtitle).toBe("rg needle src");
    const loud = fixture({ status: "running", endedAt: undefined, command: "npm test" });
    recordFailure(loud, "exit", "exited with code 2", "l1");
    row = provider.listRows(Date.now()).find((x: any) => x.id === loud.id);
    expect(row.primary).toMatch(/Action required/);
  });
});
