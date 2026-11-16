import { lstatSync, realpathSync } from 'node:fs';

export function executableDiagnostic(path) {
    try {
        const info = lstatSync(path);
        return { path, canonical: realpathSync(path), symlink: info.isSymbolicLink(), mode: info.mode.toString(8), size: info.size };
    } catch (error) { return { path, error: error.code ?? error.message }; }
}

/** Observe immediately after spawn, before a short-lived fixture can close. */
export function observeOwnedProcess(child) {
    let stderr = '', error;
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(0, 2048); });
    child.on('error', value => { error = value.message; });
    const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    return {
        diagnostic: () => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, stderr, error }),
        async stop() {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            return await closed;
        },
    };
}
