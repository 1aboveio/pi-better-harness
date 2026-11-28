import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.PI_RECAP_TEST_CLI || join(root, "node_modules/.bin/pi");
const harness = process.env.PI_RECAP_TEST_PACKAGE || join(root, "packages/pi-better-harness");
const supported = process.env.PI_RECAP_TEST_CLI || typeof ModelRegistry.prototype.streamSimple === "function";
test(
  "edit recap settings and isolate auxiliary requests in a real foreground Pi conversation",
  {
    skip: !supported || spawnSync("tmux", ["-V"]).status !== 0,
  },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-recap-tui-"));
    const agent = join(dir, "agent");
    const socket = "pi-recap-" + process.pid;
    const requests = [];
    const affinity = [];
    const prompt = "RECAP-STYLE-CANARY";
    const panel = "RECAP-OUTPUT-CANARY";
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      affinity.push([
        req.headers["session_id"],
        req.headers["x-session-affinity"],
        body.prompt_cache_key,
        body.previous_response_id,
      ]);
      const isRecap = body.messages.some((m) => String(m.content).includes(prompt));
      const text = isRecap ? JSON.stringify({ recap: panel, next: "Verify the staged install." }) : "Confirmed foreground answer.";
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: text }, null],
        [{}, "stop"],
      ]) {
        res.write(
          "data: " +
            JSON.stringify({
              id: "chatcmpl-fixture",
              object: "chat.completion.chunk",
              created: 1,
              model: "answer",
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            "\n\n",
        );
      }
      res.end("data: [DONE]\n\n");
    });
    t.after(async () => {
      spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      rmSync(dir, { recursive: true, force: true });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    mkdirSync(agent);
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, packages: [] }));
    writeFileSync(
      join(agent, "models.json"),
      JSON.stringify({
        providers: {
          "recap-test": {
            baseUrl: "http://127.0.0.1:" + server.address().port + "/v1",
            api: "openai-completions",
            apiKey: "loopback",
            models: [{ id: "answer", name: "Recap fixture", contextWindow: 32000, maxTokens: 2000 }],
          },
        },
      }),
    );
    const manifest = JSON.parse(readFileSync(join(harness, "package.json"), "utf8"));
    const extensions = ["recap", "settings"].map((name) => {
      const entry = manifest.pi.extensions.find((path) => path.endsWith("/" + name + "/index.ts"));
      assert.ok(entry, name + " must be in the shipped extension manifest");
      return resolve(harness, entry);
    });
    const tmux = (...args) => execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
    const screen = () => tmux("capture-pane", "-p", "-t", "recap");
    const key = (k) => tmux("send-keys", "-t", "recap", k);
    const send = (value) => tmux("send-keys", "-t", "recap", "-l", value);
    const wait = async (predicate) => {
      for (let i = 0; i < 240; i++) {
        const pane = screen();
        if (predicate(pane)) return pane;
        await delay(75);
      }
      assert.fail("Timed out; provider requests=" + requests.length + "\n" + screen());
    };
    const select = async (label) => {
      for (let i = 0; i < 20; i++) {
        const prev = screen()
          .split("\n")
          .find((line) => line.startsWith("> "));
        if (prev?.startsWith("> " + label + " ")) return;
        key("Down");
        await wait((p) => p.split("\n").find((line) => line.startsWith("> ")) !== prev);
      }
      assert.fail("Missing setting " + label);
    };
    const args = [
      "env",
      "HOME=" + dir,
      "PI_CODING_AGENT_DIR=" + agent,
      "PI_OFFLINE=1",
      "PI_SKIP_VERSION_CHECK=1",
      cli,
      "--session-id",
      "b71af15a-15ec-4439-929e-42642f4b1592",
      "--no-extensions",
      "--no-skills",
      "--no-tools",
      "--model",
      "recap-test/answer",
      ...extensions.flatMap((e) => ["-e", e]),
    ];
    tmux(
      "new-session",
      "-d",
      "-s",
      "recap",
      "-c",
      dir,
      "-x",
      "120",
      "-y",
      "38",
      ...args,
      "--session-dir",
      join(dir, "enabled-sessions"),
    );
    await wait((p) => p.includes("answer") || p.includes("Recap fixture"));
    send("/harness-settings");
    key("Enter");
    await wait((p) => p.includes("Harness settings"));
    await select("Session recap");
    key("Enter");
    await wait((p) => /Session recap\s+On/.test(p));
    await select("Recap prompt");
    key("Enter");
    await wait((p) => p.includes("clear to restore default"));
    key("C-a");
    key("C-k");
    send(prompt);
    key("Enter");
    await wait((p) => p.includes("Harness settings"));
    key("Escape");
    await wait((p) => !p.includes("Harness settings"));
    assert.equal(requests.length, 0);
    send("First exchange");
    key("Enter");
    await wait((p) => p.includes("↳ Recap: " + panel) && p.includes("Next: Verify the staged install."));
    send("Second exchange");
    key("Enter");
    const transcript = await wait(p => requests.length >= 4 && p.split(panel).length === 3);
    assert.ok(transcript.indexOf(panel) < transcript.indexOf("Second exchange"));
    assert.ok(transcript.lastIndexOf(panel) > transcript.indexOf("Second exchange"));
    assert.equal(requests.length, 4);
    for (const body of [requests[0], requests[2]])
      assert.doesNotMatch(JSON.stringify(body), /RECAP-(STYLE|OUTPUT)-CANARY/);
    for (const body of [requests[1], requests[3]]) {
      assert.ok(JSON.stringify(body.messages).includes(prompt));
      assert.equal(body.tools?.length ?? 0, 0);
    }
    assert.deepEqual(requests[2].messages.slice(0, requests[0].messages.length), requests[0].messages);
    assert.deepEqual(requests[0].tools, requests[2].tools);
    send("/reload");
    key("Enter");
    await wait(p => p.includes("Reloaded") && p.split(panel).length === 3);
    assert.equal(requests.length, 4);
    tmux("new-session", "-d", "-s", "keep-alive");
    tmux("kill-session", "-t", "recap");
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, packages: [] }));
    tmux(
      "new-session",
      "-d",
      "-s",
      "recap",
      "-c",
      dir,
      "-x",
      "120",
      "-y",
      "38",
      ...args,
      "--session-dir",
      join(dir, "baseline-sessions"),
    );
    await wait((p) => p.includes("answer") || p.includes("Recap fixture"));
    send("First exchange");
    key("Enter");
    await wait((p) => requests.length === 5 && p.includes("Confirmed foreground answer."));
    send("Second exchange");
    key("Enter");
    await wait((p) => requests.length === 6 && p.includes("Confirmed foreground answer."));
    assert.deepEqual(requests[0], requests[4]);
    assert.deepEqual(requests[2], requests[5]);
    assert.deepEqual(affinity[0], affinity[4]);
    assert.deepEqual(affinity[2], affinity[5]);
  },
);
