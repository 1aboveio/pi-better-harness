import { join } from "node:path";

/** sockaddr_un.sun_path is 104 bytes on macOS; leave room for the NUL. */
export function socketPathFor(serverDir: string): string {
  const path = join(serverDir, "pi-server.sock");
  if (Buffer.byteLength(path) > 103) {
    throw new Error(`Socket path is too long for a unix socket (${Buffer.byteLength(path)} > 103 bytes): ${path}. Set PI_SERVER_DIR to a shorter directory.`);
  }
  return path;
}
