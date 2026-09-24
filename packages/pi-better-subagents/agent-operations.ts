/**
 * Registration seam for lifecycle. Do not wire this from index.ts in this unit.
 *
 * ```ts
 * const operations = createAgentOperations({
 *   projectConfigDirName: CONFIG_DIR_NAME,
 *   enrich: (input) => modelResolver.enrich(input),
 * });
 * operations.registerCommands(pi);
 * pi.registerTool(operations.createDiscoveryTool(Type));
 * const choice = await operations.resolveRoleAssignment(assignments, { hasUI: ctx.hasUI, select: ctx.ui.select });
 * if (choice.status === "clarification-needed") return choice; // no child
 * ```
 *
 * `enrich` belongs to the resolution unit. This package does not import
 * `model-resolution.ts`. Catalog validity is not launchability.
 */
import { agentsCatalogTool, type DiscoveryDeps } from "./agents-catalog-tool.ts";
import {
    executeAgentsCommand,
    registerAgentCommands,
    type AgentCommandDeps,
    type AgentCommandHost,
    type AgentCommandResult,
} from "./agent-commands.ts";
import { resolveRoleAssignment, type RoleAssignment, type RoleAssignmentDecision } from "./role-assignment.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface AgentOperationsDeps extends AgentCommandDeps, DiscoveryDeps {}

export interface AgentOperationsHandle {
    registerCommands(pi: Pick<ExtensionAPI, "registerCommand">): void;
    createDiscoveryTool(Type: Parameters<typeof agentsCatalogTool>[0]): ReturnType<typeof agentsCatalogTool>;
    executeCommand(args: string, host: AgentCommandHost): Promise<AgentCommandResult>;
    resolveRoleAssignment(
        assignments: readonly RoleAssignment[],
        ui: { hasUI: boolean; select?: (title: string, options: string[]) => Promise<string | undefined> },
    ): Promise<RoleAssignmentDecision>;
}

export function createAgentOperations(deps: AgentOperationsDeps = {}): AgentOperationsHandle {
    return {
        registerCommands(pi) {
            registerAgentCommands(pi, deps);
        },
        createDiscoveryTool(Type) {
            return agentsCatalogTool(Type, deps);
        },
        executeCommand(args, host) {
            return executeAgentsCommand(args, host, deps);
        },
        resolveRoleAssignment(assignments, ui) {
            return resolveRoleAssignment(assignments, ui);
        },
    };
}
