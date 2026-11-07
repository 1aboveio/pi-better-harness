/**
 * Recognise a foreground command that waits on something outside this machine.
 *
 * The guard keys off command shape rather than duration: a five minute test run belongs in the
 * foreground where its output streams, while `gh pr checks --watch` can only end when GitHub
 * says so. Duration cannot tell those apart, and blocking the first would be wrong.
 */
export interface WaitMatch {
  /** Which rule matched, quoted back to the caller so the block is explainable. */
  rule: string;
  /** What the command is waiting for. */
  waitsOn: string;
}

/** A foreground pause shorter than this is ordinary command flow, not a wait. */
export const SLEEP_THRESHOLD_SECONDS = 3;

const RULES: readonly { rule: RegExp; waitsOn: string }[] = [
  { rule: /\bgh\s+pr\s+checks\b[^\n]*--watch\b/, waitsOn: "a pull request's checks" },
  { rule: /\bgh\s+run\s+(?:view|watch)\b[^\n]*--watch\b/, waitsOn: "a workflow run" },
  { rule: /\bgh\s+run\s+watch\b/, waitsOn: "a workflow run" },
  { rule: /\bgh\s+workflow\s+run\b[^\n]*--watch\b/, waitsOn: "a workflow run" },
  // A helper script whose name starts with watch- polls an external system, whatever its flags.
  { rule: /\bwatch[-_][\w.-]*/, waitsOn: "an external state change" },
  // --watch and --until only mean polling on provider CLIs; `git log --until` is a plain filter.
  { rule: /\b(?:gh|github|glab)\b[^\n]*--(?:watch|until)\b/, waitsOn: "an external state change" },
  { rule: /(?:^|[;&|]\s*)watch\s+\S/, waitsOn: "a repeating command" },
  { rule: /\btail\s+-[a-zA-Z]*[fF]/, waitsOn: "a growing file" },
  { rule: /\bdocker\s+(?:logs|events)\b[^\n]*\s-f\b/, waitsOn: "a container's log stream" },
  { rule: /\bkubectl\b[^\n]*(?:--watch\b|\s-w\b)/, waitsOn: "cluster state" },
  // A poll loop only counts when its body actually waits on something.
  { rule: /\b(?:until|while)\b[^\n]*\b(?:sleep|curl|gh\s|docker\s|kubectl\s|pg_isready)\b/, waitsOn: "a repeated external check" },
];

const SLEEP = /(?:^|[;&|(]\s*|\bsudo\s+)sleep\s+(\d+(?:\.\d+)?)/;

export function detectForegroundWait(command: string): WaitMatch | undefined {
  for (const { rule, waitsOn } of RULES) {
    if (rule.test(command)) return { rule: rule.source, waitsOn };
  }
  const sleep = SLEEP.exec(command);
  if (sleep) {
    const seconds = Number(sleep[1]);
    if (Number.isFinite(seconds) && seconds > SLEEP_THRESHOLD_SECONDS) {
      return { rule: SLEEP.source, waitsOn: `${seconds} seconds of wall clock` };
    }
  }
  return undefined;
}

/** The message the model reads instead of the command's output. */
export function blockReason(match: WaitMatch): string {
  return [
    `This command waits on ${match.waitsOn}, so it belongs in a background task.`,
    "Spawn it with bg_task_spawn, then call wait_for_operations to park until it reports; a background task survives the end of the turn, while a foreground wait does not.",
    "Read bg_task_status and bg_task_log for the verdict.",
    'To run this command in the foreground anyway, set Tool call guard to Off in Harness settings.',
  ].join(" ");
}
