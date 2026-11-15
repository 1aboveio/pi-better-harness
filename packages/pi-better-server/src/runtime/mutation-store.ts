import { realpathSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error Generated canonical coordinator.
import { openStore } from "./domain/coordinator/index.mjs";

// Query workers own their read connection. All main-thread mutation services
// share this connection, keeping mutations within the root's two-connection budget.
const stores = new Map<string, { store: any; leases: number }>();

export function acquireMutationStore(root: string): { store: any; release(): void } {
  const key = realpathSync(root);
  let entry = stores.get(key);
  if (!entry) {
    entry = { store: openStore({ path: join(key, "operation-coordinator.sqlite") }), leases: 0 };
    stores.set(key, entry);
  }
  entry.leases++;
  const owned = entry;
  let released = false;
  return { store: owned.store, release() {
    if (released) return;
    released = true;
    if (--owned.leases === 0) {
      stores.delete(key);
      owned.store.close();
    }
  } };
}
