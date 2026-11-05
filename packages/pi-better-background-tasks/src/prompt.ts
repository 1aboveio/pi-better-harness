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

/** `sections` is optional because the repo typechecks against older pi typings. */
export interface PromptSectionTarget {
  sections?: Record<string, string>;
}

const BACKGROUND_TASKS_PROMPT = [
  "Background tasks: never wait in the foreground.",
  "",
  "- Never write `sleep N` before a command when N > 3. The only exception is up to 3 s right after `pkill`, `kill`, or `systemctl stop`, while the process exits.",
  "- Treat the wait, not the check, as the long part. Waiting for `gh pr checks` to pass is a `bg_task_watch`, not `sleep 300; gh pr checks`.",
  "- Waiting on an external system (`gh run view`, `gh pr checks`, `mergify queue show`, a redeploy, a dev server, `cloud-init`): `bg_task_watch` with the check command and `success_when`. For a PR you just enqueued, `watch_delivery`.",
  "- Waiting on your own long command (tests, build, migration): `bg_task_spawn`, then `wait_for_operations`. Do not sleep and re-read the log.",
  "- Waiting for a server you just started: `bg_task_spawn` the server, then `bg_task_watch` on a readiness check (`curl -fsS ...`).",
  "- Retry until a condition with one `bg_task_watch`, never `for i in ...; do ...; sleep N; done`.",
  "- Not ready and no watcher running? Start one. Do not loop short sleeps.",
  "- Nothing here diverts a foreground command for you. A `sleep` or monitor loop you type blocks the turn.",
  "- Omit `timeout_seconds` unless you need a bound. Leave `callback` at its default; do not poll.",
  "- Write the check so a broken check is visible; do not end it with `exit 0` or `|| true`.",
  "- Stop tasks you started for a turn-scoped purpose before finishing the turn.",
].join("\n");

/** Publish the guidance into `options.sections`; assignment keeps it idempotent across turns. */
export function publishBackgroundTasksGuidance<T extends PromptSectionTarget>(options: T): T {
  const sections = (options.sections ??= {});
  sections[BACKGROUND_TASKS_SECTION] = BACKGROUND_TASKS_PROMPT;
  return options;
}
