/** Actual SDK recipient process for manager-kernel tests. Only the provider and
 * UI delivery failure are external test boundaries; transcript/extension stay real. */
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import extension from '../index.ts';
const config = JSON.parse(process.env.RECIPIENT_FIXTURE);
let failSend = false;
const settingsManager = SettingsManager.inMemory({ defaultProvider: 'recipient-fixture', defaultModel: 'model' });
const resourceLoader = new DefaultResourceLoader({ cwd: config.cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => extension({ ...pi, sendMessage(message, options) {
        if (failSend) throw new Error('fixture recipient delivery unavailable');
        const result = pi.sendMessage(message, options);
        process.send?.({ delivery: { message, options } });
        return result;
    } }), pi => pi.registerProvider('recipient-fixture', {
        api: 'openai-completions', apiKey: 'offline', baseUrl: 'https://example.invalid',
        models: [{ id: 'model', name: 'Recipient fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model) {
            const stream = createAssistantMessageEventStream();
            queueMicrotask(() => {
                const message = { role: 'assistant', content: [{ type: 'text', text: 'Notification received' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
                stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); stream.end();
            });
            return stream;
        },
    })] });
await resourceLoader.reload();
const manager = SessionManager.create(config.cwd, config.directory, { id: config.sessionId });
const { session } = await createAgentSession({ cwd: config.cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager, resourceLoader, sessionManager: manager, noTools: 'all' });
await session.setModel(session.extensionRunner.createContext().modelRegistry.find('recipient-fixture', 'model'));
initTheme(settingsManager.getTheme(), false);
await session.bindExtensions({ mode: 'tui', uiContext: { ...session.extensionRunner.getUIContext(), notify(msg, level) { process.send?.({ notice: { msg, level } }); } } });
process.send?.({ ready: true });
process.on('message', async command => {
    try {
        if (command.type === 'stop') {
            await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
            session.dispose(); process.disconnect(); return;
        }
        if (command.type === 'failure') failSend = command.value;
        process.send?.({ id: command.id, done: true });
    } catch (error) { process.send?.({ id: command.id, error: String(error) }); }
});
