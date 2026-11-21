// Generated fixed launch domain from packages/pi-better-subagents/child-preflight.mjs. Do not edit directly.
/** Mandatory child check. Hook errors alone are nonfatal in Pi, so explicitly exit on failure. */
import { readFileSync } from 'node:fs';
import { checkChildPreflight } from './child-dependencies.mjs';
export const PREFLIGHT_ENV = 'PI_SUBAGENT_PREFLIGHT';
export default function childPreflight(pi) {
    const fail = error => {
        process.stderr.write(`Subagent child preflight failed: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    };
    let plan;
    try {
        plan = JSON.parse(readFileSync(process.env[PREFLIGHT_ENV], 'utf8'));
    }
    catch (error) {
        fail(error);
    }
    const reported = new Set();
    // The task guard activates its adapters on session_start. Check after every
    // startup handler has finished, before the first request (and subsequent runs).
    const check = async (ctx, tools) => {
        try {
            const inactive = await checkChildPreflight({ ...plan, tools }, { registry: ctx.modelRegistry,
                tools: pi.getActiveTools(), registeredTools: pi.getAllTools?.().map(tool => tool.name), model: ctx.model });
            const newlyInactive = inactive.filter(tool => !reported.has(tool));
            if (newlyInactive.length) {
                for (const tool of newlyInactive)
                    reported.add(tool);
                process.stderr.write(`Subagent child preflight: inherited trusted tools are inactive in this child: ${newlyInactive.join(', ')}. Continuing without them.\n`);
            }
        }
        catch (error) {
            fail(error);
        }
    };
    pi.on('session_start', async (_event, ctx) => check(ctx, []));
    pi.on('before_agent_start', async (_event, ctx) => check(ctx, plan.tools));
}
