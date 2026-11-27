/**
 * The Pi side of the move core: session registry, transcript file and
 * session-index.json state. Everything agent-agnostic lives in core/move-host.ts.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { estimateBundleBytes, repoRemoteOf, runChecks } from "./preflight.ts";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { rewriteSessionTranscript, type AgentMoveAdapter, type ImportRequest, type ReadinessReport, type ReadinessRequest, type SessionBundleSpec } from "../core/adapter.ts";
import type { BundleManifest } from "../core/bundle.ts";
import type { OwnershipStore } from "../core/ownership.ts";
import { SERVER_EXTENSION_VERSIONS } from "../handshake.ts";
import { importedDirFor } from "../paths.ts";
import type { IndexEntry, SessionRegistry } from "../registry.ts";

function majorMinor(version: string): string {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : version;
}

function splitModel(value: string): { provider: string; modelId: string } | undefined {
  const slash = value.indexOf("/");
  return slash < 1 ? undefined : { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
}

export class PiMoveAdapter implements AgentMoveAdapter {
  readonly kind = "pi";
  private readonly registry: SessionRegistry;
  private readonly serverDir: string;
  private readonly importing = new Map<string, string>();

  private readonly beforeStop?: (sessionId: string) => Promise<unknown>;

  /** `beforeStop` runs at the fence, once the session is fenced and before it is released (e.g. to end the attach companion that holds its lease). */
  constructor(registry: SessionRegistry, serverDir: string, beforeStop?: (sessionId: string) => Promise<unknown>) {
    this.registry = registry;
    this.serverDir = serverDir;
    if (beforeStop) this.beforeStop = beforeStop;
  }

  get ownership(): OwnershipStore {
    return this.registry.ownership;
  }

  /** Receiver checks for a move (credentials, disk, repo remote, versions), plus a description of the session for a pull. */
  async readiness(request: ReadinessRequest): Promise<ReadinessReport> {
    const input = request.includeWorkspace === false ? (request.model ? { model: request.model } : {}) : request;
    const checks = await runChecks(input, { serverDir: this.serverDir, providerAuth: (provider) => this.registry.checkProviderAuth(provider) });
    if (!request.sessionId) return { checks };
    const entry = this.registry.entry(request.sessionId);
    if (!entry) throw new Error(`Unknown session: ${request.sessionId}`);
    const blocked = this.registry.ownership.blockedReason(request.sessionId);
    if (blocked) throw new Error(blocked);
    const hosted = this.registry.get(request.sessionId);
    if (hosted?.needsInput.length || hosted?.session.pendingMessageCount) throw new Error("Session has pending input or approval dialogs; resolve them before transferring");
    const remote = request.includeWorkspace === false ? undefined : repoRemoteOf(entry.cwd);
    return {
      checks,
      session: {
        cwd: entry.cwd,
        cwdName: basename(entry.cwd),
        ...(entry.model ? { model: `${entry.model.provider}/${entry.model.modelId}` } : {}),
        ...(remote ? { repoRemote: remote } : {}),
        ...(request.includeWorkspace === false ? {} : { bytes: estimateBundleBytes(entry.cwd) }),
        ...(entry.name ? { name: entry.name } : {}),
        createdAt: entry.createdAt,
        epoch: this.registry.ownership.get(request.sessionId).epoch,
      },
    };
  }

  hasSession(sessionId: string): boolean {
    return this.registry.entry(sessionId) !== undefined;
  }

  isBusy(sessionId: string): boolean {
    const hosted = this.registry.get(sessionId);
    if (hosted?.needsInput.length || hosted?.session.pendingMessageCount) throw new Error("Session has pending input or approval dialogs; resolve them before transferring");
    return Boolean(hosted?.executionActive || hosted?.activityChecking);
  }

  async stop(sessionId: string): Promise<void> {
    await this.beforeStop?.(sessionId);
    await this.registry.release(sessionId);
  }

  bundleSession(sessionId: string): SessionBundleSpec {
    const entry = this.registry.entry(sessionId);
    if (!entry) throw new Error(`Unknown session: ${sessionId}`);
    const hasTranscript = entry.sessionFile !== "" && existsSync(entry.sessionFile);
    return {
      cwd: entry.cwd,
      agent: { kind: this.kind, version: PI_VERSION, extensions: { ...SERVER_EXTENSION_VERSIONS } },
      session: {
        id: sessionId,
        ...(entry.name ? { name: entry.name } : {}),
        ...(entry.model ? { model: `${entry.model.provider}/${entry.model.modelId}` } : {}),
        createdAt: entry.createdAt,
        metadata: { cwdName: basename(entry.cwd) },
      },
      sessionFiles: hasTranscript ? [{ name: basename(entry.sessionFile), path: entry.sessionFile }] : [],
      stateFiles: [{ name: "session-index.json", content: JSON.stringify({ name: entry.name, model: entry.model, createdAt: entry.createdAt }) }],
    };
  }

  async retire(sessionId: string): Promise<void> {
    await this.registry.retire(sessionId);
  }

  async resume(sessionId: string): Promise<void> {
    if (this.registry.entry(sessionId)?.status === "running") await this.registry.open(sessionId);
  }

  assertCanImport(sessionId: string): void {
    const existing = this.registry.entry(sessionId);
    if (existing && (existing.status !== "closed" || this.registry.get(sessionId) || this.ownership.get(sessionId).state !== "moved")) {
      throw new Error(`Session ${sessionId} already exists on this daemon`);
    }
  }

  checkBundle(manifest: BundleManifest): void {
    if (manifest.agent.kind !== this.kind) throw new Error(`Bundle was made by ${manifest.agent.kind}; this daemon hosts Pi sessions`);
    if (majorMinor(manifest.agent.version) !== majorMinor(PI_VERSION)) {
      throw new Error(`Pi version mismatch: bundle from pi ${manifest.agent.version}, this daemon runs pi ${PI_VERSION}. Both must be on the same major.minor.`);
    }
  }

  snapshot(sessionId: string): IndexEntry | undefined {
    const entry = this.registry.entry(sessionId);
    return entry ? { ...entry } : undefined;
  }

  async importSession(request: ImportRequest): Promise<{ sessionFile?: string }> {
    const { sessionId, manifest } = request;
    const root = join(importedDirFor(this.serverDir), sessionId);
    const importedDir = join(root, request.moveId);
    if (existsSync(importedDir)) throw new Error(`Import directory already exists for move ${request.moveId}`);
    this.importing.set(sessionId, importedDir);
    try {
      const transcript = manifest.files.find((file) => file.role === "session");
      let sessionFile = "";
      if (transcript) {
        mkdirSync(importedDir, { recursive: true, mode: 0o700 });
        const sourceId = request.sourceSessionId ?? manifest.session.id;
        const name = sourceId === sessionId ? basename(transcript.path) : `${new Date().toISOString().replace(/[:.]/g, "-")}_${sessionId}.jsonl`;
        sessionFile = join(importedDir, name);
        writeFileSync(sessionFile, rewriteSessionTranscript(readFileSync(join(request.extractedDir, transcript.path), "utf8"), sourceId, sessionId, request.cwd), { flag: "wx", mode: 0o600 });
      }
      const model = manifest.session.model ? splitModel(manifest.session.model) : undefined;
      const now = new Date().toISOString();
      await this.registry.adopt({
        sessionId,
        cwd: request.cwd,
        sessionFile,
        status: "running",
        ...(manifest.session.name ? { name: manifest.session.name } : {}),
        ...(model ? { model } : {}),
        createdAt: manifest.session.createdAt ?? now,
        updatedAt: now,
      });
      return sessionFile ? { sessionFile } : {};
    } catch (error) {
      this.removeImport(sessionId);
      throw error;
    }
  }

  async restore(sessionId: string, snapshot: unknown): Promise<void> {
    await this.registry.forget(sessionId, snapshot as IndexEntry | undefined);
    this.removeImport(sessionId);
  }

  private removeImport(sessionId: string): void {
    const dir = this.importing.get(sessionId);
    if (!dir) return;
    rmSync(dir, { recursive: true, force: true });
    this.importing.delete(sessionId);
    const root = join(importedDirFor(this.serverDir), sessionId);
    if (existsSync(root) && readdirSync(root).length === 0) rmdirSync(root);
  }
}
