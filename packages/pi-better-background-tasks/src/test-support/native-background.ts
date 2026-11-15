import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import extension from '../index.js';

/** Real native SDK registration, session identity and transcript. The daemon is
 * supplied by startWorkRuntime; this helper never creates a mechanical runtime. */
export async function nativeBackground(options: { cwd?: string; sessionId?: string; decorate?: (api: any) => any } = {}) {
  const cwd = options.cwd ?? process.cwd();
  const directory = mkdtempSync(join(tmpdir(), 'bg-native-'));
  const tools = new Map<string, any>();
  let pi: any;
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [api => {
      const decorated = options.decorate?.(api) ?? api;
      pi = new Proxy(decorated, { get(target, key) {
        if (key === 'registerTool') return (tool: any) => { tools.set(tool.name, tool); target.registerTool(tool); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      extension(pi);
    }] });
  await resourceLoader.reload();
  const manager = SessionManager.create(cwd, directory, options.sessionId ? { id: options.sessionId } : undefined);
  const { session } = await createAgentSession({ cwd, agentDir: process.env.PI_CODING_AGENT_DIR!, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all' });
  await session.bindExtensions({ mode: 'print' });
  return { pi, session, manager, tools,
    async execute(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool not registered: ${name}`);
      const result = await tool.execute(randomUUID(), params, new AbortController().signal, undefined, session.extensionRunner!.createContext());
      return result.content.map((part: any) => part.text).join('\n');
    },
    async close() {
      await session.abort();
      await session.extensionRunner!.emit({ type: 'session_shutdown', reason: 'quit' });
      session.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
