#!/usr/bin/env node
import { parseArgs } from "node:util";
import { GLOBAL_OPTIONS, createContext, type Subcommand } from "./remote/context.ts";

/** One module per subcommand; add a line here to register another (move, return, attach). */
const SUBCOMMANDS: Record<string, () => Promise<{ command: Subcommand }>> = {
  answer: () => import("./remote/answer.ts"),
  attach: () => import("./remote/attach.ts"),
  console: () => import("./remote/console.ts"),
  ls: () => import("./remote/ls.ts"),
  move: () => import("./remote/move.ts"),
  new: () => import("./remote/new.ts"),
  recover: () => import("./remote/recover.ts"),
  return: () => import("./remote/return.ts"),
  steer: () => import("./remote/steer.ts"),
  tail: () => import("./remote/tail.ts"),
};

async function usage(): Promise<string> {
  const lines = await Promise.all(Object.values(SUBCOMMANDS).map(async (load) => `  pi-remote ${(await load()).command.usage}`));
  return `Usage:\n${lines.join("\n")}\n\nOptions for every command:\n  --host <ssh-alias>   reach the daemon on another machine through an SSH-forwarded socket\n  --remote-dir <dir>   daemon server dir on that machine (default: ask its shell)\n  --socket <path>      daemon socket on this machine\n  --json               machine-readable output\n`;
}

export async function main(argv: string[]): Promise<number> {
  const name = argv.find((arg) => !arg.startsWith("-"));
  if (!name || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(await usage());
    return name || argv.includes("--help") || argv.includes("-h") ? 0 : 2;
  }
  const load = SUBCOMMANDS[name];
  if (!load) {
    process.stderr.write(`Unknown command: ${name}\n${await usage()}`);
    return 2;
  }
  const { command } = await load();
  const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...command.options }, allowPositionals: true });
  positionals.shift(); // the subcommand name
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const context = createContext({
    host: values.host as string | undefined,
    socket: values.socket as string | undefined,
    remoteDir: values["remote-dir"] as string | undefined,
    json: values.json === true,
    signal: abort.signal,
  });
  try {
    return await command.run({ values, positionals }, context);
  } catch (error) {
    process.stderr.write(`pi-remote: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await context.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
