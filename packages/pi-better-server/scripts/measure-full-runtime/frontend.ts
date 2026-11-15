import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import subagents from '../../../pi-better-subagents/index.ts';
import background from '../../../pi-better-background-tasks/src/index.ts';
const cwd = process.env.LAUNCH_WORKSPACE!, agentDir = process.env.PI_CODING_AGENT_DIR!;
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: [subagents, background] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: 'all' });
await session.bindExtensions({ mode: 'print', onError: error => { throw new Error(String(error)); } });
process.send?.({ ready: true, pid: process.pid, sessionId: session.sessionId });
process.on('message', async (request: any) => {
  try {
    if (request.stop) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); process.disconnect(); return; }
    const tool = session.extensionRunner.getToolDefinition(request.tool);
    if (!tool) throw new Error(`Missing real tool ${request.tool}`);
    const result = await tool.execute(request.key, request.params, undefined, undefined, session.extensionRunner.createContext());
    process.send?.({ id: request.id, result });
  } catch (error) { process.send?.({ id: request.id, error: String(error), stack: (error as Error).stack }); }
});
