import type { WorkClient } from "../../src/runtime/work-client.mjs";

/** Control readiness may precede source initialization; use the existing stream. */
export async function subscribeBackgroundReady(client: Pick<WorkClient, "subscribe" | "snapshot" | "onChange">,
  scope: Record<string, unknown>, signal: AbortSignal) {
  const initial = await client.subscribe(scope);
  if (initial.status !== "rebuilding") return initial;
  return new Promise<any>((resolve, reject) => {
    const cleanup = () => { stop(); signal.removeEventListener("abort", abort); };
    const observe = (snapshot: any) => {
      if (!snapshot || snapshot.status === "rebuilding") return;
      cleanup(); resolve(snapshot);
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    const stop = client.onChange(observe);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else observe(client.snapshot);
  });
}
