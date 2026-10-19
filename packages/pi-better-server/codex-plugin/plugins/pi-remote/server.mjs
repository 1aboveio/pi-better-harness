#!/usr/bin/env node
/**
 * Thin MCP server (stdio, newline-delimited JSON-RPC) that hands each tool call to the
 * shared `pi-remote` CLI. It holds no logic of its own: the CLI does the work, so the
 * Codex plugin and a terminal behave the same. `PI_REMOTE_BIN` names the executable
 * (default `pi-remote`).
 */
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";

const BIN = process.env.PI_REMOTE_BIN || "pi-remote";

const string = (description) => ({ type: "string", description });
const HOST = string("ssh alias of the machine that runs the Codex daemon (omit for this machine)");

/** name -> { description, schema, argv(args) } */
const TOOLS = {
  remote_ls: {
    description: "List Codex threads on a host with their status (running, idle, needs-input), working directory and last activity.",
    properties: { host: HOST },
    required: [],
    argv: (a) => ["ls", ...hostArgs(a), "--json"],
  },
  remote_steer: {
    description: "Send a message to a Codex thread on a host. Mid-turn it steers the running turn; when idle it starts a turn.",
    properties: { session: string("thread id, unique id prefix, or name"), message: string("text to send"), host: HOST },
    required: ["session", "message"],
    // "--" so a message that starts with "-" stays a message.
    argv: (a) => ["steer", ...hostArgs(a), "--json", "--", need(a, "session"), need(a, "message")],
  },
  remote_detach: {
    description: "Move a Codex thread and its workspace (including uncommitted and untracked files) from this machine to another host. The thread continues there; this machine's copy is archived.",
    properties: {
      session: string("thread id, unique id prefix, or name on this machine"),
      to: string("ssh alias of the destination host"),
      to_cwd: string("absolute directory on the destination for the workspace (optional)"),
      codex_provider: string("model provider id configured on the destination to bind the thread to; needed when the destination cannot use the thread's provider (optional)"),
      wait_seconds: { type: "number", description: "how long to wait for a running turn to finish first (optional)" },
    },
    required: ["session", "to"],
    argv: (a) => ["move", "--json", need(a, "session"), "--to", need(a, "to"), ...opt("--to-cwd", a.to_cwd), ...opt("--codex-provider", a.codex_provider), ...opt("--wait", a.wait_seconds)],
  },
  remote_return: {
    description: "Bring a Codex thread and its workspace back from a host to this machine, then resume it here.",
    properties: {
      session: string("thread id, unique id prefix, or name on the host"),
      host: string("ssh alias of the machine that has the thread"),
      to_cwd: string("empty directory on this machine for the workspace (optional)"),
      codex_provider: string("model provider id configured on this machine to bind the thread to; needed when this machine cannot use the thread's provider (optional)"),
      wait_seconds: { type: "number", description: "how long to wait for a running turn to finish first (optional)" },
    },
    required: ["session", "host"],
    argv: (a) => ["return", "--host", need(a, "host"), "--json", need(a, "session"), ...opt("--to-cwd", a.to_cwd), ...opt("--codex-provider", a.codex_provider), ...opt("--wait", a.wait_seconds)],
  },
};

function need(args, key) {
  const value = args?.[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`"${key}" is required`);
  if (value.startsWith("-") && key !== "message") throw new Error(`"${key}" must not start with "-"`);
  return value;
}
function opt(flag, value) {
  return value === undefined || value === null || value === "" ? [] : [flag, String(value)];
}
function hostArgs(args) {
  return typeof args?.host === "string" && args.host ? ["--host", need(args, "host")] : [];
}

function run(argv) {
  return new Promise((resolve) => {
    execFile(BIN, argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 15 * 60_000 }, (error, stdout, stderr) => {
      // Progress goes to stderr; show it only when the command failed, so a successful result stays one JSON document.
      const text = (error ? [stdout.trim(), stderr.trim() && `[stderr]\n${stderr.trim()}`] : [stdout.trim() || stderr.trim()]).filter(Boolean).join("\n");
      resolve({ isError: Boolean(error), text: text || (error ? error.message : "ok") });
    });
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "pi-remote", version: "0.1.0" } } });
  }
  if (method === "tools/list") {
    const tools = Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: "object", properties: t.properties, required: t.required, additionalProperties: false } }));
    return send({ id, result: { tools } });
  }
  if (method === "tools/call") {
    const tool = TOOLS[params?.name];
    if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
    let argv;
    try {
      argv = tool.argv(params.arguments ?? {});
    } catch (error) {
      return send({ id, result: { isError: true, content: [{ type: "text", text: error.message }] } });
    }
    const outcome = await run(argv);
    return send({ id, result: { isError: outcome.isError, content: [{ type: "text", text: outcome.text }] } });
  }
  if (method === "ping") return send({ id, result: {} });
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  void handle(request).catch((error) => request.id !== undefined && send({ id: request.id, error: { code: -32603, message: String(error?.message ?? error) } }));
});
