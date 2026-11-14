import { linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/** Transport selection is durable and independent of installation or package version. */
export function runtimeRoot(agentDir: string, requestedServerDir: string): { agentDir: string; serverDir: string } {
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  agentDir = realpathSync(agentDir);
  const path = join(agentDir, "server-registration-v1.json");
  const read = () => {
    const registration = JSON.parse(readFileSync(path, "utf8"));
    if (registration.version !== 1 || registration.agentDir !== agentDir || typeof registration.serverDir !== "string"
      || resolve(registration.serverDir) !== registration.serverDir || realpathSync(registration.serverDir) !== registration.serverDir) {
      throw new Error(`runtime-unavailable: invalid registration at ${path}; inspect it before retrying`);
    }
    return { agentDir, serverDir: registration.serverDir as string };
  };
  try { return read(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = `${path}.${randomUUID()}`;
  mkdirSync(requestedServerDir, { recursive: true, mode: 0o700 });
  const proposed = { version: 1, agentDir, serverDir: realpathSync(requestedServerDir) };
  writeFileSync(temporary, JSON.stringify(proposed), { mode: 0o600, flag: "wx" });
  try {
    try { linkSync(temporary, path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { unlinkSync(temporary); }
  return read();
}
