const closedChannel = error => ["EPIPE", "ECONNRESET", "ERR_IPC_CHANNEL_CLOSED"].includes(error?.code);

/** Wait for this exact fixture child, including the disconnect-before-exit gap. */
export async function stopFixtureChild(child, message = "stop") {
    const exitError = (code, signal) => code !== 0 ? new Error(`Fixture child ${child.pid} exited (${signal ?? code})`) : undefined;
    if (child.exitCode !== null || child.signalCode !== null) {
        const error = exitError(child.exitCode, child.signalCode);
        if (error) throw error;
        return;
    }
    await new Promise((resolve, reject) => {
        let sendError;
        const finish = () => {
            clearTimeout(timer);
            child.off("exit", onExit);
            child.off("error", onError);
        };
        const onExit = (code, signal) => {
            finish();
            const error = sendError ?? exitError(code, signal);
            error ? reject(error) : resolve();
        };
        const onError = error => {
            // A closed pipe is not proof of exit. Still await the child's exit.
            if (!closedChannel(error)) sendError ??= error;
        };
        const timer = setTimeout(() => {
            finish();
            reject(new Error(`Fixture child ${child.pid} did not exit after shutdown${sendError ? `: ${sendError.message}` : ""}`));
        }, 5000);
        child.once("exit", onExit);
        child.on("error", onError);
        if (child.connected) {
            try { child.send(message, error => { if (error) onError(error); }); }
            catch (error) { onError(error); }
        }
    });
}
