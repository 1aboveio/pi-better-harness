import { after } from "node:test";
import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import { WorkQueryExecutor } from "../../src/runtime/query-executor.ts";
import { WorkClient } from "../../src/runtime/work-client.mjs";

export async function fixture(options: { capacity?: number; timeoutMs?: number; watchdogMs?: number; workerUrl?: URL; onTerminalLogsChanged?: (ids: string[]) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "query-root-"));
  mkdirSync(join(root, "runs"));
  const transport = mkdtempSync("/tmp/query-socket-");
  const executor = new WorkQueryExecutor(root, "query-instance", { ...options,
    workerUrl: options.workerUrl ?? new URL("./slow-query-worker.mjs", import.meta.url),
    modelOptions: { baseDir: root, durableDir: join(root, "durable"), intervalMs: 60000 } });
  const worker = (executor as unknown as { worker: Worker }).worker;
  const bootstrapped = new Promise<void>((resolve, reject) => {
    const cleanup = () => { worker.off("message", listener); worker.off("exit", exited); worker.off("error", failed); };
    const listener = (message: any) => { if (message.type === "fixture-ready") { cleanup(); resolve(); } };
    const exited = (code: number) => { cleanup(); reject(new Error(`query fixture worker exited before bootstrap (code ${code})`)); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    worker.on("message", listener); worker.once("exit", exited); worker.once("error", failed);
  });
  // Most fixtures do not need a bootstrap receipt, but awaited receipts must fail on exit.
  void bootstrapped.catch(() => {});
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    const queries = executor.connect(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const command = JSON.parse(line);
        const reply = (data: unknown, error?: unknown) => {
          if (!socket.destroyed) socket.write(JSON.stringify({ type: "response", id: command.id,
            success: !error, data, error: error ? String(error) : undefined }) + "\n");
        };
        if (["hello", "ping"].includes(command.type)) { reply({ ok: true }); continue; }
        try { void queries.handle(command).then(data => {
          if (!socket.destroyed) socket.write(JSON.stringify({ type: "response", id: command.id, success: true }).slice(0, -1) + ',"data":' + data.json + "}\n");
        }, error => reply(undefined, error)); }
        catch (error) { reply(undefined, error); }
      }
    });
  });
  const path = join(transport, "query.sock");
  const clients: WorkClient[] = [];
  const client = async () => { const value = new WorkClient(path, root); clients.push(value); await value.ready; return value; };
  const stall = async (iterations = 3000000) => {
    const started = new Promise<void>(resolve => {
      const listener = (message: any) => { if (message.type === "diagnostic-started") { worker.off("message", listener); resolve(); } };
      worker.on("message", listener);
    });
    const finished = new Promise<number>((resolve, reject) => {
      const cleanup = () => { worker.off("message", listener); worker.off("exit", exited); worker.off("error", failed); };
      const listener = (message: any) => { if (message.type === "diagnostic-finished") { cleanup(); resolve(message.durationMs); } };
      const exited = (code: number) => { cleanup(); reject(new Error(`diagnostic worker exited before completing SQLite work (code ${code})`)); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      worker.on("message", listener); worker.once("exit", exited); worker.once("error", failed);
    });
    // Some watchdog tests intentionally discard the completion promise.
    void finished.catch(() => {});
    worker.postMessage({ type: "diagnostic-stall", iterations }); await started;
    return { finished };
  };
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    clients.forEach(client => client.close()); sockets.forEach(socket => socket.destroy());
    try { await new Promise<void>(resolve => server.close(() => resolve())); }
    finally {
      await executor.close();
      rmSync(root, { recursive: true, force: true }); rmSync(transport, { recursive: true, force: true });
    }
  })();
  // A test timeout does not unwind a suspended body into its finally block.
  after(close);
  server.listen(path); await once(server, "listening");
  return { executor, client, stall, worker, bootstrapped, close, root, path };
}
