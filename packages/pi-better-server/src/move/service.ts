/**
 * Daemon side of `pi-remote move` for Pi: the shared MoveHost (core/move-host.ts)
 * wired to this daemon's session registry through the Pi adapter.
 */
import { MoveHost } from "../core/move-host.ts";
import { movesDirFor } from "../paths.ts";
import type { SessionRegistry } from "../registry.ts";
import { PiMoveAdapter } from "./pi-adapter.ts";

export type { CommitAck } from "../core/move-host.ts";

export class MoveService extends MoveHost {
  constructor(registry: SessionRegistry, serverDir: string) {
    super(new PiMoveAdapter(registry, serverDir), serverDir, movesDirFor(serverDir));
  }
}
