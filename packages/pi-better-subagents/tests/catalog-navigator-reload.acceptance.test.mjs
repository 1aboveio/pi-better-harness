/**
 * Opt-in real Pi TUI reload of the preserved Acceptance Dev run.
 *
 * PI_CATALOG_NAVIGATOR_RELOAD=1 starts pi on a pty, loads this checkout's
 * extension, and asks the registered navigator renderer and subagent_result
 * tool for sa_muff44v8_1. It does not call a model and does not launch a child.
 * A skip is not navigator evidence.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const enabled = process.env.PI_CATALOG_NAVIGATOR_RELOAD === "1";
const sandbox = process.env.PI_ACCEPTANCE_SANDBOX
    ?? join(repoRoot, ".acceptance-sandbox/2026-09-24T10-57-01-240Z");
const runId = "sa_muff44v8_1";

describe("catalog navigator reload", { concurrency: false }, () => {
    (enabled ? it : it.skip)("renders the preserved run from the registered navigator and result tool", { timeout: 120_000 }, async () => {
        assert.equal(existsSync(join(sandbox, "tmp/pi-better-subagents/runs", runId, "meta.json")), true);
        const out = join(repoRoot, ".rush-results/navigator-reload.json");
        const screen = join(repoRoot, ".rush-results/navigator-reload.pty");
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
        child.stdin.write(pythonDriver(sandbox, out, screen, pi));
        child.stdin.end();
        const exit = await new Promise((resolveExit) => child.on("close", resolveExit));
        assert.equal(exit, 0, `pty driver failed\n${stderr}\n${stdout}`);
        const evidence = JSON.parse(readFileSync(out, "utf8"));
        assert.equal(evidence.error, null, JSON.stringify(evidence.error));
        assert.equal(evidence.mode, "tui");
        const text = JSON.stringify(evidence.navigator);
        assert.match(text, /Acceptance Dev/);
        assert.match(text, /role\.developer/);
        assert.match(text, /grok-4\.5/);
        assert.match(text, /low/);
        assert.match(text, new RegExp(runId));
        const resultText = evidence.result?.content?.map((block) => block.text ?? "").join("\n") ?? "";
        assert.match(resultText, new RegExp(runId));
        assert.match(resultText, /completed/i);
        assert.match(resultText, /\bDONE\b/);
        const capture = readFileSync(screen);
        assert.ok(capture.length > 0, "pty capture must contain the real Pi TUI bytes");
    });
});

function pythonDriver(sandbox, out, screen, pi) {
    const extension = join(repoRoot, "packages/pi-better-subagents/index.ts");
    const probe = join(here, "fixtures/acceptance/navigator-reload-probe.ts");
    const work = join(sandbox, "work");
    const agent = join(sandbox, "pi-agent");
    const tmp = join(sandbox, "tmp");
    const sessions = join(sandbox, "sessions");
    return `
import os, pty, select, struct, fcntl, termios, time, signal
out = ${JSON.stringify(out)}
screen_path = ${JSON.stringify(screen)}
work = ${JSON.stringify(work)}
argv = [
    ${JSON.stringify(pi)},
    "--no-extensions", "-e", ${JSON.stringify(extension)}, "-e", ${JSON.stringify(probe)},
    "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve",
    "--no-session", "--session-dir", ${JSON.stringify(sessions)},
    "--model", "xai/grok-4.7", "--thinking", "high",
    "--tools", "subagent_result",
]
env = os.environ.copy()
env.update({
    "PI_CODING_AGENT_DIR": ${JSON.stringify(agent)},
    "TMPDIR": ${JSON.stringify(tmp)},
    "PI_CATALOG_ACCEPTANCE_PROBE": "1",
    "PI_ACCEPTANCE_NAV_OUT": out,
    "PI_ACCEPTANCE_RUN_ID": "sa_muff44v8_1",
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
    deadline = time.time() + 90
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
        if not sent and os.path.exists(out) and os.path.getsize(out) > 2:
            try:
                os.write(fd, b"\\x1b[D")
            except OSError:
                pass
            sent = True
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except OSError:
            pass
        time.sleep(0.5)
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
        raise SystemExit("pi exited before the navigator probe wrote evidence")
`;
}
