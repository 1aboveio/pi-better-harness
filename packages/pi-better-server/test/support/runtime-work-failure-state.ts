import type { TestContext } from "node:test";
import { performance } from "node:perf_hooks";

/** Observe fixture cancellation without starting another read or changing its await. */
export function runtimeWorkFailureState(t: Pick<TestContext, "signal" | "diagnostic" | "after">, fixture: string, read: () => unknown) {
  let phase = "setup", entered = performance.now();
  const report = () => {
    let state: unknown;
    try { state = read(); } catch (error) { state = { inspectionError: String(error).slice(0, 512) }; }
    const text = JSON.stringify({ fixture, phase, phaseElapsedMs: performance.now() - entered, state });
    t.diagnostic(text.length <= 8192 ? text : JSON.stringify({ fixture, phase, truncated: true, prefix: text.slice(0, 3000) }));
  };
  t.signal.addEventListener("abort", report, { once: true });
  t.after(() => t.signal.removeEventListener("abort", report));
  return (next: string) => { phase = next; entered = performance.now(); };
}
