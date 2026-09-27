import assert from "node:assert/strict";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  OUTPUT_BUDGET_BYTES,
  OUTPUT_BUDGET_MAX_BYTES,
  OUTPUT_PAGE_DEFAULTS,
  assemblePriorityEnvelope,
  budgetFor,
  clampBudgetBytes,
  formatUnchangedEvidence,
  inspectStatusRevision,
  pageRetainedFile,
  pageVerbatimText,
  readBoundedTail,
  sliceUtf8Bytes,
  tailTerminalDisplay,
  utf8ByteLength,
} from "./index.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "pi-log-utils-"));
  directories.push(directory);
  return directory;
}

function reconstructText(source: string, maxBytes: number): { text: string; pages: number } {
  let cursor: string | undefined;
  let text = "";
  for (let pages = 1; pages <= 10_000; pages += 1) {
    const page = pageVerbatimText(source, { cursor, maxBytes });
    text += page.text;
    if (!page.hasMore) return { text, pages };
    assert.notEqual(page.nextCursor, page.cursor, "forward paging must advance the cursor");
    cursor = page.nextCursor;
  }
  throw new Error("verbatim reconstruction did not terminate");
}

function reconstructFile(path: string, maxBytes: number, request: Omit<Parameters<typeof pageRetainedFile>[1], "cursor" | "maxBytes"> = {}): string {
  let cursor: string | undefined;
  let text = "";
  for (let pages = 1; pages <= 10_000; pages += 1) {
    const page = pageRetainedFile(path, { ...request, cursor, maxBytes });
    text += page.text;
    if (!page.hasMore) return text;
    cursor = page.nextCursor;
  }
  throw new Error("file reconstruction did not terminate");
}

describe("readBoundedTail", () => {
  it("reads only the bounded end of a large file", () => {
    const directory = tempDir();
    const path = join(directory, "output.log");
    writeFileSync(path, `${"discarded\n".repeat(50_000)}recent-one\nrecent-two\n`);

    const tail = readBoundedTail(path, 64);

    assert.equal(tail.truncated, true);
    assert.ok(tail.totalBytes > 64);
    assert.match(tail.text, /recent-one\nrecent-two\n$/);
    assert.ok(tail.text.length <= 64);
  });
});

describe("tailTerminalDisplay", () => {
  it("collapses carriage-return progress while preserving final error lines", () => {
    const output = "10%\r20%\r99%\rRead from remote host: Operation timed out\nclient_loop: Broken pipe\n";

    assert.equal(
      tailTerminalDisplay(output, 10),
      "Read from remote host: Operation timed out\nclient_loop: Broken pipe",
    );
  });

  it("keeps the final progress snapshot without a trailing newline", () => {
    assert.equal(tailTerminalDisplay("10%\r20%\r99%", 10), "99%");
  });
});

describe("output budgets", () => {
  it("uses OUTPUT-POLICY UTF-8 byte defaults and clamps explicit pages to the hard cap", () => {
    assert.equal(OUTPUT_BUDGET_BYTES.status, 1 * 1024);
    assert.equal(OUTPUT_BUDGET_BYTES.answer, 2 * 1024);
    assert.equal(OUTPUT_BUDGET_BYTES.log, 1 * 1024);
    assert.equal(OUTPUT_BUDGET_BYTES.list, 1 * 1024);
    assert.equal(OUTPUT_BUDGET_BYTES.callbackBatch, 2 * 1024);
    assert.equal(OUTPUT_BUDGET_BYTES.rawPage, 16 * 1024);
    assert.equal(OUTPUT_BUDGET_MAX_BYTES.status, 2 * 1024);
    assert.equal(OUTPUT_BUDGET_MAX_BYTES.answer, 8 * 1024);
    assert.equal(OUTPUT_BUDGET_MAX_BYTES.log, 4 * 1024);
    assert.equal(OUTPUT_BUDGET_MAX_BYTES.list, 4 * 1024);
    assert.equal(OUTPUT_BUDGET_MAX_BYTES.callbackBatch, 8 * 1024);
    assert.equal(OUTPUT_BUDGET_MAX_BYTES.rawPage, 64 * 1024);
    assert.equal(OUTPUT_PAGE_DEFAULTS.logLines, 10);
    assert.equal(OUTPUT_PAGE_DEFAULTS.listEntries, 10);
    assert.equal(budgetFor("answer", 100), 100);
    assert.equal(budgetFor("answer", 99_999), OUTPUT_BUDGET_MAX_BYTES.answer);
    assert.equal(budgetFor("status", 0), OUTPUT_BUDGET_BYTES.status);
    assert.equal(budgetFor("log", -8), OUTPUT_BUDGET_BYTES.log);
    assert.equal(budgetFor("rawPage", Number.NaN), OUTPUT_BUDGET_BYTES.rawPage);
    assert.equal(clampBudgetBytes("32", 99), 32);
  });

  it("counts UTF-8 bytes rather than JS UTF-16 units", () => {
    assert.equal(utf8ByteLength("a"), 1);
    assert.equal(utf8ByteLength("é"), 2);
    assert.equal(utf8ByteLength("你"), 3);
    assert.equal(utf8ByteLength("😀"), 4);
    const split = sliceUtf8Bytes("é😀", 0, 3, false);
    assert.equal(split.text, "é");
    assert.equal(split.bytes, 2);
  });
});

describe("pageVerbatimText", () => {
  it("reconstructs multibyte text exactly across UTF-8 page boundaries", () => {
    const source = `café 你好 😀\n${"x".repeat(50)}`;
    const rebuilt = reconstructText(source, 8);
    assert.equal(rebuilt.text, source);
    assert.ok(rebuilt.pages > 1);
  });

  it("makes forward progress on a single oversized line", () => {
    const source = `{"status":${"0".repeat(400)}}`;
    assert.equal(source.includes("\n"), false);
    const first = pageVerbatimText(source, { maxBytes: 40 });
    assert.equal(first.hasMore, true);
    assert.equal(first.text.includes("\n"), false);
    assert.ok(utf8ByteLength(first.text) <= 40 || utf8ByteLength(first.text) <= 4);
    assert.ok(first.text.length > 0);
    assert.equal(reconstructText(source, 40).text, source);
  });

  it("does not split or replace UTF-8 when a tail starts on a continuation byte", () => {
    const source = `café${"你".repeat(80)}😀END`;
    const encoded = Buffer.from(source, "utf8");
    const mid = encoded.indexOf(Buffer.from("你", "utf8")) + 1; // continuation of 你
    const slice = sliceUtf8Bytes(source, mid, 40, false);
    assert.doesNotMatch(slice.text, /\uFFFD/);
    assert.match(slice.text, /你|😀|END/);
    assert.equal(source.includes(slice.text), true);
    assert.equal(reconstructText(source, 17).text, source);
  });

  it("replays a caller cursor and keeps independent callers from consuming each other", () => {
    const source = "AAAA\nBBBB\nCCCC\nDDDD\n";
    const callerA = pageVerbatimText(source, { maxBytes: 5 });
    const callerB = pageVerbatimText(source, { maxBytes: 5 });
    assert.equal(callerA.text, callerB.text);
    const replayA = pageVerbatimText(source, { cursor: callerA.cursor, maxBytes: 5 });
    assert.equal(replayA.text, callerA.text);
    assert.equal(replayA.startByte, callerA.startByte);
    const callerA2 = pageVerbatimText(source, { cursor: callerA.nextCursor, maxBytes: 5 });
    const stillB = pageVerbatimText(source, { cursor: callerB.cursor, maxBytes: 5 });
    assert.equal(stillB.text, callerB.text);
    assert.notEqual(callerA2.text, callerA.text);
    let cursor: string | undefined = callerA.cursor;
    let rebuilt = "";
    for (;;) {
      const page = pageVerbatimText(source, { cursor, maxBytes: 5 });
      rebuilt += page.text;
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    assert.equal(rebuilt, source);
  });

  it("resets when the source text is replaced rather than serving shifted bytes", () => {
    const first = pageVerbatimText("alpha-answer-body", { maxBytes: 8 });
    const replaced = pageVerbatimText("omega-answer-body", { cursor: first.nextCursor, maxBytes: 8 });
    assert.equal(replaced.reset, "source-replaced");
    assert.equal(replaced.startByte, 0);
    assert.equal(replaced.text.startsWith("omega"), true);
  });

  it("treats a foreign cursor as stale without throwing", () => {
    const page = pageVerbatimText("hello", { cursor: "not-a-cursor", maxBytes: 8 });
    assert.equal(page.reset, "stale-cursor");
    assert.equal(page.text, "hello");
  });

  it("keeps a final line with no trailing newline when the remainder fits", () => {
    const source = Array.from({ length: 18 }, (_, i) => `result-line-${String(i + 1).padStart(2, "0")}`).join("\n");
    const page = pageVerbatimText(source, { maxBytes: 8 * 1024 });
    assert.equal(page.hasMore, false);
    assert.equal(page.text, source);
    assert.equal(page.text.endsWith("result-line-18"), true);
  });

  it("honors maxLines without embedding source bytes in the cursor", () => {
    const source = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`).join("\n");
    const page = pageVerbatimText(source, { maxBytes: 8 * 1024, maxLines: 10 });
    assert.equal(page.hasMore, true);
    assert.equal(page.text.split("\n").filter(Boolean).length, 10);
    assert.equal(page.text.includes("line-11"), false);
    assert.equal(page.cursor.includes("line-1"), false);
    assert.equal(page.nextCursor.includes(source.slice(0, 20)), false);
    const next = pageVerbatimText(source, { cursor: page.nextCursor, maxBytes: 8 * 1024, maxLines: 10 });
    assert.match(next.text, /^line-11/);
  });
});

describe("pageRetainedFile", () => {
  it("reconstructs retained bytes including a UTF-8 character split across the budget", () => {
    const path = join(tempDir(), "retained.log");
    const source = "a€b你好😀\nend";
    writeFileSync(path, source);
    assert.equal(reconstructFile(path, 3, { resource: "task-1", generation: 1 }), source);
  });

  it("keeps a snapshot stable across appends and only returns new bytes from the end cursor", () => {
    const path = join(tempDir(), "watch.log");
    writeFileSync(path, "one\n");
    const first = pageRetainedFile(path, { maxBytes: 64, resource: "bg", generation: 1 });
    assert.equal(first.text, "one\n");
    assert.equal(first.hasMore, false);
    appendFileSync(path, "two\n");
    const replay = pageRetainedFile(path, { cursor: first.cursor, maxBytes: 64, resource: "bg", generation: 1 });
    assert.equal(replay.text, "one\n");
    assert.equal(replay.reset, undefined);
    const appended = pageRetainedFile(path, { cursor: first.nextCursor, maxBytes: 64, resource: "bg", generation: 1 });
    assert.equal(appended.text, "two\n");
    assert.equal(appended.reset, undefined);
  });

  it("does not let a second caller consume the first caller's retained range", () => {
    const path = join(tempDir(), "shared.log");
    writeFileSync(path, "row-one\nrow-two\nrow-three\n");
    const a1 = pageRetainedFile(path, { maxBytes: 8, resource: "bg", generation: 3 });
    const b1 = pageRetainedFile(path, { maxBytes: 8, resource: "bg", generation: 3 });
    assert.equal(a1.text, b1.text);
    const a2 = pageRetainedFile(path, { cursor: a1.nextCursor, maxBytes: 8, resource: "bg", generation: 3 });
    const bReplay = pageRetainedFile(path, { cursor: b1.cursor, maxBytes: 8, resource: "bg", generation: 3 });
    assert.equal(bReplay.text, b1.text);
    assert.ok(a2.startByte >= a1.endByte);
  });

  it("resets on same-inode compaction when the consumer generation advances", () => {
    const path = join(tempDir(), "compact.log");
    writeFileSync(path, "AAAAAAAAAA\nBBBBBBBBBB\nCCCCCCCCCC\n");
    const first = pageRetainedFile(path, { maxBytes: 12, resource: "bg", generation: 1 });
    const ino = statSync(path).ino;
    truncateSync(path, 0);
    appendFileSync(path, "CCCCCCCCCC\n");
    assert.equal(statSync(path).ino, ino);
    const after = pageRetainedFile(path, {
      cursor: first.nextCursor,
      maxBytes: 12,
      resource: "bg",
      generation: 2,
    });
    assert.equal(after.reset, "compacted");
    assert.equal(after.startByte, 0);
    assert.equal(after.text, "CCCCCCCCCC\n");
  });

  it("resets as source-replaced when the path is a new inode", () => {
    const path = join(tempDir(), "replaced.log");
    writeFileSync(path, "old-bytes\n");
    const first = pageRetainedFile(path, { maxBytes: 8, resource: "bg", generation: 1 });
    rmSync(path);
    writeFileSync(path, "new-bytes-here\n");
    const after = pageRetainedFile(path, {
      cursor: first.nextCursor,
      maxBytes: 8,
      resource: "bg",
      generation: 2,
    });
    assert.equal(after.reset, "source-replaced");
    assert.equal(after.startByte, 0);
    assert.equal(after.text.startsWith("new-byte"), true);
  });

  it("distinguishes missing, empty, and unreadable files from a healthy empty result", () => {
    const directory = tempDir();
    const missing = pageRetainedFile(join(directory, "gone.log"), { maxBytes: 32, resource: "bg" });
    assert.equal(missing.text, "");
    assert.equal(missing.gaps.some((gap) => gap.kind === "read"), true);
    assert.notEqual(missing.gaps[0]?.detail, undefined);

    const emptyPath = join(directory, "empty.log");
    writeFileSync(emptyPath, "");
    const empty = pageRetainedFile(emptyPath, { maxBytes: 32, resource: "bg", generation: 1 });
    assert.equal(empty.text, "");
    assert.equal(empty.gaps.length, 0);
    assert.equal(empty.reset, undefined);

    const blocked = join(directory, "blocked.log");
    writeFileSync(blocked, "secret-evidence\n");
    chmodSync(blocked, 0);
    try {
      const unreadable = pageRetainedFile(blocked, { maxBytes: 32, resource: "bg" });
      assert.equal(unreadable.text, "");
      assert.equal(unreadable.gaps.some((gap) => gap.kind === "read"), true);
      assert.equal(unreadable.text.includes("secret-evidence"), false);
    } finally {
      chmodSync(blocked, 0o600);
    }
  });

  it("discloses capture and retention gaps without claiming discarded bytes are pageable", () => {
    const path = join(tempDir(), "lossy.log");
    writeFileSync(path, "retained-tail\n");
    const page = pageRetainedFile(path, {
      maxBytes: 64,
      resource: "bg",
      generation: 4,
      discardedBytes: 102_400,
      captureGaps: [{ bytes: 151_436, detail: "stdout cap" }],
    });
    assert.equal(page.text, "retained-tail\n");
    assert.equal(page.gaps.some((gap) => gap.kind === "retention" && gap.bytes === 102_400), true);
    assert.equal(page.gaps.some((gap) => gap.kind === "capture" && gap.bytes === 151_436), true);
    assert.equal(reconstructFile(path, 8, { resource: "bg", generation: 4 }), "retained-tail\n");
  });
});

describe("inspectStatusRevision", () => {
  it("reports failure-only changes without treating the read as globally consumed", () => {
    const initial = inspectStatusRevision({
      resource: "bg_1",
      contentRevision: "log:1:100",
      failureRevision: "fail:a",
    });
    assert.equal(initial.change, "content");
    const unchanged = inspectStatusRevision({
      cursor: initial.nextCursor,
      resource: "bg_1",
      contentRevision: "log:1:100",
      failureRevision: "fail:a",
    });
    assert.equal(unchanged.change, "none");
    const otherCaller = inspectStatusRevision({
      cursor: initial.nextCursor,
      resource: "bg_1",
      contentRevision: "log:1:100",
      failureRevision: "fail:a",
    });
    assert.equal(otherCaller.change, "none");
    const failureOnly = inspectStatusRevision({
      cursor: initial.nextCursor,
      resource: "bg_1",
      contentRevision: "log:1:100",
      failureRevision: "fail:b",
    });
    assert.equal(failureOnly.change, "failure");
    const content = inspectStatusRevision({
      cursor: initial.nextCursor,
      resource: "bg_1",
      contentRevision: "log:1:200",
      failureRevision: "fail:a",
    });
    assert.equal(content.change, "content");
    assert.match(formatUnchangedEvidence(unchanged.nextCursor), /No new evidence since cursor /);
  });

  it("resets a cursor bound to a different resource", () => {
    const first = inspectStatusRevision({ resource: "a", contentRevision: "c", failureRevision: "f" });
    const other = inspectStatusRevision({
      cursor: first.nextCursor,
      resource: "b",
      contentRevision: "c",
      failureRevision: "f",
    });
    assert.equal(other.change, "reset");
    assert.equal(other.reset, "stale-cursor");
  });
});

describe("assemblePriorityEnvelope", () => {
  it("keeps the total payload within the status budget including headers and continuation", () => {
    const envelope = assemblePriorityEnvelope({
      maxBytes: OUTPUT_BUDGET_BYTES.status,
      sections: {
        identity: "bg_watch running · last check 4s ago",
        failure: "1 unresolved incident",
        decision: "Condition matched: $.terminalFailure = true",
        progress: `poll ${"x".repeat(8_000)}`,
      },
    });
    assert.ok(envelope.byteLength <= OUTPUT_BUDGET_BYTES.status);
    assert.equal(utf8ByteLength(envelope.text), envelope.byteLength);
    assert.match(envelope.text, /1 unresolved incident/);
    assert.match(envelope.text, /terminalFailure/);
    assert.equal(envelope.text.indexOf("1 unresolved incident") < envelope.text.indexOf("terminalFailure"), true);
    assert.ok(envelope.omitted.some((item) => item.section === "progress"));
  });

  it("reserves metadata so verbatim answer pages still concatenate to the source", () => {
    const answer = `${"café 你好 ".repeat(2_000)}END`;
    let usedBudget = 0;
    const first = assemblePriorityEnvelope({
      maxBytes: OUTPUT_BUDGET_BYTES.answer,
      sections: {
        identity: "sa_9 completed",
        failure: "1 unresolved incident",
      },
      verbatim: (budget) => {
        usedBudget = budget;
        return pageVerbatimText(answer, { maxBytes: budget });
      },
    });
    assert.ok(usedBudget > 0);
    assert.ok(usedBudget < OUTPUT_BUDGET_BYTES.answer);
    assert.ok(utf8ByteLength(first.text) <= OUTPUT_BUDGET_BYTES.answer);
    assert.match(first.text, /1 unresolved incident/);
    assert.equal(first.text.startsWith("sa_9 completed\n1 unresolved incident\n"), true);
    assert.equal(first.verbatim?.hasMore, true);
    const rebuilt = reconstructText(answer, usedBudget);
    assert.equal(rebuilt.text, answer);
    assert.ok(rebuilt.pages > 1);
  });

  it("counts a long JSON line against the total budget and still discloses unread bytes", () => {
    const line = `{"ok":false,"body":"${"n".repeat(9_000)}"}`;
    const envelope = assemblePriorityEnvelope({
      maxBytes: OUTPUT_BUDGET_BYTES.log,
      sections: { identity: "bg_log" },
      verbatim: (budget) => pageVerbatimText(line, { maxBytes: budget }),
    });
    assert.ok(utf8ByteLength(envelope.text) <= OUTPUT_BUDGET_BYTES.log);
    assert.equal(envelope.verbatim?.hasMore, true);
    assert.ok((envelope.verbatim?.omittedBytes ?? 0) > 0);
    assert.match(envelope.text, /hasMore=true/);
  });
});
