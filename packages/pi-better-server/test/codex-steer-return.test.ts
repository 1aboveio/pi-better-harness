import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { digestWorktree } from "../src/core/bundle.ts";
import { moveSession } from "../src/move/orchestrate.ts";
import { createThread, git, makeRepo, remote, runCleanups, shortDir, startHost, type Host } from "./codex-host.ts";
import { waitFor } from "./helpers.ts";
import { resumeHint } from "../src/codex/return.ts";
import { defaultServerDir } from "../src/paths.ts";

after(runCleanups);

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** User messages the model was sent in its latest request. */
function sentTexts(host: Host, request = host.model.requests.length - 1): string[] {
  return (host.model.requests[request]?.input ?? []).filter((item) => item.role === "user").flatMap((item) => item.content.map((c: { text: string }) => c.text));
}

interface Listed {
  sessionId: string;
  displayStatus: string;
  ownership?: string;
  cwd: string;
}
async function ls(host: Host): Promise<Listed[]> {
  const result = await remote(["ls", "--json", "--socket", host.daemon.socketPath]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as Listed[];
}

describe("Codex steer and ls (real codex app-server, mock model)", { concurrency: false }, () => {
  it("steers an idle thread by starting a turn, and a running thread by joining its turn", async () => {
    const host = await startHost("s1");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(host, repo);
    assert.deepEqual((await ls(host)).map((t) => [t.sessionId, t.displayStatus]), [[id, "idle"]]);
    const sock = ["--socket", host.daemon.socketPath];

    // Idle: the message starts a turn, and the model is sent the whole conversation plus the new text.
    const before = host.model.requests.length;
    const idle = await remote(["steer", ...sock, "--json", id.slice(0, 8), "second message"]);
    assert.equal(idle.code, 0, idle.stderr);
    assert.equal(JSON.parse(idle.stdout).delivered, "prompt");
    await waitFor("idle steer to reach the model", () => host.model.requests.length > before);
    assert.ok(sentTexts(host).includes("hello from the laptop"), "earlier history is part of the request");
    assert.ok(sentTexts(host).includes("second message"));

    // Mid-turn: hold the model, start a turn, then steer it.
    await waitFor("turn to finish", async () => (await ls(host))[0]?.displayStatus === "idle");
    const hold = host.model.holdNext();
    const started = await remote(["steer", ...sock, "--json", id, "first of three"]);
    assert.equal(JSON.parse(started.stdout).delivered, "prompt");
    await hold.arrived;
    assert.equal((await ls(host))[0]?.displayStatus, "running");

    const requestsBefore = host.model.requests.length;
    const mid = await remote(["steer", ...sock, "--json", id, "change of plan"]);
    assert.equal(mid.code, 0, mid.stderr);
    assert.equal(JSON.parse(mid.stdout).delivered, "steer");
    hold.release();
    await waitFor("steered text to reach the model", () => host.model.requests.length > requestsBefore);
    assert.ok(sentTexts(host).includes("change of plan"), `second model call of the same turn: ${JSON.stringify(sentTexts(host))}`);
    await waitFor("turn to end", async () => (await ls(host))[0]?.displayStatus === "idle");
  });

  it("refuses to drive a thread this host no longer owns", async () => {
    const host = await startHost("s2");
    const other = await startHost("s3");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(host, repo);
    await moveSession(host.client, other.client, { sessionId: id });
    const result = await remote(["steer", "--socket", host.daemon.socketPath, id, "still there?"]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /moved on this host/); // the retired thread is archived and still listed, as closed
    assert.deepEqual((await ls(host)).map((t) => [t.sessionId, t.displayStatus, t.ownership]), [[id, "closed", "moved"]]);
    const requestsBefore = host.model.requests.length;
    await assert.rejects(host.client.call({ type: "steer", sessionId: id, message: "x" }), /moved on this host/);
    assert.equal(host.model.requests.length, requestsBefore);
  });
});

describe("pi-remote return for a Codex thread", { concurrency: false }, () => {
  it("brings the thread and workspace back after steering it on the host, and resumes it locally", async () => {
    const laptop = await startHost("l1");
    const server = await startHost("r1");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(laptop, repo);

    // Detach, then work on the host: steer it while idle.
    const detached = await moveSession(laptop.client, server.client, { sessionId: id });
    const remoteSock = ["--socket", server.daemon.socketPath];
    const steered = await remote(["steer", ...remoteSock, "--json", id, "continue on the server"]);
    assert.equal(JSON.parse(steered.stdout).delivered, "prompt");
    await waitFor("host turn", async () => (await ls(server))[0]?.displayStatus === "idle" && server.model.requests.length >= 1);
    writeFileSync(join(detached.cwd, "src", "from-server.ts"), "export const y = 2;\n");
    writeFileSync(join(detached.cwd, "a.txt"), "one\ndirty\nedited on the server\n");

    // Return. The laptop's daemon is running, so the command uses it. The original directory still holds the stale copy.
    const back = shortDir("cx-back-");
    const result = await remote(["return", ...remoteSock, "--json", id.slice(0, 8), "--to-cwd", join(back, "ws")], laptop.env);
    assert.equal(result.code, 0, result.stderr);
    const returned = JSON.parse(result.stdout) as { cwd: string; resumeCommand: string; verified: boolean; worktreeFiles: number };
    assert.equal(returned.cwd, join(back, "ws"));
    assert.equal(returned.verified, true);
    // The laptop daemon holds the thread, so a standalone `codex resume` would be refused; the hint goes through it.
    assert.match(returned.resumeCommand, new RegExp(`pi-remote attach ${id}`));
    assert.doesNotMatch(returned.resumeCommand, /codex (exec )?resume/);

    // Workspace: the host's edits, byte for byte, same commit.
    assert.equal(returned.worktreeFiles, digestWorktree(detached.cwd).length);
    for (const file of ["a.txt", "src/untracked.ts", "src/from-server.ts", "run.sh"]) assert.equal(sha(join(returned.cwd, file)), sha(join(detached.cwd, file)), file);
    assert.equal(git(returned.cwd, "rev-parse", "HEAD"), git(repo, "rev-parse", "HEAD"));

    // Thread: owned by the laptop again, at the new workspace, with the host's turn in its history.
    const local = (await ls(laptop))[0]!;
    assert.deepEqual([local.sessionId, local.displayStatus, local.ownership, local.cwd], [id, "idle", undefined, returned.cwd]);

    // Single writer: the host's copy is retired (listed as moved) and refuses messages.
    assert.deepEqual((await ls(server)).map((t) => [t.sessionId, t.displayStatus, t.ownership]), [[id, "closed", "moved"]]);
    await assert.rejects(server.client.call({ type: "prompt", sessionId: id, message: "x" }), /moved on this host/);

    // Resume locally: a new message runs on the laptop's own app-server with the full history.
    const before = laptop.model.requests.length;
    const resumed = await remote(["steer", "--socket", laptop.daemon.socketPath, "--json", id, "welcome back"]);
    assert.equal(JSON.parse(resumed.stdout).delivered, "prompt");
    await waitFor("local turn", () => laptop.model.requests.length > before);
    const texts = sentTexts(laptop);
    for (const expected of ["hello from the laptop", "continue on the server", "welcome back"]) assert.ok(texts.includes(expected), `${expected} in ${JSON.stringify(texts)}`);
  });

  it("starts a daemon for the command when none is running on this machine", async () => {
    const laptop = await startHost("l2");
    const server = await startHost("r2");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(laptop, repo);
    await moveSession(laptop.client, server.client, { sessionId: id });
    // The laptop's daemon goes away; its CODEX_HOME and server dir stay.
    laptop.client.close();
    await laptop.daemon.stop();
    const back = shortDir("cx-back-");
    const result = await remote(["return", "--socket", server.daemon.socketPath, "--json", id, "--to-cwd", join(back, "ws")], laptop.env);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(existsSync(join(back, "ws", "src", "untracked.ts")), true);
    assert.equal(laptop.daemon.runtime.rolloutPath(id) !== undefined, true);
    assert.deepEqual((await ls(server)).map((t) => [t.sessionId, t.displayStatus, t.ownership]), [[id, "closed", "moved"]]);
  });

  it("leaves the host's thread live and untouched when return cannot go ahead", async () => {
    const laptop = await startHost("l3");
    const server = await startHost("r3");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(laptop, repo);
    await moveSession(laptop.client, server.client, { sessionId: id });
    const sock = ["--socket", server.daemon.socketPath];

    // 1. A destination that is not empty is refused before anything is fenced.
    const busyDir = shortDir("cx-busy-");
    writeFileSync(join(busyDir, "keep.txt"), "mine\n");
    const refused = await remote(["return", ...sock, id, "--to-cwd", busyDir], laptop.env);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /not empty; pass --to-cwd/);

    // 2. A turn that outlasts --wait: the fence times out, the host unfences, the turn carries on.
    const hold = server.model.holdNext();
    await remote(["steer", ...sock, id, "long job"]);
    await hold.arrived;
    const timedOut = await remote(["return", ...sock, id, "--wait", "1", "--to-cwd", join(shortDir("cx-back-"), "ws")], laptop.env);
    assert.notEqual(timedOut.code, 0);
    assert.equal((await ls(server))[0]?.ownership, undefined, "host still owns the thread");
    assert.equal((await ls(server))[0]?.displayStatus, "running");
    hold.release();
    await waitFor("host turn to end", async () => (await ls(server))[0]?.displayStatus === "idle");
    // Never half-moved: the laptop never took it, and the host still takes messages.
    assert.equal(laptop.daemon.runtime.rolloutPath(id), undefined);
    assert.equal(JSON.parse((await remote(["steer", ...sock, "--json", id, "still yours"])).stdout).delivered, "prompt");
  });
});

describe("codex return hint", () => {
  it("goes through the running daemon, naming a non-default server dir, and uses plain codex resume only when nothing holds the thread", () => {
    assert.equal(resumeHint("/w", "t1", false, defaultServerDir()), "cd /w && codex resume t1");
    assert.match(resumeHint("/w", "t1", true, defaultServerDir()), /^pi-remote attach t1 /);
    assert.match(resumeHint("/w", "t1", true, "/x/srv"), /^PI_SERVER_DIR=\/x\/srv pi-remote attach t1 .*PI_SERVER_DIR=\/x\/srv pi-remote steer t1/);
  });
});
