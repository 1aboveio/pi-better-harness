/** Failure-only fixture timing; never reads source state or changes control scheduling. */
export function parkPhaseTrace(signal: AbortSignal, emit: (record: unknown) => void, now = () => performance.now()) {
  const started = now();
  const phases: { phase: string; elapsedMs: number }[] = [];
  const launchPhases: { phase: string; startedMs: number; sdkStartedMs: number; endedMs?: number; sdkEndedMs?: number; state: string }[] = [];
  const launchPhase = (receipt: { index: number; phase: string; state: string; elapsedMs: number }) => {
    if (reported || !Number.isInteger(receipt.index) || receipt.index < 0 || receipt.index >= 32
        || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0
        || !["tool-execute", "hello", "client-registration", "catalog-binding", "catalog-registration", "launch-bridge", "provision-shell", "detached-spawn"].includes(receipt.phase)) return;
    const elapsedMs = Math.round(now() - started);
    const entry = launchPhases[receipt.index];
    if (receipt.state === "started" && receipt.index === launchPhases.length)
      launchPhases.push({ phase: receipt.phase, startedMs: elapsedMs, sdkStartedMs: receipt.elapsedMs, state: "started" });
    else if (["finished", "failed"].includes(receipt.state) && entry?.phase === receipt.phase && entry.state === "started")
      Object.assign(entry, { endedMs: elapsedMs, sdkEndedMs: receipt.elapsedMs, state: receipt.state });
  };
  let reported = false;
  const mark = (phase: string) => {
    phases.push({ phase, elapsedMs: Math.round(now() - started) });
    if (phases.length > 32) phases.shift();
  };
  const report = (cause: "abort" | "failure") => {
    if (reported) return;
    reported = true;
    emit({ parkPhaseFailure: { cause, elapsedMs: Math.round(now() - started), phases: [...phases],
      ...(launchPhases.length ? { launchPhases: launchPhases.map(phase => ({ ...phase })) } : {}) } });
  };
  const aborted = () => report("abort");
  signal.addEventListener("abort", aborted, { once: true });
  return { mark, launchPhase, report, close: () => signal.removeEventListener("abort", aborted) };
}
