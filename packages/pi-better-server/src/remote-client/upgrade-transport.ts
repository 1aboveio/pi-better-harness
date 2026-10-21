import { setTimeout as delay } from "node:timers/promises";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DaemonClient, HandshakeError } from "../client.ts";
import { PROTOCOL_VERSION } from "../protocol.ts";
import { resolveTarget, type Target, type TargetOptions } from "../remote/target.ts";
import type { ReplacementRemoteTransport } from "./session.ts";

export const NATIVE_RECONNECT_CAPABILITIES = ["runtime-reconnect-v1"];

class BuildNotReadyError extends Error {}

function retryable(error: unknown): boolean {
  if (error instanceof HandshakeError) return false;
  if (error instanceof BuildNotReadyError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return ["ENOENT", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code ?? "")
    || error.name === "TimeoutError" || /^(?:connection closed|Timeout|connection timed out)$/i.test(error.message);
}

/** Abort promptly even if an injected connector ignores cancellation; dispose any late result. */
function acquire<T>(pending: Promise<T>, signal: AbortSignal, dispose: (value: T) => void | Promise<void>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        // The caller may already have returned on cancellation.
        void Promise.resolve().then(() => dispose(value)).catch(() => undefined);
        reject(signal.reason);
      } else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
  });
}

/** Setup owns every provisional resource until the session adopts the replacement.
 * With an announced build, retry only transport/hello until it is ready (30 seconds by default).
 * Without one, preserve the one-shot setup contract for existing callers.
 */
export async function openUpgradeTransport(
  options: TargetOptions,
  dependencies: {
    resolveTarget: typeof resolveTarget;
    connectClient?: typeof DaemonClient.connect;
    /** Total setup deadline and retry backoff, used only when matchingBuildId is supplied. */
    timeoutMs?: number;
    retryDelayMs?: number;
  },
  signal: AbortSignal,
  matchingBuildId?: string,
): Promise<ReplacementRemoteTransport> {
  signal.throwIfAborted();
  const deadline = matchingBuildId === undefined ? undefined : new AbortController();
  const abort = () => deadline?.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = deadline ? setTimeout(() => deadline.abort(new DOMException(
    `Timed out waiting for upgraded server build ${matchingBuildId}`, "TimeoutError",
  )), dependencies.timeoutMs ?? 30_000) : undefined;
  const setupSignal = deadline?.signal ?? signal;
  try {
    for (;;) {
      let target: Target | undefined;
      let client: DaemonClient | undefined;
      try {
        setupSignal.throwIfAborted();
        target = await acquire(dependencies.resolveTarget({ ...options, ensureServer: false, signal: setupSignal }), setupSignal, target => target.close());
        setupSignal.throwIfAborted();
        client = await acquire((dependencies.connectClient ?? DaemonClient.connect)(target.socketPath, {
          signal: setupSignal, hello: { capabilities: [...NATIVE_RECONNECT_CAPABILITIES] },
        }), setupSignal, client => client.close());
        setupSignal.throwIfAborted();
        if (!client.server?.capabilities?.includes("native-client-v1")) throw new Error("Upgrade replacement does not support the native remote client");
        const hello = client.server as typeof client.server & { buildId?: string };
        const buildId = hello.build?.contentId ?? hello.buildId;
        if (matchingBuildId !== undefined && buildId !== matchingBuildId) {
          // Only a valid old hello is evidence that the successor is not ready yet.
          if (hello.piVersion !== PI_VERSION || hello.protocolVersion !== PROTOCOL_VERSION) throw new HandshakeError("Upgrade replacement has an incompatible SDK or protocol");
          if (!buildId || !hello.instanceId) throw new Error("Upgrade replacement has no build or instance identity");
          throw new BuildNotReadyError(`Waiting for upgraded server build ${matchingBuildId}; reached ${buildId}`);
        }
        const owned = target;
        return { client, dispose: () => owned.close() };
      } catch (error) {
        client?.close();
        if (target) await acquire(target.close(), setupSignal, () => undefined).catch(() => undefined);
        setupSignal.throwIfAborted();
        // ENOENT before a target exists means local setup (for example a missing ssh binary), not a missing daemon socket.
        if (!target && (error as NodeJS.ErrnoException)?.code === "ENOENT") throw error;
        if (matchingBuildId === undefined || !retryable(error)) throw error;
      }
      await delay(dependencies.retryDelayMs ?? 250, undefined, { signal: setupSignal }).catch(error => {
        setupSignal.throwIfAborted();
        throw error;
      });
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
