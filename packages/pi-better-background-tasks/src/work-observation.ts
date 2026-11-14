import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const clients = new WeakMap<object, Promise<any>>();
const listeners = new WeakMap<object, Set<() => void>>();
export function onBackgroundObservation(pi: ExtensionAPI, notify: () => void): () => void {
  let set = listeners.get(pi);
  if (!set) { set = new Set(); listeners.set(pi, set); }
  set.add(notify); return () => { set.delete(notify); };
}

/** A query connection grants no supervisor, transcript writer or retention authority. */
export function backgroundObservation(pi: ExtensionAPI, ctx: ExtensionContext, history = false, all = false): Promise<any> {
  const scope = { background: true, cwd: ctx.cwd, sessionId: ctx.sessionManager?.getSessionId() };
  let pending = clients.get(pi);
  if (!pending) {
    pending = (async () => {
      const requestedRoot = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
      mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
      const root = realpathSync(requestedRoot);
      const ensure = async () => {
        const installer = new URL("../runtime-client/src/runtime/client.mjs", import.meta.url).href;
        await (await import(installer)).ensureRuntime({ agentDir: root, serverDir: process.env.PI_SERVER_DIR });
      };
      let registration;
      try { registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await ensure();
        registration = JSON.parse(readFileSync(join(root, "server-registration-v1.json"), "utf8"));
      }
      if (registration.version !== 1 || registration.agentDir !== root) throw new Error("Invalid canonical runtime registration");
      const module = new URL("./shared-work-client.mjs", import.meta.url).href;
      const { WorkClient } = await import(module);
      const client = new WorkClient(join(registration.serverDir, "pi-server.sock"), root, ["runtime-background-state-v1"]);
      let subscribed = false;
      client.onChange(() => {
        if (clients.get(pi) !== pending) return;
        if (client.closed) clients.delete(pi);
        if (!subscribed) return;
        for (const notify of listeners.get(pi) ?? []) notify();
      });
      try { await client.subscribe(scope); }
      catch (error) { client.close(); throw error; }
      subscribed = true;
      return client;
    })();
    clients.set(pi, pending);
    pending.catch(() => { if (clients.get(pi) === pending) clients.delete(pi); });
  }
  return pending.then(client => client.get({ ...scope, backgroundHistory: history, backgroundAll: all }));
}

export function closeBackgroundObservation(pi: ExtensionAPI): void {
  const pending = clients.get(pi); clients.delete(pi);
  void pending?.then(client => client.close(), () => {});
}
