// Generated fixed launch domain from packages/pi-better-background-tasks/src/shared-render-scheduler.ts. Do not edit directly.
/**
 * Schedule TUI paints as replaceable one-shot deadlines. Callers reschedule
 * only while visible state still changes; static and hidden UI stays idle.
 */
export function createRenderScheduler(requestRender) {
    let timer;
    let disposed = false;
    const cancel = () => {
        if (timer)
            clearTimeout(timer);
        timer = undefined;
    };
    return {
        request() {
            if (disposed)
                return;
            cancel();
            requestRender();
        },
        schedule(delayMs) {
            if (disposed)
                return;
            cancel();
            timer = setTimeout(() => {
                timer = undefined;
                if (!disposed)
                    requestRender();
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
