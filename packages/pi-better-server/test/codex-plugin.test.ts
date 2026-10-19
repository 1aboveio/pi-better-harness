import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CODEX_BIN, MARKETPLACE, createThread, installPlugin, makeRepo, pkgRoot, run, runCleanups, shortDir, startHost, writePiRemoteWrapper, type Host } from "./codex-host.ts";
import { waitFor } from "./helpers.ts";

after(runCleanups);

const NAMESPACE = "mcp__pi_remote";

/** Run `codex exec` whose scripted model answers the first request with one call to a plugin tool. */
async function execToolCall(host: Host, tool: string, args: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const wrapper = writePiRemoteWrapper(shortDir("cx-bin-"));
  const before = host.model.requests.length;
  host.model.queueToolCall(tool, args, NAMESPACE);
  const cwd = shortDir("cx-exec-");
  const result = await run(
    [CODEX_BIN, "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, `use ${tool}`],
    { ...host.env, PI_REMOTE_BIN: wrapper, ...extraEnv },
  );
  assert.equal(result.code, 0, result.stderr);
  const requests = host.model.requests.slice(before);
  const raw = requests.flatMap((request) => request.input).filter((item) => item.type === "function_call_output").at(-1)?.output;
  // Codex hands MCP results back as content parts, with a timing header first.
  const output = Array.isArray(raw) ? raw.map((part: { text: string }) => part.text).filter((text: string) => !text.startsWith("Wall time")).join("\n") : String(raw ?? "");
  return { requests, output };
}

describe("Codex plugin (real codex plugin add, real codex exec, mock model)", { concurrency: false }, () => {
  it("installs with codex plugin add, ships its skill, and exposes the four tools", async () => {
    const host = await startHost("pl1");
    await installPlugin(host);
    const { requests } = await execToolCall(host, "remote_ls", {});
    const first = requests[0]!;
    const namespace = first.tools?.find((tool) => tool.name === NAMESPACE);
    assert.deepEqual(namespace?.tools.map((tool: { name: string }) => tool.name).sort(), ["remote_detach", "remote_ls", "remote_return", "remote_steer"]);
    assert.match(JSON.stringify(first.input), /pi-remote/, "the skill is offered to the model");
  });

  it("remote_ls and remote_steer reach the daemon through the shared CLI", async () => {
    const host = await startHost("pl2");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(host, repo);
    await installPlugin(host);

    const listed = await execToolCall(host, "remote_ls", {});
    const rows = JSON.parse(listed.output) as Array<{ sessionId: string; displayStatus: string }>;
    // `codex exec` made its own thread in this home too; ours is among them.
    assert.ok(rows.some((row) => row.sessionId === id && row.displayStatus === "idle"), listed.output);

    const before = host.model.requests.length;
    const steered = await execToolCall(host, "remote_steer", { session: id, message: "-dash text via plugin" });
    assert.deepEqual(JSON.parse(steered.output), { sessionId: id, delivered: "prompt" });
    await waitFor("steered thread to call the model", () =>
      host.model.requests.slice(before).some((request) => JSON.stringify(request.input).includes("hello from the laptop") && JSON.stringify(request.input).includes("-dash text via plugin")),
    );
  });

  it("returns a failed CLI run as a tool error with the CLI's own message", async () => {
    const host = await startHost("pl3");
    await installPlugin(host);
    const failed = await execToolCall(host, "remote_steer", { session: "nope", message: "x" });
    assert.match(failed.output, /No session matches "nope"/);
  });
});

describe("Codex plugin MCP server", { concurrency: false }, () => {
  /** Talk to server.mjs over stdio with a fake `pi-remote` that records its arguments. */
  async function withServer<T>(fn: (call: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>, argv: () => string[][]) => Promise<T>): Promise<T> {
    const dir = shortDir("cx-mcp-");
    const log = join(dir, "argv.log");
    const fake = join(dir, "fake-pi-remote");
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\necho '{"ok":true}'\ncase "$*" in *boom*) echo "it broke" >&2; exit 3;; esac\n`);
    chmodSync(fake, 0o755);
    const child = spawn("node", [join(MARKETPLACE, "plugins", "pi-remote", "server.mjs")], { env: { ...process.env, PI_REMOTE_BIN: fake }, stdio: ["pipe", "pipe", "inherit"] });
    const pending = new Map<number, (message: any) => void>();
    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        pending.get(message.id)?.(message);
      }
    });
    let nextId = 1;
    const rpc = (method: string, params: unknown) =>
      new Promise<any>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    try {
      await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      const call = async (name: string, args: Record<string, unknown>) => {
        const reply = await rpc("tools/call", { name, arguments: args });
        return { isError: reply.result.isError as boolean, text: reply.result.content[0].text as string };
      };
      return await fn(call, () => (existsLog(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(" ")) : []));
    } finally {
      child.kill();
    }
  }
  const existsLog = (file: string) => {
    try {
      readFileSync(file);
      return true;
    } catch {
      return false;
    }
  };

  it("maps detach, ls, steer and return to pi-remote commands", async () => {
    await withServer(async (call, argv) => {
      await call("remote_ls", { host: "r9" });
      await call("remote_steer", { host: "r9", session: "abc123", message: "keep going" });
      await call("remote_detach", { session: "abc123", to: "r9", to_cwd: "/srv/ws", wait_seconds: 5 });
      await call("remote_return", { session: "abc123", host: "r9" });
      assert.deepEqual(argv(), [
        ["ls", "--host", "r9", "--json"],
        ["steer", "--host", "r9", "--json", "--", "abc123", "keep", "going"],
        ["move", "--json", "abc123", "--to", "r9", "--to-cwd", "/srv/ws", "--wait", "5"],
        ["return", "--host", "r9", "--json", "abc123"],
      ]);
    });
  });

  it("rejects missing or option-like arguments and reports CLI failures as tool errors", async () => {
    await withServer(async (call, argv) => {
      assert.deepEqual(await call("remote_detach", { session: "abc123" }), { isError: true, text: '"to" is required' });
      assert.equal((await call("remote_return", { session: "--help", host: "r9" })).isError, true);
      assert.deepEqual(argv(), [], "nothing ran");
      const failed = await call("remote_steer", { session: "abc123", message: "boom" });
      assert.equal(failed.isError, true);
      assert.match(failed.text, /it broke/);
    });
  });
});
