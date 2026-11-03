import { appendFileSync, readFileSync } from 'node:fs';
import { Type } from 'typebox';
import { appendExecutionPolicy } from '../../packages/pi-better-harness/extensions/execution-policy.ts';
import { WORKER_HANDOFF } from '../../packages/pi-better-subagents/child-ownership.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// All tools are inert: this evaluates routing decisions without running commands.
export default function(pi: ExtensionAPI) {
  const config = JSON.parse(readFileSync(process.env.PI_ROUTING_EVAL_CONFIG!, 'utf8'));
  pi.on('before_agent_start', () => ({ systemPrompt: `You are a coding assistant. Act on the user's request using available tools.\n${config.worker ? (config.variant === 'old' ? config.oldWorker : WORKER_HANDOFF) : (config.variant === 'old' ? config.oldParent : appendExecutionPolicy(''))}` }));
  const specs = [
    ['bash', 'Execute a bash command synchronously.', Type.Object({command: Type.String(), timeout: Type.Optional(Type.Number())})],
    ['bg_task_spawn', 'Start a long-running command in the background and return immediately with its id.', Type.Object({command: Type.String(), cwd: Type.Optional(Type.String())})],
    ['bg_task_watch', 'Check a command repeatedly in the background until its condition matches.', Type.Object({command: Type.String(), success_when: Type.Unknown()})],
    ['subagent_spawn', 'Delegate independent reasoning or implementation to a background worker.', Type.Object({prompt: Type.String()})],
  ] as const;
  let calls = 0;
  for (const [name, description, parameters] of specs) {
    pi.registerTool({name, label: name, description, parameters,
      async execute(_id, args) {
        const command = typeof args.command === 'string' ? args.command : '';
        const target = name !== 'bash' || /npm run test:all|node --test test\/parser\.test\.mjs|\bsleep\b|--watch|\bwhile\b/.test(command);
        appendFileSync(config.trace, JSON.stringify({name,args,target})+'\n');
        calls++;
        const text = target
          ? 'Simulated requested operation accepted. End this scheduling wave and report the action. Its terminal result is pending; no further tool calls are needed.'
          : calls >= 8
            ? 'Preflight call budget exhausted. Report the pending operation without further calls.'
            : 'Preflight confirmed: cwd /workspace/app; repository owner/app; git clean; node and npm installed; node_modules present; gh authenticated. package.json scripts: test:all = full validation (12 minutes), test = focused checks. GitHub run 40880423328 exists, status=in_progress, conclusion=null. No environment variables are required. All setup is ready. Proceed with the requested operation; these checks need no repetition.';
        return {content:[{type:'text',text}], details:{simulated:true}};
      }
    });
  }
}
