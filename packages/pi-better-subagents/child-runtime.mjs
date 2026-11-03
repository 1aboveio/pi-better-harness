/** Validate preflight before CLI discovery can downgrade import errors, then
 * execute the selected launcher with its own interpreter and SDK.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import './child-preflight.mjs';

try {
  const [binary, ...args] = process.argv.slice(2);
  // Stay in the bootstrap's process group so harness group termination reaches
  // the launcher and its descendants. Keep this child referenced until it exits.
  const child = spawn(binary, ['--extension', fileURLToPath(new URL('./child-preflight.mjs', import.meta.url)), ...args], {
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
