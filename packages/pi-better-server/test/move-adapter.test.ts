import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { DaemonClient } from "../src/client.ts";
import type { AgentMoveAdapter, ImportRequest, MovePreflightContext } from "../src/core/adapter.ts";
import { MoveHost } from "../src/core/move-host.ts";
import { OwnershipStore } from "../src/core/ownership.ts";
import { moveSession } from "../src/move/orchestrate.ts";
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
  async preflight(context: MovePreflightContext) {
    this.preflights.push(context);
  }
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
});
