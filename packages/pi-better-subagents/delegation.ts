export type DelegationMode = "manual" | "adaptive" | "coordinator";

export const DELEGATION_MODE_REQUEST = "pi-better-subagents:delegation-mode-request";

export function isDelegationMode(value: unknown): value is DelegationMode {
    return value === "manual" || value === "adaptive" || value === "coordinator";
}

export function normalizeDelegationMode(value: unknown): DelegationMode {
    return isDelegationMode(value) ? value : "adaptive";
}

export function delegationPrompt(mode: DelegationMode): string {
    switch (mode) {
        case "manual":
            return "Delegation mode: manual. Do not proactively delegate work. Use subagents only when the user explicitly asks for delegation or an active workflow explicitly requires it. A structured plan or plan mode does not override this restriction; perform planned work in the foreground unless explicitly required otherwise.";
        case "coordinator":
            return "Delegation mode: coordinator. The foreground coordinates, integrates, and verifies. Call agents_catalog to discover current available roles and inspect their descriptions. Delegate every nontrivial task covered by an available role according to its current description; do not assume bundled roles are unchanged. Keep orchestration, cross-role decisions, unowned or ambiguous work, integration, and final verification in the foreground. Inspect results and failures before concluding; do not poll for running children.";
        case "adaptive":
            return "Delegation mode: adaptive. Delegate bounded, substantial independent work when a suitable subagent is available and useful; continue unblocked foreground work. Keep small, tightly coupled, or interactive work in the foreground. Inspect and integrate delegated results before final verification; do not poll.";
    }
}
