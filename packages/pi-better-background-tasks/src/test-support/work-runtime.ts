import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";

/** A real query endpoint for tools tests; never starts the user's managed runtime. */
export async function startWorkRuntime() {
  mkdirSync(resolve(".work/754"), { recursive: true });
  const root = mkdtempSync(resolve(".work/754/output-"));
  const transport = mkdtempSync("/tmp/p754-");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const { WorkReadModel } = await import(new URL("../../../pi-better-server/src/runtime/read-model.ts", import.meta.url).href);
  const { WorkQueries } = await import(new URL("../../../pi-better-server/src/runtime/queries.ts", import.meta.url).href);
  const { checkHello } = await import(new URL("../../../pi-better-server/src/handshake.ts", import.meta.url).href);
  const model = new WorkReadModel(root, "output-tests", { baseDir: join(root, "runs"), durableDir: join(root, "archives") });
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    const queries = new WorkQueries(model, socket);
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        try {
          const result = command.type === "hello" ? checkHello(command, { agentDir: root }) : { ok: true, data: queries.handle(command) };
          socket.write(JSON.stringify({ id: command.id, type: "response", success: result.ok, ...result }) + "\n");
        } catch (error) { socket.write(JSON.stringify({ id: command.id, type: "response", success: false, error: String(error) }) + "\n"); }
      }
    });
  });
  server.listen(join(transport, "pi-server.sock")); await once(server, "listening");
  writeFileSync(join(root, "server-registration-v1.json"), JSON.stringify({ version: 1, agentDir: root, serverDir: transport }));
  return async () => {
    for (const socket of sockets) socket.destroy();
    server.close(); await once(server, "close"); await model.close();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(transport, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true });
  };
}
