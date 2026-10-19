import type { AgentSession, AgentSessionEvent, RpcCommand, RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { EventLog, LoggedEvent, Replay } from "./event-log.ts";
import { UNSUPPORTED_SESSION_COMMANDS } from "./protocol.ts";
import { UiBridge, type PendingDialog } from "./ui-bridge.ts";

type Listener = (logged: LoggedEvent) => void;

function ok(id: string | undefined, command: string, data?: unknown): RpcResponse {
  return { ...(id !== undefined ? { id } : {}), type: "response", command, success: true, ...(data !== undefined ? { data } : {}) } as RpcResponse;
}

/** Pi 1.x reports `started` / `handled` / `queued`; Pi 0.82 reports nothing, so the response carries no data. */
function dispositionData(outcome: unknown): { disposition: string } | undefined {
  return typeof outcome === "string" ? { disposition: outcome } : undefined;
}

/**
 * Pi's RPC mode passes `{ source: "rpc" }` to steer/followUp on 1.x so extension `input` handlers see the right source.
 * Pi 0.82 declares no third parameter and ignores the extra argument.
 */
function steerOrFollowUp(session: AgentSession, kind: "steer" | "followUp", message: string, images: RpcCommandImages | undefined): Promise<unknown> {
  const call = session[kind] as (text: string, images?: RpcCommandImages, options?: { source: "rpc" }) => Promise<unknown>;
  return call.call(session, message, images, { source: "rpc" });
}

function fail(id: string | undefined, command: string, error: string): RpcResponse {
  return { ...(id !== undefined ? { id } : {}), type: "response", command, success: false, error };
}

/** Model metadata crosses hosts; headers, endpoint URLs and auth must not. */
function clientModel(model: AgentSession["model"]) {
  return model ? {
    id: model.id, provider: model.provider, name: model.name, api: model.api,
    reasoning: model.reasoning, input: model.input, cost: model.cost,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens,
  } : undefined;
}

/**
 * One live Pi `AgentSession` plus the Pi RPC command dispatcher for it.
 * The dispatcher mirrors Pi's own `runRpcMode` handler for the commands that
 * make sense when the daemon owns the session file, with one deliberate
 * difference: `steer` on an idle session starts the next turn.
 */
export class HostedSession {
  readonly generation = randomUUID();
  private activeMessage: unknown;
  private readonly activeTools = new Map<string, unknown>();
  private readonly listeners = new Set<Listener>();
  private readonly unsubscribe: () => void;
  readonly session: AgentSession;
  private readonly onActivity: () => void;
  /**
   * Prompts handed to Pi that have not settled yet. Pi sets `isStreaming` only after its
   * preflight awaits, so this covers the starting window that `isStreaming` misses.
   */
  private promptsInFlight = 0;
  /** Releases for deferred prompts whose turn is running; they fire when that turn's `agent_end` arrives. */
  private readonly releaseOnAgentEnd = new Set<() => void>();
  /**
   * Pi's idle signal for the current run, taken while the run is active. Pi resolves it only after agent_settled and the
   * prompts it deferred have run (or failed); asking later would return at once, since Pi counts the settle window as idle.
   */
  private runIdle: Promise<void> | undefined;
  private readonly log: EventLog;
  private readonly ui: UiBridge;
  private controller: unknown;

  constructor(session: AgentSession, log: EventLog, onActivity: () => void) {
    this.session = session;
    this.log = log;
    this.onActivity = onActivity;
    this.ui = new UiBridge((event) => this.publish(event));
    this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "message_start" || event.type === "message_update") this.activeMessage = event.message;
      if (event.type === "message_end") this.activeMessage = undefined;
      if (event.type === "tool_execution_start" || event.type === "tool_execution_update") this.activeTools.set(event.toolCallId, event);
      if (event.type === "tool_execution_end") this.activeTools.delete(event.toolCallId);
      this.publish(event);
      if (event.type === "agent_start") this.runIdle = session.waitForIdle().catch(() => undefined);
      if (event.type === "agent_end") for (const release of [...this.releaseOnAgentEnd]) release();
      if (event.type === "agent_end" || event.type === "turn_end") this.onActivity();
    });
  }

  /** Give extensions a UI whose dialogs the daemon routes to the controller (or holds as needs-input). */
  async bindUi(): Promise<void> {
    await this.session.bindExtensions({ uiContext: this.ui.context(), mode: "rpc" });
  }

  get isStreaming(): boolean {
    return this.session.isStreaming;
  }

  private rpcState(): RpcSessionState {
    const session = this.session;
    return {
      model: session.model, thinkingLevel: session.thinkingLevel,
      isStreaming: session.isStreaming, isCompacting: session.isCompacting,
      steeringMode: session.steeringMode, followUpMode: session.followUpMode,
      sessionFile: session.sessionFile, sessionId: session.sessionId,
      sessionName: session.sessionName, autoCompactionEnabled: session.autoCompactionEnabled,
      messageCount: session.messages.length, pendingMessageCount: session.pendingMessageCount,
    };
  }

  /** A single JS-turn snapshot plus cursor; the native client subscribes after this cursor. */
  async clientSnapshot(): Promise<Record<string, unknown>> {
    const session = this.session;
    const models = await session.modelRuntime.getAvailable();
    const manager = session.sessionManager;
    const commands = session.extensionRunner.getRegisteredCommands().map((entry) => ({ name: entry.invocationName, description: entry.description }));
    const snapshot = {
      generation: this.generation, lastSeq: this.lastSeq,
      sessionId: session.sessionId, cwd: manager.getCwd(), name: session.sessionName,
      sessionFile: session.sessionFile, state: { ...this.rpcState(), model: clientModel(session.model), lastSeq: this.lastSeq, hasController: this.hasController, needsInput: this.needsInput, steering: session.getSteeringMessages(), followUp: session.getFollowUpMessages() },
      messages: session.messages, entries: manager.getEntries(), leafId: manager.getLeafId(),
      tools: session.getAllTools().map((tool) => ({ name: tool.name, description: tool.description, parameters: session.getToolDefinition(tool.name)?.parameters })),
      commands, models: models.map(clientModel), contextUsage: session.getContextUsage(), stats: session.getSessionStats(),
      activeMessage: this.activeMessage, activeTools: [...this.activeTools.values()],
    };
    // Detach mutable message/entry arrays before yielding back to another model event.
    return JSON.parse(JSON.stringify(snapshot));
  }

  /** A turn is starting or running: queue steers for it instead of starting another one. */
  get turnActive(): boolean {
    return this.promptsInFlight > 0 || this.session.isStreaming;
  }

  get lastSeq(): number {
    return this.log.last;
  }

  /** Dialogs an extension is blocked on right now. */
  get needsInput(): PendingDialog[] {
    return this.ui.pending();
  }

  get hasController(): boolean {
    return this.controller !== undefined;
  }

  private publish(event: unknown): void {
    const logged = this.log.append(event);
    for (const listener of this.listeners) listener(logged);
  }

  /**
   * Replay retained events after `sinceSeq` (none when omitted), then stream live.
   * The replay and the live registration happen in one synchronous step, so no event is lost or repeated.
   */
  subscribe(sinceSeq: number | undefined, listener: Listener): { replay: Replay; unsubscribe: () => void } {
    const replay = sinceSeq === undefined ? { events: [], firstSeq: 0, truncated: false } : this.log.since(sinceSeq);
    return { replay, unsubscribe: this.addListener(listener) };
  }

  /** Receive every session event. Returns an unsubscribe function. */
  addListener(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Take the single controller lease. False when another owner holds it. */
  acquireControl(owner: unknown): boolean {
    if (this.controller !== undefined && this.controller !== owner) return false;
    this.controller = owner;
    return true;
  }

  /** True when the current lease holder satisfies `matches`. */
  controllerIs(matches: (owner: unknown) => boolean): boolean {
    return this.controller !== undefined && matches(this.controller);
  }

  releaseControl(owner: unknown): boolean {
    if (this.controller !== owner) return false;
    this.controller = undefined;
    return true;
  }

  isController(owner: unknown): boolean {
    return this.controller === owner;
  }

  /** Resolve a pending dialog; the blocked extension (and so the turn) continues. */
  answerDialog(requestId: string, answer: Parameters<UiBridge["answer"]>[1]): boolean {
    return this.ui.answer(requestId, answer);
  }

  /** Stop the running turn (if any) and release the session. The session file stays on disk. */
  async dispose(options: { abort: boolean }): Promise<void> {
    this.ui.cancelAll();
    if (options.abort) await this.session.abort().catch(() => undefined);
    this.unsubscribe();
    this.listeners.clear();
    this.log.flush();
    this.session.dispose();
  }

  private async queueForStartingTurn(id: string | undefined, command: string, message: string, options: { images?: RpcCommandImages; streamingBehavior?: "steer" | "followUp" }): Promise<RpcResponse> {
    try {
      const outcome = await steerOrFollowUp(this.session, options.streamingBehavior === "followUp" ? "followUp" : "steer", message, options.images);
      return ok(id, command, dispositionData(outcome));
    } catch (error) {
      return fail(id, command, error instanceof Error ? error.message : String(error));
    }
  }

  /** Start a turn and answer once preflight accepted it, as Pi's RPC mode does. */
  private startPrompt(id: string | undefined, command: string, message: string, options: { images?: RpcCommandImages; streamingBehavior?: "steer" | "followUp" }): Promise<RpcResponse> {
    if (this.turnActive && !options.streamingBehavior) {
      return Promise.resolve(fail(id, command, "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."));
    }
    if (this.turnActive && options.streamingBehavior && !this.session.isStreaming) {
      // The turn is still in Pi's preflight, where `session.prompt` would see `isStreaming` false and start a second run.
      // Queue the message for the starting turn instead, as a steer/follow_up command would.
      return this.queueForStartingTurn(id, command, message, options);
    }
    this.promptsInFlight++;
    return new Promise<RpcResponse>((resolve) => {
      let accepted = false;
      let returned = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.releaseOnAgentEnd.delete(release);
        this.promptsInFlight--;
        this.onActivity();
        this.runStrandedQueue();
      };
      this.session
        .prompt(message, {
          images: options.images,
          streamingBehavior: options.streamingBehavior,
          source: "rpc",
          // Pi 0.82 passes a boolean (false: rejected); Pi 1.x passes the disposition string and only calls this on success.
          preflightResult: (outcome: unknown) => {
            if (outcome === false) return;
            accepted = true;
            resolve(ok(id, command, dispositionData(outcome)));
            // Pi 1.x deferred this prompt (it arrived while Pi was emitting agent_settled) and prompt() already returned.
            // Nothing awaits the deferred run, so a started turn is released when it ends; any other outcome is already over.
            if (returned) {
              if (outcome === "started") this.releaseOnAgentEnd.add(release);
              else release();
            }
          },
        })
        .then(
          () => {
            returned = true;
            // Returned before preflight reported: Pi 1.x deferred the prompt. Keep the turn marked until it has run.
            if (accepted) {
              release();
              return;
            }
            // Pi settles the run's idle signal after it ran (or failed) the deferred actions, so a prompt that never reached
            // preflight by then threw inside Pi and nothing else will answer or release it.
            void this.runIdle?.then(() => {
              if (accepted || released) return;
              resolve(fail(id, command, "Pi did not accept the prompt: it failed after being deferred while the agent was settling"));
              release();
            });
          },
          (error: unknown) => {
            returned = true;
            const text = error instanceof Error ? error.message : String(error);
            if (!accepted) {
              resolve(fail(id, command, text));
            } else {
              // The response already said success; tell every listener the accepted message did not run.
              const event = { type: "prompt_error", command, ...(id !== undefined ? { id } : {}), error: text } as unknown as AgentSessionEvent;
              this.publish(event);
            }
            release();
          },
        );
    });
  }

  /**
   * A message queued for a starting turn is delivered by that turn or refused. When the starting prompt
   * ended without a run (extension command, handled input, error before the turn, settle window) and
   * messages are still queued, nothing would run them: start a turn for them now, or report them refused.
   */
  private runStrandedQueue(): void {
    const session = this.session;
    if (this.promptsInFlight > 0 || session.isStreaming || session.pendingMessageCount === 0) return;
    this.promptsInFlight++;
    const refuse = (error: unknown, messages: string[]) => {
      const text = error instanceof Error ? error.message : String(error);
      this.publish({ type: "prompt_error", command: "queued", error: `queued message did not run: ${text}`, messages } as unknown as AgentSessionEvent);
    };
    const run = async () => {
      // The first queued message starts the turn through session.prompt (not agent.continue), so it runs in Pi's
      // run lifecycle: isStreaming while it runs, post-run retry/compaction, and agent_settled after it.
      const { steering, followUp } = session.clearQueue();
      const [first, ...rest] = [...steering, ...followUp];
      if (first === undefined) return;
      try {
        await session.prompt(first, {
          source: "rpc",
          preflightResult: (outcome: unknown) => {
            if (outcome === false) return;
            for (const text of rest) steerOrFollowUp(session, "followUp", text, undefined).catch((error: unknown) => refuse(error, [text]));
          },
        });
      } catch (error) {
        refuse(error, [first, ...rest]);
      }
    };
    run()
      .catch((error: unknown) => {
        const left = session.clearQueue();
        refuse(error, [...left.steering, ...left.followUp]);
      })
      .finally(() => {
        this.promptsInFlight--;
        this.onActivity();
        this.runStrandedQueue();
      });
  }

  async handle(command: RpcCommand): Promise<RpcResponse> {
    const id = command.id;
    const session = this.session;
    try {
      if (UNSUPPORTED_SESSION_COMMANDS.has(command.type)) {
        return fail(id, command.type, `${command.type} is not supported: the daemon pins one session file per session; use create_session`);
      }
      switch (command.type) {
        case "prompt":
          return await this.startPrompt(id, "prompt", command.message, { images: command.images, streamingBehavior: command.streamingBehavior });
        case "steer":
          // Starting or running turn: queue, delivered after the current tool calls and before the next LLM call.
          if (this.turnActive) {
            return ok(id, "steer", dispositionData(await steerOrFollowUp(session, "steer", command.message, command.images)));
          }
          // Idle (no turn running or starting): Pi would only queue it for a turn that never starts. Start that turn now.
          return await this.startPrompt(id, "steer", command.message, { images: command.images });
        case "follow_up":
          return ok(id, "follow_up", dispositionData(await steerOrFollowUp(session, "followUp", command.message, command.images)));
        case "abort":
          await session.abort();
          return ok(id, "abort");
        case "get_state": {
          const state = this.rpcState();
          return ok(id, "get_state", { ...state, model: clientModel(session.model), lastSeq: this.lastSeq, hasController: this.hasController, needsInput: this.needsInput });
        }
        case "set_model": {
          const models = await session.modelRuntime.getAvailable();
          const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
          if (!model) return fail(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
          await session.setModel(model);
          this.onActivity();
          return ok(id, "set_model", clientModel(model));
        }
        case "cycle_model": {
          const result = await session.cycleModel();
          return ok(id, "cycle_model", result ? { ...result, model: clientModel(result.model) } : null);
        }
        case "get_available_models":
          return ok(id, "get_available_models", { models: (await session.modelRuntime.getAvailable()).map(clientModel) });
        case "set_thinking_level":
          session.setThinkingLevel(command.level);
          return ok(id, "set_thinking_level");
        case "cycle_thinking_level": {
          const level = session.cycleThinkingLevel();
          return ok(id, "cycle_thinking_level", level ? { level } : null);
        }
        case "get_available_thinking_levels":
          return ok(id, "get_available_thinking_levels", { levels: session.getAvailableThinkingLevels() });
        case "set_steering_mode":
          session.setSteeringMode(command.mode);
          return ok(id, "set_steering_mode");
        case "set_follow_up_mode":
          session.setFollowUpMode(command.mode);
          return ok(id, "set_follow_up_mode");
        case "compact":
          return ok(id, "compact", await session.compact(command.customInstructions));
        case "set_auto_compaction":
          session.setAutoCompactionEnabled(command.enabled);
          return ok(id, "set_auto_compaction");
        case "set_auto_retry":
          session.setAutoRetryEnabled(command.enabled);
          return ok(id, "set_auto_retry");
        case "abort_retry":
          session.abortRetry();
          return ok(id, "abort_retry");
        case "bash": {
          let guardError: string | undefined;
          const off = session.extensionRunner.onError((error) => { if (error.event === "user_bash") guardError = error.error; });
          let intercepted: Awaited<ReturnType<typeof session.extensionRunner.emitUserBash>>;
          try {
            intercepted = await session.extensionRunner.emitUserBash({ type: "user_bash", command: command.command, excludeFromContext: command.excludeFromContext ?? false, cwd: session.sessionManager.getCwd() });
            // Older Pi versions report guard errors without throwing; still fail closed.
            if (guardError) throw new Error(guardError);
          } finally { off(); }
          if (intercepted?.result) {
            session.recordBashResult(command.command, intercepted.result, { excludeFromContext: command.excludeFromContext });
            return ok(id, "bash", intercepted.result);
          }
          return ok(id, "bash", await session.executeBash(command.command, undefined, { excludeFromContext: command.excludeFromContext, operations: intercepted?.operations, id }));
        }
        case "abort_bash":
          session.abortBash();
          return ok(id, "abort_bash");
        case "get_session_stats":
          return ok(id, "get_session_stats", session.getSessionStats());
        case "export_html":
          return ok(id, "export_html", { path: await session.exportToHtml(command.outputPath) });
        case "get_fork_messages":
          return ok(id, "get_fork_messages", { messages: session.getUserMessagesForForking() });
        case "get_entries": {
          const manager = session.sessionManager;
          let entries = manager.getEntries();
          if (command.since !== undefined) {
            const index = entries.findIndex((entry) => entry.id === command.since);
            if (index === -1) return fail(id, "get_entries", `Entry not found: ${command.since}`);
            entries = entries.slice(index + 1);
          }
          return ok(id, "get_entries", { entries, leafId: manager.getLeafId() });
        }
        case "get_tree":
          return ok(id, "get_tree", { tree: session.sessionManager.getTree(), leafId: session.sessionManager.getLeafId() });
        case "get_last_assistant_text":
          return ok(id, "get_last_assistant_text", { text: session.getLastAssistantText() });
        case "set_session_name": {
          const name = command.name.trim();
          if (!name) return fail(id, "set_session_name", "Session name cannot be empty");
          session.setSessionName(name);
          this.onActivity();
          return ok(id, "set_session_name");
        }
        case "get_messages":
          return ok(id, "get_messages", { messages: session.messages });
        case "get_commands": {
          const commands: unknown[] = [];
          for (const entry of session.extensionRunner.getRegisteredCommands()) {
            commands.push({ name: entry.invocationName, description: entry.description, source: "extension", sourceInfo: entry.sourceInfo });
          }
          for (const template of session.promptTemplates) {
            commands.push({ name: template.name, description: template.description, source: "prompt", sourceInfo: template.sourceInfo });
          }
          for (const skill of session.resourceLoader.getSkills().skills) {
            commands.push({ name: `skill:${skill.name}`, description: skill.description, source: "skill", sourceInfo: skill.sourceInfo });
          }
          return ok(id, "get_commands", { commands });
        }
        default: {
          const unknown = command as { type: string };
          return fail(id, unknown.type, `Unknown command: ${unknown.type}`);
        }
      }
    } catch (error) {
      return fail(id, command.type, error instanceof Error ? error.message : String(error));
    }
  }
}

type RpcCommandImages = Extract<RpcCommand, { type: "prompt" }>["images"];
