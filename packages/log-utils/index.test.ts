import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  renameSync,
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
  lifecycleContentRevision,
  logIdentityFacts,
  originScopeDigest,
  readOutputControls,
  readOutputInclude,
  sessionScopeKey,
  pageRetainedFile,
  pageRows,
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
    assert.equal(utf8ByteLength(first.text), 40);
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

  it("never exceeds maxBytes: a code point larger than the budget is not returned", () => {
    const page = pageVerbatimText("你好", { maxBytes: 1 });
    assert.equal(page.text, "");
    assert.equal(page.hasMore, true);
    assert.equal(page.nextCursor, page.cursor);
    const zero = pageVerbatimText("abc", { maxBytes: 0 });
    assert.equal(zero.text, "");
    assert.equal(zero.hasMore, true);
    assert.equal(zero.nextCursor, zero.cursor);
  });

  it("prefers a newline break only when it keeps at least half the page", () => {
    const source = `a\n${"x".repeat(3_000)}`;
    const page = pageVerbatimText(source, { maxBytes: 2_048 });
    assert.equal(utf8ByteLength(page.text), 2_048);
    assert.equal(reconstructText(source, 2_048).text, source);
    const lines = `${"l".repeat(1_500)}\n${"y".repeat(3_000)}`;
    assert.equal(pageVerbatimText(lines, { maxBytes: 2_048 }).text, `${"l".repeat(1_500)}\n`);
    const path = join(tempDir(), "shortline.log");
    writeFileSync(path, source);
    assert.equal(pageRetainedFile(path, { maxBytes: 2_048, resource: "r" }).endByte, 2_048);
  });

  it("binds text cursors to the resource so a scope change resets", () => {
    const source = "answer ".repeat(100);
    const first = pageVerbatimText(source, { maxBytes: 20, resource: "answer:session-a:sa_1" });
    const crossed = pageVerbatimText(source, { cursor: first.nextCursor, maxBytes: 20, resource: "answer:all:sa_1" });
    assert.equal(crossed.reset, "stale-cursor");
    assert.equal(crossed.startByte, 0);
    const otherRun = pageVerbatimText(source, { cursor: first.nextCursor, maxBytes: 20, resource: "answer:session-a:sa_2" });
    assert.equal(otherRun.reset, "stale-cursor");
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

const CURSOR_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * A cursor as the model re-types it: exactly one base64url character changed.
 * Picks the first edit whose payload still parses as the same cursor kind and
 * satisfies `accept`, which is the near-miss described in #617.
 */
function miscopiedCursor(
  cursor: string,
  kind: "t" | "f" | "s",
  accept: (payload: Record<string, any>, original: Record<string, any>) => boolean,
): string {
  const prefix = "p1.";
  const body = cursor.slice(prefix.length);
  const original = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  for (let index = 0; index < body.length; index += 1) {
    for (const replacement of CURSOR_ALPHABET) {
      if (replacement === body[index]) continue;
      const candidate = `${prefix}${body.slice(0, index)}${replacement}${body.slice(index + 1)}`;
      let payload: Record<string, any>;
      try {
        payload = JSON.parse(Buffer.from(candidate.slice(prefix.length), "base64url").toString("utf8"));
      } catch {
        continue;
      }
      if (payload?.k === kind && accept(payload, original)) return candidate;
    }
  }
  throw new Error("no single-character miscopy of this cursor satisfied the expectation");
}

/** The same cursor with one field rewritten: a still-parseable damaged payload. */
function reencodedCursor(cursor: string, edit: (payload: Record<string, any>) => void): string {
  const payload = JSON.parse(Buffer.from(cursor.slice(3), "base64url").toString("utf8"));
  edit(payload);
  return `${cursor.slice(0, 3)}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function textDigest22(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64url").slice(0, 22);
}

/**
 * A text cursor exactly as released versions minted it: the source digest and
 * the offset, with none of the position witnesses this module adds now.
 */
function legacyTextCursor(text: string, offset: number): string {
  return `p1.${Buffer.from(JSON.stringify({ k: "t", v: textDigest22(text), o: offset, n: utf8ByteLength(text) }), "utf8").toString("base64url")}`;
}

/** The integrity tag a released version minted: a SHA-256 of every other field. */
function integrityTagOf(payload: Record<string, unknown>): string {
  const { x: _ignored, ...rest } = payload;
  return createHash("sha256").update(JSON.stringify(rest)).digest("base64url").slice(0, 6);
}

describe("cursor integrity (#617)", () => {
  const answer = Array.from({ length: 120 }, (_, i) => `answer-${String(i).padStart(3, "0")} ${"z".repeat(40)}`).join("\n");
  const resource = "answer:session-a:sa_1";

  it("reports a miscopied answer cursor as cursor-corrupt and continues after its offset", () => {
    const first = pageVerbatimText(answer, { maxBytes: 400, resource });
    assert.equal(first.hasMore, true);
    // The reported near-miss: only the whole-text digest changed, so the offset
    // is still meaningful. It used to be read as a replaced source, restarting
    // page 1 and minting the same cursor again — forever.
    const miscopied = miscopiedCursor(first.nextCursor, "t", (p, o) => p.o === o.o && p.n === o.n && p.v !== o.v);
    const page = pageVerbatimText(answer, { cursor: miscopied, maxBytes: 400, resource });
    assert.equal(page.reset, "cursor-corrupt");
    assert.equal(page.startByte, first.endByte, "a still-meaningful offset is reused");
    assert.equal(page.text, pageVerbatimText(answer, { cursor: first.nextCursor, maxBytes: 400, resource }).text);
    assert.notEqual(page.text, first.text, "the corrupted cursor must not replay page 1");
    assert.notEqual(page.nextCursor, first.nextCursor, "it must not mint the page-1 cursor again");
  });

  it("reaches the end of the answer from a corrupted cursor the caller keeps miscopying", () => {
    const first = pageVerbatimText(answer, { maxBytes: 400, resource });
    let cursor: string | undefined = miscopiedCursor(first.nextCursor, "t", (p, o) => p.o === o.o && p.v !== o.v);
    let rest = "";
    for (let pages = 1; pages <= 100; pages += 1) {
      const page = pageVerbatimText(answer, { cursor, maxBytes: 400, resource });
      assert.equal(page.reset, pages === 1 ? "cursor-corrupt" : undefined, `page ${pages}`);
      rest += page.text;
      if (!page.hasMore) break;
      cursor = page.nextCursor;
      assert.notEqual(page.nextCursor, first.nextCursor);
    }
    assert.equal(first.text + rest, answer);
  });

  it("classifies a damaged scope tag as corrupt rather than as another scope", () => {
    const first = pageVerbatimText(answer, { maxBytes: 400, resource });
    const miscopied = miscopiedCursor(first.nextCursor, "t", (p, o) => p.r !== o.r && p.o === o.o);
    const page = pageVerbatimText(answer, { cursor: miscopied, maxBytes: 400, resource });
    assert.equal(page.reset, "cursor-corrupt");
    assert.equal(page.startByte, 0);
  });

  it("keeps a pristine cursor's source replacement distinct from corruption", () => {
    const first = pageVerbatimText("alpha-answer-body", { maxBytes: 8 });
    const replaced = pageVerbatimText("omega-answer-body", { cursor: first.nextCursor, maxBytes: 8 });
    assert.equal(replaced.reset, "source-replaced");
    assert.equal(replaced.startByte, 0);
    assert.equal(replaced.text, "omega-an");
  });

  it("still advances when only the second position witness is damaged", () => {
    const first = pageVerbatimText(answer, { maxBytes: 400, resource });
    const clean = pageVerbatimText(answer, { cursor: first.nextCursor, maxBytes: 400, resource });
    const damaged = miscopiedCursor(first.nextCursor, "t", (p, o) => p.w !== o.w && p.o === o.o && p.v === o.v);
    const page = pageVerbatimText(answer, { cursor: damaged, maxBytes: 400, resource });
    assert.equal(page.reset, "cursor-corrupt");
    assert.equal(page.startByte, clean.startByte);
    assert.equal(page.text, clean.text, "the surviving witness proves the same position");
  });

  it("restarts at byte 0 when the cursor's offset itself is damaged", () => {
    // A damaged offset must never be served: an offset pushed to the end used
    // to answer "end of text, nothing omitted" while most of the text was
    // still unread (#617 R1).
    const first = pageVerbatimText(answer, { maxBytes: 400, resource });
    const pageOne = pageVerbatimText(answer, { maxBytes: 400, resource });
    const atEnd = reencodedCursor(first.nextCursor, (payload) => { payload.o = payload.n; });
    const shifted = miscopiedCursor(first.nextCursor, "t", (p, o) => typeof p.o === "number" && p.o !== o.o);
    for (const [label, damaged] of [["moved to the end", atEnd], ["moved by one", shifted]] as const) {
      const page = pageVerbatimText(answer, { cursor: damaged, maxBytes: 400, resource });
      assert.equal(page.reset, "cursor-corrupt", label);
      assert.equal(page.startByte, 0, `${label}: restarts at byte 0`);
      assert.equal(page.text, pageOne.text, `${label}: serves the first page, not a shifted one`);
      assert.equal(page.hasMore, true, `${label}: the unread tail stays reachable`);
      assert.notEqual(page.text, "", `${label}: never an empty end page`);
    }
  });

  it("restarts a cursor with no witness instead of trusting its offset over a replaced source", () => {
    const legacy = legacyTextCursor("alpha-answer-body", 8);
    const legacyPage = pageVerbatimText("alpha-answer-body", { cursor: legacy, maxBytes: 8 });
    assert.equal(legacyPage.reset, "cursor-corrupt");
    assert.equal(legacyPage.startByte, 0, "an untagged cursor cannot prove its offset, so nothing is skipped");
    assert.equal(legacyPage.text, "alpha-an");
    const replaced = pageVerbatimText("omega-answer-body", { cursor: legacy, maxBytes: 8 });
    assert.equal(replaced.reset, "cursor-corrupt");
    assert.equal(replaced.startByte, 0);
    assert.equal(replaced.text, "omega-an", "the replacement is shown from its first byte (#617 R1)");

    // The intermediate format carried an integrity tag but no position witness.
    // An intact tag must not be read as proof that the offset still applies.
    const payload = { k: "t", v: textDigest22("alpha-answer-body"), o: 8, n: utf8ByteLength("alpha-answer-body") };
    const taggedWithoutWitness = `p1.${Buffer.from(JSON.stringify({ ...payload, x: integrityTagOf(payload) }), "utf8").toString("base64url")}`;
    const unproven = pageVerbatimText("alpha-answer-body", { cursor: taggedWithoutWitness, maxBytes: 8 });
    assert.equal(unproven.reset, "cursor-corrupt");
    assert.equal(unproven.startByte, 0, "an unproven offset restarts the page");
    assert.equal(unproven.text, "alpha-an");
  });

  it("reports a corrupted file cursor as corrupt and resumes when the byte checks still hold", () => {
    const path = join(tempDir(), "integrity.log");
    writeFileSync(path, `${"row ".repeat(400)}\n`);
    const first = pageRetainedFile(path, { maxBytes: 64, resource: "raw:session-a:sa_1" });
    assert.equal(first.hasMore, true);
    const damagedTag = miscopiedCursor(first.nextCursor, "f", (p, o) => p.x !== o.x && p.o === o.o && p.i === o.i);
    const resumed = pageRetainedFile(path, { cursor: damagedTag, maxBytes: 64, resource: "raw:session-a:sa_1" });
    assert.equal(resumed.reset, "cursor-corrupt");
    assert.equal(resumed.startByte, first.endByte, "the independent byte checks still validate the offset");
    assert.equal(resumed.text, pageRetainedFile(path, { cursor: first.nextCursor, maxBytes: 64, resource: "raw:session-a:sa_1" }).text);
    const damagedWindow = miscopiedCursor(first.nextCursor, "f", (p, o) => p.w !== o.w);
    const restarted = pageRetainedFile(path, { cursor: damagedWindow, maxBytes: 64, resource: "raw:session-a:sa_1" });
    assert.equal(restarted.reset, "cursor-corrupt", "a damaged boundary digest is corruption, not a replacement claim");
    assert.equal(restarted.startByte, 0);
  });
});

describe("pageRetainedFile", () => {
  it("reconstructs retained bytes including a UTF-8 character split across the budget", () => {
    const path = join(tempDir(), "retained.log");
    const source = "a€b你好😀\nend";
    writeFileSync(path, source);
    assert.equal(reconstructFile(path, 4, { resource: "task-1", generation: 1 }), source);
    assert.equal(reconstructFile(path, 5, { resource: "task-1", generation: 1 }), source);
  });

  it("never exceeds maxBytes: a budget smaller than the next code point stays put", () => {
    const path = join(tempDir(), "emoji.log");
    writeFileSync(path, "😀tail");
    const page = pageRetainedFile(path, { maxBytes: 3, resource: "task" });
    assert.equal(page.text, "");
    assert.equal(page.hasMore, true);
    assert.equal(page.startByte, 0);
    assert.equal(page.endByte, 0);
    assert.equal(page.nextCursor, page.cursor);
    const wider = pageRetainedFile(path, { cursor: page.nextCursor, maxBytes: 4, resource: "task" });
    assert.equal(wider.text, "😀");
  });

  it("withholds a trailing incomplete UTF-8 sequence until the writer completes it", () => {
    const path = join(tempDir(), "split.log");
    const emoji = Buffer.from("😀", "utf8");
    writeFileSync(path, Buffer.concat([Buffer.from("a"), emoji.subarray(0, 2)]));
    const first = pageRetainedFile(path, { maxBytes: 64, resource: "task" });
    assert.equal(first.text, "a");
    assert.equal(first.pendingBytes, 2);
    assert.equal(first.hasMore, false);
    assert.equal(first.appendReady, true);
    appendFileSync(path, Buffer.concat([emoji.subarray(2), Buffer.from("b")]));
    const second = pageRetainedFile(path, { cursor: first.nextCursor, maxBytes: 64, resource: "task" });
    assert.equal(second.reset, undefined);
    assert.equal(second.text, "😀b");
    assert.equal(first.text + second.text, "a😀b");
    assert.equal(second.pendingBytes, undefined);
  });

  it("passes malformed bytes through instead of withholding them forever", () => {
    const path = join(tempDir(), "malformed.log");
    writeFileSync(path, Buffer.from([0x61, 0xf0, 0x41, 0x42]));
    const page = pageRetainedFile(path, { maxBytes: 64, resource: "task" });
    assert.equal(page.endByte, 4);
    assert.equal(page.pendingBytes, undefined);
  });

  it("detects an in-place rewrite that keeps the head, size, and inode", () => {
    const path = join(tempDir(), "rewrite.log");
    writeFileSync(path, `${"a".repeat(300)}${"b".repeat(30_000)}`);
    const inode = statSync(path).ino;
    const first = pageRetainedFile(path, { maxBytes: 16 * 1024, resource: "run" });
    assert.equal(first.text.endsWith("b"), true);
    writeFileSync(path, `${"a".repeat(300)}${"c".repeat(30_000)}`);
    assert.equal(statSync(path).ino, inode, "fixture must keep the inode");
    const after = pageRetainedFile(path, { cursor: first.nextCursor, maxBytes: 16 * 1024, resource: "run" });
    assert.equal(after.reset, "source-replaced");
    assert.equal(after.startByte, 0);
    assert.equal(after.text.startsWith("a".repeat(300) + "c"), true);
  });

  it("binds file cursors to the resource and session scope", () => {
    const path = join(tempDir(), "scoped.log");
    writeFileSync(path, "x".repeat(100));
    const own = pageRetainedFile(path, { maxBytes: 10, resource: "raw:session-a:bg_1" });
    const other = pageRetainedFile(path, { cursor: own.nextCursor, maxBytes: 10, resource: "raw:all:bg_1" });
    assert.equal(other.reset, "stale-cursor");
    assert.equal(other.startByte, 0);
    const same = pageRetainedFile(path, { cursor: own.nextCursor, maxBytes: 10, resource: "raw:session-a:bg_1" });
    assert.equal(same.reset, undefined);
    assert.equal(same.startByte, 10);
  });

  it("returns an append-ready cursor at the end that reads only appended bytes", () => {
    const path = join(tempDir(), "eof.log");
    writeFileSync(path, "first\n");
    const end = pageRetainedFile(path, { maxBytes: 64, resource: "r" });
    assert.equal(end.hasMore, false);
    assert.equal(end.appendReady, true);
    const idle = pageRetainedFile(path, { cursor: end.nextCursor, maxBytes: 64, resource: "r" });
    assert.equal(idle.text, "");
    assert.equal(idle.appendReady, true);
    appendFileSync(path, "second\n");
    const appended = pageRetainedFile(path, { cursor: end.nextCursor, maxBytes: 64, resource: "r" });
    assert.equal(appended.text, "second\n");
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
    // Rotate the old file away (it stays allocated), so the new file at this
    // path is guaranteed a different inode on every platform. Deleting it
    // instead lets Linux hand the same inode number to the new file.
    renameSync(path, `${path}.1`);
    writeFileSync(path, "new-bytes-here\n");
    assert.notEqual(statSync(path).ino, statSync(`${path}.1`).ino);
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

  it("resets from byte zero when a deleted file is recreated, even on a reused inode", () => {
    const path = join(tempDir(), "recreated.log");
    writeFileSync(path, "old-bytes-old-bytes\n");
    const first = pageRetainedFile(path, { maxBytes: 8, resource: "run" });
    rmSync(path);
    writeFileSync(path, "new-bytes-here-and-more\n");
    const after = pageRetainedFile(path, { cursor: first.nextCursor, maxBytes: 8, resource: "run" });
    assert.equal(after.reset, "source-replaced");
    assert.equal(after.startByte, 0);
    assert.equal(after.text, "new-byte");
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

  it("does not advance the cursor past answer bytes it could not show", () => {
    const answer = `BEGIN${"x".repeat(5_000)}END`;
    const envelope = assemblePriorityEnvelope({
      maxBytes: OUTPUT_BUDGET_BYTES.answer,
      sections: { identity: "sa_1 completed", failure: "F".repeat(4_000) },
      verbatim: (budget) => pageVerbatimText(answer, { maxBytes: budget }),
    });
    assert.ok(envelope.byteLength <= OUTPUT_BUDGET_BYTES.answer);
    const page = envelope.verbatim!;
    const shown = page.text;
    const next = pageVerbatimText(answer, { cursor: page.nextCursor, maxBytes: 100 });
    assert.equal(next.startByte, utf8ByteLength(shown), "the next page starts at the first unshown byte");
  });

  it("reconstructs an answer exactly through envelope pages while failures take priority", () => {
    const answer = `${"answer 你好 😀\n".repeat(400)}END`;
    let cursor: string | undefined;
    let rebuilt = "";
    for (let i = 0; i < 200; i += 1) {
      const envelope = assemblePriorityEnvelope({
        maxBytes: OUTPUT_BUDGET_BYTES.answer,
        sections: {
          identity: "sa_1 completed",
          failure: (budget) => "incident ".repeat(1_000).slice(0, Math.max(0, budget)),
          decision: "Condition matched: exit_code = 0",
        },
        verbatimReserve: OUTPUT_BUDGET_BYTES.answer / 2,
        verbatim: (budget) => pageVerbatimText(answer, { cursor, maxBytes: budget }),
      });
      assert.ok(envelope.byteLength <= OUTPUT_BUDGET_BYTES.answer);
      assert.match(envelope.text, /Condition matched/);
      assert.match(envelope.text, /incident/);
      if (envelope.verbatim!.hasMore) {
        assert.ok(utf8ByteLength(envelope.verbatim!.text) >= 900, "the reserve keeps answer pages advancing");
      }
      rebuilt += envelope.verbatim!.text;
      if (!envelope.verbatim!.hasMore) break;
      cursor = envelope.verbatim!.nextCursor;
    }
    assert.equal(rebuilt, answer);
  });

  it("gives a function failure section the exact remaining bytes and keeps decision facts", () => {
    let granted = -1;
    const envelope = assemblePriorityEnvelope({
      maxBytes: 512,
      sections: {
        identity: "bg_1 failed",
        decision: "stop failed: EPERM\nCondition matched: $.x = true",
        failure: (budget) => {
          granted = budget;
          return "R".repeat(budget);
        },
        progress: "elapsed: 1s",
      },
      statusCursor: "p1.status",
    });
    assert.ok(envelope.byteLength <= 512);
    assert.ok(granted > 0);
    assert.match(envelope.text, /stop failed: EPERM/);
    assert.match(envelope.text, /Condition matched/);
    assert.match(envelope.text, /statusCursor=p1\.status/);
    assert.equal(envelope.omitted.some((item) => item.section === "failure"), false);
  });

  it("prints an append-ready cursor for a retained file read to its end", () => {
    const path = join(tempDir(), "raw.log");
    writeFileSync(path, "complete\n");
    const envelope = assemblePriorityEnvelope({
      maxBytes: OUTPUT_BUDGET_BYTES.rawPage,
      sections: { identity: "raw" },
      verbatim: (budget) => pageRetainedFile(path, { maxBytes: budget, resource: "r" }),
    });
    const match = envelope.text.match(/end nextCursor=(\S+)/);
    assert.ok(match, envelope.text);
    appendFileSync(path, "later\n");
    assert.equal(pageRetainedFile(path, { cursor: match![1], maxBytes: 64, resource: "r" }).text, "later\n");
  });
});

describe("envelope convergence", () => {
  it("keeps every section and whole rows when a row page nearly fills the budget", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `run_${String(i).padStart(3, "0")}`, t: i }));
    for (const maxBytes of [1_024, 2_048, 4_096]) {
      const envelope = assemblePriorityEnvelope({
        maxBytes,
        sections: {
          identity: "subagent_list · 200 matching",
          failure: "150 listed runs with active failure observations",
          diagnostics: "3 run record(s) with missing or unreadable metadata",
        },
        gaps: [{ kind: "read", detail: "3 unreadable run metadata record(s)" }],
        statusCursor: `p1.${"s".repeat(120)}`,
        verbatim: (budget) => pageRows(items, {
          resource: "list:all:",
          limit: 100,
          maxBytes: budget,
          keyOf: (row) => ({ time: row.t, id: row.id }),
          render: (row) => `• ${row.id}  [completed]  model  1m 00s · 3 incidents`,
        }),
      });
      assert.ok(envelope.byteLength <= maxBytes, `${envelope.byteLength} > ${maxBytes}`);
      assert.match(envelope.text, /150 listed runs/);
      assert.match(envelope.text, /unreadable metadata/);
      assert.match(envelope.text, /• run_199/);
      assert.match(envelope.text, /hasMore=true omittedRows=\d+ nextCursor=l1\./);
      assert.equal(envelope.omitted.length, 0);
    }
  });
});

describe("pageRows", () => {
  interface Row { id: string; t: number }
  const rows = (count: number, from = 0): Row[] => Array.from({ length: count }, (_, i) => ({ id: `task_${String(from + i).padStart(3, "0")}`, t: 1_000 + from + i }));
  const request = (cursor?: string, limit = 10) => ({
    cursor,
    resource: "list:session-a:",
    limit,
    maxBytes: 4_096,
    keyOf: (row: Row) => ({ time: row.t, id: row.id }),
    render: (row: Row) => `${row.id} ok`,
  });

  it("pages every row newest first, beyond 100, without repeats or gaps", () => {
    const items = rows(105);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      const page = pageRows(items, request(cursor));
      seen.push(...page.text.split("\n").filter(Boolean).map((line) => line.split(" ")[0]!));
      if (!page.hasMore) break;
      assert.equal(page.omittedRows, 105 - seen.length);
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 105);
    assert.equal(new Set(seen).size, 105);
    assert.equal(seen[0], "task_104");
    assert.equal(seen.at(-1), "task_000");
  });

  it("keeps later pages stable when new rows arrive ahead of the cursor", () => {
    const items = rows(30);
    const first = pageRows(items, request());
    const grown = [...items, ...rows(5, 30)];
    const second = pageRows(grown, request(first.nextCursor));
    assert.equal(second.text.split("\n")[0], "task_019 ok");
  });

  it("resets a cursor from another scope or filter", () => {
    const items = rows(30);
    const first = pageRows(items, request());
    const other = pageRows(items, { ...request(first.nextCursor), resource: "list:all:" });
    assert.equal(other.reset, "stale-cursor");
    assert.equal(other.before, 0);
  });

  it("returns a cursor at this page's start when no row fits, so a larger page can retry", () => {
    const items = rows(21);
    const none = pageRows(items, { ...request(), maxBytes: 3 });
    assert.equal(none.shown, 0);
    assert.equal(none.hasMore, true);
    assert.ok(none.nextCursor, "hasMore always comes with a cursor");
    const retry = pageRows(items, request(none.nextCursor));
    assert.equal(retry.reset, undefined);
    assert.equal(retry.text.split("\n")[0], "task_020 ok");
    const second = pageRows(items, request(retry.nextCursor));
    const stuck = pageRows(items, { ...request(second.nextCursor), maxBytes: 3 });
    assert.equal(stuck.shown, 0);
    assert.equal(pageRows(items, request(stuck.nextCursor)).text.split("\n")[0], "task_000 ok");
  });

  it("clips a single oversized row but keeps its leading id", () => {
    const items = [{ id: "task_big", t: 1 }, { id: "task_small", t: 0 }];
    const page = pageRows(items, { ...request(), maxBytes: 64, render: (row: Row) => `${row.id} ${"n".repeat(500)}` });
    assert.ok(utf8ByteLength(page.text) <= 64);
    assert.equal(page.text.startsWith("task_big "), true);
    assert.equal(page.clippedRows, 1);
    const next = pageRows(items, { ...request(page.nextCursor), maxBytes: 64, render: (row: Row) => `${row.id} ${"n".repeat(500)}` });
    assert.equal(next.text.startsWith("task_small "), true);
  });
});

describe("shared output controls and scope keys (#321/#323)", () => {
  it("resolves canonical output-control names over deprecated aliases", () => {
    assert.deepEqual(readOutputControls({ max_bytes: 512, lines: 3 }), { maxBytes: 512, lines: 3 });
    assert.deepEqual(readOutputControls({ maxBytes: 256, tail_lines: 4 }), { maxBytes: 256, lines: 4 });
    assert.deepEqual(readOutputControls({ max_bytes: 512, maxBytes: 256, lines: 0, tail_lines: 9 }), { maxBytes: 512, lines: 0 });
    assert.deepEqual(readOutputControls(undefined), {});
    // #332: an explicit null canonical value is "not given" and never hides a numeric alias.
    assert.deepEqual(readOutputControls({ max_bytes: null, maxBytes: 300, lines: null, tail_lines: 7 }), { maxBytes: 300, lines: 7 });
    assert.deepEqual(readOutputControls({ max_bytes: null, maxBytes: null }), {});
  });

  it("parses include opt-ins, deduplicating known values and naming unknown ones", () => {
    const parsed = readOutputInclude(["tools", "COST", "tools", "bogus", "", "bogus"]);
    assert.deepEqual([...parsed.include].sort(), ["cost", "tools"]);
    assert.deepEqual(parsed.unknown, ["bogus"]);
    assert.deepEqual([...readOutputInclude("cost, tools").include].sort(), ["cost", "tools"]);
    assert.equal(readOutputInclude(undefined).include.size, 0);
    // #332: a non-string, non-array value is an unknown entry that gets a note, not silently nothing.
    assert.deepEqual(readOutputInclude(42).unknown, ["42"]);
    assert.deepEqual(readOutputInclude(true).unknown, ["true"]);
    assert.deepEqual(readOutputInclude(null), { include: new Set(), unknown: [] });
  });

  it("keys cursor scopes by session, never letting an unavailable identity match a readable one", () => {
    const origin = { cwd: "/w", sessionId: "s1" };
    assert.equal(sessionScopeKey({ all: true, origin }), "all");
    assert.equal(sessionScopeKey({ origin }), `session:${originScopeDigest(origin)}`);
    assert.notEqual(sessionScopeKey({ origin }), sessionScopeKey({ origin: { cwd: "/w", sessionId: "s2" } }));
    assert.equal(sessionScopeKey({ unavailable: true, origin }), "session:unavailable");
    assert.equal(sessionScopeKey({ fallback: "parent:1" }), "parent:1");
    assert.equal(sessionScopeKey({}), "none");
    assert.match(originScopeDigest(origin), /^[0-9a-f]{24}$/);
  });

  it("makes a deleted, replaced, or appended log a content change", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-identity-"));
    try {
      const path = join(dir, "task.log");
      writeFileSync(path, "one\n");
      const first = lifecycleContentRevision(["running", 1], path);
      assert.equal(lifecycleContentRevision(["running", 1], path), first);
      assert.notEqual(lifecycleContentRevision(["failed", 1], path), first);
      appendFileSync(path, "two\n");
      const appended = lifecycleContentRevision(["running", 1], path);
      assert.notEqual(appended, first);
      rmSync(path);
      assert.deepEqual(logIdentityFacts(path), ["unreadable", "ENOENT"]);
      assert.notEqual(lifecycleContentRevision(["running", 1], path), appended);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("documents the accepted identical-prefix heuristic: a rewrite that keeps the sampled bytes continues and skips nothing after the cursor", () => {
    // A same-identity rewrite whose head sample and pre-cursor window match is
    // indistinguishable by stat and samples (the same case as delete + recreate
    // on a reused inode with coarse birth times). The cursor continues; every
    // byte after it is still returned. Accepted in the log-utils README.
    const dir = mkdtempSync(join(tmpdir(), "log-identical-prefix-"));
    try {
      const path = join(dir, "task.log");
      const prefix = "p".repeat(600);
      writeFileSync(path, `${prefix}OLD-TAIL\n`);
      const first = pageRetainedFile(path, { maxBytes: 600, resource: "run" });
      assert.equal(first.text, prefix);
      writeFileSync(path, `${prefix}NEW-TAIL-AND-MORE\n`);
      let cursor = first.nextCursor;
      let rest = "";
      for (let pages = 0; pages < 5; pages += 1) {
        const next = pageRetainedFile(path, { cursor, maxBytes: 600, resource: "run" });
        assert.equal(next.reset, undefined);
        if (pages === 0) assert.equal(next.startByte, 600);
        rest += next.text;
        if (next.nextCursor === cursor) break;
        cursor = next.nextCursor;
      }
      assert.equal(rest, "NEW-TAIL-AND-MORE\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
