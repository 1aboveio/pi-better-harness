import type { LoggedEvent } from "./event-log.ts";
import type { HostedSession } from "./hosted-session.ts";
import { failure, type DialogAnswer, type ServerMessage } from "./protocol.ts";

/**
 * What one client connection holds on the daemon: its event subscriptions and
 * its controller leases. Both end when the connection does, so a vanished
 * client can never keep a lease or a stream alive.
 */
export class ConnectionControl {
  private readonly subscriptions = new Map<string, () => void>();
  private readonly leases = new Set<HostedSession>();
  private readonly send: (message: ServerMessage) => void;

  constructor(send: (message: ServerMessage) => void) {
    this.send = send;
  }

  /** Stream a session's events to this connection, replaying after `sinceSeq` first. Replaces an earlier subscription. */
  subscribe(sessionId: string, hosted: HostedSession, sinceSeq: number | undefined): { summary: Record<string, unknown>; events: LoggedEvent[] } {
    this.unsubscribe(sessionId);
    const { replay, unsubscribe } = hosted.subscribe(sinceSeq, (logged) => this.send({ type: "event", sessionId, seq: logged.seq, event: logged.event }));
    this.subscriptions.set(sessionId, unsubscribe);
    const summary = { lastSeq: hosted.lastSeq, firstSeq: replay.firstSeq, replayed: replay.events.length, truncated: replay.truncated };
    return { summary, events: replay.events };
  }

  unsubscribe(sessionId: string): void {
    this.subscriptions.get(sessionId)?.();
    this.subscriptions.delete(sessionId);
  }

  /** Answer a subscribe/acquire_control/release_control/extension_ui_response command. */
  handle(command: Record<string, unknown>, hosted: HostedSession): void {
    const id = typeof command.id === "string" ? command.id : undefined;
    const type = String(command.type);
    const sessionId = String(command.sessionId);
    const reply = (data?: unknown): void => this.send({ ...(id !== undefined ? { id } : {}), sessionId, type: "response", command: type, success: true, ...(data !== undefined ? { data } : {}) } as ServerMessage);
    const refuse = (error: string): void => this.send(failure(id, type, error, sessionId));

    if (type === "subscribe") {
      const since = command.sinceSeq;
      if (since !== undefined && (typeof since !== "number" || !Number.isInteger(since) || since < 0)) return refuse("sinceSeq must be a non-negative integer");
      const { summary, events } = this.subscribe(sessionId, hosted, since as number | undefined);
      reply(summary);
      for (const logged of events) this.send({ type: "event", sessionId, seq: logged.seq, event: logged.event });
      return;
    }
    if (type === "acquire_control") {
      if (!hosted.acquireControl(this)) return refuse("Another connection holds the controller lease for this session");
      this.leases.add(hosted);
      return reply({ needsInput: hosted.needsInput });
    }
    if (type === "release_control") {
      if (!hosted.releaseControl(this)) return refuse("This connection does not hold the controller lease");
      this.leases.delete(hosted);
      return reply();
    }
    // extension_ui_response
    if (!hosted.isController(this)) return refuse("Only the controller can answer dialogs: acquire_control first");
    const requestId = command.requestId;
    if (typeof requestId !== "string") return refuse("requestId is required");
    const answer = parseAnswer(command);
    if (!answer) return refuse("Answer needs one of: value (string), confirmed (boolean), cancelled (true)");
    if (!hosted.answerDialog(requestId, answer)) return refuse(`No pending dialog ${requestId}`);
    reply();
  }

  dispose(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    for (const hosted of this.leases) hosted.releaseControl(this);
    this.leases.clear();
  }
}

function parseAnswer(command: Record<string, unknown>): DialogAnswer | undefined {
  if (typeof command.value === "string") return { value: command.value };
  if (typeof command.confirmed === "boolean") return { confirmed: command.confirmed };
  if (command.cancelled === true) return { cancelled: true };
  return undefined;
}
