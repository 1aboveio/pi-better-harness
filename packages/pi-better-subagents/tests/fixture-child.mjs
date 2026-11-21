const closedChannel = error => ["EPIPE", "ECONNRESET", "ERR_IPC_CHANNEL_CLOSED"].includes(error?.code);
const observations = new WeakMap();

/** Capture the first failure while stderr is still open, not just at teardown. */
export function observeFixtureChild(child) {
    if (observations.has(child)) return observations.get(child);
    const observation = { pid: child.pid, stderr: "", exitCode: child.exitCode, signal: child.signalCode };
    child.stderr?.on("data", bytes => { observation.stderr = (observation.stderr + bytes).slice(0, 65536); });
    child.once("exit", (code, signal) => { observation.exitCode = code; observation.signal = signal; });
    observations.set(child, observation);
    return observation;
}

/** Wait for this exact fixture child, including the disconnect-before-exit gap. */
export async function stopFixtureChild(child, message = "stop") {
    const observation = observeFixtureChild(child);
    const exitError = (code, signal) => code !== 0 ? Object.assign(new Error(`Fixture child ${child.pid} exited (${signal ?? code}): ${observation.stderr}`), { fixture: { ...observation } }) : undefined;
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
