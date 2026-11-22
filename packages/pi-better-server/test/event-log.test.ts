import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EventLog } from "../src/event-log.ts";
import { HostedSession } from "../src/hosted-session.ts";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

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
    assert.equal(log.since(96).firstSeq, 97, "only the last four events fit in the ring");
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

it("publishes live events only after their sequence can be replayed across a restart", () => {
  const path = tempLog("committed.jsonl");
  const log = new EventLog(path, { flushMs: 60_000 });
  const host = new HostedSession({ subscribe: () => () => {} } as unknown as AgentSession, log, () => {});
  const observed: unknown[] = [];
  host.addListener(entry => {
    assert.deepEqual(new EventLog(path).since(entry.seq - 1).events[0], entry);
    observed.push(entry.event);
  });

  const event = { type: "message_update", text: "before mutation" };
  host.publishRuntimeEvent(event);
  event.text = "after mutation";
  assert.deepEqual(observed, []);
  log.flush();

  assert.deepEqual(observed, [{ type: "message_update", text: "before mutation" }]);
  assert.equal(new EventLog(path).last, 1);
});

it("repairs a partial final line before writing the next sequence", () => {
  const path = tempLog("partial.jsonl");
  const original = new EventLog(path);
  original.append({ text: "已保存" });
  original.flush();
  appendFileSync(path, '{"seq":2,"event"');

  const recovered = new EventLog(path);
  const next = recovered.append({ text: "after restart" });
  recovered.flush();
  assert.equal(next.seq, 2);
  assert.deepEqual(new EventLog(path).since(1).events, [next]);
});
