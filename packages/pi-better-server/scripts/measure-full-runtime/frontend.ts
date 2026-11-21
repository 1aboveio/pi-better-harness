import { createAgentSession, initTheme, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import subagents from '../../../pi-better-subagents/index.ts';
import background from '../../../pi-better-background-tasks/src/index.ts';
import { getObservedWaitHost } from '../../../pi-better-background-tasks/src/observed-waits.ts';
let backgroundApi: any;
const capturedBackground = (pi: any) => { backgroundApi = pi; return background(pi); };
const cwd = process.env.LAUNCH_WORKSPACE!, agentDir = process.env.PI_CODING_AGENT_DIR!;
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true, extensionFactories: process.env.BACKGROUND_ONLY ? [capturedBackground] : [subagents, capturedBackground] });
await resourceLoader.reload();
const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader, sessionManager: process.env.BACKGROUND_SESSION_FILE ? SessionManager.open(process.env.BACKGROUND_SESSION_FILE) : SessionManager.inMemory(cwd), noTools: 'all' });
const testNavigator = process.env.BACKGROUND_TEST_NAVIGATOR === "1";
if (testNavigator) initTheme("dark", false);
await session.bindExtensions({ mode: testNavigator ? 'tui' : 'print',
  ...(testNavigator ? { uiContext: { ...session.extensionRunner.createContext().ui, setEditorComponent() {}, setWidget() {}, setStatus() {} } } : {}), onError: error => { throw new Error(String(error)); } });
process.send?.({ ready: true, pid: process.pid, sessionId: session.sessionId });
process.on('message', async (request: any) => {
  try {
    if (request.stop) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); process.disconnect(); return; }
    if(request.barrier){await getObservedWaitHost(backgroundApi)!.reconcileNow();process.send?.({id:request.id,result:{ready:true}});return;}
    if (request.navigatorRows) {
      const state = (globalThis as any)[Symbol.for("pi-better-harness.navigator.state")];
      process.send?.({ id: request.id, result: state.providers.get("background-tasks").listRows(Date.now()) });
      return;
    }
    if(request.entries){process.send?.({id:request.id,result:session.sessionManager.getBranch()});return;}
    const tool = session.extensionRunner.getToolDefinition(request.tool);
    if (!tool) throw new Error(`Missing real tool ${request.tool}`);
    const result = await tool.execute(request.key, request.params, undefined, undefined, session.extensionRunner.createContext());
    process.send?.({ id: request.id, result });
  } catch (error) { process.send?.({ id: request.id, error: String(error), stack: (error as Error).stack }); }
});
