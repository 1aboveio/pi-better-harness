// THROWAWAY selected design A. Uses the real catalog component with in-memory callbacks.
// No settings/catalog writes, no network calls, and no reads of the user's definitions.
import { ProcessTerminal, TUI } from '@earendil-works/pi-tui';
import { readFileSync } from 'node:fs';
import { createCatalogComponent } from '../catalog-ui.ts';
import type { OperationView } from '../agent-inspection.ts';

const bundledPrompt = readFileSync(new URL('../roles/role.developer.md', import.meta.url), 'utf8').split(/^---\s*$/m).slice(2).join('---').trim();
const defaults = {model: 'openai/gpt-6.1-sol', effort: 'high'};
const legacy = {model: 'deepseek/deepseek-flash', effort: 'medium'};
let user = true;
let saved: Record<string, string> = {};
let followBundled = false;
let session: Record<string, string | null> = {};
let archived = false;
const theme = {
  fg(color: string, text: string) {
    const code = color === 'accent' ? 180 : color === 'error' ? 203 : color === 'warning' ? 215 : color === 'dim' ? 245 : 250;
    return `\x1b[38;5;${code}m${text}\x1b[0m`;
  },
  bg(_color: string, text: string) { return `\x1b[48;5;237m${text}\x1b[0m`; },
  bold(text: string) { return `\x1b[1m${text}\x1b[22m`; },
  inverse(text: string) { return `\x1b[7m${text}\x1b[27m`; },
};
function catalog() {
  const runtime: any = {...(user && !followBundled ? legacy : defaults), ...saved, ...session};
  const view: OperationView = {
    id: 'role.developer', found: true, definitionValid: true, catalogLaunchable: true,
    launchable: true, launchabilityDecided: true, launchabilityReason: 'Prototype model choices are illustrative; no model is launched.',
    identity: {id: 'role.developer', kind: 'role', name: 'Developer', scope: user ? 'user' : 'bundled',
      description: 'Implementation and focused tests. Delivery and publishing belong to the coordinator.',
      path: user ? '~/.pi/agent/agents/roles/role.developer.md' : 'pi-better-subagents/roles/role.developer.md'},
    winningSource: {id: 'role.developer', scope: user ? 'user' : 'bundled', path: 'prototype-only', contentDigest: user ? 'legacy-sample' : 'bundled-sample'},
    shadowed: user ? [{scope: 'bundled', path: 'pi-better-subagents/roles/role.developer.md', contentDigest: 'bundled-sample', reason: 'shadowed-by-whole-definition'}] : [],
    instructionMode: 'role', instructions: user ? 'Old user role prompt. Implement the requested change and own focused tests.\n\nThis sample override does not yet include the new release handoff boundaries.' : bundledPrompt,
    fields: {
      model: {value: runtime.model, source: 'role-default', explicit: false, inherited: true},
      effort: {value: runtime.effort, source: 'role-default', explicit: false, inherited: true},
      tier: {value: 'balanced', source: 'role-default', explicit: false, inherited: true},
    },
    preferenceSources: Object.fromEntries((followBundled ? ['model', 'effort'] : Object.keys(saved)).map(key => [key, {scope: 'user', path: '~/.pi/agent/agents/settings.json', bundled: followBundled && !Object.hasOwn(saved, key)}])),
    defaults: {model: runtime.model, effort: runtime.effort, label: `${runtime.model}@${runtime.effort}`},
    requestedModel: runtime.model, requestedEffort: runtime.effort, actualModel: runtime.model, actualEffort: runtime.effort,
    capabilities: {} as any, restrictions: [], codexProvenanceModel: null, validation: [], text: '',
  };
  return {entries: [view], revision: 'prototype', diagnostics: [], text: ''};
}
const terminal = new ProcessTerminal();
const tui = new TUI(terminal);
let stopped = false;
const close = () => {
  if (stopped) return;
  stopped = true;
  tui.stop(); terminal.write('\x1b[?1049l'); process.exit(0);
};
const component = createCatalogComponent(catalog(), theme, () => tui.requestRender(), close, 'role.developer', {
  get: catalog,
  models: () => ['deepseek/deepseek-flash', 'openai/gpt-6.1-sol', 'openai/gpt-6-astra'],
  settings: () => ({'role.developer': session}),
  change(_id, key, value) { session = {...session, [key]: value}; },
  save() { saved = {...saved, ...session} as Record<string, string>; return {ok: true, message: 'Prototype: saved model/effort only. No real file changed.'}; },
  resetToBundled() {
    followBundled = true; saved = {}; session = {};
    return {ok: true, message: 'Prototype: bundled model/effort restored; role prompt kept.'};
  },
  resetDefinition() {
    if (user) { if (!followBundled) saved = {...legacy, ...saved}; user = false; archived = true; }
    return {ok: true, message: `Prototype: bundled prompt restored; model/effort kept.${archived ? ' User Markdown backed up.' : ''}`};
  },
}, () => Math.max(10, terminal.rows - 1));
const wrapper = {
  render(width: number) { return [...component.render(width), theme.fg('dim', 'PROTOTYPE · memory only · q quit')]; },
  handleInput(data: string) { if (data === 'q' || data === '\x03') close(); else component.handleInput(data); },
  invalidate() { component.invalidate(); },
};
terminal.write('\x1b[?1049h');
tui.addChild(wrapper); tui.setFocus(wrapper);
process.on('SIGTERM', close); process.on('SIGINT', close);
tui.start();
