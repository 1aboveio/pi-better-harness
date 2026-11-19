export const queryPhase: Readonly<Record<"workerStart" | "dispatch" | "callerDeadline" | "replyReceived" | "fixtureReady"
  | "moduleEntered" | "modelImportBegin" | "modelImportEnd" | "modelConstructBegin" | "modelConstructEnd"
  | "handlerInstalled" | "queryReceived" | "handlerEntered" | "snapshotBegin" | "snapshotEnd"
  | "replyBegin" | "replyPosted" | "cancelReceived" | "fixtureHeld" | "releaseSent" | "fixtureReleased"
  | "bootstrapHandoff" | "inventoryBegin" | "inventoryEnd" | "watchBegin" | "watchEnd"
  | "checkpointBegin" | "checkpointEnd" | "backgroundBegin" | "backgroundEnd" | "sourceReady" | "watchdogFired", number>>;
export function recordQuerySample(buffer: SharedArrayBuffer | undefined, kind: "accepted" | "sent" | "consumed" | "response" | "watchdog" | "bootstrapSent" | "bootstrapConsumed"): void;
export function createQueryPhaseBuffer(): SharedArrayBuffer;
export function recordQueryPhase(buffer: SharedArrayBuffer | undefined, phase: number, id?: number, generation?: number): void;
export function readQueryPhases(buffer: SharedArrayBuffer): {
  capacity: number; total: number; dropped: number;
  samples: Record<string, { count: number; lastNs: string }>;
  records: Array<{ atNs: string; id: number; phase: string; generation: number }>;
};
