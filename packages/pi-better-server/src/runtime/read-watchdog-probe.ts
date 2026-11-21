// Fixed labels only: the watchdog log must not include request or source data.
export const executionPhases = ["starting", "idle", "snapshot", "request", "publish"] as const;
export const inventoryPhases = ["idle", "background", "metadata", "coordinator", "log-stats", "projection", "verify", "commit"] as const;
export type InventoryPhase = typeof inventoryPhases[number];