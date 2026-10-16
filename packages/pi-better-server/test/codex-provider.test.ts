import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { rewriteRolloutCwd, rewriteRolloutProvider } from "../src/codex/rollout.ts";
import { returnCodexThread } from "../src/codex/return.ts";
import { moveSession } from "../src/move/orchestrate.ts";
import { CODEX_BIN, createThread, makeRepo, remote, runCleanups, shortDir, startHost, type Host } from "./codex-host.ts";
import { waitFor } from "./helpers.ts";

after(runCleanups);

const FIXTURE = join(import.meta.dirname, "fixtures", "codex-rollout.jsonl");
const OPENAI_THREAD = "0198a000-0000-7000-8000-000000000478";

function rolloutOf(host: Host, id: string): string {
  const file = host.daemon.runtime.rolloutPath(id) ?? host.daemon.runtime.archivedRolloutPath(id);
  assert.ok(file, `${id} has a rollout on ${host.home}`);
  return readFileSync(file, "utf8");
}
const providerOf = (text: string): string => JSON.parse(text.split("\n")[0]!).payload.model_provider;

/** The fixture thread (recorded under provider "openai") planted in a host, as if its Codex had recorded it for `cwd`. */
function plantOpenAiThread(host: Host, cwd: string): string {
  const dir = join(host.home, "sessions", "2026", "10", "16");
  mkdirSync(dir, { recursive: true });
  const text = rewriteRolloutCwd(readFileSync(FIXTURE, "utf8"), "/original/workspace", cwd).text;
  writeFileSync(join(dir, `rollout-2026-10-16T14-23-03-${OPENAI_THREAD}.jsonl`), text);
  return OPENAI_THREAD;
}

async function ownership(host: Host, id: string): Promise<string | undefined> {
  const rows = ((await host.client.call({ type: "list_sessions" })).data as { sessions: Array<{ sessionId: string; ownership?: string }> }).sessions;
  return rows.find((row) => row.sessionId === id)?.ownership;
}

describe("rollout provider rewriting", () => {
  const settings = JSON.stringify({ timestamp: "t", ordinal: 7, type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "x", thread_settings: { model: "m", model_provider_id: "openai", approval_policy: "never" } } });
  const text = `${readFileSync(FIXTURE, "utf8").trimEnd()}\n${settings}\n`;

  it("a cwd rewrite also moves the workspace in thread_settings_applied, which the app-server resumes a thread with", () => {
    const line = JSON.stringify({ timestamp: "t", ordinal: 8, type: "event_msg", payload: { type: "thread_settings_applied", thread_id: "x", thread_settings: { cwd: "/host/ws", runtime_workspace_roots: ["/host/ws"], model: "m" } } });
    const out = rewriteRolloutCwd(`${line}\n`, "/host/ws", "/back/ws");
    assert.equal(out.changed, 2);
    assert.deepEqual(JSON.parse(out.text).payload.thread_settings, { cwd: "/back/ws", runtime_workspace_roots: ["/back/ws"], model: "m" });
  });

  it("changes only the provider fields: session_meta.model_provider and thread_settings_applied.model_provider_id", () => {
    const out = rewriteRolloutProvider(text, "corp");
    assert.equal(out.changed, 2);
    const before = text.split("\n");
    const after = out.text.split("\n");
    assert.equal(after.length, before.length);
    const changedLines = after.flatMap((line, index) => (line === before[index] ? [] : [index]));
    assert.deepEqual(changedLines, [0, before.indexOf(settings)]);
    assert.equal(providerOf(out.text), "corp");
    assert.equal(JSON.parse(after[before.indexOf(settings)]!).payload.thread_settings.model_provider_id, "corp");
    // Undoing the rewrite gives the original back byte for byte.
    assert.equal(rewriteRolloutProvider(rewriteRolloutProvider(out.text, "openai").text, "openai").text, text);
  });
});

describe("Codex move checks the target's provider (real codex-cli, real app-servers, mock models)", { concurrency: false }, () => {
  it("refuses before fencing, naming the provider, when the target does not configure it; --codex-provider rebinds and the first turn runs there; return rebinds back", async () => {
    const laptop = await startHost("pl", "alpha");
    const server = await startHost("pr", "beta");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(laptop, repo);
    const original = rolloutOf(laptop, id);
    assert.equal(providerOf(original), "alpha");
    const socket = ["--socket", laptop.daemon.socketPath];

    // No rebind: refused before the source is fenced, nothing reaches the target.
    const refused = await remote(["move", ...socket, id, "--to-socket", server.daemon.socketPath], laptop.env);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Refusing to move; nothing was changed/);
    assert.match(refused.stderr, /provider-auth: model provider "alpha" cannot be used there: it is not configured there/);
    assert.match(refused.stderr, /--codex-provider/);
    assert.equal(await ownership(laptop, id), undefined, "the source was never fenced");
    assert.equal(rolloutOf(laptop, id), original, "the source rollout is untouched");
    assert.equal(server.daemon.runtime.rolloutPath(id), undefined, "the target holds nothing");

    // A rebind to a provider the target does not have is refused the same way.
    const bad = await remote(["move", ...socket, id, "--to-socket", server.daemon.socketPath, "--codex-provider", "gamma"], laptop.env);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /model provider "gamma" cannot be used there/);
    assert.equal(await ownership(laptop, id), undefined);

    // Rebind: moves, and only the provider field of the moved rollout differs from the source's.
    const moved = await remote(["move", ...socket, id, "--to-socket", server.daemon.socketPath, "--codex-provider", "beta", "--json", "--to-cwd", join(shortDir("cx-dst-"), "ws")], laptop.env);
    assert.equal(moved.code, 0, moved.stderr);
    const target = rolloutOf(server, id);
    assert.equal(providerOf(target), "beta");
    const cwd = (JSON.parse(moved.stdout) as { cwd: string }).cwd;
    assert.ok(rewriteRolloutProvider(rewriteRolloutCwd(target, cwd, repo).text, "alpha").text.startsWith(original.trimEnd()), "everything but the provider and the workspace path is what the source had");
    assert.equal(rolloutOf(laptop, id), original, "the source's archived copy keeps its provider");

    // The first turn on the target runs with the target's provider.
    const sent = { laptop: laptop.model.requests.length, server: server.model.requests.length };
    const steered = await remote(["steer", "--socket", server.daemon.socketPath, "--json", id, "go on"]);
    assert.equal(steered.code, 0, steered.stderr);
    await waitFor("turn on the target", () => server.model.requests.length > sent.server);
    assert.equal(laptop.model.requests.length, sent.laptop, "the source's model got nothing");
    await waitFor("turn to end", async () => JSON.parse((await remote(["ls", "--json", "--socket", server.daemon.socketPath])).stdout)[0]?.displayStatus === "idle");

    // Return: the laptop has no provider "beta", so it is refused until the thread is bound back to one it has.
    const back = join(shortDir("cx-back-"), "ws");
    const returnOptions = { ref: id, host: server.client, serverDir: laptop.serverDir, codex: { bin: CODEX_BIN, home: laptop.home }, toCwd: back };
    await assert.rejects(returnCodexThread(returnOptions), /model provider "beta" cannot be used there: it is not configured there/);
    assert.equal(await ownership(server, id), undefined, "the host kept the thread");
    const returned = await returnCodexThread({ ...returnOptions, rebindProvider: "alpha" });
    assert.equal(returned.cwd, back);
    assert.equal(providerOf(rolloutOf(laptop, id)), "alpha");
    const before = laptop.model.requests.length;
    const local = await remote(["steer", "--socket", laptop.daemon.socketPath, "--json", id, "welcome back"]);
    assert.equal(local.code, 0, local.stderr);
    await waitFor("local turn", () => laptop.model.requests.length > before);
  });

  it("the target re-checks at import, so a move that skips the CLI preflight still leaves the source unfenced", async () => {
    const source = await startHost("ps", "alpha");
    const target = await startHost("pt", "beta");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(source, repo);
    await assert.rejects(moveSession(source.client, target.client, { sessionId: id }), /source session is unchanged and running: .*model provider "alpha" cannot be used there/);
    assert.equal(await ownership(source, id), undefined);
    assert.equal(target.daemon.runtime.rolloutPath(id), undefined);
    await moveSession(source.client, target.client, { sessionId: id, rebindProvider: "beta" });
    assert.equal(providerOf(rolloutOf(target, id)), "beta");
  });

  it("an API-key login on the target belongs to its configured provider, not to the built-in openai", async () => {
    const laptop = await startHost("po", "alpha");
    const server = await startHost("pk", "beta", { apiKeyLogin: true });
    const bare = await startHost("pn", "beta");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = plantOpenAiThread(laptop, repo);
    // Index the planted rollout, as Codex would have when it was recorded.
    const app = await laptop.daemon.runtime.client();
    await app.call("thread/read", { threadId: id, includeTurns: false });
    await app.call("thread/turns/list", { threadId: id });
    const move = (to: Host, ...extra: string[]) => remote(["move", "--socket", laptop.daemon.socketPath, id, "--to-socket", to.daemon.socketPath, ...extra], laptop.env);

    const signedOut = await move(bare);
    assert.notEqual(signedOut.code, 0);
    assert.match(signedOut.stderr, /model provider "openai" cannot be used there: this host is not signed in/);

    const keyed = await move(server);
    assert.notEqual(keyed.code, 0);
    assert.match(keyed.stderr, /model provider "openai" cannot be used there: its only sign-in is an API key, which belongs to the provider "beta" configured there/);
    assert.equal(await ownership(laptop, id), undefined);

    const rebound = await move(server, "--codex-provider", "beta");
    assert.equal(rebound.code, 0, rebound.stderr);
    assert.equal(providerOf(rolloutOf(server, id)), "beta");
  });
});

describe("a turn that fails on the host is reported", { concurrency: false }, () => {
  it("steer exits non-zero with the failure instead of `started turn`, and ls shows the error instead of idle until a turn succeeds", async () => {
    const host = await startHost("pf");
    const repo = makeRepo(shortDir("cx-ws-"));
    const id = await createThread(host, repo);
    const sock = ["--socket", host.daemon.socketPath];

    host.model.failNext(401, "Incorrect API key provided");
    const failed = await remote(["steer", ...sock, id, "this will fail"]);
    assert.equal(failed.code, 1);
    assert.doesNotMatch(failed.stdout, /started turn/);
    assert.match(failed.stderr, new RegExp(`turn on ${id.slice(0, 8)} failed: .*401 Unauthorized.*Incorrect API key provided`));

    const listed = JSON.parse((await remote(["ls", "--json", ...sock])).stdout) as Array<{ displayStatus: string; lastError?: string }>;
    assert.equal(listed[0]?.displayStatus, "error");
    assert.match(listed[0]?.lastError ?? "", /401 Unauthorized/);
    const table = (await remote(["ls", ...sock])).stdout;
    assert.match(table, /error: .*401 Unauthorized/);
    assert.doesNotMatch(table, /\bidle\b/);

    // A turn that works clears it.
    const ok = await remote(["steer", ...sock, "--json", id, "try again"]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).delivered, "prompt");
    await waitFor("thread to read as idle again", async () => (JSON.parse((await remote(["ls", "--json", ...sock])).stdout) as Array<{ displayStatus: string }>)[0]?.displayStatus === "idle");
  });
});

