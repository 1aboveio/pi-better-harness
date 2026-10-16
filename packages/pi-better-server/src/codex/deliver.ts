/**
 * Getting a message into a Codex thread through the app-server: `turn/steer` while a turn
 * runs (the text joins the turn at its next model call), `turn/start` when the thread is
 * idle. The same thing `codex queue --thread` does, without a second process.
 */
import type { CodexMoveAdapter } from "./adapter.ts";
import type { CodexRuntime } from "./runtime.ts";

export type Delivery = "steer" | "prompt";

const NO_ACTIVE_TURN = /no active turn/i;

function userInput(text: string): unknown[] {
  return [{ type: "text", text, text_elements: [] }];
}

/** A thread this daemon may drive: present here and not fenced or handed to another host. */
export function assertDrivable(adapter: CodexMoveAdapter, runtime: CodexRuntime, threadId: string): void {
  const ownership = adapter.ownership.get(threadId).state;
  if (ownership !== "owned") throw new Error(`Thread ${threadId} is ${ownership} on this host and cannot take messages here; drive it where it now lives`);
  if (!runtime.rolloutPath(threadId)) throw new Error(`Unknown Codex thread: ${threadId}`);
}

async function threadStatus(runtime: CodexRuntime, threadId: string): Promise<string> {
  const client = await runtime.client();
  const { thread } = await client.call<{ thread: { status?: { type?: string } } }>("thread/read", { threadId, includeTurns: false });
  return thread.status?.type ?? "notLoaded";
}

export async function isThreadRunning(adapter: CodexMoveAdapter, runtime: CodexRuntime, threadId: string): Promise<boolean> {
  assertDrivable(adapter, runtime, threadId);
  return (await threadStatus(runtime, threadId)) === "active";
}

async function activeTurnId(runtime: CodexRuntime, threadId: string): Promise<string | undefined> {
  const client = await runtime.client();
  const page = await client.call<{ data: Array<{ id: string; status: string }> }>("thread/turns/list", { threadId, limit: 5 });
  return page.data.find((turn) => turn.status === "inProgress")?.id;
}

/**
 * Deliver `text`. Mid-turn it steers the running turn; idle it starts a turn. A turn
 * that ends (or starts) between the status read and the call is retried once the other way.
 */
export async function deliverToThread(adapter: CodexMoveAdapter, runtime: CodexRuntime, threadId: string, text: string): Promise<Delivery> {
  assertDrivable(adapter, runtime, threadId);
  const client = await runtime.client();
  const status = await threadStatus(runtime, threadId);
  if (status === "notLoaded") await client.call("thread/resume", { threadId, excludeTurns: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    const turnId = status === "active" || attempt > 0 ? await activeTurnId(runtime, threadId) : undefined;
    if (turnId) {
      try {
        await client.call("turn/steer", { threadId, expectedTurnId: turnId, input: userInput(text) });
        return "steer";
      } catch (error) {
        if (!(error instanceof Error && NO_ACTIVE_TURN.test(error.message))) throw error;
        continue; // the turn ended just now; start one
      }
    }
    await client.call("turn/start", { threadId, input: userInput(text) });
    return "prompt";
  }
  throw new Error(`Could not deliver to ${threadId}: its turn state kept changing`);
}
