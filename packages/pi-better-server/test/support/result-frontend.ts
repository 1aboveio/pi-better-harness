import { EventEmitter } from "node:events";
import { join } from "node:path";
const { createObservedWaitHost } = await import(new URL("../../../pi-better-background-tasks/src/observed-waits.ts", import.meta.url).href);
const { registerTools } = await import(new URL("../../../pi-better-background-tasks/src/tools.ts", import.meta.url).href);
const root = process.env.PI_CODING_AGENT_DIR!;
const tools = new Map<string, any>();
const pi = { events: new EventEmitter(), on() {}, registerTool(tool: any) { tools.set(tool.name, tool); } };
const host = createObservedWaitHost(pi, { storePath: join(root, "operation-coordinator.sqlite"), supervisorDirectory: join(root, "supervisor") });
const ctx = { cwd: root, isIdle: () => true, sessionManager: { getSessionId: () => "exact-recipient-760", getBranch: () => [] } };
host.start(ctx);
registerTools(pi);
const launched = await tools.get("bg_task_spawn").execute("spawn-760", { shell: false, callback: true,
  argv: [process.execPath, "-e", `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(root, "executions"))},'start\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(root, "finish"))})){clearInterval(t);console.log('independent terminal evidence');}},20);`] }, undefined, undefined, ctx);
const taskId = launched.content.map((part: any) => part.text ?? "").join("\n").match(/bgs_[0-9a-f]{20}/)?.[0];
if (!taskId) throw new Error(JSON.stringify(launched));
const waited = await tools.get("wait_for_operations").execute("wait-760", { task_ids: [taskId], continuation_note: "Interpret the independent result" }, undefined, undefined, ctx);
if (!waited.details?.waitId) throw new Error(JSON.stringify(waited));
process.send?.({ taskId, wait: waited.details });
process.on("message", () => { host.close(); process.exit(0); });
