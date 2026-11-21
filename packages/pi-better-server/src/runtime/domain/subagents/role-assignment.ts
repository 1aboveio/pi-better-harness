/**
 * One run gets one role. Two roles ask the user to choose one or split the
 * work. This helper never launches a child and never writes a definition.
 * Lifecycle calls it before spawn; headless callers receive clarification-needed.
 */

export interface RoleAssignment {
    /** Omit when every assignment belongs to the same run. */
    jobId?: string;
    roleId: string;
}

export interface RoleAssignmentDecision {
    status: "resolved" | "clarification-needed";
    /** Always false. Role choice is not a launch. */
    launched: false;
    /** Always false. Role choice is not a catalog write. */
    wrote: false;
    /** Always false. Multiple base roles are not produced. */
    multipleParents: false;
    jobs: { jobId: string; roleId: string }[];
    message: string;
    choices: string[];
}

export interface RoleChoiceUi {
    select(title: string, options: string[]): Promise<string | undefined>;
}

const IMPLICIT_JOB = "run";

export function assessRoleAssignment(assignments: readonly RoleAssignment[]): RoleAssignmentDecision {
    if (assignments.length === 0) {
        return decision("clarification-needed", [], "Pass a role id. Nothing was launched or written.");
    }
    const grouped = new Map<string, string[]>();
    for (const assignment of assignments) {
        const roleId = assignment.roleId.trim();
        if (!roleId) {
            return decision("clarification-needed", [], "A role assignment was empty. Choose one role id. Nothing was launched or written.");
        }
        const jobId = assignment.jobId?.trim() || IMPLICIT_JOB;
        const roles = grouped.get(jobId) ?? [];
        if (!roles.includes(roleId)) roles.push(roleId);
        grouped.set(jobId, roles);
    }
    const ambiguous = [...grouped.entries()].filter(([, roles]) => roles.length > 1);
    if (ambiguous.length === 0) {
        const jobs = [...grouped.entries()].map(([jobId, roles]) => ({ jobId, roleId: roles[0]! }));
        return decision("resolved", jobs, `Each run has one role: ${jobs.map((job) => `${job.jobId}=${job.roleId}`).join(", ")}. Nothing was launched or written.`);
    }
    const choices: string[] = [];
    for (const [, roles] of ambiguous) {
        for (const roleId of roles) choices.push(`Choose ${roleId}`);
        choices.push(`Split into ${roles.length} runs`);
    }
    const described = ambiguous.map(([jobId, roles]) => `${jobId} names ${roles.join(" and ")}`).join("; ");
    return decision(
        "clarification-needed",
        [],
        `${described}. A run has one base role, not multiple parents. Choose one role or split the work into separate runs. Nothing was launched or written.`,
        choices,
    );
}

export async function resolveRoleAssignment(
    assignments: readonly RoleAssignment[],
    ui: { hasUI: boolean; select?: RoleChoiceUi["select"] },
): Promise<RoleAssignmentDecision> {
    const assessed = assessRoleAssignment(assignments);
    if (assessed.status === "resolved") return assessed;
    if (!ui.hasUI || !ui.select) {
        return {
            ...assessed,
            message: `${assessed.message} UI is unavailable, so the choice was not made. Re-run in the TUI or RPC UI and choose one role or split. No launch and no write.`,
        };
    }
    const groups = groupRoles(assignments);
    const ambiguous = [...groups.entries()].filter(([, roles]) => roles.length > 1);
    if (ambiguous.length === 0) return assessed;
    const pieces = new Map<string, { jobId: string; roleId: string }[]>();
    for (const [jobId, roles] of ambiguous) {
        const choices = [...roles.map((roleId) => `Choose ${roleId}`), `Split into ${roles.length} runs`];
        const selected = await ui.select(
            ambiguous.length === 1 ? "This request assigns more than one role" : `Run ${jobId} assigns more than one role`,
            choices,
        );
        if (!selected) {
            return decision("clarification-needed", [], "The role choice was dismissed. Nothing was launched or written.", assessed.choices);
        }
        if (selected === `Split into ${roles.length} runs`) {
            pieces.set(jobId, roles.map((roleId, index) => ({ jobId: `${jobId}#${index + 1}`, roleId })));
            continue;
        }
        const roleId = selected.startsWith("Choose ") ? selected.slice("Choose ".length) : undefined;
        if (!roleId || !roles.includes(roleId)) {
            return decision("clarification-needed", [], `Unknown choice ${JSON.stringify(selected)}. Nothing was launched or written.`, choices);
        }
        pieces.set(jobId, [{ jobId, roleId }]);
    }
    const jobs = [...groups.entries()].flatMap(([jobId, roles]) => {
        if (roles.length <= 1) return [{ jobId, roleId: roles[0]! }];
        return pieces.get(jobId) ?? [];
    });
    const single = ambiguous.length === 1 ? pieces.get(ambiguous[0]![0]) : undefined;
    const message = single && single.length > 1
        ? `Split chosen. These are separate runs, not multiple parents: ${jobs.map((job) => `${job.jobId}=${job.roleId}`).join(", ")}. Nothing was launched or written by this check.`
        : single && single.length === 1
            ? `Chose ${single[0]!.roleId}. Nothing was launched or written by this check.`
            : `Each ambiguous run was resolved on its own: ${jobs.map((job) => `${job.jobId}=${job.roleId}`).join(", ")}. One run's choice was not applied to another. Nothing was launched or written by this check.`;
    return decision("resolved", jobs, message, assessed.choices);
}

function groupRoles(assignments: readonly RoleAssignment[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const assignment of assignments) {
        const jobId = assignment.jobId?.trim() || IMPLICIT_JOB;
        const roleId = assignment.roleId.trim();
        const roles = grouped.get(jobId) ?? [];
        if (roleId && !roles.includes(roleId)) roles.push(roleId);
        grouped.set(jobId, roles);
    }
    return grouped;
}

function decision(
    status: RoleAssignmentDecision["status"],
    jobs: RoleAssignmentDecision["jobs"],
    message: string,
    choices: string[] = [],
): RoleAssignmentDecision {
    return {
        status,
        launched: false,
        wrote: false,
        multipleParents: false,
        jobs,
        message,
        choices,
    };
}
