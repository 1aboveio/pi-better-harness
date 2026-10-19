/**
 * The Pi side of the move core: session registry, transcript file and
 * session-index.json state. Everything agent-agnostic lives in core/move-host.ts.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { estimateBundleBytes, repoRemoteOf, runChecks } from "./preflight.ts";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { AgentMoveAdapter, ImportRequest, ReadinessReport, ReadinessRequest, SessionBundleSpec } from "../core/adapter.ts";
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
    const checks = await runChecks(request, { serverDir: this.serverDir, providerAuth: (provider) => this.registry.checkProviderAuth(provider) });
    if (!request.sessionId) return { checks };
    const entry = this.registry.entry(request.sessionId);
    if (!entry) throw new Error(`Unknown session: ${request.sessionId}`);
    const blocked = this.registry.ownership.blockedReason(request.sessionId);
    if (blocked) throw new Error(blocked);
    const remote = repoRemoteOf(entry.cwd);
    return {
      checks,
      session: {
        cwd: entry.cwd,
        cwdName: basename(entry.cwd),
        ...(entry.model ? { model: `${entry.model.provider}/${entry.model.modelId}` } : {}),
        ...(remote ? { repoRemote: remote } : {}),
        bytes: estimateBundleBytes(entry.cwd),
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
    return Boolean(this.registry.get(sessionId)?.turnActive);
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
    if (existing && existing.status === "running" && !this.registry.ownership.blockedReason(sessionId)) {
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
    return this.registry.entry(sessionId) as IndexEntry | undefined;
  }

  async importSession(request: ImportRequest): Promise<void> {
    const { sessionId, manifest } = request;
    const importedDir = join(importedDirFor(this.serverDir), sessionId);
    rmSync(importedDir, { recursive: true, force: true });
    try {
      const transcript = manifest.files.find((file) => file.role === "session");
      let sessionFile = "";
      if (transcript) {
        mkdirSync(importedDir, { recursive: true, mode: 0o700 });
        sessionFile = join(importedDir, basename(transcript.path));
        copyFileSync(join(request.extractedDir, transcript.path), sessionFile);
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
    } catch (error) {
      rmSync(importedDir, { recursive: true, force: true });
      throw error;
    }
  }

  async restore(sessionId: string, snapshot: unknown): Promise<void> {
    await this.registry.forget(sessionId, snapshot as IndexEntry | undefined);
    rmSync(join(importedDirFor(this.serverDir), sessionId), { recursive: true, force: true });
  }
}
