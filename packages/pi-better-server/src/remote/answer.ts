import type { DialogAnswer, PendingDialog, SessionSummary } from "../protocol.ts";
import type { Subcommand } from "./context.ts";
import { matchSession } from "./sessions.ts";

export interface AnswerOptions {
  /** Full id, unique id prefix, or exact name. */
  session: string;
  /** Which dialog; optional when exactly one is pending. */
  requestId?: string;
  /** What to answer. Omit to only list what is pending. */
  answer?: DialogAnswer;
}

export interface AnswerResult {
  sessionId: string;
  /** The dialog that was answered, or the dialogs still waiting when no answer was given. */
  answered?: PendingDialog;
  pending: PendingDialog[];
}

interface Requester {
  request(command: Record<string, unknown>): Promise<any>;
}

/**
 * Answer a session's pending dialog from outside: take the controller lease,
 * answer, give the lease back. Fails (rather than waiting) if another
 * connection already holds the lease. The transport is injected so the
 * caller decides how the daemon is reached (`pi-remote` passes its client).
 */
export async function answerPending(daemon: Requester, options: AnswerOptions): Promise<AnswerResult> {
  const listed = await daemon.request({ type: "list_sessions" });
  if (!listed.success) throw new Error(listed.error ?? "list_sessions failed");
  const sessions: SessionSummary[] = listed.data.sessions;
  const summary = matchSession(sessions, options.session);
  const sessionId = summary.sessionId;
  if (!summary.live) {
    const opened = await daemon.request({ type: "open_session", sessionId });
    if (!opened.success) throw new Error(opened.error ?? "open_session failed");
  }

  const acquired = await daemon.request({ type: "acquire_control", sessionId });
  if (!acquired.success) throw new Error(acquired.error ?? "acquire_control failed");
  try {
    const pending: PendingDialog[] = acquired.data.needsInput;
    if (!options.answer) return { sessionId, pending };
    if (pending.length === 0) throw new Error(`Session ${sessionId} has no pending dialog`);
    const target = options.requestId ? pending.find((d) => d.id === options.requestId) : pending.length === 1 ? pending[0] : undefined;
    if (!target) {
      throw new Error(options.requestId ? `No pending dialog ${options.requestId}` : `${pending.length} dialogs are pending; pass --request <id>: ${pending.map((d) => d.id).join(", ")}`);
    }
    const response = await daemon.request({ type: "extension_ui_response", sessionId, requestId: target.id, ...options.answer });
    if (!response.success) throw new Error(response.error ?? "extension_ui_response failed");
    return { sessionId, answered: target, pending: pending.filter((d) => d.id !== target.id) };
  } finally {
    await daemon.request({ type: "release_control", sessionId });
  }
}

export function parseAnswer(values: Record<string, string | boolean | undefined>): DialogAnswer | undefined {
  const given = ["value", "confirm", "deny", "cancel"].filter((flag) => values[flag] !== undefined && values[flag] !== false);
  if (given.length > 1) throw new Error("Choose one of --value, --confirm, --deny, --cancel");
  if (typeof values.value === "string") return { value: values.value };
  if (values.confirm) return { confirmed: true };
  if (values.deny) return { confirmed: false };
  if (values.cancel) return { cancelled: true };
  return undefined;
}

export const command: Subcommand = {
  usage: "answer [--host <ssh-alias>] <session> [--request <id>] (--value <text> | --confirm | --deny | --cancel)",
  options: {
    request: { type: "string" },
    value: { type: "string" },
    confirm: { type: "boolean" },
    deny: { type: "boolean" },
    cancel: { type: "boolean" },
  },
  async run({ values, positionals }, context) {
    const session = positionals[0];
    if (!session || positionals.length !== 1) throw new Error("answer needs one session: pi-remote answer <session> [--request <id>] (--value <text> | --confirm | --deny | --cancel); without an answer flag it lists what is pending");
    const answer = parseAnswer(values);
    const result = await answerPending(await context.connect(), {
      session,
      ...(typeof values.request === "string" ? { requestId: values.request } : {}),
      ...(answer ? { answer } : {}),
    });
    if (context.json) context.stdout(`${JSON.stringify(result)}\n`);
    else {
      if (result.answered) context.stdout(`answered ${result.answered.method} "${result.answered.title}" (${result.answered.id}) on ${result.sessionId}\n`);
      for (const dialog of result.pending) context.stdout(`pending ${dialog.id} ${dialog.method} "${dialog.title}"\n`);
    }
    return result.answered || result.pending.length === 0 ? 0 : 1;
  },
};
