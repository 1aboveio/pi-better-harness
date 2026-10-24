/**
 * Benchmark for the pi-better-server localhost connection path.
 *
 * Run with plain node (Node >= 22.18 strips the types itself):
 *
 *   node scripts/bench-localhost.ts
 *
 * Spawns real daemon child processes (src/cli.ts) against a private agent dir
 * with the scripted fake provider, then measures: cold start, connect+hello,
 * RPC latencies, prompt roundtrip, replay catch-up, and the re-attach path.
 */
import { connect } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DaemonClient } from "../src/client.ts";
import { makeEnv, spawnDaemon, type Env } from "../test/helpers.ts";

// Iteration counts. Kept small so the whole run stays well under a minute.
const COLD_STARTS = 3;
const CONNECTS = 10;
const RPC_CALLS = 10;
const CREATE_SESSIONS = 4;
const PROMPTS = 5;
const REPLAY_TURNS = 12; // prompts run to accumulate events for the replay measurement
const REPLAY_RUNS = 5; // fresh connections replaying the accumulated history
const ATTACHES = 5;

const now = (): number => performance.now();

function stats(samples: number[]): { min: number; median: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}

interface Row {
  name: string;
  n: number;
  min: number;
  median: number;
  max: number;
  note?: string;
}

const rows: Row[] = [];
function record(name: string, samples: number[], note?: string): void {
  const s = stats(samples);
  rows.push({ name, n: samples.length, ...s, note });
}

function printTable(): void {
  const headers = ["benchmark", "n", "min (ms)", "median (ms)", "max (ms)", "notes"];
  const cells = rows.map((r) => [r.name, String(r.n), r.min.toFixed(1), r.median.toFixed(1), r.max.toFixed(1), r.note ?? ""]);
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (parts: string[]): string => parts.map((p, i) => p.padEnd(widths[i])).join("  ").trimEnd();
  console.log("");
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const c of cells) console.log(line(c));
  console.log("");
}

/** Connect, say hello (no optional capabilities), and time the whole thing. */
async function timedConnect(socketPath: string): Promise<{ client: DaemonClient; ms: number }> {
  const t0 = now();
  const client = await DaemonClient.connect(socketPath, { hello: { capabilities: [] } });
  return { client, ms: now() - t0 };
}

/** Time one RPC through `client.call` (throws on failure). */
async function timedCall(client: DaemonClient, command: Record<string, unknown>): Promise<{ response: any; ms: number }> {
  const t0 = now();
  const response = await client.call(command);
  return { response, ms: now() - t0 };
}

/** Resolve once `match` has been true for a pushed event, with a hard timeout. */
function waitForEvent(events: Array<{ message: any; at: number }>, what: string, match: (message: any) => boolean, timeoutMs = 20_000): Promise<{ message: any; at: number }> {
  const deadline = now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const hit = events.find((e) => match(e.message));
      if (hit) return resolve(hit);
      if (now() > deadline) return reject(new Error(`Timed out waiting for ${what}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

const daemons: Array<{ kill: (signal?: string) => void }> = [];
function cleanup(): void {
  for (const child of daemons) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
}
process.on("exit", cleanup);
// makeEnv registers an exit handler that removes the temp roots.

async function main(): Promise<void> {
  console.log("bench-localhost: measuring pi-better-server over a local unix socket");

  // ---- 1. Daemon cold start: spawn -> "listening on" -> socket accepts a connection ----
  const coldStarts: number[] = [];
  let env: Env | undefined;
  let daemon: (typeof daemons)[number] | undefined;
  let socketPath = "";
  for (let i = 0; i < COLD_STARTS; i++) {
    const e = makeEnv();
    const t0 = now();
    const started = await spawnDaemon(e);
    // The stderr marker precedes the socket being connectable by a hair; probe a real connection.
    await new Promise<void>((resolve, reject) => {
      const probe = connect(join(e.serverDir, "pi-server.sock"));
      probe.once("connect", () => {
        probe.end();
        resolve();
      });
      probe.once("error", reject);
    });
    coldStarts.push(now() - t0);
    daemons.push(started.child);
    if (i === COLD_STARTS - 1) {
      // Keep the last daemon for the rest of the benchmark.
      env = e;
      daemon = started.child;
      socketPath = started.socketPath;
    } else {
      started.child.kill("SIGKILL");
    }
  }
  record("daemon cold start (spawn -> socket accepts)", coldStarts);
  if (!env || !daemon) throw new Error("no daemon survived cold-start measurement");

  // ---- 2. Client connect + hello handshake ----
  const connects: number[] = [];
  for (let i = 0; i < CONNECTS; i++) {
    const { client, ms } = await timedConnect(socketPath);
    connects.push(ms);
    client.close();
  }
  record("client connect + hello", connects);

  // One long-lived client for the RPC and prompt measurements.
  const { client } = await timedConnect(socketPath);

  // ---- 3a. list_sessions ----
  const listSessions: number[] = [];
  for (let i = 0; i < RPC_CALLS; i++) listSessions.push((await timedCall(client, { type: "list_sessions" })).ms);
  record("rpc list_sessions", listSessions);

  // ---- 3b. create_session (keeps one for the prompt tests, closes the rest later) ----
  const createSessions: number[] = [];
  const createdIds: string[] = [];
  for (let i = 0; i < CREATE_SESSIONS; i++) {
    const { response, ms } = await timedCall(client, { type: "create_session", cwd: env.cwd, model: { provider: "fake", modelId: "fake-1" } });
    createSessions.push(ms);
    createdIds.push(response.sessionId);
  }
  record("rpc create_session", createSessions);
  const sessionId = createdIds[0];
  const spareIds = createdIds.slice(1);

  // ---- 3c. open_session on an already-created session ----
  const openSessions: number[] = [];
  for (let i = 0; i < RPC_CALLS; i++) openSessions.push((await timedCall(client, { type: "open_session", sessionId })).ms);
  record("rpc open_session", openSessions);

  // ---- 3d. client_snapshot ----
  const snapshots: number[] = [];
  for (let i = 0; i < RPC_CALLS; i++) snapshots.push((await timedCall(client, { type: "client_snapshot", sessionId })).ms);
  record("rpc client_snapshot", snapshots);

  // ---- 3e. subscribe ----
  const subscribes: number[] = [];
  for (let i = 0; i < RPC_CALLS; i++) subscribes.push((await timedCall(client, { type: "subscribe", sessionId })).ms);
  record("rpc subscribe", subscribes);

  // ---- 3f. rename_session ----
  const renames: number[] = [];
  for (let i = 0; i < RPC_CALLS; i++) renames.push((await timedCall(client, { type: "rename_session", sessionId, name: `bench-${i}` })).ms);
  record("rpc rename_session", renames);

  // ---- 3g. close_session (close the spare sessions created above) ----
  const closes: number[] = [];
  for (const id of spareIds) closes.push((await timedCall(client, { type: "close_session", sessionId: id })).ms);
  record("rpc close_session", closes);

  // ---- 4. Prompt roundtrip with the fake provider ----
  // The creator connection is auto-subscribed, so events stream to it.
  const events: Array<{ message: any; at: number }> = [];
  client.onEvent((message) => events.push({ message, at: now() }));
  const firstEvent: number[] = [];
  const toAgentEnd: number[] = [];
  const toSettled: number[] = [];
  let settledSeen = false;
  // Match only events pushed after `startIdx` in the shared log.
  const after = (startIdx: number, predicate: (m: any) => boolean) => (m: any): boolean => {
    const idx = events.findIndex((e) => e.message === m);
    return idx >= startIdx && predicate(m);
  };
  for (let i = 0; i < PROMPTS; i++) {
    const baseline = events.length;
    const t0 = now();
    await client.call({ type: "prompt", sessionId, message: `bench prompt ${i}` });
    const first = await waitForEvent(events, "first streamed event", after(baseline, (m) => m.sessionId === sessionId));
    firstEvent.push(first.at - t0);
    const end = await waitForEvent(events, "agent_end", after(baseline, (m) => m.sessionId === sessionId && m.event?.type === "agent_end"));
    toAgentEnd.push(end.at - t0);
    try {
      const settled = await waitForEvent(events, "agent_settled", after(baseline, (m) => m.sessionId === sessionId && m.event?.type === "agent_settled"), 3_000);
      toSettled.push(settled.at - t0);
      settledSeen = true;
    } catch {
      // This Pi build does not emit agent_settled to subscribers; agent_end is the terminal event.
    }
  }
  record("prompt -> first streamed event", firstEvent);
  record("prompt -> agent_end", toAgentEnd);
  if (settledSeen) record("prompt -> agent_settled", toSettled);
  else console.log("note: daemon emitted no agent_settled event; agent_end is the measured terminal event");

  // ---- 5. Replay: accumulate history, then subscribe from seq 0 on fresh connections ----
  for (let i = 0; i < REPLAY_TURNS; i++) {
    const baseline = events.length;
    await client.call({ type: "prompt", sessionId, message: `replay filler ${i}` });
    await waitForEvent(events, "agent_end", after(baseline, (m) => m.sessionId === sessionId && m.event?.type === "agent_end"));
  }
  const replays: number[] = [];
  let replayCount = 0;
  let replayed = 0;
  for (let run = 0; run < REPLAY_RUNS; run++) {
    const replayClient = (await timedConnect(socketPath)).client;
    const replayEvents: Array<{ message: any; at: number }> = [];
    replayClient.onEvent((message) => replayEvents.push({ message, at: now() }));
    const tReplay0 = now();
    const sub = await replayClient.call({ type: "subscribe", sessionId, sinceSeq: 0 });
    const lastSeq = (sub.data as { lastSeq: number }).lastSeq;
    replayed = (sub.data as { replayed: number }).replayed;
    await waitForEvent(replayEvents, `replay catch-up to seq ${lastSeq}`, (m) => m.sessionId === sessionId && typeof m.seq === "number" && m.seq >= lastSeq);
    replays.push(now() - tReplay0);
    replayCount = replayEvents.filter((m) => m.message.sessionId === sessionId && typeof m.message.seq === "number" && m.message.seq <= lastSeq).length;
    replayClient.close();
  }
  const replayMedian = stats(replays).median;
  const perSec = replayMedian > 0 ? (replayCount / replayMedian) * 1000 : 0;
  record("replay subscribe(sinceSeq 0) -> caught up", replays, `${replayCount} events (replayed ${replayed}), ${perSec.toFixed(0)} events/s at median`);

  // ---- 6. Re-attach: open_session + client_snapshot + subscribe on the existing session ----
  const attaches: number[] = [];
  for (let i = 0; i < ATTACHES; i++) {
    const attachClient = (await timedConnect(socketPath)).client;
    const t0 = now();
    await attachClient.call({ type: "open_session", sessionId });
    await attachClient.call({ type: "client_snapshot", sessionId });
    await attachClient.call({ type: "subscribe", sessionId, sinceSeq: 0 });
    attaches.push(now() - t0);
    attachClient.close();
  }
  record("re-attach (open + snapshot + subscribe)", attaches, "per fresh connection, connect+hello excluded");

  // ---- Cleanup ----
  await client.call({ type: "close_session", sessionId }).catch(() => undefined);
  client.close();
  daemon.kill("SIGKILL");

  printTable();
}

main().catch((error) => {
  console.error("bench failed:", error);
  cleanup();
  process.exit(1);
});
