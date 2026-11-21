/** Diagnostic sampling must not replace the assertion or cleanup failure. */
export function historyPhaseMetrics(source?: { readonly metrics: unknown }): unknown {
  try { return source?.metrics; }
  catch (error) { return { unavailable: error instanceof Error ? error.message : String(error) }; }
}
