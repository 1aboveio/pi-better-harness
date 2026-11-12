export interface AssignmentProjection {
    state: "running" | "waiting" | "completed" | "failed" | "cancelled";
    revision: string;
    reason: string;
    processStatus: string;
    termination: string;
    attemptId: string;
    evidence: string[];
    verified: boolean;
}
export function assignmentFor(meta: object, processStatus?: string, options?: { baseDir?: string | undefined; coordinatorPath?: string; observation?: object }): AssignmentProjection;
export function projectAssignment(meta: object, processStatus: string, observation?: object): AssignmentProjection;
export function assignmentDiagnostic(assignment: AssignmentProjection): string;
export const ASSIGNMENT_STATES: string[];
