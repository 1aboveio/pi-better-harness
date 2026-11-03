/** Validate preflight before CLI discovery can downgrade import errors, then
 * execute the selected launcher with its own interpreter and SDK.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './child-preflight.mjs';

try {
  const [binary, ...args] = process.argv.slice(2);
  const launcherArgs = ['--extension', fileURLToPath(new URL('./child-preflight.mjs', import.meta.url)), ...args];
  if (process.platform !== 'win32' && typeof process.execve === 'function') {
    // execve does not search PATH. Resolve only executable files; let spawn
    // report lookup errors below rather than invoking Node's fatal execve error.
    const candidates = binary.includes('/') ? [binary]
      : (process.env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(dir, binary));
    const executable = candidates.find(candidate => {
      try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); }
      catch { return false; }
    });
    if (executable) {
      // Replace the bootstrap so the recorded launch PID is the launcher's PID.
      // The executable retains its own shebang/interpreter and exact arguments.
      process.execve(resolve(executable), [binary, ...launcherArgs], process.env);
    }
  }
  // Older Node/platforms retain supervision and signal forwarding. Stay in the
  // bootstrap's process group so group termination reaches all descendants.
  const child = spawn(binary, launcherArgs, {
    stdio: 'inherit', env: process.env, detached: false,
  });
  const forwards = new Map(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].map(signal => {
    const forward = () => child.kill(signal);
    process.on(signal, forward);
    return [signal, forward];
  }));
  const cleanup = () => {
    for (const [signal, forward] of forwards) process.off(signal, forward);
    process.off('exit', stopChild);
  };
  const stopChild = () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
  process.on('exit', stopChild);
  child.on('error', error => {
    cleanup();
    process.stderr.write(`Subagent bootstrap failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
} catch (error) {
  process.stderr.write(`Subagent bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
