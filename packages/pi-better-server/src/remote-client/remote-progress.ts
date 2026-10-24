import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, truncateToWidth } from "@earendil-works/pi-tui";
import { formatStageDuration } from "./connection-progress.ts";

type Outcome<T> = { value: T } | { error: unknown } | undefined;

/** Read cancellation dismisses the wait, not the RPC. Writes keep their progress visible until settled. */
export async function showRemoteProgress<T>(
  ui: Pick<ExtensionUIContext, "custom">,
  host: string,
  message: string,
  run: () => Promise<T>,
  options: { cancellable?: boolean } = {},
): Promise<{ value: T } | undefined> {
  const cancellable = options.cancellable !== false;
  const result = await ui.custom<Outcome<T>>((tui, theme, _keys, done) => {
    let disposed = false;
    const startedAt = Date.now();
    const safeMessage = `${host}: ${message}`.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
    const loader = new CancellableLoader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), safeMessage);
    // Keep the wait visibly alive: the elapsed label ticks even when nothing else changes.
    const ticker = setInterval(() => {
      if (disposed) return;
      loader.setMessage(`${safeMessage} · ${formatStageDuration(Date.now() - startedAt)}`);
      tui.requestRender();
    }, 500);
    const finish = (value: Outcome<T>) => {
      if (disposed) return;
      disposed = true;
      clearInterval(ticker);
      loader.stop();
      done(value);
    };
    loader.onAbort = () => { if (cancellable) finish(undefined); };
    void Promise.resolve().then(() => disposed ? undefined : run()).then(
      value => { if (!disposed) finish({ value: value as T }); },
      error => finish({ error }),
    );
    return {
      render: width => width > 0 ? [...loader.render(width), theme.fg("dim", truncateToWidth(cancellable ? "Esc cancel" : "Waiting for the remote operation to finish", width, ""))] : [],
      handleInput: data => { if (cancellable) loader.handleInput(data); },
      invalidate: () => loader.invalidate(),
      dispose: () => { disposed = true; clearInterval(ticker); loader.dispose(); },
    };
  });
  if (result && "error" in result) throw result.error;
  return result;
}