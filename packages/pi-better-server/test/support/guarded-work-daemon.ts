import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runGuardian } from "../../src/runtime/guardian.ts";

const directory = process.env.PI_SERVER_DIR!;
const socket = join(directory, "pi-server.sock");
const running = runGuardian(directory);
process.on("message", () => process.kill(process.pid, "SIGTERM"));
const ready = async () => {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const live = await new Promise<boolean>(resolve => {
      const probe = connect(socket);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (live) { process.send?.({ ready: socket }); return; }
    await delay(20);
  }
  throw new Error("Guardian did not publish its server listener");
};
await Promise.race([ready(), running.then(() => { throw new Error("Guardian exited before readiness"); })]);
await running;
process.disconnect?.();
