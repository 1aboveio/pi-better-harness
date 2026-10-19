import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Directory that owns the socket and the session index. Override for tests with PI_SERVER_DIR. */
export function defaultServerDir(): string {
  return process.env.PI_SERVER_DIR || join(getAgentDir(), "server");
}

/** sockaddr_un.sun_path is 104 bytes on macOS and 108 on Linux; leave room for the NUL. */
const MAX_SOCKET_PATH_BYTES = 103;

export function socketPathFor(serverDir: string): string {
  const path = join(serverDir, "pi-server.sock");
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`Socket path is too long for a unix socket (${Buffer.byteLength(path)} > ${MAX_SOCKET_PATH_BYTES} bytes): ${path}. Set PI_SERVER_DIR to a shorter directory.`);
  }
  return path;
}

export function indexPathFor(serverDir: string): string {
  return join(serverDir, "sessions.json");
}

/**
 * Create the server directory with mode 0700 and refuse a directory another
 * user owns. The directory permission is what keeps other local users away
 * from the socket, so a lax or foreign directory is an error, not a warning.
 */
export function ensureServerDir(serverDir: string): void {
  mkdirSync(serverDir, { recursive: true, mode: 0o700 });
  const info = statSync(serverDir);
  if (!info.isDirectory()) throw new Error(`${serverDir} is not a directory`);
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw new Error(`${serverDir} is owned by uid ${info.uid}, not the current user`);
  }
  if ((info.mode & 0o777) !== 0o700) chmodSync(serverDir, 0o700);
}

export function ownershipPathFor(serverDir: string): string {
  return join(serverDir, "ownership.json");
}

/** Scratch space for in-flight moves: exported and received bundles. */
export function movesDirFor(serverDir: string): string {
  return join(serverDir, "moves");
}

/** Where transcripts of sessions imported from another daemon live. */
export function importedDirFor(serverDir: string): string {
  return join(serverDir, "imported");
}
