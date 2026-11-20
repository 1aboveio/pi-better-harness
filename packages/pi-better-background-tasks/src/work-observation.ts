import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";

import { cursorKind } from "./shared-log-utils.js";

const hostedClients = new WeakSet<object>();
const connectionAborts = new WeakMap<object, AbortController>();
const clients = new WeakMap<object, Promise<any>>();
const generations = new WeakMap<object, number>();
const listeners = new WeakMap<object, Set<() => void>>();
const activityScopes = new WeakMap<object, string>();

/** Goal reads the subscribed observation, never a periodic full-state RPC. */
export async function backgroundGoalObservation(pi: ExtensionAPI, ctx: ExtensionContext): Promise<any> {
  const scope = { background: true, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId(), processId: process.pid };
  const client = await observationClient(pi, scope);
  const key = JSON.stringify(scope);
  if (activityScopes.get(client) !== key) {
    await client.subscribe(scope);
    activityScopes.set(client, key);
  }
  return client.snapshot;
}
export function onBackgroundObservation(pi: ExtensionAPI, notify: () => void): () => void {
  let set = listeners.get(pi);
  if (!set) { set = new Set(); listeners.set(pi, set); }
  set.add(notify); return () => { set.delete(notify); };
}

export function backgroundListNeedsHistory(params: Record<string, unknown>): boolean {
  return params.all === true || params.limit !== undefined || params.status !== undefined
    || typeof params.cursor === "string" && cursorKind(params.cursor) !== "s";
}

/** A query connection grants no supervisor, transcript writer or retention authority. */
export function backgroundObservation(pi: ExtensionAPI, ctx: ExtensionContext, history = false, all = false, page?: { limit?: number; statuses?: string[]; cursor?: string }, wait?: { timeoutMs: number; signal?: AbortSignal }): Promise<any> {
  const scope = { background: true, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId(), processId: process.pid };
  const generation = generations.get(pi) ?? 0;
  const read = async (retry: boolean): Promise<any> => {
    if ((generations.get(pi) ?? 0) !== generation) throw new Error("runtime-unavailable: client closed");
    const connection = observationClient(pi, scope);
    const client = await connection;
    if ((generations.get(pi) ?? 0) !== generation) throw new Error("runtime-unavailable: client closed");
    try {
      const deadline = Date.now() + (wait?.timeoutMs ?? 20000);
      for (;;) {
        wait?.signal?.throwIfAborted();
        checkGeneration();
        const snapshot = await client.get({ ...scope, backgroundHistory: history, backgroundAll: all, ...page });
        if (!history || snapshot.status !== "rebuilding" || Date.now() >= deadline) return snapshot;
        await delay(wait ? 100 : 20, undefined, { signal: wait?.signal });
      }
    }
    catch (error) {
      if (!retry || hostedClients.has(client) || !client.closed || (generations.get(pi) ?? 0) !== generation) throw error;
      if (clients.get(pi) === connection) clients.delete(pi);
      return read(false);
    }
  };
  const checkGeneration = () => { if ((generations.get(pi) ?? 0) !== generation) throw new Error("runtime-unavailable: client closed"); };
  return read(true);
}

function observationClient(pi: ExtensionAPI, scope: { background: boolean; cwd: string; sessionId?: string }): Promise<any> {
  const generation = generations.get(pi) ?? 0;
  const checkOpen = () => {
    if ((generations.get(pi) ?? 0) !== generation) throw new Error("runtime-unavailable: client closed");
  };
  let pending = clients.get(pi);
  if (!pending) {
    const controller = new AbortController();
    connectionAborts.set(pi, controller);
    pending = (async () => {
      let hosted: any;
      let rejected: unknown;
      pi.events?.emit("pi-better-runtime:connect", {
        accept: (client: any) => { hosted = client; }, reject: (error: unknown) => { rejected = error; },
      });
      if (rejected) throw rejected;
      if (hosted) {
        hostedClients.add(hosted);
        hosted.onChange(() => { for (const notify of listeners.get(pi) ?? []) notify(); });
        try { await hosted.subscribe(scope); activityScopes.set(hosted, JSON.stringify({ ...scope, processId: process.pid })); checkOpen(); return hosted; }
        catch (error) { hosted.close(); throw error; }
      }
      const requestedRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      const root = realpathSync(requestedRoot);
      const ensure = async (timeoutMs?: number, signal?: AbortSignal) => {
        const installer = new URL("../runtime-client/src/runtime/client.mjs", import.meta.url).href;
        const { ensureRuntime } = await import(installer);
        await ensureRuntime({ agentDir: root, serverDir: process.env.PI_SERVER_DIR, timeoutMs, signal });
      };
      let registration;
      try { registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await ensure(undefined, controller.signal);
        registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8"));
      }
      if (registration.version !== 1 || registration.agentDir !== root) throw new Error("Invalid canonical runtime registration");
      const module = new URL("./shared-work-client.mjs", import.meta.url).href;
      const { connectWorkClient } = await import(module);
      const connect = async () => {
        checkOpen();
        const client = await connectWorkClient(join(registration.serverDir, "pi-server.sock"), root, ["runtime-background-state-v1"], {
          signal: controller.signal, recover: ({ timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal }) => ensure(timeoutMs, signal),
        });
        let subscribed = false;
        client.onChange(() => {
          if (!subscribed || clients.get(pi) !== pending) return;
          if (client.closed) clients.delete(pi);
          for (const notify of listeners.get(pi) ?? []) notify();
        });
        try { checkOpen(); await client.subscribe(scope); checkOpen(); }
        catch (error) { client.close(); throw error; }
        subscribed = true;
        activityScopes.set(client, JSON.stringify({ ...scope, processId: process.pid }));
        return client;
      };
      return connect();
    })();
    clients.set(pi, pending);
    pending.catch(() => { if (clients.get(pi) === pending) clients.delete(pi); });
  }
  return pending;
}

export function closeBackgroundObservation(pi: ExtensionAPI): void {
  generations.set(pi, (generations.get(pi) ?? 0) + 1);
  connectionAborts.get(pi)?.abort(); connectionAborts.delete(pi);
  const pending = clients.get(pi); clients.delete(pi);
  void pending?.then(client => client.close(), () => {});
}
