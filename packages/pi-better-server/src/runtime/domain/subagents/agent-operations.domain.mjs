// Generated fixed launch domain from packages/pi-better-subagents/agent-operations.ts. Do not edit directly.
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
import { agentsCatalogTool } from "./agents-catalog-tool.domain.mjs";
import { executeAgentsCommand, executeAgentsCommandContext, registerAgentCommands, } from "./agent-commands.domain.mjs";
import { resolveRoleAssignment } from "./role-assignment.domain.mjs";
export function createAgentOperations(deps = {}) {
    return {
        async openCatalog(ctx) {
            await executeAgentsCommandContext("", ctx, deps);
        },
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
