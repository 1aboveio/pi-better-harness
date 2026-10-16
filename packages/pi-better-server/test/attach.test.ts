import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { attachCommand } from "../src/remote/attach.ts";
import { Client, gate, llmCalls, makeEnv, spawnDaemon, waitFor, type Env } from "./helpers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "remote-cli.ts");
const haveTmux = spawnSync("tmux", ["-V"]).status === 0;

describe("attachCommand", () => {
  it("is plain tmux locally and ssh -t into the host's tmux remotely", () => {
    const tmux = ["tmux", "-L", "x", "attach", "-t", "=pi-abc"];
    assert.deepEqual(attachCommand(undefined, tmux), tmux);
    assert.deepEqual(attachCommand("r9", tmux), ["ssh", "-t", "--", "r9", ...tmux]);
    assert.deepEqual(attachCommand("r9", ["tmux", "attach", "-t", "a b"]).slice(-1), ["'a b'"]);
  });
});

describe("pi-remote attach (tmux companion on a real daemon)", { skip: haveTmux ? false : "tmux is not installed", concurrency: false }, () => {
  let env: Env;
  let daemon: ChildProcess;
  let socketPath: string;
  const tmuxSocket = `pbs-${randomBytes(4).toString("hex")}`;
  let sessionId = "";
  let repo = "";
  const ptys: Array<() => void> = [];

  const tmux = (...args: string[]): string => spawnSync("tmux", ["-L", tmuxSocket, ...args], { encoding: "utf8" }).stdout;
  const pane = (): string => tmux("capture-pane", "-p", "-S", "-500", "-t", `=pi-${sessionId.slice(0, 12)}:`);
  const type = (text: string): void => void tmux("send-keys", "-t", `=pi-${sessionId.slice(0, 12)}:`, "-l", text, ";", "send-keys", "-t", `=pi-${sessionId.slice(0, 12)}:`, "Enter");
  const userTexts = (): string[] => llmCalls(env).map((c) => c.messages.filter((m) => m.role === "user").at(-1)?.text ?? "");

  function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env.vars, PI_REMOTE_STATE_DIR: join(env.root, "state") }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout!.on("data", (c: Buffer) => (stdout += c));
      child.stderr!.on("data", (c: Buffer) => (stderr += c));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  }

  const summary = async (): Promise<any> => {
    const out = await runCli(["ls", "--json"]);
    return JSON.parse(out.stdout).find((s: any) => s.sessionId === sessionId);
  };

  before(async () => {
    env = makeEnv();
    env.vars.PI_SERVER_TMUX_SOCKET = tmuxSocket;
    mkdirSync(join(env.root, "state"));
    repo = env.cwd;
    ({ child: daemon, socketPath } = await spawnDaemon(env));
    const created = await runCli(["new", "--model", "fake/fake-1", "--cwd", repo, "--name", "att", "seed"]);
    assert.equal(created.code, 0, created.stderr);
    sessionId = created.stdout.trim();
    await waitFor("seed turn", async () => (await summary())?.displayStatus === "idle");
  });

  after(() => {
    for (const stop of ptys) stop();
    spawnSync("tmux", ["-L", tmuxSocket, "kill-server"]);
    daemon?.kill("SIGKILL");
  });

  it("starts a companion terminal in a named tmux session that holds the controller lease", async () => {
    const out = await runCli(["attach", "att", "--no-attach", "--json"]);
    assert.equal(out.code, 0, out.stderr);
    const info = JSON.parse(out.stdout);
    assert.equal(info.created, true);
    assert.equal(info.tmuxSession, `pi-${sessionId.slice(0, 12)}`);
    assert.deepEqual(info.command, ["tmux", "-L", tmuxSocket, "attach", "-t", `=${info.tmuxSession}`]);
    assert.match(tmux("list-sessions", "-F", "#{session_name}"), new RegExp(`^${info.tmuxSession}$`, "m"));
    assert.equal((await summary()).hasController, true);
    await waitFor("pane to show attached banner", () => pane().includes("-- attached to att"));
    assert.match(pane(), /echo:seed/, "the pane opens with the session's earlier output");
  });

  it("typed input is delivered as a prompt when idle and as steer mid-turn", async () => {
    type("typed hello");
    await waitFor("prompt to reach the model", () => userTexts().includes("typed hello"));
    await waitFor("reply in the pane", () => pane().includes("echo:typed hello"));

    type("tool g1");
    await waitFor("gate g1", () => gate(env, "g1").started());
    await waitFor("session running", async () => (await summary()).displayStatus === "running");
    type("mid-turn nudge");
    gate(env, "g1").release();
    await waitFor("steer to reach the model", () => userTexts().includes("mid-turn nudge"));
    await waitFor("turn to end", async () => (await summary()).displayStatus === "idle");
    assert.match(pane(), /\[tool gate\]/);
  });

  it("detaching a real attached client leaves the session running; re-attach shows what happened meanwhile", async () => {
    const attachArgs = ["tmux", "-L", tmuxSocket, "attach", "-t", `=pi-${sessionId.slice(0, 12)}`];
    const viaPty = (): { stop: () => void; out: () => string } => {
      // Python's pty module gives tmux the terminal it insists on, the same on macOS and Linux. It also
      // wants a real pipe on stdin, which `sleep |` provides (a Node "pipe" is a socket).
      const script = `python3 -c 'import pty,sys;pty.spawn(sys.argv[1:])' ${attachArgs.join(" ")}`;
      const child = spawn("sh", ["-c", `sleep 120 | ${script}`], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: { ...process.env, TERM: "xterm" } });
      let seen = "";
      child.stdout!.on("data", (c: Buffer) => (seen += c));
      child.stderr!.on("data", (c: Buffer) => (seen += `ERR:${c}`));
      const stop = (): void => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          // already gone
        }
      };
      ptys.push(stop);
      return { stop, out: () => seen };
    };
    const first = viaPty();
    await waitFor("first attach to render the pane", () => first.out().includes("[pi-"));
    tmux("detach-client", "-s", `=pi-${sessionId.slice(0, 12)}`);
    await waitFor("tmux to detach the client", () => tmux("list-clients").trim() === "");
    first.stop();

    const steered = await runCli(["steer", "att", "while-away"]);
    assert.equal(steered.code, 0, steered.stderr);
    await waitFor("work to continue while detached", () => userTexts().includes("while-away"));
    assert.equal((await summary()).hasController, true, "the companion keeps the session while nobody is attached");

    const second = viaPty();
    await waitFor("re-attach to show the missed reply", () => second.out().includes("echo:while-away"));
    second.stop();
  });

  it("an extension dialog is answerable from the attached terminal", async () => {
    type("ask favourite colour?");
    await waitFor("dialog in the pane", () => pane().includes("? favourite colour?"));
    assert.equal((await summary()).needsInput.length, 1);
    type("blue");
    await waitFor("answer to reach the tool", () => userTexts().length > 0 && llmCalls(env).some((c) => c.messages.some((m) => m.role === "toolResult" && m.text === "answer:blue")));
    await waitFor("dialog to clear", async () => (await summary()).needsInput.length === 0);
  });

  it("never lets a second writer in: one companion, one lease", async () => {
    // Two racing attach requests start exactly one companion.
    const [a, b] = await Promise.all([runCli(["attach", "att", "--no-attach", "--json"]), runCli(["attach", "att", "--no-attach", "--json"])]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.equal(tmux("list-sessions", "-F", "#{session_name}").split("\n").filter(Boolean).length, 1);
    assert.equal(JSON.parse(a.stdout).created, false);

    // A second connection can neither take the lease nor answer for the companion.
    const other = await Client.connect(socketPath);
    const taken = await other.request({ type: "acquire_control", sessionId });
    assert.equal(taken.success, false);
    assert.match(taken.error, /Another connection holds the controller lease/);
    const answered = await other.request({ type: "extension_ui_response", sessionId, requestId: "x", value: "nope" });
    assert.equal(answered.success, false);
    assert.match(answered.error, /Only the controller can answer/);
    other.close();

    // A second console exits instead of becoming a second writer, and `answer` refuses too.
    const second = await runCli(["console", "att"]);
    assert.notEqual(second.code, 0);
    assert.match(second.stderr, /controller/);
    const answer = await runCli(["answer", sessionId, "--value", "x"]);
    assert.notEqual(answer.code, 0);
    assert.match(answer.stderr, /Another connection holds the controller lease/);
    assert.equal(llmCalls(env).filter((c) => c.messages.some((m) => m.text === "x")).length, 0);
  });

  it("a restarted companion catches up, and picks up a dialog raised while nobody was controlling", async () => {
    const stopped = await Client.connect(socketPath);
    assert.equal((await stopped.request({ type: "stop_companion", sessionId })).data.stopped, true);
    await waitFor("lease release", async () => !(await summary()).hasController);
    stopped.close();

    // Raise a dialog with no controller at all.
    const steered = await runCli(["steer", "att", "ask while nobody is here?"]);
    assert.equal(steered.code, 0, steered.stderr);
    await waitFor("dialog pending", async () => (await summary()).needsInput.length === 1);

    const out = await runCli(["attach", "att", "--no-attach", "--json"]);
    assert.equal(JSON.parse(out.stdout).created, true);
    await waitFor("pane to replay old output", () => pane().includes("echo:typed hello"));
    await waitFor("pending dialog in the pane", () => pane().includes("? ask while nobody is here?") || pane().includes("while nobody is here?"));
    type("late answer");
    await waitFor("dialog answered from the new terminal", () => llmCalls(env).some((c) => c.messages.some((m) => m.role === "toolResult" && m.text === "answer:late answer")));
  });

  it("closing the session removes its companion", async () => {
    const client = await Client.connect(socketPath);
    assert.equal((await client.request({ type: "close_session", sessionId })).success, true);
    client.close();
    assert.equal(tmux("list-sessions", "-F", "#{session_name}").trim(), "");
  });
});
