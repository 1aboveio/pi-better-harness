import { parseArgs } from "node:util";

export type ServerAgent = "pi" | "codex";

/** Resolves the daemon agent from argv (`--agent codex` or `--agent=codex`), falling back to the env value, then "pi". */
export function resolveAgent(argv: readonly string[], envAgent?: string): ServerAgent {
  let value: string | undefined = envAgent;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--agent") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) throw new Error("--agent requires a value; expected pi or codex");
      value = next;
      i++;
    } else if (arg.startsWith("--agent=")) {
      value = arg.slice("--agent=".length);
    }
  }
  const agent = value ?? "pi";
  if (agent !== "pi" && agent !== "codex") throw new Error(`Unknown --agent ${agent}; expected pi or codex`);
  return agent;
}

/** Shared managed-startup grammar; flags follow the same --name/--name=value rules as ensure. */
export function parseManagedStartupArgs(argv: string[]) {
  return parseArgs({ args: argv, options: {
    agent: { type: "string" },
    "server-dir": { type: "string" },
    "agent-dir": { type: "string" },
    runtime: { type: "string" },
    "desired-runtime": { type: "string" },
    "operation-id": { type: "string" },
    "timeout-ms": { type: "string" },
    "pi-version": { type: "string" },
    "protocol-version": { type: "string" },
    "require-capability": { type: "string", multiple: true },
  } }).values;
}
