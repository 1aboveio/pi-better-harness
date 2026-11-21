/** Offline resource fixture: commands invoke the actual hosted extension tools. */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import background from '../../../pi-better-background-tasks/src/index.ts';
import subagents from '../../../pi-better-subagents/index.ts';
import { join } from 'node:path';
export default function hostedResourceFixture(pi: ExtensionAPI) {
  const tools = new Map<string, any>();
  const capture = { ...pi, registerTool(tool: any) { tools.set(tool.name, tool); pi.registerTool(tool); } };
  background(capture); subagents(capture);
  pi.registerProvider('openai', {
    baseUrl: 'https://example.invalid', apiKey: 'offline', api: 'openai-completions',
    models: [{ id: 'gpt-4.1', name: 'Offline recipient', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message: any = { role: 'assistant', content: [{ type: 'text', text: 'Received exact hosted result' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end();
      }); return stream;
    },
  });
  pi.registerCommand('resource_background', { description: 'Launch the real hosted Background resource fixture', handler: async (_args, ctx) => {
    const marker = join(ctx.cwd, 'remote-command-pid'), finish = join(ctx.cwd, 'finish');
    const result = await tools.get('bg_task_spawn').execute('remote-resource-spawn', { shell: false, callback: true,
      argv: [process.execPath, '-e', `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(t);console.log('remote-resource-done')}},50)`] }, undefined, undefined, ctx);
    pi.sendMessage({ customType: 'remote-resource-proof', content: 'Hosted Background admitted', details: result.details, display: false }, { triggerTurn: true });
  } });
}
