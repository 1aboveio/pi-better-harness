/**
 * What an agent has to provide for the shared move core (move-host.ts) to hand one
 * of its sessions to another daemon. The core owns the bundle, the chunked
 * transfer, the preflight call sites and the ownership/epoch bookkeeping; an
 * adapter owns everything that is specific to one agent: where its session files
 * live, whether it is mid-turn, how to stop it, how to register an imported one.
 *
 * No agent imports here. The Pi adapter is src/move/pi-adapter.ts.
 */
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { BundleManifest, CreateBundleOptions } from "./bundle.ts";
import type { MoveCommand } from "../protocol.ts";
import type { OwnershipStore } from "./ownership.ts";

/** What the adapter hands the core to bundle a session. The core adds `outFile` and `ownership`. */
export type SessionBundleSpec = Pick<CreateBundleOptions, "cwd" | "agent" | "session" | "sessionFiles" | "stateFiles" | "baseRef" | "includeWorkspace" | "compression">;

export interface MovePreflightContext {
  side: "source" | "target";
  sessionId: string;
  moveId: string;
  /** Target only: the requested `--to-cwd`, if any. */
  cwd?: string;
}

export interface ImportRequest {
  sessionId: string;
  /** Original logical id in the bundle; different only for an explicit copy. */
  sourceSessionId?: string;
  moveId: string;
  manifest: BundleManifest;
  /** Directory holding the verified bundle members (`session/<name>`, `state/<name>`). Removed by the core afterwards. */
  extractedDir: string;
  /** The rebuilt workspace. */
  cwd: string;
  /** Agent-specific: bind the imported session to this model provider instead of the one it had (`move_begin`'s `rebindProvider`). */
  rebindProvider?: string;
}

/** A `move_preflight` request and what the adapter answers; the core adds the daemon id. Nothing is changed. */
export type ReadinessRequest = Extract<MoveCommand, { type: "move_preflight" }>;
export interface ReadinessReport {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  /** When the request names a session: a description of it for a pull. */
  session?: Record<string, unknown>;
}

export interface AgentMoveAdapter {
  /** Matches `manifest.agent.kind` of bundles this adapter can import. */
  readonly kind: string;
  /** This daemon's ownership ledger. */
  readonly ownership: OwnershipStore;

  // ---- source side ----
  hasSession(sessionId: string): boolean;
  /** True while execution, prompt preflight, bash or background work is active. Pending inputs/dialogs must also refuse transfer. */
  isBusy(sessionId: string): boolean;
  /** Stop serving the session without forgetting it (it is fenced). */
  stop(sessionId: string): Promise<void>;
  /** Describe the session for bundling. Synchronous: nothing may change between this and the fence. */
  bundleSession(sessionId: string): SessionBundleSpec;
  /** The move succeeded elsewhere: close the session and keep a tombstone. */
  retire(sessionId: string): Promise<void>;
  /** The move failed or was aborted: serve the session again if it was running. */
  resume(sessionId: string): Promise<void>;

  // ---- target side ----
  /** Throw for any existing session except a known, safely retired tombstone. */
  assertCanImport(sessionId: string): void;
  /** Throw if this bundle cannot be read by this daemon (agent kind, version). */
  checkBundle(manifest: BundleManifest): void;
  /** Capture what `restore` needs to undo `importSession`. */
  snapshot(sessionId: string): unknown;
  /** Register the session on this daemon, running. May throw; the core then calls `restore` if ownership was acquired. */
  importSession(request: ImportRequest): Promise<void | { sessionFile?: string }>;
  /** Undo a failed `importSession`. */
  restore(sessionId: string, snapshot: unknown): Promise<void>;

  /** Answer a `move_preflight` command (receiver checks, plus a session description for `pi-remote return`). */
  readiness?(request: ReadinessRequest): Promise<ReadinessReport>;

  /** Optional checks run before the source fences and before the target accepts a bundle. #477 supplies the Pi checks. */
  preflight?(context: MovePreflightContext): void | Promise<void>;
}

/** Session-only transfers may use a populated workspace, but never create one. */
export function assertExistingDirectory(cwd: string | undefined): asserts cwd is string {
  if (!cwd || !isAbsolute(cwd)) throw new Error("Session-only transfer requires an existing absolute destination directory (toCwd)");
  if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`Session-only destination ${cwd} must be an existing directory`);
}

/** Only the parsed header changes. Conversation entries and their parent ids stay intact. */
export function rewriteSessionTranscript(transcript: string, sourceId: string, destinationId: string, cwd: string): string {
  const newline = transcript.indexOf("\n");
  const first = newline === -1 ? transcript : transcript.slice(0, newline);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(first);
  } catch {
    throw new Error("Invalid session transcript header");
  }
  if (!header || header.type !== "session" || (header.id !== sourceId && !(header.id === undefined && sourceId === destinationId))) {
    throw new Error(`Transcript header must identify source session ${sourceId}`);
  }
  // A transferred transcript is self-contained; a source-host parent path would dangle.
  const { parentSessionFile: _parentFile, parentSession: _parent, ...rest } = header;
  return `${JSON.stringify({ ...rest, id: destinationId, cwd })}${newline === -1 ? "" : transcript.slice(newline)}`;
}
