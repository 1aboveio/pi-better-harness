import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runGuardian } from "../../src/runtime/guardian.ts";
import { WorkClient } from "../../src/runtime/work-client.mjs";
import { retainGuardedStartup } from "./guarded-startup.ts";

const directory = process.env.PI_SERVER_DIR!;
const socket = join(directory, "pi-server.sock");
const running = runGuardian(directory);
let releaseStartup: (() => void) | undefined;
process.on("message", message => {
  if ((message as { releaseStartup?: boolean })?.releaseStartup) {
    releaseStartup?.();
    process.send?.({ startupReleased: true });
  } else {
    releaseStartup?.();
    process.kill(process.pid, "SIGTERM");
  }
});
const ready = async () => {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const live = await new Promise<boolean>(resolve => {
      const probe = connect(socket);
      probe.once("connect", () => { probe.destroy(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (live) {
      const startup = await retainGuardedStartup(new WorkClient(socket, process.env.PI_CODING_AGENT_DIR!, ["runtime-client-retention-v1"]), socket);
      releaseStartup = startup.release;
      process.send?.(startup.ready);
      return;
    }
    await delay(20);
  }
  throw new Error("Guardian did not publish its server listener");
};
await Promise.race([ready(), running.then(() => { throw new Error("Guardian exited before readiness"); })]);
await running;
process.disconnect?.();
