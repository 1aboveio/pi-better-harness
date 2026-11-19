import { queryPhase, recordQueryPhase } from "../../src/runtime/query-phase-diagnostics.mjs";

// Temporary first-initialization observations, enabled only by the three CI fixtures.
export function traceInitialInventory(Model, data) {
  if (!data.queryPhaseDiagnostics) return;
  const trace = phase => recordQueryPhase(data.queryPhaseDiagnostics, phase, 0, data.queryPhaseGeneration);
  const reconcile = Model.prototype.reconcile;
  let first = true;
  Model.prototype.reconcile = function(...args) {
    if (!first) return reconcile.apply(this, args);
    first = false;
    const observe = (owner, name, begin, end) => {
      const original = owner[name];
      let initial = true;
      owner[name] = function(...values) {
        if (!initial) return original.apply(this, values);
        initial = false; trace(begin);
        const result = original.apply(this, values);
        if (result?.then) void result.then(() => trace(end), () => trace(end));
        else trace(end);
        return result;
      };
    };
    observe(this, "watchRegistrations", queryPhase.watchBegin, queryPhase.watchEnd);
    observe(this.checkpoints, "initialize", queryPhase.checkpointBegin, queryPhase.checkpointEnd);
    observe(this.background, "initialize", queryPhase.backgroundBegin, queryPhase.backgroundEnd);
    trace(queryPhase.inventoryBegin);
    const result = reconcile.apply(this, args);
    void result.then(() => trace(queryPhase.inventoryEnd), () => trace(queryPhase.inventoryEnd));
    return result;
  };
}
