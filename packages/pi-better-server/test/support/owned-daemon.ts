import { startDaemon } from "../../src/server.ts";
import { WorkClient } from "../../src/runtime/work-client.mjs";
import { realpathSync } from "node:fs";

// Legacy session/transfer fixtures own the server itself, not its recovery parent.
const daemon = await startDaemon({ serverDir: process.env.PI_SERVER_DIR,
  log: message => process.stderr.write(`[owned-daemon] ${message}\n`) });
const client = new WorkClient(daemon.socketPath, realpathSync(process.env.PI_CODING_AGENT_DIR!));
await client.ready;
const stop = () => { client.close(); void daemon.stop(); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
await daemon.closed;
client.close();
process.off("SIGTERM", stop);
process.off("SIGINT", stop);
