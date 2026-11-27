import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactWindow } from "../extensions/native-compaction/provider.ts";

async function fixture(t, baseUrl, modelId, apiKey, contextWindow = 128_000, liveWindow = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-native-compaction-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "test-responses": {
    api: "openai-responses", apiKey, baseUrl, models: [{ id: modelId, name: modelId, contextWindow }],
  } } }));
  const workers = new Set();
  t.after(async () => {
    await Promise.all([...workers].map(async child => { const dead = once(child, "exit"); child.kill("SIGKILL"); await dead; }));
    await rm(root, { recursive: true, force: true });
  });
  return async function open(file = "", automatic = false) {
    const child = fork(new URL("./fixtures/native-compaction-session.mjs", import.meta.url),
      [root, modelId, file, String(automatic)], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir,
          PI_NATIVE_COMPACTION_LIVE_WINDOW: liveWindow ? "1" : "0" },
        execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "inherit", "ipc"] });
    workers.add(child);
    child.once("exit", () => workers.delete(child));
    const receive = () => new Promise((resolve, reject) => {
      const exit = code => { child.off("message", message); reject(new Error(`Pi exited (${code})`)); };
      const message = value => { child.off("exit", exit); value.error ? reject(new Error(value.error)) : resolve(value); };
      child.once("message", message);
      child.once("exit", exit);
    });
    const ready = await receive();
    return { ...ready, child, async send(command) {
      const reply = receive();
      child.send(command);
      const result = await reply;
      assert.deepEqual(result.errors ?? [], []);
      return result;
    }, async stop() { const dead = once(child, "exit"); child.kill("SIGKILL"); await dead; } };
  };
}

async function provider(t) {
  const state = { requests: [], mode: "compact", inputs: 100 };
  let serial = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    state.requests.push({ path: req.url, body, headers: req.headers });
    if (req.url.endsWith("/compact")) {
      if (state.mode === "hang") { state.entered(); return; }
      if (["unsupported", "trigger", "truncated"].includes(state.mode)) { res.writeHead(404).end(); return; }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "retained original" }] },
        { type: "compaction", encrypted_content: `opaque-${++serial}` },
      ] }));
      return;
    }
    if (body.input.at(-1)?.type === "compaction_trigger") {
      if (state.mode === "trigger" || state.mode === "truncated") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const item = { type: "compaction", encrypted_content: "trigger-ciphertext" };
        res.write(`data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`);
        if (state.mode === "trigger") res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({error:{message:"Unsupported compaction_trigger"}}));
      return;
    }
    const item = { id: `msg_${++serial}`, type: "message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Fixture answer.", annotations: [] }] };
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: `resp_${serial}`, status: "completed", output: [item],
        usage: { input_tokens: state.inputs, output_tokens: 4, total_tokens: state.inputs + 4 } } },
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return Object.assign(state, { baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
}

const first = "The project code is SAPPHIRE. " + "Original request details. ".repeat(90);
const recent = "Keep this recent work in the conversation. " + "Recent changes. ".repeat(110);

test("Codex compaction uses the active account and its configured endpoint", async t => {
  const server = await provider(t);
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } };
  const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const model = { api: "openai-codex-responses", provider: "openai-codex", id: "gpt-test", baseUrl: server.baseUrl + "/codex", headers: { "X-Optional": "model" } };
  const ctx = { getSystemPrompt: () => "Existing system prompt", sessionManager: { getSessionId: () => "test-session" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token, headers: { "x-optional": null, "x-stainless-lang": null } }) } };
  const output = await compactWindow(ctx, model, [{ role: "user", content: "First turn" }], undefined, new AbortController().signal);
  assert.equal(output.at(-1).type, "compaction");
  const [request] = server.requests;
  assert.equal(request.path, "/v1/codex/responses/compact");
  assert.equal(request.headers["chatgpt-account-id"], "test-account");
  assert.equal(request.headers.authorization, `Bearer ${token}`);
  assert.equal(request.headers["session-id"], "test-session");
  assert.equal(request.headers["x-optional"], undefined);
  assert.equal(request.headers["x-stainless-lang"], undefined);
});

test("interrupted compaction leaves the journal intact and committed output survives a fresh Pi process", { timeout: 90_000 }, async t => {
  const server = await provider(t);
  const open = await fixture(t, server.baseUrl, "gpt-test", "fixture");
  let pi = await open();
  assert.equal(pi.toggle, "Off");
  assert.equal((await pi.send({ toggle: "On" })).toggle, "On");
  await pi.send({ prompt: first });
  await pi.send({ prompt: recent });
  const before = await readFile(pi.file, "utf8");
  server.mode = "hang";
  const entered = new Promise(resolve => { server.entered = resolve; });
  pi.child.send({ compact: true });
  await entered;
  await pi.stop();
  assert.equal(await readFile(pi.file, "utf8"), before);
  pi = await open(pi.file);
  assert.equal(pi.toggle, "On");
  server.mode = "compact";
  assert.equal((await pi.send({ compact: true, focus: "Keep the code." })).native, true);
  assert.match(server.requests.at(-1).body.instructions, /Keep the code\./);
  const commits = (await readFile(pi.file, "utf8")).trim().split("\n").map(JSON.parse).filter(e => e.type === "compaction");
  assert.equal(commits.length, 1);
  const { output } = commits[0].details;
  await pi.stop();
  pi = await open(pi.file);
  await pi.send({ prompt: "Continue." });
  const resumed = server.requests.at(-1).body;
  assert.deepEqual(resumed.input.slice(1, 3), output);
  assert.equal(JSON.stringify(resumed.input).split(recent).length - 1, 1);
  assert.ok(!JSON.stringify(resumed.input).includes("SAPPHIRE"));
  assert.equal(server.requests.filter(r => r.path.endsWith("/compact")).length, 2);
  await pi.send({ prompt: "Next phase. ".repeat(110) });
  await pi.send({ compact: true });
  assert.deepEqual(server.requests.at(-1).body.input.slice(0, 2), output);
  await pi.send({ toggle: "Off" });
  await pi.send({ prompt: "Next task. ".repeat(110) });
  assert.equal((await pi.send({ compact: true })).native, false);
  assert.match(JSON.stringify(server.requests.at(-1).body.input), /SAPPHIRE/);
});

test("Pi's automatic threshold uses native compaction and unsupported routes fall back to a Pi summary", { timeout: 60_000 }, async t => {
  const server = await provider(t);
  const open = await fixture(t, server.baseUrl, "gpt-test", "fixture", 12_000);
  const pi = await open("", true);
  await pi.send({ toggle: "On" });
  await pi.send({ prompt: first });
  server.inputs = 11_500;
  await pi.send({ prompt: recent });
  assert.ok(server.requests.some(r => r.path.endsWith("/compact")));
  server.inputs = 100;
  server.mode = "unsupported";
  await pi.send({ prompt: "Start another turn. ".repeat(100) });
  assert.equal((await pi.send({ compact: true })).native, false);
  assert.match(JSON.stringify(server.requests.at(-1).body.input), /SAPPHIRE/);
});

test("a partial trigger stream cannot replace history, and another model reads the original messages", { timeout: 60_000 }, async t => {
  const server = await provider(t);
  const open = await fixture(t, server.baseUrl, "gpt-test", "fixture");
  let pi = await open();
  await pi.send({ toggle: "On" });
  await pi.send({ prompt: first });
  await pi.send({ prompt: recent });
  server.mode = "truncated";
  const before = await readFile(pi.file, "utf8");
  await assert.rejects(pi.send({ compact: true }), /cancelled/i);
  assert.equal(await readFile(pi.file, "utf8"), before);
  server.mode = "trigger";
  assert.equal((await pi.send({ compact: true })).native, true);
  const file = pi.file;
  await pi.stop();
  const other = await fixture(t, server.baseUrl, "another-model", "fixture");
  pi = await other(file);
  await pi.send({ toggle: "On" });
  await pi.send({ prompt: "What did we decide?" });
  const input = JSON.stringify(server.requests.at(-1).body.input);
  assert.match(input, /SAPPHIRE/);
  assert.ok(!input.includes("trigger-ciphertext"));
  await pi.send({ prompt: "Keep the follow-up findings. ".repeat(100) });
  const count = server.requests.filter(r => r.path.endsWith("/compact")).length;
  assert.equal((await pi.send({ compact: true })).native, false);
  assert.equal(server.requests.filter(r => r.path.endsWith("/compact")).length, count);
});

test("live GPT follow-ups each reuse more than 95% of input tokens across a restart", {
  skip: process.env.PI_NATIVE_COMPACTION_LIVE !== "1", timeout: 360_000,
}, async t => {
  const model = process.env.PI_NATIVE_COMPACTION_MODEL || "gpt-6.2-sol";
  const open = await fixture(t, process.env.OPENAI_BASE_URL || "https://api.openai.com/v1", model, "$OPENAI_API_KEY", 128_000, true);
  let pi = await open();
  await pi.send({ toggle: "On" });
  await pi.send({ prompt: "The release codename is SAPPHIRE. Remember it. Reply only OK." });
  // Exercise the default Pi keepRecentTokens window with a synthetic release inventory.
  const records = Array.from({ length: 2048 }, (_, i) => `Record ${i}: revision ${(i * 17) % 199}, owner team ${i % 13}, batch ${i % 31}.`);
  await pi.send({ prompt: "Keep this inventory for follow-up questions. Reply only OK.\n" + records.join("\n") });
  assert.equal((await pi.send({ compact: true })).native, true);
  const ratios = [];
  let previous;
  for (let turn = 0; turn < 4; turn++) {
    if (turn === 2) { await pi.stop(); pi = await open(pi.file); }
    const reply = await pi.send({ prompt: "Reply only with the release codename." });
    assert.match(reply.text, /SAPPHIRE/i);
    assert.ok(reply.total > 0);
    t.diagnostic(`${model} turn ${turn + 1}: ${reply.cached}/${reply.total} (${(100 * reply.cached / reply.total).toFixed(2)}%)`);
    if (previous) {
      assert.equal(reply.request.settings, previous.settings, "request settings changed");
      assert.deepEqual(reply.request.prefix.slice(0, previous.prefix.length), previous.prefix, "cached prefix changed");
      ratios.push(reply.cached / reply.total);
    }
    previous = reply.request;
  }
  assert.ok(ratios.every(ratio => ratio > 0.95), `warm cached input ratios: ${ratios.join(", ")}`);
});
