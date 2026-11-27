import { realpathSync } from "node:fs";
import { join } from "node:path";
import { createWorkBudget } from "./work-budget.ts";
// @ts-expect-error Generated canonical coordinator.
import { openStore } from "./domain/coordinator/index.mjs";

// Query workers own their read connection. All main-thread mutation services
// share this connection, keeping mutations within the root's two-connection budget.
const stores = new Map<string, { store: any; leases: number; budget: ReturnType<typeof createWorkBudget> }>();

export function acquireMutationStore(root: string): { store: any; budget: ReturnType<typeof createWorkBudget>; release(): void } {
  const key = realpathSync(root);
  let entry = stores.get(key);
  if (!entry) {
    entry = { store: openStore({ path: join(key, "operation-coordinator.sqlite") }), leases: 0, budget: createWorkBudget() };
    stores.set(key, entry);
  }
  entry.leases++;
  const owned = entry;
  let released = false;
  return { store: owned.store, budget: owned.budget, release() {
    if (released) return;
    released = true;
    if (--owned.leases === 0) {
      stores.delete(key);
      owned.store.close();
    }
  } };
}

/** Main-thread connections only; read-worker connections are reported separately. */
export function mutationStoreMetrics(root: string): { active: number; leases: number } {
  const entry = stores.get(realpathSync(root));
  return { active: entry ? 1 : 0, leases: entry?.leases ?? 0 };
}
