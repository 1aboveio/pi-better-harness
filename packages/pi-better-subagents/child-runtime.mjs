/** Verify the preflight module before CLI discovery can downgrade import errors.
 * Keep the selected Pi executable and its SDK (also supports executable test fixtures).
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import './child-preflight.mjs';
try {
  const [binary, ...args] = process.argv.slice(2);
  const entry = realpathSync(binary);
  process.argv = [process.execPath, entry, '--extension', fileURLToPath(new URL('./child-preflight.mjs', import.meta.url)), ...args];
  await import(pathToFileURL(entry).href);
} catch (error) {
  process.stderr.write(`Subagent bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
