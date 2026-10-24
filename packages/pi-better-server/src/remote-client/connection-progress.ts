import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader, truncateToWidth } from "@earendil-works/pi-tui";

export interface ConnectionProgress {
  signal: AbortSignal;
  stage(message: string): void;
  /** SSH is up. Later stages are work on the remote, not the connection itself. */
  sshConnected(): void;
}

type Outcome<T> = { kind: "connected"; value: T } | { kind: "failed"; error: unknown } | { kind: "cancelled" };

interface StageRecord {
  message: string;
  startedAt: number;
  durationMs?: number;
}

/** Compact durations: one decimal under ten seconds, whole seconds after that. */
export function formatStageDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

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
      const startedAt = Date.now();
      const stages: StageRecord[] = [];
      const loader = new CancellableLoader(tui, text => theme.fg("accent", text), text => theme.fg("muted", text), `Connecting to ${host}: preparing...`);
      let finished = false;
      let abandoned = false;
      let sshReady = false;
      const prefix = () => sshReady ? "Remote" : `Connecting to ${host}`;
      const paint = (message: string, started = Date.now()) => {
        loader.setMessage(`${prefix()}: ${message} · ${formatStageDuration(Date.now() - started)}`);
      };
      // Elapsed labels tick even when the current stage produces no new messages.
      const ticker = setInterval(() => {
        if (finished) return;
        const current = stages.at(-1);
        if (current) paint(current.message, current.startedAt);
        tui.requestRender();
      }, 500);
      const stage = (message: string) => {
        if (finished) return;
        const current = stages.at(-1);
        if (current?.message === message) return;
        if (current) current.durationMs = Date.now() - current.startedAt;
        stages.push({ message, startedAt: Date.now() });
        if (!finished) loader.setMessage(`${prefix()}: ${message}`);
        tui.requestRender();
      };
      const sshConnected = () => {
        if (finished || sshReady) return;
        sshReady = true;
        const current = stages.at(-1);
        if (current) loader.setMessage(`${prefix()}: ${current.message}`);
        tui.requestRender();
      };
      const stop = () => {
        clearInterval(ticker);
        loader.stop();
      };
      abandon = () => {
        if (finished) return;
        finished = true;
        abandoned = true;
        controller.abort();
        stop();
      };
      loader.onAbort = () => { if (!finished) { abandon!(); done({ kind: "cancelled" }); } };
      void Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return connect({ signal: controller.signal, stage, sshConnected });
      }).then(value => {
        if (abandoned) { void Promise.resolve().then(() => disposeLate(value)).catch(() => undefined); return; }
        finished = true;
        stop();
        done({ kind: "connected", value });
      }, error => {
        if (abandoned) return;
        finished = true;
        stop();
        done({ kind: "failed", error });
      });
      return {
        render: width => {
          if (width <= 0) return [];
          const fit = (text: string) => truncateToWidth(text, width, "...");
          const now = Date.now();
          const history = stages.slice(0, -1).map(doneStage =>
            theme.fg("muted", fit(`  ✓ ${doneStage.message} ${formatStageDuration(doneStage.durationMs ?? now - doneStage.startedAt)}`)));
          const connected = sshReady ? [theme.fg("accent", fit(`Connected to ${host}`))] : [];
          const elapsed = theme.fg("dim", fit(`Esc cancel · ${formatStageDuration(now - startedAt)}`));
          return [...history, ...connected, ...loader.render(width), elapsed];
        },
        handleInput: data => loader.handleInput(data),
        invalidate: () => loader.invalidate(),
        dispose: () => { clearInterval(ticker); abandon?.(); loader.dispose(); },
      };
    });
  } catch (error) { abandon?.(); throw error; }
  if (!outcome) { abandon?.(); return undefined; }
  if (outcome.kind === "failed") throw outcome.error;
  return outcome.kind === "connected" ? outcome.value : undefined;
}
