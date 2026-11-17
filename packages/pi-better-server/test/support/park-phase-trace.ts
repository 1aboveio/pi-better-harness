/** Failure-only fixture timing; never reads source state or changes control scheduling. */
export function parkPhaseTrace(signal: AbortSignal, emit: (record: unknown) => void, now = () => performance.now()) {
  const started = now();
  const phases: { phase: string; elapsedMs: number }[] = [];
  let reported = false;
  const mark = (phase: string) => {
    phases.push({ phase, elapsedMs: Math.round(now() - started) });
    if (phases.length > 32) phases.shift();
  };
  const report = (cause: "abort" | "failure") => {
    if (reported) return;
    reported = true;
    emit({ parkPhaseFailure: { cause, elapsedMs: Math.round(now() - started), phases: [...phases] } });
  };
  const aborted = () => report("abort");
  signal.addEventListener("abort", aborted, { once: true });
  return { mark, report, close: () => signal.removeEventListener("abort", aborted) };
}
