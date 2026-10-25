import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inspectMeta } from "./registry.js";

/** Optional-peer contract, mirrored by pi-better-sandbox/background-admission.ts. */
export const BACKGROUND_ADAPTER_REQUEST = "pi-better-background-tasks:adapter-request";
export const BACKGROUND_ADAPTER_VERSION = 1;

type Admission = "local-launch" | "registry";
type Request = {
  version: number;
  name: string;
  input: unknown;
  reply(value: { version: number; parameters: object; admission: Admission }): void;
};

/** The schemas belong to one registerTools invocation, never to a module singleton. */
export function advertiseBackgroundAdapter(pi: ExtensionAPI, schemas: ReadonlyMap<string, object>): void {
  const unsubscribe = pi.events?.on(BACKGROUND_ADAPTER_REQUEST, (data: unknown) => {
    const request = data as Partial<Request> | undefined;
    if (request?.version !== BACKGROUND_ADAPTER_VERSION || typeof request.name !== "string" ||
        typeof request.reply !== "function") return;
    const parameters = schemas.get(request.name);
    if (!parameters) return;
    const admission = classify(request.name, request.input);
    if (admission) request.reply({ version: BACKGROUND_ADAPTER_VERSION, parameters, admission });
  });
  pi.on("session_shutdown", () => { if (typeof unsubscribe === "function") unsubscribe(); });
}

function classify(name: string, input: unknown): Admission | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const params = input as Record<string, unknown>;
  let action: unknown;
  switch (name) {
    case "bg_task_spawn": action = "spawn"; break;
    case "bg_task_watch": action = "watch"; break;
    case "bg_task_list": action = "list"; break;
    case "bg_task_status": action = "status"; break;
    case "bg_task_log": action = "log"; break;
    case "bg_task_stop": action = "stop"; break;
    case "bg_task": action = params.action; break;
    case "bg_status":
      if (params.action === "spawn" || params.action === "watch") return;
      action = params.action;
      break;
    default: return;
  }
  if (action === "spawn" || action === "watch") return params.ssh ? undefined : "local-launch";
  if (action === "list" || action === "status" || action === "log" || action === "clear") return "registry";
  if (action !== "stop" || typeof params.id !== "string" || !params.id) return;
  // Never trust caller flags about locality. Missing/corrupt metadata is not proof
  // of a local stop; a remote stop can execute SSH in the trusted Pi process.
  const meta = inspectMeta(params.id).meta;
  if (meta && !meta.ssh && !meta.remote && (meta.kind === "process" || meta.kind === "command_watch")) return "registry";
}
