import { startDaemon } from "../../src/server.ts";

const daemon = await startDaemon({ serverDir: process.env.PI_SERVER_DIR, sessionIdleMs: 0, daemonIdleMs: 0 });
process.send?.({ ready: daemon.socketPath });
process.on("message", () => { void daemon.stop().then(() => process.exit(0)); });
