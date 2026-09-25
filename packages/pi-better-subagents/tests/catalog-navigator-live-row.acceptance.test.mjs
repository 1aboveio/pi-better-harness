/**
 * Opt-in real Pi TUI proof that a named agent launched by the registered
 * spawn tool appears in that same parent's navigator list while it is running.
 *
 * PI_CATALOG_LIVE_ROW=1 starts pi on a pty. The probe calls the registered
 * subagent_spawn tool with the live context. A local OpenAI-compatible
 * fixture holds the child stream open. It does not write meta.json, change
 * spawnPid, or invent rows. A skip is not navigator evidence.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const enabled = process.env.PI_CATALOG_LIVE_ROW === "1";
const agentId = "agent.live-row";
const agentName = "Live Row Agent";
const holdMs = 18_000;

describe("catalog navigator live row", { concurrency: false }, () => {
    (enabled ? it : it.skip)("lists a named agent launched in the same Pi TUI process", { timeout: 90_000 }, async () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const sandbox = join(repoRoot, ".acceptance-sandbox", `live-row-${stamp}`);
        const agent = join(sandbox, "pi-agent");
        const work = join(sandbox, "work");
        const tmp = join(sandbox, "tmp");
        const sessions = join(sandbox, "sessions");
        mkdirSync(join(agent, "agents/agents"), { recursive: true });
        mkdirSync(work, { recursive: true });
        mkdirSync(tmp, { recursive: true });
        mkdirSync(sessions, { recursive: true });
        const hold = await startHold(holdMs);
        const hits = join(sandbox, "hold-hits.json");
        hold.hitsPath = hits;
        writeFileSync(join(agent, "models.json"), JSON.stringify({
            providers: {
                hold: {
                    baseUrl: hold.baseUrl,
                    api: "openai-completions",
                    apiKey: "hold-local",
                    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
                    models: [{
                        id: "hold-stream",
                        name: "Hold Stream",
                        reasoning: true,
                        input: ["text"],
                        contextWindow: 8000,
                        maxTokens: 256,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    }],
                },
            },
        }));
        writeFileSync(join(agent, "agents/agents/agent.live-row.md"), `---
schema: pi-agent/v1
kind: agent
id: ${agentId}
name: ${agentName}
roleId: role.developer
instructions:
  mode: add
overrides:
  model: hold/hold-stream
  effort: low
---
Reply with the single word DONE.
`);
        const out = join(repoRoot, ".rush-results/navigator-live-row.json");
        const phase = join(repoRoot, ".rush-results/navigator-live-row.phase");
        const screen = join(repoRoot, ".rush-results/navigator-live-row.pty");
        mkdirSync(join(repoRoot, ".rush-results"), { recursive: true });
        const pi = process.env.PI_BIN ?? "pi";
        const child = spawn("python3", ["-"], {
            cwd: repoRoot,
            stdio: ["pipe", "pipe", "pipe"],
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.stdin.write(pythonDriver({ sandbox, work, agent, tmp, sessions, out, phase, screen, pi }));
        child.stdin.end();
        const exit = await new Promise((resolveExit) => child.on("close", resolveExit));
        hold.server.close();
        writeFileSync(hits, JSON.stringify(hold.hits, null, 2));
        assert.equal(exit, 0, `pty driver failed\n${stderr}\n${stdout}`);
        const evidence = JSON.parse(readFileSync(out, "utf8"));
        assert.equal(evidence.error, null, JSON.stringify(evidence));
        assert.equal(evidence.mode, "tui");
        assert.equal(evidence.hasUI, true);
        assert.equal(evidence.stillRunning, true);
        const row = evidence.liveRow;
        assert.equal(row.name, agentName);
        assert.equal(row.status, "running");
        assert.match(row.model, /hold-stream/);
        assert.equal(row.effort, "low");
        assert.match(row.id, /^sa_/);
        const navigator = evidence.navigator;
        assert.ok(navigator.listedIds.includes(row.id), JSON.stringify(navigator.listedIds));
        const rendered = JSON.stringify(navigator);
        assert.match(rendered, new RegExp(agentName));
        assert.match(rendered, /role\.developer/);
        assert.match(rendered, /hold-stream/);
        assert.match(rendered, /\blow\b/);
        assert.match(rendered, new RegExp(row.id));
        const listText = (navigator.listLines ?? []).join("\n");
        assert.match(listText, new RegExp(agentName));
        assert.match(listText, /hold-stream/);
        const resultText = evidence.result?.content?.map((block) => block.text ?? "").join("\n") ?? "";
        assert.match(resultText, new RegExp(row.id));
        const stopText = evidence.stopped?.content?.map((block) => block.text ?? "").join("\n") ?? "";
        assert.match(stopText, /Stopped subagent/);
        const capture = readFileSync(screen);
        assert.ok(capture.length > 0, "pty capture must contain the real Pi TUI bytes");
        evidence.screenBytes = capture.length;
        evidence.screenHasName = capture.includes(Buffer.from(agentName));
        evidence.holdRequests = hold.hits.length;
        writeFileSync(out, JSON.stringify(evidence));
    });
});

function startHold(ms) {
    const hits = [];
    const server = createServer((request, response) => {
        const chunks = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
            hits.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8").slice(0, 400) });
            if (request.method === "GET") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ object: "list", data: [{ id: "hold-stream" }] }));
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const send = (payload) => response.write(`data: ${JSON.stringify(payload)}\n\n`);
            send({ id: "chatcmpl-hold", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
            setTimeout(() => {
                send({ id: "chatcmpl-hold", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "DONE" }, finish_reason: null }] });
                send({ id: "chatcmpl-hold", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
                response.write("data: [DONE]\n\n");
                response.end();
            }, ms).unref?.();
        });
        request.on("error", () => { try { response.end(); } catch { /* the child stopped */ } });
        response.on("error", () => { /* the child stopped */ });
    });
    return new Promise((resolveReady, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                reject(new Error("hold server did not bind a port"));
                return;
            }
            resolveReady({ server, hits, baseUrl: `http://127.0.0.1:${address.port}/v1` });
        });
    });
}

function pythonDriver({ work, agent, tmp, sessions, out, phase, screen, pi }) {
    const extension = join(repoRoot, "packages/pi-better-subagents/index.ts");
    const probe = join(here, "fixtures/acceptance/navigator-live-row-probe.ts");
    return `
import os, pty, select, struct, fcntl, termios, time, signal
out = ${JSON.stringify(out)}
phase = ${JSON.stringify(phase)}
screen_path = ${JSON.stringify(screen)}
work = ${JSON.stringify(work)}
argv = [
    ${JSON.stringify(pi)},
    "--no-extensions", "-e", ${JSON.stringify(extension)}, "-e", ${JSON.stringify(probe)},
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
    "--no-session", "--session-dir", ${JSON.stringify(sessions)},
    "--model", "hold/hold-stream", "--thinking", "low",
    "--tools", "subagent_spawn,subagent_result,subagent_stop",
]
env = os.environ.copy()
env.update({
    "PI_CODING_AGENT_DIR": ${JSON.stringify(agent)},
    "TMPDIR": ${JSON.stringify(tmp)},
    "PI_CATALOG_ACCEPTANCE_PROBE": "1",
    "PI_ACCEPTANCE_NAV_OUT": out,
    "PI_ACCEPTANCE_NAV_PHASE": phase,
    "PI_ACCEPTANCE_AGENT_ID": ${JSON.stringify(agentId)},
    "TERM": "xterm-256color",
    "COLUMNS": "120",
    "LINES": "42",
})
pid, fd = pty.fork()
if pid == 0:
    os.chdir(work)
    os.execvpe(argv[0], argv, env)
else:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 42, 120, 0, 0))
    buf = bytearray()
    sent = False
    deadline = time.time() + 70
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.2)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)
        exited, _ = os.waitpid(pid, os.WNOHANG)
        if exited:
            break
        if not sent and os.path.exists(phase):
            try:
                os.write(fd, b"\\x1b[D")
                time.sleep(0.3)
                os.write(fd, b"\\x1b[B")
            except OSError:
                pass
            sent = True
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        time.sleep(0.4)
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
    try:
        os.close(fd)
    except OSError:
        pass
    open(screen_path, "wb").write(buf)
    if not os.path.exists(out):
        raise SystemExit("pi exited before the live-row probe wrote evidence")
`;
}
