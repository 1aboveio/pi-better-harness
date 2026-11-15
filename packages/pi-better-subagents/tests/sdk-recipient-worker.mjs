/** Actual SDK recipient process for manager-kernel tests. Only the provider and
 * UI delivery failure are external test boundaries; transcript/extension stay real. */
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, initTheme } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import extension from '../index.ts';
import { renderRegisteredWorkDetail } from '../shared-navigator.ts';
import { getCallbackBatcher } from '../shared-callback-batcher.ts';
let extensionApi;
let deliverySequence = 0;
const approvals = new Map();
const config = JSON.parse(process.env.RECIPIENT_FIXTURE);
let failSend = false;
let providerRelease;
let providerHold;
let foregroundPrompt;
const settingsManager = SettingsManager.inMemory({ defaultProvider: 'recipient-fixture', defaultModel: 'model' });
const resourceLoader = new DefaultResourceLoader({ cwd: config.cwd, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => { extensionApi = { ...pi, async sendMessage(message, options) {
        if (config.preflight) {
            const id = ++deliverySequence;
            const decision = new Promise((resolve, reject) => approvals.set(id, { resolve, reject }));
            process.send?.({ sendRequest: { id, message, options } });
            await decision;
        }
        if (failSend) throw new Error('fixture recipient delivery unavailable');
        const result = pi.sendMessage(message, options);
        process.send?.({ delivery: { message, options } });
        return result;
    } }; extension(extensionApi); }, pi => pi.registerProvider('recipient-fixture', {
        api: 'openai-completions', apiKey: 'offline', baseUrl: 'https://example.invalid',
        models: [{ id: 'model', name: 'Recipient fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        streamSimple(model) {
            const stream = createAssistantMessageEventStream();
            queueMicrotask(async () => {
                if (providerHold) await providerHold;
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
        if (command.type === 'send-decision') {
            const pending = approvals.get(command.id); approvals.delete(command.id);
            if (command.error) pending?.reject(new Error(command.error)); else pending?.resolve();
            return;
        }
        if (command.type === 'rows') { process.send?.({ id: command.id, value: globalThis[Symbol.for("pi-better-harness.navigator.state")].providers.get("subagents").listRows(Date.now()) }); return; }
        if (command.type === 'detail') { process.send?.({ id: command.id, value: renderRegisteredWorkDetail('subagents', command.value, 120) }); return; }
        if (command.type === 'capture-branch') {
            const base = manager.appendCustomEntry('fixture-base', {});
            const captured = manager.appendCustomEntry('fixture-captured', {});
            manager.branch(base);
            process.send?.({ id: command.id, value: captured }); return;
        }
        if (command.type === 'branch') { manager.branch(command.value); await session.extensionRunner.emit({ type: 'session_tree' }); }
        if (command.type === 'busy') {
            providerHold = new Promise(resolve => { providerRelease = resolve; });
            foregroundPrompt = session.prompt('Keep this foreground turn open until the fixture provider finishes.');
            await new Promise(resolve => setImmediate(resolve));
        }
        if (command.type === 'settle') { providerRelease?.(); providerHold = undefined; await foregroundPrompt; }
        if (command.type === 'flush') { process.send?.({ id: command.id, value: await getCallbackBatcher(extensionApi).flush() }); return; }
        if (command.type === 'start') await session.extensionRunner.emit({ type: 'session_start' });
        if (command.type === 'pending') { process.send?.({ id: command.id, value: getCallbackBatcher(extensionApi).pendingCount() }); return; }
        if (command.type === 'stop') {
            providerRelease?.(); providerHold = undefined;
            await session.abort();
            await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
            session.dispose(); process.disconnect(); return;
        }
        if (command.type === 'failure') failSend = command.value;
        process.send?.({ id: command.id, done: true });
    } catch (error) { process.send?.({ id: command.id, error: String(error) }); }
});
