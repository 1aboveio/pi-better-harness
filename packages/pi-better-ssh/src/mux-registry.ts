import { createSshMuxController } from "./shared-ssh-core/index.js";
import type {
  RemoteRunner,
  ResolvedSshCommand,
  SshMuxCleanupResult,
  SshMuxController,
  SshMuxStatus,
} from "./shared-ssh-core/index.js";

const GLOBAL_MUX_ENTRIES = Symbol.for("pi-better-ssh.mux-entries.v1");

export interface KnownSshMuxEntry {
  sessionScope: string;
  resolved: ResolvedSshCommand;
}

export type SshMuxEntryMap = Map<string, KnownSshMuxEntry>;

export interface SshMuxRegistry {
  controllerFor(resolved: ResolvedSshCommand, sessionScope: string): SshMuxController;
  statusTarget(resolved: ResolvedSshCommand, sessionScope: string): Promise<SshMuxStatus>;
  stopTarget(resolved: ResolvedSshCommand, sessionScope: string): Promise<SshMuxCleanupResult>;
  statusAll(sessionScope: string): Promise<SshMuxStatus[]>;
  stopAll(sessionScope: string): Promise<SshMuxCleanupResult[]>;
}

export function createSshMuxRegistry(options: {
  runner: RemoteRunner;
  controlPathRoot?: string;
  entries?: SshMuxEntryMap;
}): SshMuxRegistry {
  const entries = options.entries ?? processMuxEntries();

  const makeController = (resolved: ResolvedSshCommand, sessionScope: string): SshMuxController =>
    createSshMuxController({
      ...resolved,
      runner: options.runner,
      sessionScope,
      ...(options.controlPathRoot ? { controlPathRoot: options.controlPathRoot } : {}),
    });

  const controllerFor = (resolved: ResolvedSshCommand, sessionScope: string): SshMuxController => {
    const controller = makeController(resolved, sessionScope);
    entries.set(controller.controlPath, { sessionScope, resolved });
    return controller;
  };

  const knownForSession = (sessionScope: string): Array<[string, KnownSshMuxEntry]> =>
    [...entries].filter(([, entry]) => entry.sessionScope === sessionScope);

  return {
    controllerFor,
    statusTarget: (resolved, sessionScope) => controllerFor(resolved, sessionScope).status(),
    stopTarget: async (resolved, sessionScope) => {
      const controller = controllerFor(resolved, sessionScope);
      try {
        return await controller.cleanup();
      } finally {
        entries.delete(controller.controlPath);
      }
    },
    statusAll: async (sessionScope) => {
      const statuses: SshMuxStatus[] = [];
      for (const [, entry] of knownForSession(sessionScope)) {
        statuses.push(await makeController(entry.resolved, sessionScope).status());
      }
      return statuses;
    },
    stopAll: async (sessionScope) => {
      const results: SshMuxCleanupResult[] = [];
      for (const [controlPath, entry] of knownForSession(sessionScope)) {
        try {
          results.push(await makeController(entry.resolved, sessionScope).cleanup());
        } finally {
          entries.delete(controlPath);
        }
      }
      return results;
    },
  };
}

function processMuxEntries(): SshMuxEntryMap {
  const globalState = globalThis as typeof globalThis & { [GLOBAL_MUX_ENTRIES]?: SshMuxEntryMap };
  return globalState[GLOBAL_MUX_ENTRIES] ??= new Map();
}
