import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { readOwnBuild } from "./startup/artifact.ts";
import type { ServerBuild } from "./startup/managed-types.ts";
import { PROTOCOL_VERSION, type HelloCommand, type HelloData } from "./protocol.ts";

/** Kept equal to package.json `version`; a test pins that. */
export const SERVER_VERSION = "0.2.1";

export const SERVER_EXTENSION_VERSIONS: Readonly<Record<string, string>> = { "pi-better-server": SERVER_VERSION };

export interface HelloIdentity { build?: ServerBuild; instanceId?: string; safeUpgrade?: boolean }

export function serverHello(identity: HelloIdentity = {}): HelloData {
  const build = identity.build ?? readOwnBuild();
  return { protocolVersion: PROTOCOL_VERSION, piVersion: PI_VERSION, extensionVersions: { ...SERVER_EXTENSION_VERSIONS },
    ...(build ? { build } : {}), ...(identity.instanceId ? { instanceId: identity.instanceId } : {}),
    capabilities: ["native-client-v1", "package-sync-v1", "global-package-sync-v1", "session-browser-v1", "folder-browser-v1", "session-transfer-v1", "compressed-bundle-v1", "remote-reload-v1",
      ...(identity.safeUpgrade && build && identity.instanceId ? ["safe-upgrade-v1"] : [])] };
}

function majorMinor(version: string): string | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

/**
 * Decide whether a client may talk to this daemon. The wire protocol must match
 * exactly. Pi is 0.x, where a minor bump can change the RPC payloads, so Pi must
 * match by major.minor when the client states its version. Extension versions
 * are reported back but never cause a rejection.
 */
export function checkHello(command: Record<string, unknown>, identity: HelloIdentity = {}): { ok: true; data: HelloData } | { ok: false; error: string } {
  const server = serverHello(identity);
  const { protocolVersion, piVersion, extensionVersions } = command as Partial<HelloCommand>;
  if (typeof protocolVersion !== "number" || !Number.isInteger(protocolVersion)) {
    return { ok: false, error: `hello requires an integer protocolVersion; this daemon speaks protocol ${server.protocolVersion}` };
  }
  if (protocolVersion !== server.protocolVersion) {
    return {
      ok: false,
      error: `Protocol version mismatch: client speaks protocol ${protocolVersion}, daemon speaks protocol ${server.protocolVersion}. Update ${protocolVersion > server.protocolVersion ? "the daemon" : "the client"} so both match.`,
    };
  }
  if (piVersion !== undefined) {
    const client = typeof piVersion === "string" ? majorMinor(piVersion) : undefined;
    const daemon = majorMinor(server.piVersion);
    if (!client) return { ok: false, error: `hello piVersion is not a version string: ${JSON.stringify(piVersion)}` };
    if (daemon && client !== daemon) {
      return { ok: false, error: `Pi version mismatch: client runs pi ${piVersion}, daemon runs pi ${server.piVersion}. Both must be on the same major.minor.` };
    }
  }
  if (extensionVersions !== undefined) {
    const valid = typeof extensionVersions === "object" && extensionVersions !== null && !Array.isArray(extensionVersions) && Object.values(extensionVersions).every((v) => typeof v === "string");
    if (!valid) return { ok: false, error: "hello extensionVersions must be an object of version strings" };
  }
  return { ok: true, data: server };
}
