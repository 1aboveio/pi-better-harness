import { createLocalWorkClient } from "./runtime/local-client.ts";
import { chmodSync, existsSync, realpathSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { connect, createServer, type Server, type Socket } from "node:net";
import { getAgentDir, type RpcCommand } from "@earendil-works/pi-coding-agent";
import { CompanionManager, type CompanionManagerOptions } from "./companion.ts";
import { ConnectionControl } from "./control.ts";
import { checkHello } from "./handshake.ts";
import { defaultServerDir, ensureServerDir, socketPathFor } from "./paths.ts";
import { MoveService } from "./move/service.ts";
import { CONTROL_COMMANDS, DAEMON_COMMANDS, encodeLine, failure, LineDecoder, MOVE_COMMANDS, type MoveCommand, type ServerMessage } from "./protocol.ts";
import { SessionRegistry, type SessionRegistryOptions } from "./registry.ts";
import { NativeClientHost, NATIVE_HOST_COMMANDS } from "./remote-client/host.ts";
import { claimDaemonOwner, inspectDaemonOwner, ownerIdentityVerified, sameOwner, validateDaemonOwnerIdentity } from "./daemon-owner.ts";
import { readOwnBuild, readStagedRuntime } from "./startup/artifact.ts";
import { canonicalStateDir, commitActivationStop, compatibleUpgrade, hasActivationReservations, readActivationJournal } from "./startup/activation.ts";
import { admitDaemonStartup, startupIntentFromEnv } from "./startup/admission.ts";
import type { IdleSessionsLease, UpgradeRequest } from "./startup/managed-types.ts";
import { HostedSession } from "./hosted-session.ts";
import { readLifecycleConfig, type LifecycleConfig } from "./lifecycle-config.ts";
import { runtimeRoot } from "./runtime/root.ts";
import { RuntimeCancellation, hasPendingCancellation } from "./runtime/cancellation.ts";
import { SharedCatalog } from "./runtime/catalog.ts";
import { WorkQueryExecutor } from "./runtime/query-executor.ts";

export interface DaemonOptions extends Partial<LifecycleConfig> {
  /** Defaults to `~/.pi/agent/server` (or `$PI_SERVER_DIR`). */
  serverDir?: string;
  sessionOptions?: SessionRegistryOptions["sessionOptions"];
  log?: (message: string) => void;
  /** Bounds for each session's replay ring and on-disk event log. */
  eventLog?: SessionRegistryOptions["eventLog"];
  /** Where `start_companion` runs the attach terminal; defaults to `$PI_SERVER_TMUX_SOCKET` or the user's own tmux server. */
  companion?: Pick<CompanionManagerOptions, "tmuxSocket" | "command" | "readyTimeoutMs">;
  /** Clock injection for deterministic lifetime tests. */
  now?: () => number;
  /** Brief protection between hello/readiness and creation of a session. */
  startupGraceMs?: number;
  /** CLI-owned process shutdown budget; never used to reclaim a different owner. */
  onDraining?: () => void;
  /** Trusted fault-injection seam; never exposed through the socket protocol. */
  cancellationFault?: (stage: import("./runtime/cancellation.ts").CancellationStage) => void;
}

export interface Daemon {
  readonly serverDir: string;
  readonly socketPath: string;
  readonly registry: SessionRegistry;
  readonly closed: Promise<void>;
  /** Run the same maintenance pass used by the background scheduler. */
  sweepIdle(): Promise<void>;
  /** Close the socket and release sessions. Sessions stay marked running so the next start resumes them. */
  stop(): Promise<void>;
}

/** True when something is already accepting connections on the socket. */
function socketIsLive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(path);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });
}

export async function startDaemon(options: DaemonOptions = {}): Promise<Daemon> {
  const serverDir = runtimeRoot(getAgentDir(), canonicalStateDir(options.serverDir ?? defaultServerDir())).serverDir;
  const socketPath = socketPathFor(serverDir);
  const log = options.log ?? (() => undefined);
  ensureServerDir(serverDir);
  const config = readLifecycleConfig(serverDir, options);
  const now = options.now ?? Date.now;
  const startupGraceMs = options.startupGraceMs ?? 30_000;
  if (!Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0) throw new Error("startupGraceMs must be a non-negative integer");
  // A directory rename can replace an empty lock directory. Preserve ambiguous state
  // before claiming; admission still rereads disk after the claim and socket probe.
  if (inspectDaemonOwner(serverDir).status === "ambiguous") throw new Error("Startup admission: ownership is ambiguous");
  const releaseOwner = claimDaemonOwner(serverDir);
  let cleanupStartup = async (): Promise<void> => undefined;
  try {
    if (existsSync(socketPath)) {
      if (await socketIsLive(socketPath)) throw new Error(`A pi-better-server is already listening on ${socketPath}`);
      unlinkSync(socketPath); // left behind by a daemon that died without cleaning up
    }

    const build = readOwnBuild();
    const owner = inspectDaemonOwner(serverDir);
    const instanceId = owner.status === "live" ? owner.owner.token : undefined;
    admitDaemonStartup({ canonicalServerDir: serverDir, agentDir: getAgentDir(), build, intent: startupIntentFromEnv(process.env) });
    let cancellations: RuntimeCancellation | undefined;
    if (hasPendingCancellation(getAgentDir())) cancellations = new RuntimeCancellation(realpathSync(getAgentDir()), instanceId!, options.cancellationFault);
    const catalog = new SharedCatalog(realpathSync(getAgentDir()), instanceId!);
    let workModel: WorkQueryExecutor | undefined;
    const work = () => {
      if (!workModel) {
        workModel = new WorkQueryExecutor(realpathSync(getAgentDir()), instanceId!);
      }
      return workModel;
    };
    const registry = new SessionRegistry({ serverDir, sessionOptions: options.sessionOptions, eventLog: options.eventLog, log, sessionIdleMs: config.sessionIdleMs, now, workClient: () => createLocalWorkClient(work(), realpathSync(getAgentDir())) });
    cleanupStartup = async () => { await registry.shutdown(); await cancellations?.close(); await workModel?.close(); };
    await registry.resumeAll();
    const nativeHost = new NativeClientHost(registry);
    // Structural port permits independent integration with the shared maintenance owner.
    const sessionMaintenance = (registry as SessionRegistry & { maintenance?: {
      readonly busy: boolean;
      enterSessionOperation(): () => void;
      withIdleSessions<T>(purpose: "upgrade", run: (live: HostedSession[], lease: IdleSessionsLease) => Promise<T>): Promise<T>;
    } }).maintenance;
    const safeUpgrade = !!(build && instanceId && sessionMaintenance
      && typeof sessionMaintenance.withIdleSessions === "function" && "publishRuntimeEvent" in HostedSession.prototype);
    let pendingUpgrade: UpgradeRequest | undefined;
    const reconnectControllers = new Map<ConnectionControl, boolean>();
    let upgradeCommitted = false;
    const companions = new CompanionManager({
      socketPath,
      ...options.companion,
      tmuxSocket: options.companion?.tmuxSocket ?? process.env.PI_SERVER_TMUX_SOCKET,
      isReady: (id) => registry.get(id)?.controllerIs((owner) => owner instanceof ConnectionControl && owner.companion) ?? false,
    });

    // A running attach companion holds the controller lease: the move ends it at the fence, after any wait for a turn, so one started during that wait is stopped too.
    const moves = new MoveService(registry, serverDir, (sessionId) => companions.stop(sessionId));

    const sockets = new Set<Socket>();
    const dispatches = new Set<Promise<void>>();
    let inFlight = 0;
    let draining = false;
    let idleStopping = false;
    const runtimeClients = new Map<Socket, string>();
    let guardianBinding: { socket: Socket; identity: import("./daemon-owner.ts").DaemonOwnerIdentity } | undefined;
    let observationUnavailable = false;
    let runtimeZeroSince: number | undefined = now();
    let hostedUsed = registry.activeCount > 0;
    let zeroSince: number | undefined = registry.activeCount === 0 ? now() : undefined;
    let startupUntil = 0;
    const server: Server = createServer((socket) => {
      sockets.add(socket);
      const send = (message: ServerMessage): void => {
        if (!socket.destroyed) socket.write(encodeLine(message));
      };
      const control = new ConnectionControl(send);
      let greeted = false;
      const catalogCommand = catalog.connection();
      let catalogSubscription: { close(): void } | undefined;
      let workQueries: ReturnType<WorkQueryExecutor["connect"]> | undefined;
      let runtimeInFlight = 0;

      const dispatch = async (line: string): Promise<void> => {
        let command: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
          command = parsed as Record<string, unknown>;
        } catch {
          send(failure(undefined, "parse", "Invalid JSON line"));
          return;
        }
        const id = typeof command.id === "string" ? command.id : undefined;
        const type = typeof command.type === "string" ? command.type : "";
        const reply = (message: Record<string, unknown>): void => send({ ...(id !== undefined ? { id } : {}), type: "response", command: type, success: true, ...message } as ServerMessage);
        let releaseSessionOperation: (() => void) | undefined;
        if (draining) {
          send(failure(id, type || "unknown", "Daemon is shutting down; reconnect to start it again"));
          return;
        }
        inFlight++;
        try {
          if (!type) {
            send(failure(id, "unknown", "Missing command type"));
            return;
          }
          if (type === "hello") {
            const verdict = checkHello(command, { build, instanceId, safeUpgrade, runtimeLifecycle: true, agentDir: realpathSync(getAgentDir()) });
            if (verdict.ok) {
              reconnectControllers.set(control, Array.isArray(command.capabilities) && command.capabilities.includes("runtime-reconnect-v1"));
              if (!greeted && command.runtimeRoot === undefined) startupUntil = Math.max(startupUntil, now() + startupGraceMs);
              greeted = true;
              return reply({ data: verdict.data });
            }
            send(failure(id, type, verdict.error));
            socket.end(); // an incompatible client gets the reason, then the door
            return;
          }
          if (type === "runtime_get_status") {
            if (!greeted) throw new Error("runtime_get_status requires hello");
            return reply({ data: { agentDir: realpathSync(getAgentDir()), serverDir, instanceId, build, nodeVersion: process.versions.node,
              capabilities: ["runtime-status-v1"], hostedSessions: registry.activeCount, lifecycle: config,
              guardianBinding: guardianBinding?.identity ?? null,
              livenessReasons: [...[...runtimeClients.values()].map(id => ({ kind: "connection", id })),
                ...registry.list().filter(session => session.live).map(session => ({ kind: "hosted-session", id: session.sessionId })),
                ...(await workModel?.livenessReasons() ?? [])],
              nextIdleDeadline: runtimeClients.size > 0 || registry.activeCount > 0 ? null
                : hostedUsed ? config.daemonIdleMs === 0 || zeroSince === undefined ? null : zeroSince + config.daemonIdleMs
                : runtimeZeroSince === undefined ? null : runtimeZeroSince + config.runtimeIdleMs } });
          }
          if (type === "runtime_cancel_task" || type === "runtime_query_cancellation" || type === "runtime_cancellation_status") {
            if (!greeted) throw new Error("not_accepted: cancellation requires hello");
            if (runtimeInFlight >= 32) throw new Error("not_accepted: too many in-flight runtime requests");
            if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }
            runtimeInFlight++;
            try {
              cancellations ??= new RuntimeCancellation(realpathSync(getAgentDir()), instanceId!, options.cancellationFault);
              return reply({ data: await cancellations.handle(command) });
            } finally { runtimeInFlight--; }
          }
          if (type === "runtime_bind_catalog_host") {
            if (!greeted) throw new Error(`${type} requires hello`);
            catalog.admission.bind(command.authority, socket);
            return reply({ data: { bound: true } });
          }
          if (type === "runtime_subscribe_catalog") {
            if (!greeted) throw new Error(`${type} requires hello`);
            catalogSubscription?.close();
            const subscription = catalog.observe(() => catalogCommand({ type: "runtime_get_catalog", overlay: command.overlay }), snapshot => {
              if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }
              send({ type: "event", event: { type: "runtime_catalog_snapshot", snapshot } } as unknown as ServerMessage);
            });
            catalogSubscription = subscription;
            return reply({ data: subscription.snapshot });
          }
          if (["runtime_register_catalog", "runtime_get_catalog", "runtime_get_catalog_scope", "runtime_edit_catalog"].includes(type)) {
            if (!greeted) throw new Error(`${type} requires hello`);
            return reply({ data: catalogCommand(command) });
          }
          if (type === "runtime_register_client") {
            if (!greeted) throw new Error("runtime_register_client requires hello");
            if (typeof command.clientId !== "string" || !command.clientId || command.clientId.length > 256) throw new Error("Invalid runtime client identity");
            runtimeClients.set(socket, command.clientId);
            runtimeZeroSince = undefined;
            return reply({ data: { clientId: command.clientId } });
          }
          if (type === "runtime_guardian_bind") {
            if (!greeted) throw new Error("runtime_guardian_bind requires hello");
            validateDaemonOwnerIdentity(command.server);
            validateDaemonOwnerIdentity(command.guardian);
            const current = inspectDaemonOwner(serverDir);
            const guardian = inspectDaemonOwner(serverDir, "guardian-owner");
            if (current.status !== "live" || guardian.status !== "live"
              || !ownerIdentityVerified(current.owner) || !ownerIdentityVerified(guardian.owner)
              || !sameOwner(current.owner, command.server) || !sameOwner(guardian.owner, command.guardian)
              || current.owner.token !== instanceId) throw new Error("runtime-unhealthy: exact guardian/server identity could not be verified");
            guardianBinding = { socket, identity: guardian.owner };
            return reply({ data: { server: current.owner, guardian: guardian.owner } });
          }
          if (type === "runtime_upgrade_status") return reply({ data: readActivationJournal(serverDir) ?? null });
          if (["runtime_get_snapshot", "runtime_subscribe", "runtime_unsubscribe", "runtime_get_metrics"].includes(type)) {
            if (!greeted) throw new Error(`${type} requires hello`);
            if (id && id.length > 128) throw new Error("Runtime request ID exceeds 128 characters");
            if (runtimeInFlight >= 32) throw new Error("runtime-unhealthy: too many in-flight queries; resync and retry");
            if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }
            runtimeInFlight++;
            try {
              workQueries ??= work().connect(socket);
              const data = await workQueries.handle(command);
              if (socket.writableLength > 4 * 1024 * 1024) { socket.destroy(); return; }
              // Snapshot JSON is encoded in the worker; only the small envelope runs here.
              const envelope = JSON.stringify({ id, type: "response", command: type, success: true });
              if (!socket.destroyed) socket.write(envelope.slice(0, -1) + ',"data":' + data.json + "}\n");
              return;
            } finally {
              runtimeInFlight--;
            }
          }
          if (type === "runtime_upgrade") {
            if (!safeUpgrade || !build) throw new Error("This daemon cannot safely activate managed runtimes");
            if (typeof command.operationId !== "string" || typeof command.runtime !== "object" || !command.runtime) throw new Error("Invalid upgrade request");
            const runtime = readStagedRuntime((command.runtime as { manifestPath: string }).manifestPath);
            const journal = readActivationJournal(serverDir);
            if (command.serverDir !== serverDir || command.agentDir !== realpathSync(getAgentDir())
              || !journal || journal.operationId !== command.operationId || journal.desiredBuild.contentId !== runtime.build.contentId
              || journal.previousOwner?.token !== instanceId || journal.phase !== "prepared") throw new Error("Upgrade request does not match this daemon's activation journal");
            if (!compatibleUpgrade(build, runtime.build)) throw new Error("Unsafe SDK downgrade or incompatible protocol");
            if (pendingUpgrade && pendingUpgrade.operationId !== command.operationId) throw new Error("activation-conflict: another upgrade is pending");
            pendingUpgrade = { runtime, operationId: command.operationId, serverDir, agentDir: command.agentDir as string };
            setImmediate(() => { void daemon.sweepIdle().catch(error => log(`upgrade maintenance failed: ${String(error)}`)); });
            return reply({ data: { status: "deferred", operationId: command.operationId, reason: "Waiting for idle sessions" } });
          }
          if (NATIVE_HOST_COMMANDS.has(type)) return reply({ data: await nativeHost.handle(command) });
          if ((sessionMaintenance?.busy || nativeHost.busy) && !["list_sessions", "client_snapshot", "subscribe", "acquire_control", "release_control", "extension_ui_response"].includes(type)) {
            send(failure(id, type, "Remote extensions are being updated; retry after installation finishes"));
            return;
          }
          if (MOVE_COMMANDS.has(type) || (DAEMON_COMMANDS.has(type) && type !== "list_sessions")) releaseSessionOperation = sessionMaintenance ? sessionMaintenance.enterSessionOperation() : nativeHost.enterSessionOperation();
          if (MOVE_COMMANDS.has(type)) {
            return reply(await moves.handle(command as MoveCommand));
          }
          if (DAEMON_COMMANDS.has(type)) {
            const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
            if (type === "list_sessions") return reply({ data: { sessions: registry.list() } });
            if (type === "create_session") {
              zeroSince = undefined;
              const summary = await registry.create(command as never);
              // A brand-new session has no history to catch up on: stream it live to its creator.
              const created = registry.get(summary.sessionId);
              if (created) control.subscribe(summary.sessionId, created, undefined);
              return reply({ sessionId: summary.sessionId, data: summary });
            }
            if (!sessionId) {
              send(failure(id, type, "sessionId is required"));
              return;
            }
            if (type === "open_session") {
              zeroSince = undefined;
              const summary = await registry.open(sessionId);
              return reply({ sessionId, data: summary });
            }
            if (type === "rename_session") {
              const summary = await registry.rename(sessionId, command.name as string);
              return reply({ sessionId, data: summary });
            }
            if (type === "start_companion") {
              const summary = await registry.open(sessionId);
              const info = await companions.start(sessionId, summary.cwd);
              return reply({ sessionId, data: info });
            }
            if (type === "stop_companion") return reply({ sessionId, data: { stopped: await companions.stop(sessionId) } });
            if (type === "close_session") {
              const blocked = registry.ownership.blockedReason(sessionId);
              if (blocked) throw new Error(blocked);
              control.unsubscribe(sessionId);
              await companions.stop(sessionId);
              await registry.close(sessionId);
              return reply({ sessionId });
            }
            throw new Error(`Unknown daemon command: ${type}`);
          }
          const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
          if (!sessionId) {
            send(failure(id, type, "sessionId is required"));
            return;
          }
          const blocked = registry.ownership.blockedReason(sessionId);
          if (blocked) {
            send(failure(id, type, blocked, sessionId));
            return;
          }
          const hosted = registry.get(sessionId);
          if (hosted && CONTROL_COMMANDS.has(type)) return control.handle(command, hosted);
          if (!hosted) {
            const reason = registry.resumeError(sessionId);
            send(failure(id, type, reason ? `Session ${sessionId} failed to resume: ${reason}` : `Session not open: ${sessionId}`, sessionId));
            return;
          }
          if (type === "client_reload") {
            if (!hosted.isController(control)) throw new Error("Acquire the session controller lease before reloading");
            await nativeHost.reload(sessionId);
            return reply({ sessionId });
          }
          if (type === "client_snapshot") return reply({ sessionId, data: await hosted.clientSnapshot() });
          if (type === "clear_queue") return reply({ sessionId, data: hosted.session.clearQueue() });
          if (type === "abort_compaction") {
            hosted.session.abortCompaction();
            return reply({ sessionId });
          }
          const { sessionId: _addressed, ...rpc } = command;
          const response = await hosted.handle(rpc as RpcCommand);
          send({ ...response, sessionId } as ServerMessage);
        } catch (error) {
          send(failure(id, type || "unknown", error instanceof Error ? error.message : String(error)));
        } finally {
          releaseSessionOperation?.();
          inFlight--;
          if (registry.activeCount > 0) { zeroSince = undefined; hostedUsed = true; }
          else zeroSince ??= now();
        }
      };

      socket.setEncoding("utf8");
      const decoder = new LineDecoder(
        (line) => {
          const request = dispatch(line);
          dispatches.add(request);
          void request.then(() => dispatches.delete(request), error => {
            dispatches.delete(request);
            log(`request dispatch failed: ${String(error)}`);
          });
        },
        () => {
          send(failure(undefined, "parse", "Line too long"));
          socket.destroy();
        },
      );
      socket.on("data", (chunk: string) => decoder.push(chunk));
      socket.on("error", () => undefined);
      socket.on("close", () => {
        catalogSubscription?.close();
        catalog.admission.close(socket);
        workQueries?.close();
        sockets.delete(socket);
        runtimeClients.delete(socket);
        if (guardianBinding?.socket === socket) guardianBinding = undefined;
        if (runtimeClients.size === 0) runtimeZeroSince ??= now();
        reconnectControllers.delete(control);
        control.dispose();
      });
    });

    cleanupStartup = async () => {
      await cancellations?.close();
      await workModel?.close();
      for (const socket of sockets) socket.destroy();
      server.close();
      await registry.shutdown();
    };
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      // Unix socket only: there is deliberately no TCP listener.
      server.listen(socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(socketPath, 0o600);
    log(`listening on ${socketPath}`);

    let stopped: Promise<void> | undefined;
    let maintenance: Promise<void> | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let finishClosed!: () => void;
    const closed = new Promise<void>(resolve => { finishClosed = resolve; });
    const daemon: Daemon = {
      serverDir,
      socketPath,
      registry,
      closed,
      sweepIdle() {
        if (draining) return stopped ?? Promise.resolve();
        if (sessionMaintenance?.busy || nativeHost.busy) return Promise.resolve();
        maintenance ??= (async () => {
          if (pendingUpgrade && sessionMaintenance) {
            const request = pendingUpgrade;
            const journal = readActivationJournal(serverDir);
            if (!journal || journal.operationId !== request.operationId || !hasActivationReservations(journal)) pendingUpgrade = undefined;
            else {
              try {
                // Observe background completion before taking the idle fence. A slow or
                // failed provider must leave admitted work and dialog answers usable.
                const live = registry.list().filter(item => item.live).map(item => registry.get(item.sessionId)!);
                if (live.some(hosted => hosted.activityChecking)) throw new Error("Wait for remote activity observation to finish before upgrading");
                await Promise.all(live.map(hosted => hosted.refreshActivity()));
                if (draining) return;
                await sessionMaintenance.withIdleSessions("upgrade", async (live, lease) => {
                  // Older attached views have no replacement-transport contract. Let them detach first.
                  const legacyController = () => live.some(hosted => hosted.controllerIs(controller =>
                    !(controller instanceof ConnectionControl) || reconnectControllers.get(controller) !== true));
                  if (legacyController()) throw new Error("Waiting for legacy controllers to detach");
                  commitActivationStop(request, lease, () => { draining = true; upgradeCommitted = true; });
                  for (const hosted of live) {
                    (hosted as HostedSession & { publishRuntimeEvent(event: unknown): void }).publishRuntimeEvent({
                      type: "runtime_upgrade", phase: "restarting", operationId: request.operationId, buildId: request.runtime.build.contentId,
                    });
                  }
                });
              } catch (error) { log(`upgrade waiting: ${String(error)}`); }
              // Pending upgrades take priority over expiry and release their idle fence on busy passes.
              return;
            }
          }
          const expired = await registry.expireIdle(now());
          if (draining) return;
          for (const sessionId of expired) await companions.stop(sessionId);
          if (registry.activeCount > 0) {
            zeroSince = undefined;
            return;
          }
          zeroSince ??= now();
          if (runtimeClients.size > 0) return;
          runtimeZeroSince ??= now();
          if (hostedUsed ? (config.daemonIdleMs === 0 || now() - zeroSince < config.daemonIdleMs || now() < startupUntil)
            : (now() - runtimeZeroSince < config.runtimeIdleMs || now() < startupUntil)) return;
          // Recheck durable activity before fencing admission; observation never adopts a writer.
          if (draining) return;
          try {
            if ((await work().livenessReasons()).length > 0) {
              runtimeZeroSince = undefined;
              return;
            }
          } catch (error) {
            // The executor already bounds query deadlines and terminates failed workers.
            // Unknown obligations cannot keep an otherwise detached runtime alive forever.
            // Stop only the management layer; leave runner evidence and writer leases intact.
            observationUnavailable = true;
            log(`runtime observation unavailable at idle shutdown: ${String(error)}`);
          }
          // No create/open can slip between this check and the synchronous admission fence.
          if (runtimeClients.size > 0 || registry.activeCount > 0 || inFlight > 0 || cancellations?.busy || sessionMaintenance?.busy || nativeHost.busy || registry.hasPendingOperations) return;
          draining = true;
          idleStopping = true;
          log("idle timeout with no active sessions; shutting down");
        })().finally(() => { maintenance = undefined; });
        return maintenance.then(() => draining ? daemon.stop() : undefined);
      },
      stop() {
        const pendingMaintenance = maintenance;
        stopped ??= (async () => {
          draining = true;
          options.onDraining?.();
          if (idleStopping) {
            const temporary = join(serverDir, `idle-stop-${instanceId}.tmp`);
            writeFileSync(temporary, JSON.stringify({ token: instanceId, pid: process.pid }), { mode: 0o600 });
            renameSync(temporary, join(serverDir, "idle-stop-intent.json"));
          }
          if (timer) clearInterval(timer);
          await pendingMaintenance?.catch(error => log(`maintenance interrupted during shutdown: ${String(error)}`));
          if (upgradeCommitted) {
            // Let queued restarting events reach both attached views before closing their transports.
            await Promise.all([...sockets].map(socket => new Promise<void>(resolve => {
              const timeout = setTimeout(resolve, 1_000);
              socket.write("", () => { clearTimeout(timeout); resolve(); });
            })));
          }
          const closed = new Promise<void>((resolve) => server.close(() => resolve()));
          for (const socket of sockets) socket.destroy();
          await closed;
          await cancellations?.close();
          await workModel?.close();
          await registry.shutdown();
          await Promise.allSettled([...dispatches]);
          if (existsSync(socketPath)) unlinkSync(socketPath);
          const checkpoint = join(serverDir, `clean-stop-${instanceId}.tmp`);
          writeFileSync(checkpoint, JSON.stringify({ pid: process.pid, token: instanceId, reason: "clean-stop", observation: observationUnavailable ? "unavailable" : "verified" }), { mode: 0o600 });
          renameSync(checkpoint, join(serverDir, "clean-stop.json"));
          releaseOwner();
          finishClosed();
        })();
        return stopped;
      },
    };
    const durations = [config.sessionIdleMs, config.daemonIdleMs, config.runtimeIdleMs].filter(value => value > 0);
    if (safeUpgrade) durations.push(1_000);
    if (durations.length) {
      timer = setInterval(() => { void daemon.sweepIdle().catch(error => log(`lifecycle maintenance failed: ${String(error)}`)); }, Math.max(5, Math.min(1_000, ...durations)));
      timer.unref();
    }
    return daemon;
  } catch (error) {
    await cleanupStartup();
    releaseOwner();
    throw error;
  }
}
