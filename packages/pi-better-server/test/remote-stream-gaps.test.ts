import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaemonClient } from "../src/client.ts";
import { RemoteClientSession, type ClientSnapshot } from "../src/remote-client/session.ts";

const SESSION = "s1";
const GENERATION = "gen-1";

function snapshot(lastSeq: number, messages: Array<{ role: string; text: string }> = [], generation = GENERATION): ClientSnapshot {
  return {
    generation,
    lastSeq,
    sessionId: SESSION,
    cwd: "/work",
    name: "gap",
    sessionFile: "/tmp/s1.jsonl",
    state: {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      autoCompactionEnabled: false,
      steeringMode: "all",
      followUpMode: "all",
      thinkingLevel: "off",
    } as ClientSnapshot["state"],
    messages: messages.map((message, index) => ({ id: `m${index}`, role: message.role, content: [{ type: "text", text: message.text }] })),
    entries: [],
    leafId: null,
    tools: [],
    commands: [],
    models: [],
    contextUsage: {},
    stats: {},
  };
}

/** Scripted socket: each snapshot and subscribe answer is consumed in order. */
class ScriptedClient {
  server = { piVersion: "1.2.0", capabilities: [] as string[] };
  readonly calls: Array<Record<string, unknown>> = [];
  private readonly listeners = new Set<(message: any) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly snapshots: ClientSnapshot[];
  private readonly subscribes: Array<Record<string, unknown>>;

  constructor(snapshots: ClientSnapshot[], subscribes: Array<Record<string, unknown>>) {
    this.snapshots = snapshots;
    this.subscribes = subscribes;
  }

  async call(command: Record<string, unknown>): Promise<any> {
    this.calls.push(command);
    switch (command.type) {
      case "client_snapshot": {
        const data = this.snapshots.shift();
        if (!data) throw new Error("scripted client ran out of snapshots");
        return { success: true, data };
      }
      case "subscribe": {
        const data = this.subscribes.shift();
        if (!data) throw new Error("scripted client ran out of subscribe replies");
        return { success: true, data };
      }
      case "acquire_control":
        return { success: true, data: { needsInput: [] } };
      case "get_available_thinking_levels":
        return { success: true, data: { levels: ["off"] } };
      default:
        throw new Error(`unexpected command ${String(command.type)}`);
    }
  }

  onEvent(listener: (message: any) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {}

  push(seq: number, event: Record<string, unknown>, generation = GENERATION): void {
    const envelope = { type: "event", sessionId: SESSION, generation, seq, event };
    for (const listener of this.listeners) listener(envelope);
  }
}

async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("a truncated replay reloads the snapshot instead of continuing with a hole", async () => {
  const missed = "this text was outside the retained window";
  const client = new ScriptedClient(
    [snapshot(1, [{ role: "user", text: "start" }]), snapshot(5, [{ role: "user", text: "start" }, { role: "assistant", text: missed }])],
    [{ truncated: true, lastSeq: 5, generation: GENERATION }, { truncated: false, lastSeq: 5, generation: GENERATION }],
  );
  const session = await RemoteClientSession.connect(client as unknown as DaemonClient, SESSION);
  assert.equal(session.messages.at(-1)?.content[0].text, missed);
  assert.deepEqual(client.calls.map((call) => call.type).filter((type) => type === "client_snapshot" || type === "subscribe"), [
    "client_snapshot", "subscribe", "client_snapshot", "subscribe",
  ]);
  session.dispose();
});

test("a live sequence gap reloads the snapshot and still delivers the next event", async () => {
  const client = new ScriptedClient(
    [
      snapshot(2, [{ role: "user", text: "start" }]),
      snapshot(4, [{ role: "user", text: "start" }, { role: "assistant", text: "filled from snapshot" }]),
    ],
    [{ truncated: false, lastSeq: 2, generation: GENERATION }, { truncated: false, lastSeq: 4, generation: GENERATION }],
  );
  const session = await RemoteClientSession.connect(client as unknown as DaemonClient, SESSION);
  const seen: Array<{ type: string; text?: string }> = [];
  session.subscribe((event) => { seen.push({ type: event.type, text: event.message?.content?.[0]?.text }); });
  client.push(4, { type: "agent_start" });
  await settled();
  assert.equal(session.messages.at(-1)?.content[0].text, "filled from snapshot");
  assert.ok(seen.some((event) => event.type === "remote_snapshot"));
  client.push(5, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "live after the gap" }] } });
  await settled();
  assert.equal(session.messages.at(-1)?.content[0].text, "live after the gap");
  assert.ok(seen.some((event) => event.text === "live after the gap"));
  session.dispose();
});

test("a generation change on subscribe reloads the snapshot for the new generation", async () => {
  const client = new ScriptedClient(
    [snapshot(1, [], GENERATION), snapshot(3, [{ role: "assistant", text: "new generation" }], "gen-2")],
    [{ truncated: false, lastSeq: 3, generation: "gen-2" }, { truncated: false, lastSeq: 3, generation: "gen-2" }],
  );
  const session = await RemoteClientSession.connect(client as unknown as DaemonClient, SESSION);
  assert.equal(session.generation, "gen-2");
  assert.equal(session.messages.at(-1)?.content[0].text, "new generation");
  assert.equal(client.calls.filter((call) => call.type === "client_snapshot").length, 2);
  session.dispose();
});
