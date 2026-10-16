import { createInterface } from "node:readline";
import type { DialogAnswer, PendingDialog } from "../protocol.ts";
import type { Subcommand } from "./context.ts";
import { resolveSession } from "./sessions.ts";
import { deliverMessage } from "./steer.ts";
import { createRenderer } from "./tail.ts";

/** How many of the newest retained events a freshly started console replays so the pane opens with context. */
const REPLAY_TAIL = 200;

const HELP = "Type a message to steer or prompt the session. /abort stops the current turn, /cancel dismisses a question, /help shows this.\n";

/** Turn what a person typed into the answer the dialog expects; a string is an explanation of what was wrong. */
export function parseDialogAnswer(dialog: PendingDialog, line: string): DialogAnswer | string {
  const text = line.trim();
  if (text === "/cancel") return { cancelled: true };
  if (dialog.method === "confirm") {
    if (/^(y|yes)$/i.test(text)) return { confirmed: true };
    if (/^(n|no)$/i.test(text)) return { confirmed: false };
    return "Answer y or n (or /cancel).";
  }
  if (dialog.method === "select") {
    const options = dialog.options ?? [];
    const picked = /^\d+$/.test(text) ? options[Number(text) - 1] : options.find((option) => option === text);
    return picked !== undefined ? { value: picked } : `Pick one of 1-${options.length} (or /cancel).`;
  }
  return { value: line };
}

function describeDialog(dialog: PendingDialog): string {
  const lines = [`\n? ${dialog.title}${dialog.message ? ` -- ${dialog.message}` : ""}`];
  if (dialog.method === "select") (dialog.options ?? []).forEach((option, index) => lines.push(`  ${index + 1}) ${option}`));
  if (dialog.method === "confirm") lines.push("  [y/n]");
  if (dialog.method === "input" && dialog.placeholder) lines.push(`  (${dialog.placeholder})`);
  return `${lines.join("\n")}\n`;
}

/**
 * The terminal the daemon runs inside tmux for `pi-remote attach`. It is an
 * ordinary daemon client: it holds the session's controller lease for as long
 * as it lives, shows the live event stream, delivers typed lines as steer/prompt,
 * and answers extension dialogs. Because it is the only holder of the lease,
 * any number of people attaching to its tmux session still make one writer.
 */
export const command: Subcommand = {
  usage: "console [--host <ssh-alias>] <session>   (the terminal `attach` shows; rarely run by hand)",
  options: {},
  async run({ positionals }, context) {
    const ref = positionals[0];
    if (!ref) throw new Error("console needs a session: pi-remote console <session>");
    const client = await context.connect();
    const session = await resolveSession(client, ref);
    const sessionId = session.sessionId;
    await client.call({ type: "open_session", sessionId });

    const dialogs = new Map<string, PendingDialog>();
    const render = createRenderer();
    client.onEvent((message) => {
      if (message.sessionId !== sessionId) return;
      const event = message.event as { type?: string; method?: string; id?: string; message?: string } | undefined;
      if (event?.type === "extension_ui_request") {
        if (event.method === "select" || event.method === "confirm" || event.method === "input" || event.method === "editor") {
          const dialog = event as unknown as PendingDialog;
          if (!dialogs.has(dialog.id)) context.stdout(describeDialog(dialog));
          dialogs.set(dialog.id, dialog);
        } else if (event.method === "notify") context.stdout(`[notice] ${event.message ?? ""}\n`);
        return;
      }
      if (event?.type === "extension_ui_resolved") {
        if (event.id) dialogs.delete(event.id);
        return;
      }
      context.stdout(render(event));
    });

    // Events and the lease snapshot arrive in order on one socket, so after both calls `dialogs` is complete.
    const state = await client.call({ type: "get_state", sessionId });
    const lastSeq = (state.data as { lastSeq: number }).lastSeq;
    await client.call({ type: "subscribe", sessionId, sinceSeq: Math.max(0, lastSeq - REPLAY_TAIL) });
    const acquired = await client.request({ type: "acquire_control", sessionId });
    if (!acquired.success) throw new Error(`${acquired.error ?? "could not take control"}; this session already has a controller`);
    for (const dialog of acquired.data.needsInput as PendingDialog[]) {
      if (!dialogs.has(dialog.id)) context.stdout(describeDialog(dialog));
      dialogs.set(dialog.id, dialog);
    }
    context.stdout(`-- attached to ${session.name ?? sessionId.slice(0, 8)} (${session.cwd}) --\n${HELP}`);

    const input = createInterface({ input: process.stdin });
    const finished = new Promise<void>((resolve) => {
      input.on("close", resolve);
      client.onClose(resolve);
      context.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    let chain = Promise.resolve();
    input.on("line", (line) => {
      chain = chain.then(async () => {
        try {
          const text = line.trim();
          const first = dialogs.values().next().value as PendingDialog | undefined;
          if (first) {
            const answer = parseDialogAnswer(first, line);
            if (typeof answer === "string") return void context.stdout(`${answer}\n`);
            const response = await client.request({ type: "extension_ui_response", sessionId, requestId: first.id, ...answer });
            dialogs.delete(first.id); // gone either way: answered, or already resolved elsewhere
            if (!response.success) context.stdout(`(${response.error ?? "answer was not accepted"})\n`);
            return;
          }
          if (!text) return;
          if (text === "/help") return void context.stdout(HELP);
          if (text === "/abort") {
            await client.call({ type: "abort", sessionId });
            return;
          }
          if (text === "/cancel") return;
          await deliverMessage(client, sessionId, text);
        } catch (error) {
          context.stdout(`error: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      });
    });
    await finished;
    input.close();
    await chain;
    return 0;
  },
};
