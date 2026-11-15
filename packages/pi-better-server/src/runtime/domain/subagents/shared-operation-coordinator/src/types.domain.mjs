// Generated fixed launch domain from packages/pi-better-subagents/shared-operation-coordinator/src/types.ts. Do not edit directly.
// Generated from packages/operation-coordinator/src/types.ts. Do not edit directly.
/**
 * Public record and call shapes for the durable operation coordinator.
 *
 * The store owns dependency records, phase transitions, resume claims, evidence
 * pins and the result outbox. It owns no provider transport, no tool execution,
 * no model call and no permission decision. Callers keep launch authority,
 * continuation admission and interpretation of the evidence.
 *
 * Identity rules that the API itself enforces:
 *
 * - an operation's owner, task id and launch token are immutable after
 *   registration; a different caller writing a terminal outcome is refused;
 * - a wait belongs to exactly one owner identity, and only that owner may cancel
 *   it or acknowledge its evidence;
 * - one owner identity holds at most one pending wait generation, and every
 *   mutation names the generation it acts on;
 * - a resume attempt id and launch token are persisted before the attempt is
 *   spawned, so a crash is reconciled instead of relaunched.
 */
/** Schema version this build writes and accepts. Any other version is refused. */
export const SCHEMA_VERSION = 4;
/** Phases that no longer accept automatic continuation. */
export const TERMINAL_WAIT_PHASES = ["consumed", "cancelled"];
