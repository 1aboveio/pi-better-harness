import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Provider {
  id: string;
  getActivity(ctx: ExtensionContext): { items: Array<{ active: boolean }> } | Promise<{ items: Array<{ active: boolean }> }>;
  onActivityChanged?(changed: () => void): () => void;
}

/** Transfers must not leave session-owned background work behind on the source. */
export function observeLocalTransferWork(pi: ExtensionAPI) {
  const providers = new Map<string, Provider>();
  const off = new Map<string, () => void>();
  let ctx: ExtensionContext | undefined;
  let pending: Promise<void> | undefined;
  let revision = 0;
  let active = false;
  let disposed = false;
  const refresh = (): Promise<void> => {
    if (!ctx || disposed) return Promise.resolve();
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      let observed: number;
      do {
        observed = revision;
        let busy = false;
        for (const provider of providers.values()) {
          try { busy ||= (await provider.getActivity(ctx!)).items.some(item => item.active); }
          catch { busy = true; }
        }
        active = busy;
      } while (observed !== revision && !disposed);
    }).finally(() => { pending = undefined; });
    return pending;
  };
  const unsubscribe = pi.events.on("pi-better-goal:register-provider", value => {
    const provider = value as Partial<Provider> | undefined;
    if (!provider || typeof provider.id !== "string" || typeof provider.getActivity !== "function" || disposed) return;
    off.get(provider.id)?.();
    providers.set(provider.id, provider as Provider);
    if (provider.onActivityChanged) off.set(provider.id, provider.onActivityChanged(() => {
      revision++;
      void refresh();
    }));
    revision++;
    void refresh();
  });
  pi.events.emit("pi-better-goal:ready", {});
  pi.on("session_shutdown", () => {
    disposed = true;
    unsubscribe();
    for (const remove of off.values()) remove();
    off.clear();
  });
  return {
    busy: () => active || pending !== undefined,
    async check(context: ExtensionContext): Promise<void> {
      ctx = context;
      await refresh();
      if (active || disposed) throw new Error("Finish or stop session-owned background work before transferring this session");
    },
  };
}