import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reconstructGoalSnapshot } from "pi-better-goal/src/goal-state.ts";
import { sessionIdleEvent, type SessionIdleInspection } from "pi-better-goal/src/types.ts";
import { Text, TruncatedText } from "@earendil-works/pi-tui";
import { readHarnessSetting, updateHarnessSetting } from "../shared-harness-settings.ts";
import {
  DEFAULT_PROMPT,
  ENTRY,
  latestAnswer,
  restoredSummary,
  summarize,
  supportsRecap,
  parseSummary,
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
  let ended: { timestamp: number; aborted: boolean } | undefined;
  let stopWatching: (() => void) | undefined;

  function cancel() {
    ended = undefined;
    stopWatching?.();
    stopWatching = undefined;
    run?.abort();
    run = undefined;
  }

  pi.registerEntryRenderer?.<{ version: number }>(ENTRY, (entry, { expanded }, theme) => {
    if (entry.data?.version !== 2) return;
    const summary = parseSummary(entry.data);
    if (!summary) return;
    const line = theme.fg("muted", "Recap") + "  " + summary.recap;
    if (!expanded) return new TruncatedText(line, 0, 0);
    return new Text(line + (summary.next ? "\n" + theme.fg("muted", "Next") + "   " + summary.next : ""), 0, 0);
  });

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
    cancel();
  }

  const toggle = {
    id: "session-recap",
    label: "Session recap",
    values: ["Off", "On"],
    description: "Add a short recap to the transcript when the session and its work are idle.",
    get: () => (prefs.enabled ? "On" : "Off"),
    change(value: string, ctx: ExtensionCommandContext) {
      if (value !== "On" && value !== "Off") throw new Error("Unknown Recap setting");
      save({ enabled: value === "On" });
      cancel();
      if (prefs.enabled && (!pi.registerEntryRenderer || !supportsRecap(ctx)))
        ctx.ui.notify("Recap requires Pi transcript entry renderers and the configured model streaming API.", "warning");
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
  pi.on("session_start", () => {
    try {
      prefs = preferences(readHarnessSetting(KEY));
    } catch {
      prefs = {};
    }
    unsubscribe ??= pi.events.on("harness-settings:request", register);
    register();
    cancel();
  });
  pi.on("session_tree", cancel);
  pi.on("agent_start", cancel);
  pi.on("agent_end", (event, ctx) => {
    if (!prefs.enabled || !ctx.hasUI || ctx.mode !== "tui" || !pi.registerEntryRenderer || !supportsRecap(ctx)) return;
    const last = event.messages.at(-1);
    if (last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "aborted")) {
      ended = { timestamp: last.timestamp, aborted: last.stopReason === "aborted" };
    }
  });
  pi.on("agent_settled", (event, ctx) => {
    const end = ended;
    ended = undefined;
    if (!end || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    const interrupted = end.aborted || (event as { aborted?: boolean }).aborted === true;
    const sessionId = ctx.sessionManager.getSessionId();
    const channel = sessionIdleEvent(sessionId);
    const check = (verify = false) => {
      const inspection: SessionIdleInspection = { verify };
      pi.events.emit(channel + ":inspect", inspection);
      // Standalone Recap works without a Goal. A persisted Goal needs its activity owner.
      if (inspection.idle !== undefined) return inspection.idle;
      return !reconstructGoalSnapshot(ctx.sessionManager.getBranch()) &&
        !pi.getAllTools?.().some(tool => ["subagent_spawn", "bg_task_spawn", "get_background_activity"].includes(tool.name));
    };
    const eligible = () => ctx.sessionManager.getSessionId() === sessionId && ctx.isIdle() && !ctx.hasPendingMessages();
    let saveWhenIdle: (() => void) | undefined;
    const onIdle = (idle: unknown) => {
      // Keep the same summary through a provider refresh. Only verified new work cancels it.
      if (idle === "checking") return;
      if (idle !== true) {
        run?.abort();
        run = undefined;
        saveWhenIdle = undefined;
        return;
      }
      if (!eligible()) return;
      if (saveWhenIdle) { saveWhenIdle(); return; }
      if (run) return;
      const branch = ctx.sessionManager.getBranch();
      const goal = reconstructGoalSnapshot(branch);
      if (goal && goal.status !== "paused" && goal.status !== "complete") return;
      const answer = latestAnswer(branch, interrupted);
      if (!answer || (interrupted ? goal?.status !== "paused" : answer.message.timestamp !== end.timestamp) ||
          restoredSummary(branch, answer.id)) {
        cancel();
        return;
      }
      const request = new AbortController();
      run = request;
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);
      void summarize(ctx, branch, answer, prefs.prompt || DEFAULT_PROMPT, signal, goal?.status, interrupted)
        .then(record => {
          if (run !== request) return;
          if (!record || signal.aborted || !eligible()) { cancel(); return; }
          saveWhenIdle = () => {
            saveWhenIdle = undefined;
            const current = ctx.sessionManager.getBranch();
            const currentGoal = reconstructGoalSnapshot(current);
            if (currentGoal?.goalId === goal?.goalId && latestAnswer(current, interrupted)?.id === answer.id &&
                !restoredSummary(current, answer.id)) {
              if (currentGoal?.status !== goal?.status) {
                run = undefined;
                onIdle(true);
                return;
              }
              pi.appendEntry(ENTRY, record);
            }
            cancel();
          };
          onIdle(check());
        })
        .catch(() => { if (run === request) cancel(); });
    };
    stopWatching = pi.events.on(channel, onIdle);
    onIdle(check(true));
  });
  pi.on("session_shutdown", () => {
    cancel();
    unsubscribe?.();
    unsubscribe = undefined;
  });
}
