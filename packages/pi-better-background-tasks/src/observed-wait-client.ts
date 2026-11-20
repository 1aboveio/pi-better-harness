import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ObservedWaitHost } from "./observed-waits.js";

const hosts = new WeakMap<object, ObservedWaitHost>();

export function registerObservedWaitClient(pi: ExtensionAPI, host: ObservedWaitHost): void { hosts.set(pi as object, host); }

export function getObservedWaitHost(pi: unknown): ObservedWaitHost | undefined {
  return pi && typeof pi === "object" ? hosts.get(pi as object) : undefined;
}
