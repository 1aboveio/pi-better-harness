import { EventEmitter } from "node:events";
import { join } from "node:path";
const { createObservedWaitHost } = await import(new URL("../../../pi-better-background-tasks/src/observed-waits.ts", import.meta.url).href);
const { createLocalSupervisor } = await import(new URL("../../../pi-better-background-tasks/src/supervisor/index.ts", import.meta.url).href);
const root = process.argv[2]!;
const directory = join(root, "supervisor");
const pi = { events: new EventEmitter(), on() {}, registerTool() {} };
const ctx = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => "parent-759", getBranch: () => [] } };
const host = createObservedWaitHost(pi, { storePath: join(root, "operation-coordinator.sqlite"), supervisorDirectory: directory, pollMs: 0 });
host.start(ctx);
const launch = await host.launchParent({ kind: "process", params: { shell: false, callback: false,
  argv: [process.execPath, "-e", "setInterval(()=>{},1000)"] }, ctx });
process.send?.({ launch });
// This host deliberately offers no cancellation handoff or credential exchange.
process.on("message", () => { void (async () => {
  await createLocalSupervisor({ directory }).stop(launch.id);
  host.close(); process.exit(0);
})(); });
