import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostedSession } from "../src/hosted-session.ts";

/** A session whose starting prompt ends without a run, with one message already queued behind it. */
function stub(options: { messages: unknown[]; promptRejects?: boolean; queuedRejects?: boolean }) {
  const queued = { steering: ["queued"], followUp: [] as string[] };
  const calls: string[] = [];
  const session = {
    isStreaming: false,
    messages: options.messages,
    get pendingMessageCount() {
      return queued.steering.length + queued.followUp.length;
    },
    subscribe: () => () => undefined,
    clearQueue: () => {
      const out = { steering: [...queued.steering], followUp: [...queued.followUp] };
      queued.steering = [];
      queued.followUp = [];
      return out;
    },
    prompt: async (text: string, opts?: { preflightResult?: (outcome: unknown) => void }) => {
      calls.push(`prompt:${text}`);
      if (options.promptRejects && text === "start") throw new Error("preflight failed");
      if (options.queuedRejects && text !== "start") throw new Error("cannot run");
      opts?.preflightResult?.("handled");
      // The starting prompt (an extension command) ends without a run and leaves the queue alone; a queued one runs.
      if (text !== "start") queued.steering = [];
    },
    followUp: async () => undefined,
  };
  return { session, calls };
}

function host(session: unknown) {
  const events: any[] = [];
  const log = { append: (event: unknown) => ({ seq: 1, event }), flush: () => undefined, last: 0 } as never;
  const hosted = new HostedSession(session as never, log, () => undefined);
  hosted.addListener((logged) => events.push(logged.event));
  return { hosted, events };
}

describe("queued messages when the starting prompt ends without a run", () => {
  it("an error before the turn starts still runs the queued message", async () => {
    const { session, calls } = stub({ messages: [], promptRejects: true });
    const { hosted } = host(session);
    const response = await hosted.handle({ id: "p1", type: "prompt", message: "start" } as never);
    assert.equal(response.success, false);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls, ["prompt:start", "prompt:queued"]);
  });

  it("with history, the queued message is prompted (Pi's run lifecycle), not continued, after the starting prompt settles", async () => {
    const { session, calls } = stub({ messages: [{ role: "assistant" }] });
    const { hosted } = host(session);
    await hosted.handle({ id: "p1", type: "prompt", message: "start" } as never);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(calls, ["prompt:start", "prompt:queued"]);
  });

  it("reports the queued messages refused when they cannot run", async () => {
    const { session } = stub({ messages: [{ role: "assistant" }], queuedRejects: true });
    const { hosted, events } = host(session);
    await hosted.handle({ id: "p1", type: "prompt", message: "start" } as never);
    await new Promise((r) => setTimeout(r, 20));
    const refused = events.find((e) => e.type === "prompt_error" && e.command === "queued");
    assert.ok(refused, "a refusal event was published");
    assert.deepEqual(refused.messages, ["queued"]);
  });
});
