import { EventEmitter } from "node:events";
import { realpathSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { basename, relative, sep } from "node:path";
import { isMainThread, type MessagePort } from "node:worker_threads";

export interface SourceWatcher extends EventEmitter { ready: Promise<void>; close(): void }
export type SourceWatch = (path: string, listener: (event: string, name?: string) => void) => SourceWatcher;
export type WatchBackend = (path: string, changed: (name?: string) => void, failed: (error: Error) => void) => () => Promise<void>;

export const nativeWatch: WatchBackend = (path, changed, failed) => {
  const root = realpathSync(path);
  if (process.platform !== "darwin") {
    const watcher = watch(root, (_event, name) => changed(name ?? undefined));
    watcher.on("error", failed);
    return () => new Promise(resolve => { watcher.once("close", resolve); watcher.close(); });
  }
  // Loaded only by the owner, never by an executor worker.
  if (!isMainThread) throw new Error("Darwin native source watches require the host transport");
  const native = createRequire(import.meta.url)("fsevents");
  return native.watch(root, (entry: string, flags: number) => {
    const name = relative(root, entry);
    if (name === ".." || name.includes(sep)) return;
    changed(flags & 7 ? undefined : name || basename(root));
  });
};

export const watchSource: SourceWatch = (path, listener) => {
  const watcher = new EventEmitter() as SourceWatcher;
  let closed = false;
  watcher.on("change", listener);
  const stop = nativeWatch(path, name => { if (!closed) watcher.emit("change", "rename", name); }, error => { if (!closed) watcher.emit("error", error); });
  watcher.ready = Promise.resolve();
  watcher.close = () => { if (!closed) { closed = true; void stop().then(() => watcher.emit("close"), error => watcher.emit("error", error)); } };
  return watcher;
};

interface Subscription { live: boolean; busy: boolean; names: Set<string | undefined>; overflow: boolean; stop: () => Promise<void>; retiring?: Promise<void> }
/** One executor owns native lifetimes even when its worker cannot run cleanup. */
export class HostSourceWatches {
  private entries = new Map<string, Subscription>();
  private revoked = new Set<number>();
  private stopFailures = 0;
  private backend: WatchBackend;
  private limit: number;
  constructor(backend: WatchBackend = nativeWatch, limit = 16384) { this.backend = backend; this.limit = limit; }
  metrics() { return { allocated: this.entries.size, retiring: [...this.entries.values()].filter(value => !value.live).length, stopFailures: this.stopFailures }; }
  handle(generation: number, message: any, send: (value: any) => void) {
    if (!String(message.type).startsWith("source-watch-")) return false;
    const id = message.id, key = `${generation}:${id}`;
    if (!Number.isSafeInteger(id) || id < 1) return true;
    const entry = this.entries.get(key);
    if (message.type === "source-watch-subscribe") {
      if (this.revoked.has(generation)) return true;
      try {
        if (entry || this.entries.size >= this.limit) throw new Error("Source watch capacity exhausted (including retiring subscriptions)");
        const value: Subscription = { live: true, busy: false, names: new Set(), overflow: false, stop: async () => {} };
        this.entries.set(key, value);
        const changed = (name?: string) => {
          if (!value.live) return;
          if (value.busy) {
            if (value.names.size < 128) value.names.add(name); else value.overflow = true;
            return;
          }
          value.busy = true;
          send({ type: "source-watch-event", id, names: [name] });
        };
        try { value.stop = this.backend(message.path, changed, error => {
          if (!value.live) return;
          send({ type: "source-watch-error", id, error: String(error).slice(0, 512) });
          void this.retire(key, value).catch(() => {});
        }); }
        catch (error) { this.entries.delete(key); throw error; }
        send({ type: "source-watch-subscribed", id });
      } catch (error) { send({ type: "source-watch-subscribed", id, error: String(error).slice(0, 512) }); }
    } else if (message.type === "source-watch-consumed" && entry?.live) {
      entry.busy = false;
      if (entry.names.size || entry.overflow) {
        const names = [...entry.names];
        if (entry.overflow) names.push(undefined);
        entry.names.clear(); entry.overflow = false; entry.busy = true;
        send({ type: "source-watch-event", id, names });
      }
    } else if (message.type === "source-watch-unsubscribe") {
      void (entry ? this.retire(key, entry) : Promise.resolve()).then(() => send({ type: "source-watch-unsubscribed", id }),
        error => send({ type: "source-watch-unsubscribed", id, error: String(error).slice(0, 512) }));
    }
    return true;
  }
  private retire(key: string, entry: Subscription) {
    entry.live = false;
    return entry.retiring ??= Promise.resolve().then(entry.stop).then(() => { this.entries.delete(key); }, error => { this.stopFailures++; throw error; });
  }
  revoke(generation: number) {
    this.revoked.add(generation);
    return Promise.all([...this.entries].filter(([key]) => key.startsWith(`${generation}:`)).map(([key, entry]) => this.retire(key, entry)));
  }
  close() { return Promise.all([...this.entries].map(([key, entry]) => this.retire(key, entry))); }
}

export function workerSourceWatch(port: MessagePort): SourceWatch {
  let counter = 0;
  const entries = new Map<number, { watcher: SourceWatcher; resolve(): void; reject(error: Error): void; closed: boolean }>();
  port.on("message", message => {
    const entry = entries.get(message.id);
    if (!entry || !String(message.type).startsWith("source-watch-")) return;
    if (message.type === "source-watch-subscribed") {
      if (message.error) entry.reject(new Error(message.error)); else entry.resolve();
    } else if (message.type === "source-watch-error") {
      if (!entry.closed) entry.watcher.emit("error", new Error(message.error));
    } else if (message.type === "source-watch-event") {
      if (!entry.closed) for (const name of message.names) entry.watcher.emit("change", "rename", name);
      port.postMessage({ type: "source-watch-consumed", id: message.id });
    } else if (message.type === "source-watch-unsubscribed") {
      entries.delete(message.id);
      if (message.error) entry.watcher.emit("error", new Error(message.error)); else entry.watcher.emit("close");
    }
  });
  return (path, listener) => {
    // Preserve synchronous missing-path semantics; the model owns ancestor selection.
    realpathSync(path);
    const id = ++counter, watcher = new EventEmitter() as SourceWatcher;
    let resolve!: () => void, reject!: (error: Error) => void;
    watcher.ready = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void watcher.ready.catch(() => {});
    const entry = { watcher, resolve, reject, closed: false };
    entries.set(id, entry); watcher.on("change", listener);
    watcher.close = () => { if (!entry.closed) { entry.closed = true; port.postMessage({ type: "source-watch-unsubscribe", id }); } };
    port.postMessage({ type: "source-watch-subscribe", id, path });
    return watcher;
  };
}
