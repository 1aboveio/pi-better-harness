// Generated canonical read-only process observation.
/** Cheap liveness probe via signal 0. */
export function processExists(pid) {
    if (typeof pid !== "number" || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
/**
 * Reconcile the recorded status with reality for display. A run marked
 * "running" whose PID is no longer alive exited without our handler firing
 * (foreground pi was closed / restarted) — surface that as "exited".
 */
export function effectiveStatus(meta) {
    if (meta.status !== "running")
        return meta.status;
    if (processExists(meta.pid))
        return "running";
    return "exited";
}
