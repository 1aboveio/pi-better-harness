import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EventLog } from "../src/event-log.ts";

const tempLog = (name: string) => join(mkdtempSync(join(tmpdir(), "event-log-")), name);
const bigEvent = (n: number) => ({ type: "message_update", n, partial: "x".repeat(2_000) });

describe("event log size bound", () => {
  it("keeps the file under its byte bound even when the event count bound never trips", () => {
    const path = tempLog("a.jsonl");
    const log = new EventLog(path, { ringSize: 5, maxEvents: 1_000_000, maxBytes: 20_000, flushMs: 1 });
    for (let n = 0; n < 200; n++) log.append(bigEvent(n));
    log.flush();
    assert.ok(statSync(path).size <= 20_000 + 2_100, `file is ${statSync(path).size} bytes`);
    const replay = log.since(0);
    assert.equal(replay.truncated, true);
    assert.equal(replay.events.at(-1)!.seq, 200);
    assert.equal(log.last, 200);
  });

  it("bounds the in-memory ring by bytes and still replays the older events from disk", () => {
    const path = tempLog("b.jsonl");
    const log = new EventLog(path, { ringSize: 1_000, ringBytes: 10_000, maxBytes: 10_000_000 });
    for (let n = 0; n < 100; n++) log.append(bigEvent(n));
    const replay = log.since(0);
    assert.equal(replay.truncated, false);
    assert.equal(replay.events.length, 100);
  });

  it("batches token-rate appends instead of writing each one, and flush writes them all", () => {
    const path = tempLog("c.jsonl");
    const log = new EventLog(path, { flushMs: 60_000 });
    for (let n = 0; n < 50; n++) log.append({ type: "message_update", n });
    assert.equal(statSync(path, { throwIfNoEntry: false })?.size ?? 0, 0, "nothing written per event");
    log.flush();
    assert.equal(readFileSync(path, "utf8").split("\n").filter(Boolean).length, 50);
  });
});
