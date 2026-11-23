import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";
import {
  DEFAULT_PROMPT,
  ENTRY,
  latestAnswer,
  restoredSummary,
  summarize,
  supportsRecap,
  type Summary,
} from "./summary.ts";

type Preferences = { enabled?: boolean; prompt?: string };
const KEY = "sessionRecap";

function preferences(value: unknown): Preferences {
  if (!value || typeof value !== "object") return {};
  const { enabled, prompt } = value as Preferences;
  return {
    enabled: enabled === true,
    prompt: typeof prompt === "string" && prompt.trim() && prompt.length <= 4096 ? prompt : undefined,
  };
}

export default function recapExtension(pi: ExtensionAPI): void {
  let prefs: Preferences = {};
  let run: AbortController | undefined;
  let answerId: string | undefined;

  function cancel() {
    run?.abort();
    run = undefined;
    answerId = undefined;
  }

  function display(ctx: ExtensionContext, summary?: Summary) {
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    ctx.ui.setWidget(
      ENTRY,
      summary
        ? (_tui, theme) => {
            const lines = [theme.bold("Recap") + "  " + summary.recap];
            if (summary.next) lines.push(theme.fg("accent", "Next") + "   " + summary.next);
            return new Text(lines.join("\n"), 0, 0);
          }
        : undefined,
      { placement: "aboveEditor" },
    );
  }

  function restore(ctx: ExtensionContext) {
    cancel();
    if (!prefs.enabled || ctx.mode !== "tui") return display(ctx);
    const branch = ctx.sessionManager.getBranch();
    const answer = latestAnswer(branch);
    display(ctx, answer && restoredSummary(branch, answer.id));
  }

  function save(update: Preferences) {
    prefs = updateHarnessSetting<Preferences>(KEY, (current) => ({ ...preferences(current), ...update }));
  }

  async function editPrompt(ctx: ExtensionCommandContext) {
    const edit = await ctx.ui.editor("Recap prompt · clear to restore default", prefs.prompt || DEFAULT_PROMPT);
    if (edit === undefined) return;
    const prompt = edit.trim();
    if (prompt.length > 4096) {
      ctx.ui.notify("Recap prompt must fit within 4,096 characters.", "warning");
      return;
    }
    save({ prompt: prompt && prompt !== DEFAULT_PROMPT ? prompt : undefined });
    restore(ctx);
  }

  const toggle = {
    id: "session-recap",
    label: "Session recap",
    values: ["Off", "On"],
    description: "Summarize settled conversations above the editor using a separate model request.",
    get: () => (prefs.enabled ? "On" : "Off"),
    change(value: string, ctx: ExtensionCommandContext) {
      if (value !== "On" && value !== "Off") throw new Error("Unknown Recap setting");
      save({ enabled: value === "On" });
      restore(ctx);
      if (prefs.enabled && !supportsRecap(ctx))
        ctx.ui.notify("Recap generation requires Pi's configured model streaming API.", "warning");
    },
  };
  const promptLink = {
    id: "recap-prompt",
    label: "Recap prompt",
    description: "Edit instructions used only by the summary model.",
    command: "/recap-prompt",
    open: editPrompt,
  };
  const register = () => {
    pi.events.emit("harness-settings:register", toggle);
    pi.events.emit("harness-settings:register", promptLink);
  };
  let unsubscribe: (() => void) | undefined;
  pi.registerCommand("recap-prompt", {
    description: "Edit the session recap instructions",
    handler: (_args, ctx) => editPrompt(ctx),
  });
  pi.on("session_start", (_event, ctx) => {
    try {
      prefs = preferences(readHarnessSetting(KEY));
    } catch {
      prefs = {};
    }
    unsubscribe ??= pi.events.on("harness-settings:request", register);
    register();
    restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("agent_start", (_event, ctx) => {
    cancel();
    display(ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    if (!prefs.enabled || ctx.mode !== "tui") return;
    const last = event.messages.at(-1);
    const answer = latestAnswer(ctx.sessionManager.getBranch());
    if (last?.role === "assistant" && last.stopReason === "stop" && last.timestamp === answer?.message.timestamp)
      answerId = answer.id;
  });
  pi.on("agent_settled", (event, ctx) => {
    const id = answerId;
    answerId = undefined;
    if (
      !id ||
      (event as { aborted?: boolean }).aborted ||
      ctx.hasPendingMessages() ||
      !prefs.enabled ||
      !ctx.hasUI ||
      ctx.mode !== "tui"
    )
      return;
    const branch = ctx.sessionManager.getBranch();
    const answer = latestAnswer(branch);
    if (answer?.id !== id || restoredSummary(branch, id)) return;
    const sessionId = ctx.sessionManager.getSessionId();
    const request = new AbortController();
    run = request;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
    void summarize(ctx, branch, answer, prefs.prompt || DEFAULT_PROMPT, signal)
      .then((record) => {
        if (
          !record ||
          signal.aborted ||
          run !== request ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          latestAnswer(ctx.sessionManager.getBranch())?.id !== id
        )
          return;
        pi.appendEntry(ENTRY, record);
        display(ctx, record);
      })
      .catch(() => {
        /* Auxiliary failures never interrupt foreground work. */
      })
      .finally(() => {
        if (run === request) run = undefined;
      });
  });
  pi.on("session_shutdown", (_event, ctx) => {
    cancel();
    display(ctx);
    unsubscribe?.();
    unsubscribe = undefined;
  });
}
