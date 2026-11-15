import type { CatalogHost } from "./catalog-runtime.ts";
import type { CatalogSnapshot } from "./catalog-store.ts";
import type { RunMeta } from "./registry.ts";

/** Fixed server adapter port; never deserialized from a socket request. */
export interface ManagedLaunchPort {
    backgroundTools(): readonly string[];
    readonly owner: { pid: number; start?: string };
    readonly identity: { root: string; instance: string; epoch: number };
    continuationContext?(): import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
    dispatchContinuation?(park: import("./worker-waits.ts").ParkedWait, run: () => Promise<"resumed" | "held" | "skipped">): Promise<"resumed" | "held" | "skipped">;
    supervised(): RunMeta[];
    owns(meta: Partial<RunMeta>): boolean;
    assertCurrent(): void;
    capacity(countRunning: () => number): { readonly pending: number; tryReserve(count: number, cap: number): boolean; commit(count?: number): void; release(count?: number): void };
    snapshot(host: CatalogHost): Promise<CatalogSnapshot>;
    attempt(): string;
    beforeSpawn(input: { id: string; sessionId: string; lease: string; leasePath: string; preflightPath: string; policyPath?: string; permissions: unknown; recoveryMeta: RunMeta; recipe: NonNullable<RunMeta["recipe"]> }): Record<string, string>;
    spawned(id: string, pid: number): void;
}
