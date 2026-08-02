// Generated from packages/render-scheduler/index.ts. Do not edit directly.
export interface RenderScheduler {
  request(): void;
  schedule(delayMs: number): void;
  cancel(): void;
  dispose(): void;
  pending(): boolean;
}

/**
 * Schedule TUI paints as replaceable one-shot deadlines. Callers reschedule
 * only while visible state still changes; static and hidden UI stays idle.
 */
export function createRenderScheduler(requestRender: () => void): RenderScheduler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  return {
    request() {
      if (disposed) return;
      cancel();
      requestRender();
    },
    schedule(delayMs: number) {
      if (disposed) return;
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) requestRender();
      }, Math.max(0, delayMs));
      timer.unref?.();
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
    },
    pending() {
      return timer !== undefined;
    },
  };
}