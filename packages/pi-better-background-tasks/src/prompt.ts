/**
 * The operational prompt this package owns: how to wait, and how to launch.
 *
 * Published as a named section so pi can diff it. It exists because the tool
 * descriptions cannot carry it: a description explains one call, while the
 * failure this prevents is choosing `sleep` over a watcher in the first place.
 *
 * Instructions only. No rationale, no worked examples, and no defaults that the
 * tool schemas already state: the model has every schema in context, and repeated
 * reference just spends prefix tokens on text it can already read.
 */
export const BACKGROUND_TASKS_SECTION = "background_tasks";

import { EXECUTION_POLICY_TEXT, publishExecutionPolicy, supportsPromptSections } from "./shared-execution-policy.js";

/** `sections` is optional because the repo typechecks against older pi typings. */
export interface PromptSectionTarget {
  sections?: Record<string, string>;
}

export const BACKGROUND_TASKS_PROMPT: string = [
  "Background tasks: never wait in the foreground.",
  "",
  "- Never use foreground `sleep` to wait or poll, whether alone, before another command, or inside a loop. The sole permitted foreground sleep is at most 3 s immediately after `pkill`, `kill`, or `systemctl stop`, while the process exits.",
  "- Use `bg_task_spawn` and `bg_task_watch` instead of `nohup`, `&`, or `disown`.",
  "- Treat the wait, not the check, as the long part. Waiting for `gh pr checks` to pass is a `bg_task_watch`, not `sleep 300; gh pr checks`.",
  "- Waiting on an external system (`gh run view`, `gh pr checks`, `mergify queue show`, a redeploy, a dev server, `cloud-init`): `bg_task_watch` with the check command and `success_when`. For a PR you just enqueued, `watch_delivery`.",
  "- Waiting on your own long command (tests, build, migration): `bg_task_spawn`, then `wait_for_operations`. Do not sleep and re-read the log.",
  "- Waiting for a server you just started: `bg_task_spawn` the server, then `bg_task_watch` on a readiness check (`curl -fsS ...`).",
  "- Retry until a condition with one `bg_task_watch`, never `for i in ...; do ...; sleep N; done`.",
  "- If a dependency is pending and no watcher is running, start `bg_task_watch`; do not loop short sleeps.",
  "- Nothing here automatically diverts a foreground command. A sleep or monitor loop submitted through foreground `bash` blocks the turn.",
  "- Omit `timeout_seconds` on `bg_task_spawn` unless you need a bound. Raise it on `bg_task_watch` for a wait longer than 15 minutes, and leave `callback` alone: do not poll.",
  "- Write the check so a broken check is visible; do not end it with `exit 0` or `|| true`.",
  "- Stop tasks you started for a turn-scoped purpose before finishing the turn.",
].join("\n");

/** Publish the guidance into `options.sections`; assignment keeps it idempotent across turns. */
export function publishBackgroundTasksGuidance<T extends object>(options: T): T {
  const target = options as PromptSectionTarget;
  const sections = (target.sections ??= {});
  sections[BACKGROUND_TASKS_SECTION] = BACKGROUND_TASKS_PROMPT;
  return options;
}

/** What a handler receives; only these two fields are used. */
export interface BeforeAgentStartEvent {
  systemPrompt: string;
  systemPromptOptions?: unknown;
}

/**
 * Deliver this package's guidance on both kinds of host.
 *
 * Modern pi renders custom sections, so publishing keeps the prompt structured
 * and lets pi diff it. Older pi (the packages declare support back to 0.84.4)
 * renders no sections at all, so publishing there would silently deliver nothing;
 * returning the text is the behaviour those hosts already had.
 */
export function deliverBackgroundTasksPrompt(event: BeforeAgentStartEvent): { systemPrompt: string } | undefined {
  if (!supportsPromptSections(event.systemPromptOptions)) {
    // Several packages carry the same policy, so appending blindly would print it
    // once per publisher. The text path stays idempotent exactly as it used to be.
    const policy = event.systemPrompt.includes(EXECUTION_POLICY_TEXT) ? "" : `${EXECUTION_POLICY_TEXT}\n\n`;
    const guidance = event.systemPrompt.includes(BACKGROUND_TASKS_PROMPT) ? "" : BACKGROUND_TASKS_PROMPT;
    return { systemPrompt: `${event.systemPrompt}\n\n${policy}${guidance}` };
  }
  const options = event.systemPromptOptions as { sections?: Record<string, string> };
  publishExecutionPolicy(options);
  publishBackgroundTasksGuidance(options);
  return undefined;
}
