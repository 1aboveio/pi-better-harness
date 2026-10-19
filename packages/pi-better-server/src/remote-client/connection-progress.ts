import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, truncateToWidth } from "@earendil-works/pi-tui";

export interface ConnectionProgress {
  signal: AbortSignal;
  stage(message: string): void;
}

type Outcome<T> = { kind: "connected"; value: T } | { kind: "failed"; error: unknown } | { kind: "cancelled" };

/** Owns the loading screen only; late resources from a cancelled attempt are disposed. */
export async function withConnectionProgress<T>(
  ui: Pick<ExtensionUIContext, "custom">,
  host: string,
  connect: (progress: ConnectionProgress) => Promise<T>,
  disposeLate: (value: T) => void | Promise<void>,
): Promise<T | undefined> {
  let abandon: (() => void) | undefined;
  let outcome: Outcome<T> | undefined;
  try {
    outcome = await ui.custom<Outcome<T>>((tui, theme, _keys, done) => {
      const controller = new AbortController();
      const loader = new CancellableLoader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), `Connecting to ${host}: preparing...`);
      let finished = false;
      let abandoned = false;
      abandon = () => {
        if (finished) return;
        finished = true;
        abandoned = true;
        controller.abort();
        loader.stop();
      };
      loader.onAbort = () => { if (!finished) { abandon!(); done({ kind: "cancelled" }); } };
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return connect({
          signal: controller.signal,
          stage: message => { if (!finished) loader.setMessage(`Connecting to ${host}: ${message}`); },
        });
      }).then(value => {
        if (abandoned) { void Promise.resolve().then(() => disposeLate(value)).catch(() => undefined); return; }
        finished = true;
        loader.stop();
        done({ kind: "connected", value });
      }, error => {
        if (abandoned) return;
        finished = true;
        loader.stop();
        done({ kind: "failed", error });
      });
      return {
        render: width => width > 0 ? [...loader.render(width), theme.fg("dim", truncateToWidth("Esc cancel", width, ""))] : [],
        handleInput: data => loader.handleInput(data),
        invalidate: () => loader.invalidate(),
        dispose: () => { abandon?.(); loader.dispose(); },
      };
    });
  } catch (error) { abandon?.(); throw error; }
  if (!outcome) { abandon?.(); return undefined; }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "connected" ? outcome.value : undefined;
}