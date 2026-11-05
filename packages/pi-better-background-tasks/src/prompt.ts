/**
 * The operational prompt this package owns: how to wait, and how to launch.
 *
 * Published as a named section so pi can diff it. It exists because the tool
 * descriptions cannot carry it: a description explains one call, while the
 * failure this prevents is choosing `sleep` over a watcher in the first place.
 *
 * Keep every claim here true of the shipped schema in `tools.ts`. A stale
 * section is worse than none, because the model has no way to notice it.
 */
export const BACKGROUND_TASKS_SECTION = "background_tasks";

/** `sections` is optional because the repo typechecks against older pi typings. */
export interface PromptSectionTarget {
  sections?: Record<string, string>;
}

const BACKGROUND_TASKS_PROMPT = [
  "Background tasks: never wait in the foreground.",
  "",
  "A `sleep` in a foreground bash command is a defect, even a short one. The wait belongs in a background task; the command you were about to run after the sleep becomes the check.",
  "",
  "- Never write `sleep N` before a command when N > 3. The only exception is up to 3 s right after `pkill`, `kill`, or `systemctl stop`, while the process exits.",
  "- The long part is the wait, not the check. `gh pr checks` takes two seconds; waiting for the checks to pass takes ten minutes. That is a `bg_task_watch`, not `sleep 300; gh pr checks`.",
  "- Waiting on an external system (`gh run view`, `gh pr checks`, `mergify queue show`, a redeploy, a dev server, `cloud-init`): `bg_task_watch` with the check command and `success_when`. For a PR you just enqueued, `watch_delivery`.",
  "- Waiting on your own long command (tests, build, migration): `bg_task_spawn`, then `wait_for_operations`. Do not `sleep` and re-read the log.",
  "- Waiting for a server you just started: `bg_task_spawn` the server, then `bg_task_watch` on a readiness check (`curl -fsS ...`) with `success_when: {\"type\":\"exit_code\",\"equals\":0}`.",
  "- Retry until a condition: one `bg_task_watch`, never `for i in ...; do ...; sleep N; done`.",
  "- Not ready yet and no watcher is running? Start one. Do not loop short sleeps.",
  "- Nothing here diverts a foreground command for you. A `sleep` or a monitor loop you type runs in the foreground and blocks the turn.",
  "",
  "Launching and watching:",
  "",
  "- `callback` (default true) queues a follow-up when the task reaches a terminal state. That follow-up is how you learn the result; you do not need to poll for it.",
  "- `bg_task_spawn` has no default `timeout_seconds`; omit it unless you want a bound. `max_log_bytes` defaults to 4 MiB.",
  "- `require_successful_steps: true` runs a chained command under bash errexit, so an earlier failing step is not masked by a later command's exit 0.",
  "- For remote work pass structured `ssh: {host, user}` with the remote command in `command`; omit `remote.session` for durable tmux. Use `remote_bash` for a short synchronous remote command instead.",
  "- `bg_task_watch` requires `success_when` and accepts `failure_when`, `interval_seconds` (default 30), `timeout_seconds` (default 900), and `blind_checks` (default 3, which flags a check that keeps exiting 0 while printing to stderr).",
  "- A condition is one of `exit_code` + `equals`, `stdout_contains` / `stderr_contains` + `value`, or `json_path_equals` / `json_path_exists` + `path`.",
  "- Write the check so a broken check is visible. A check that ends in `exit 0` or `|| true` reports pending forever.",
  "- Stop tasks you started for a turn-scoped purpose before finishing the turn. Metadata and logs survive a reload; read them with `bg_task action: \"log\"`.",
].join("\n");

/** Publish the guidance into `options.sections`; assignment keeps it idempotent across turns. */
export function publishBackgroundTasksGuidance<T extends PromptSectionTarget>(options: T): T {
  const sections = (options.sections ??= {});
  sections[BACKGROUND_TASKS_SECTION] = BACKGROUND_TASKS_PROMPT;
  return options;
}
