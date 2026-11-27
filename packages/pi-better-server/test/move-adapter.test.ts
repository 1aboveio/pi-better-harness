import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { DaemonClient } from "../src/client.ts";
import { CodexMoveAdapter } from "../src/codex/adapter.ts";
import { CodexRuntime } from "../src/codex/runtime.ts";
import { createBundle, sha256File } from "../src/core/bundle.ts";
import type { AgentMoveAdapter, ImportRequest, MovePreflightContext } from "../src/core/adapter.ts";
import { MoveHost } from "../src/core/move-host.ts";
import { OwnershipStore } from "../src/core/ownership.ts";
import { moveSession } from "../src/move/orchestrate.ts";
import { PiMoveAdapter } from "../src/move/pi-adapter.ts";
import { SessionRegistry } from "../src/registry.ts";
import type { MoveCommand } from "../src/protocol.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });
}

interface FakeSession {
  cwd: string;
  transcript: string;
  running: boolean;
}

/** A stand-in for a non-Pi agent (kind "fake"): sessions are a transcript string, no registry, no Pi imports. */
class FakeAdapter implements AgentMoveAdapter {
  readonly kind = "fake";
  readonly ownership: OwnershipStore;
  readonly sessions = new Map<string, FakeSession>();
  readonly preflights: MovePreflightContext[] = [];

  constructor(dir: string) {
    this.ownership = new OwnershipStore(join(dir, "ownership.json"));
  }
  hasSession = (id: string) => this.sessions.has(id);
  isBusy = () => false;
  async stop(id: string) {
    this.sessions.get(id)!.running = false;
  }
  bundleSession(id: string) {
    const session = this.sessions.get(id)!;
    return {
      cwd: session.cwd,
      agent: { kind: this.kind, version: "1.0.0", extensions: {} },
      session: { id, metadata: { cwdName: "ws" } },
      stateFiles: [{ name: "transcript.txt", content: session.transcript }],
    };
  }
  async retire(id: string) {
    this.sessions.delete(id);
  }
  async resume(id: string) {
    this.sessions.get(id)!.running = true;
  }
  assertCanImport(id: string) {
    if (this.sessions.get(id)?.running) throw new Error(`Session ${id} already exists on this daemon`);
  }
  checkBundle(manifest: ImportRequest["manifest"]) {
    if (manifest.agent.kind !== this.kind) throw new Error(`Bundle was made by ${manifest.agent.kind}`);
  }
  snapshot = (id: string) => this.sessions.get(id);
  async importSession(request: ImportRequest) {
    const transcript = readFileSync(join(request.extractedDir, "state", "transcript.txt"), "utf8");
    this.sessions.set(request.sessionId, { cwd: request.cwd, transcript, running: true });
  }
  async restore(id: string, snapshot: unknown) {
    if (snapshot) this.sessions.set(id, snapshot as FakeSession);
    else this.sessions.delete(id);
  }
  preflight: (context: MovePreflightContext) => void | Promise<void> = async (context) => {
    this.preflights.push(context);
  };
}

function endpoint(host: MoveHost): DaemonClient {
  return { call: async (command: Record<string, unknown>) => host.handle(command as MoveCommand) } as unknown as DaemonClient;
}

describe("move core with a second agent adapter", () => {
  it("moves a session through the shared bundle, transfer and ownership code", async () => {
    const root = mkdtempSync(join(tmpdir(), "move-adapter-"));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    writeFileSync(join(repo, "a.txt"), "one\ndirty\n");

    const sourceDir = join(root, "source");
    const targetDir = join(root, "target");
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    const source = new FakeAdapter(sourceDir);
    const target = new FakeAdapter(targetDir);
    const sessionId = "session-fake-1";
    source.sessions.set(sessionId, { cwd: repo, transcript: "hello from the fake agent", running: true });

    const result = await moveSession(
      endpoint(new MoveHost(source, sourceDir, join(sourceDir, "moves"))),
      endpoint(new MoveHost(target, targetDir, join(targetDir, "moves"))),
      { sessionId, chunkBytes: 4096 },
    );

    assert.equal(result.verified, true);
    assert.equal(result.daemonId, target.ownership.daemonId);
    assert.equal(result.epoch, source.ownership.get(sessionId).epoch + 1);
    assert.equal(source.ownership.get(sessionId).state, "moved");
    assert.equal(source.sessions.has(sessionId), false);
    assert.equal(target.ownership.get(sessionId).state, "owned");
    assert.equal(target.sessions.get(sessionId)?.transcript, "hello from the fake agent");
    assert.equal(readFileSync(join(result.cwd, "a.txt"), "utf8"), "one\ndirty\n");
    assert.deepEqual(source.preflights.map((p) => p.side), ["source"]);
    assert.deepEqual(target.preflights.map((p) => p.side), ["target"]);
  });

  it("refuses a bundle from another agent kind and leaves the source running", async () => {
    const root = mkdtempSync(join(tmpdir(), "move-adapter-"));
    roots.push(root);
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "base");
    const sourceDir = join(root, "source");
    const targetDir = join(root, "target");
    mkdirSync(sourceDir);
    mkdirSync(targetDir);
    const source = new FakeAdapter(sourceDir);
    const target = new FakeAdapter(targetDir);
    Object.defineProperty(target, "kind", { value: "other" });
    const sessionId = "session-fake-2";
    source.sessions.set(sessionId, { cwd: repo, transcript: "t", running: true });

    await assert.rejects(
      moveSession(endpoint(new MoveHost(source, sourceDir, join(sourceDir, "moves"))), endpoint(new MoveHost(target, targetDir, join(targetDir, "moves"))), { sessionId }),
      /Bundle was made by fake/,
    );
    assert.equal(source.sessions.get(sessionId)?.running, true);
    assert.equal(source.ownership.get(sessionId).state, "owned");
    assert.equal(target.sessions.has(sessionId), false);
    assert.equal(existsSync(join(targetDir, "workspaces", sessionId)), false);
  });

  it("a duplicate move_begin or an abort that lands while the target preflight is awaited cannot register a second transfer", async () => {
    const root = mkdtempSync(join(tmpdir(), "move-adapter-"));
    roots.push(root);
    const targetDir = join(root, "target");
    mkdirSync(targetDir);
    const target = new FakeAdapter(targetDir);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => (release = resolveGate));
    target.preflight = async () => gate;
    const host = new MoveHost(target, targetDir, join(targetDir, "moves"));
    const begin = (moveId: string) => host.handle({ type: "move_begin", moveId, sessionId: "session-fake-3", size: 0, sha256: "0".repeat(64) } as MoveCommand);

    const first = begin("move-race-1");
    const second = begin("move-race-1");
    const aborted = begin("move-race-2");
    await host.handle({ type: "move_abort", moveId: "move-race-2", sessionId: "session-fake-3" });
    release();
    const results = await Promise.allSettled([first, second, aborted]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "only one begin wins");
    assert.equal(results[0]!.status, "fulfilled");
    assert.match(String((results[1] as PromiseRejectedResult).reason), /already started/);
    assert.match(String((results[2] as PromiseRejectedResult).reason), /was aborted/);
    await assert.rejects(host.handle({ type: "move_write", moveId: "move-race-2", offset: 0, data: "" } as MoveCommand), /not started or was aborted/);
  });

  describe("importSession throws after ownership is acquired", () => {
    const here = dirname(fileURLToPath(import.meta.url));

    function makeRepo(root: string): string {
      const repo = join(root, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, "a.txt"), "one\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "base");
      return repo;
    }

    /** Send `bundlePath` to the target host as one inbound move and commit it. */
    async function commitBundle(host: MoveHost, bundlePath: string, sessionId: string, moveId: string): Promise<void> {
      const data = readFileSync(bundlePath);
      await host.handle({ type: "move_begin", moveId, sessionId, size: statSync(bundlePath).size, sha256: sha256File(bundlePath) } as MoveCommand);
      await host.handle({ type: "move_write", moveId, offset: 0, data: data.toString("base64") } as MoveCommand);
      await host.handle({ type: "move_commit", moveId } as MoveCommand);
    }

    it("Pi: ownership is released, the registry entry is restored and the destination is removed", async () => {
      const root = mkdtempSync(join(tmpdir(), "move-adapter-"));
      roots.push(root);
      const repo = makeRepo(root);
      const transcript = join(root, "session.jsonl");
      writeFileSync(transcript, '{"type":"session"}\n');
      const bundle = join(root, "bundle.tar");
      createBundle({
        cwd: repo,
        outFile: bundle,
        agent: { kind: "pi", version: PI_VERSION, extensions: {} },
        session: { id: "session-pi-1", metadata: { cwdName: "ws" } },
        ownership: { epoch: 3, from: "source-daemon", moveId: "move-pi-1" },
        sessionFiles: [{ name: "session.jsonl", path: transcript }],
      });

      const targetDir = join(root, "target");
      mkdirSync(targetDir);
      class FailingRegistry extends SessionRegistry {
        override async adopt(): Promise<never> {
          throw new Error("adopt failed after acquire");
        }
      }
      const registry = new FailingRegistry({ serverDir: targetDir });
      const adapter = new PiMoveAdapter(registry, targetDir);
      const host = new MoveHost(adapter, targetDir, join(targetDir, "moves"));

      await assert.rejects(commitBundle(host, bundle, "session-pi-1", "move-pi-1"), /adopt failed after acquire/);
      assert.equal(adapter.ownership.peek("session-pi-1"), undefined, "ownership was released");
      assert.equal(registry.entry("session-pi-1"), undefined, "no registry entry is left");
      assert.equal(existsSync(join(targetDir, "workspaces", "session-pi-1", "ws")), false, "the destination was removed");
      assert.equal(existsSync(join(targetDir, "imported", "session-pi-1")), false, "the copied transcript was removed");
      // The session can be moved in again afterwards.
      adapter.assertCanImport("session-pi-1");
    });

    it("Codex: ownership is released, the rollout is removed and the destination is removed", async () => {
      const root = mkdtempSync(join(tmpdir(), "move-adapter-"));
      roots.push(root);
      const repo = makeRepo(root);
      const threadId = "0198a000-0000-7000-8000-000000000494";
      const rolloutRelPath = `2026/10/17/rollout-2026-10-17T10-00-00-${threadId}.jsonl`;
      const rollout = join(root, "rollout.jsonl");
      copyFileSync(join(here, "fixtures", "codex-rollout.jsonl"), rollout);
      const bundle = join(root, "bundle.tar");
      createBundle({
        cwd: repo,
        outFile: bundle,
        agent: { kind: "codex", version: "9.9.9", extensions: {} },
        session: { id: threadId, metadata: { cwdName: "ws" } },
        ownership: { epoch: 3, from: "source-daemon", moveId: "move-codex-1" },
        sessionFiles: [{ name: rolloutRelPath.split("/").at(-1)!, path: rollout }],
        stateFiles: [{ name: "codex-thread.json", content: JSON.stringify({ rolloutRelPath, originalCwd: "/original/workspace" }) }],
      });

      const targetDir = join(root, "target");
      const home = join(root, "codex-home");
      mkdirSync(targetDir);
      mkdirSync(home);
      const runtime = new CodexRuntime({ home, bin: "codex-not-run" });
      runtime.version = () => "9.9.9";
      const calls: string[] = [];
      const app = {
        call: async (method: string) => {
          calls.push(method);
          if (method === "thread/read") throw new Error("app-server cannot read the rollout");
          return {};
        },
      };
      runtime.ensureDaemon = async () => ({ status: "running", socketPath: "unused", cliVersion: "9.9.9" });
      runtime.client = async () => app as never;
      const adapter = new CodexMoveAdapter(runtime, targetDir);
      const host = new MoveHost(adapter, targetDir, join(targetDir, "moves"));

      await assert.rejects(commitBundle(host, bundle, threadId, "move-codex-1"), /app-server cannot read the rollout/);
      assert.ok(calls.includes("thread/read"), "the failure happened after the rollout was written");
      assert.equal(adapter.ownership.peek(threadId), undefined, "ownership was released");
      assert.equal(runtime.rolloutPath(threadId), undefined, "the imported rollout was removed");
      assert.ok(calls.includes("thread/delete"), "the app-server's row for the thread was dropped");
      assert.equal(existsSync(join(targetDir, "workspaces", threadId, "ws")), false, "the destination was removed");
      adapter.assertCanImport(threadId);
    });
  });
});
