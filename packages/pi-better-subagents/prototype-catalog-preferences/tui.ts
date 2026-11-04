// THROWAWAY native TUI prototype. No catalog, settings, network, or disk writes.
// Question: which terminal layout best separates saved runtime choices from role instructions?
import { ProcessTerminal, TUI, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import { pathToFileURL } from 'node:url';

const ink = {
  accent: (s: string) => `\x1b[38;5;180m${s}\x1b[0m`,
  muted: (s: string) => `\x1b[38;5;250m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[38;5;245m${s}\x1b[0m`,
  active: (s: string) => `\x1b[48;5;237m\x1b[38;5;223m${s}\x1b[0m`,
};
const models = ['deepseek/deepseek-flash', 'openai/gpt-6.1-sol', 'openai/gpt-6-astra'];
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
const bundled = [
  'Implement the requested change and own focused tests. Preserve behavior outside the request and record what you verified.',
  '',
  'For a release, prepare and test metadata under the coordinator’s approved plan: version files, dependency pins, lockfile, changelog, and package checks. Hand back the local changes or commit, verification evidence, and remaining blockers.',
  '',
  'Delivery and publishing belong to the coordinator: remote pushes, PR creation and merge, queue admission, release tags, publisher dispatch, and publication verification. Do not perform those operations or take ownership of external waits.',
  '',
  'The coordinator uses background watchers for CI, merge queues, publishers, registry propagation, and deployments. If an assignment crosses this boundary, report the mismatch and hand it back before proceeding.',
];
const oldPrompt = ['Implement the requested change in the existing system and own focused tests. Preserve behavior the task did not ask to change, and record what you verified.', '', 'Product policy belongs to Product Manager. Architecture belongs to Architect. Independent review belongs to Reviewer.'];
const layouts = ['A · Tabs', 'B · Split view', 'C · Compact inline'];
const sections = ['Settings', 'Instructions', 'Files'];
type Choices = { model?: string; effort?: string };

export function createPreview(requestRender: () => void, getHeight: () => number, close: () => void) {
  let layout = 0, section = 0, selected = 0, scroll = 0;
  let userDefinition = true, archived = false, updated = false;
  let saved: Choices = {}, session: Choices = {};
  let notice = 'Sample user override loaded. No real files are read or changed.';
  let picker: 'model' | 'effort' | undefined;
  let pickerIndex = 0;
  let expanded = false;
  const base = () => userDefinition ? {model: models[0]!, effort: 'high'} : {model: models[1]!, effort: 'high'};
  const effective = () => ({...base(), ...saved, ...session});
  const origin = (key: keyof Choices) => Object.hasOwn(session, key) ? 'session' : Object.hasOwn(saved, key) ? 'user config' : userDefinition ? 'user definition' : 'bundled';
  const wrap = (text: string, width: number) => wrapTextWithAnsi(text, Math.max(1, width));
  const actions = () => ['Model', 'Effort', 'Reset to bundled'];
  function reset() {
    userDefinition = true; archived = false; updated = false; saved = {}; session = {};
    section = 0; selected = 0; scroll = 0; picker = undefined;
    notice = 'Demo reset. Sample user override restored; real files are unchanged.';
  }
  function activate() {
    const action = actions()[selected];
    if (action === 'Model' || action === 'Effort') {
      picker = action === 'Model' ? 'model' : 'effort';
      pickerIndex = (picker === 'model' ? models : efforts).indexOf(effective()[picker]);
    } else if (action === 'Reset to bundled') {
      saved = userDefinition ? {model: models[1]!, effort: 'high'} : {}; session = {};
      notice = 'Bundled model/effort restored. The role prompt is unchanged.';
    }
  }
  function save() { saved = {...saved, ...session}; notice = 'Saved to agents/settings.json. Markdown unchanged; session edits retained.'; }
  function resetPrompt() {
    if (userDefinition) { saved = {...base(), ...saved}; archived = true; userDefinition = false; }
    notice = 'Bundled role prompt restored. Model/effort and session choices are unchanged.';
  }
  function settingRows(width: number) {
    const field = (index: number, label: string, value: string, source: string) => {
      const prefix = selected === index ? '› ' : '  ';
      if (width < 58) return [ink.muted(prefix + label), '    ' + value, ink.dim('    ' + source)];
      const valueWidth = Math.max(12, width - 29);
      const valueText = truncateToWidth(value, valueWidth);
      const row = prefix + label.padEnd(10) + valueText + ' '.repeat(Math.max(1, valueWidth - visibleWidth(valueText) + 2)) + source;
      return [selected === index ? ink.active(row.padEnd(width)) : row];
    };
    const rows = [ink.muted('Runtime preferences'), ink.dim('Saved separately from the Markdown definition.'), '',
      ...field(0, 'Model', effective().model!, origin('model')), '',
      ...field(1, 'Effort', effective().effort!, origin('effort')), ''];
    for (let i = 2; i < actions().length; i++) {
      const name = actions()[i]!;
      rows.push(selected === i ? ink.active(('› ' + name).padEnd(width)) : '  ' + name);
      if (name === 'Reset to bundled') rows.push(...wrap(ink.dim('  Restores model/effort; keeps the role prompt.'), width));
    }
    rows.push('', ink.dim('Effective: ' + effective().model + ' · ' + effective().effort));
    return rows;
  }
  function promptRows(width: number) {
    const source = userDefinition ? 'user override' : 'bundled';
    const prompt = [...(userDefinition ? oldPrompt : bundled), ...(updated ? ['', 'Demo bundle update: newly shipped instructions appear here.'] : [])];
    return [ink.accent('› Reset to bundled'), ink.dim('Restores the prompt; keeps model/effort choices.'), '', ink.muted('Role instructions'), ink.dim('Source: ' + source), '', ...prompt.flatMap(line => line ? wrap(line, width) : [''])];
  }
  function fileRows(width: number) {
    const config = Object.keys(saved).length ? JSON.stringify({version: 1, defaults: {'role.developer': saved}}, null, 2).split('\n') : ['No config saved yet.'];
    return [ink.muted('Saved preferences'), ...wrap(ink.dim('~/.pi/agent/agents/settings.json'), width), '', ...config, '',
      ink.muted('Definition'), ...wrap(userDefinition ? '~/.pi/agent/agents/roles/role.developer.md' : 'pi-better-subagents/roles/role.developer.md', width), '',
      ink.muted('Current session edits'), ...JSON.stringify(session, null, 2).split('\n'), '',
      ink.muted('Archived definition'), ...wrap(archived ? '.role.developer.md.demo.backup (original bytes retained)' : 'None', width)];
  }
  function fitColumns(left: string[], right: string[], width: number) {
    const half = Math.floor((width - 5) / 2);
    return Array.from({length: Math.max(left.length, right.length)}, (_, i) => {
      const a = truncateToWidth(left[i] ?? '', half);
      return a + ' '.repeat(Math.max(0, half - visibleWidth(a))) + ink.dim('  │  ') + truncateToWidth(right[i] ?? '', width - half - 5);
    });
  }
  return {
    render(columns: number): string[] {
      const width = Math.max(16, columns - 4), height = Math.max(12, getHeight());
      const title = ink.accent('Agents / Developer') + ink.dim('  ·  prototype');
      const nav = (width < 66 ? ['A Tabs', 'B Split', 'C Inline'] : layouts).map((name, i) => i === layout ? ink.accent('[' + name + ']') : ink.dim(name)).join('   ');
      const identity = 'role.developer  ·  ' + (userDefinition ? 'user definition' : 'bundled definition');
      let body: string[];
      if (picker) {
        const values = picker === 'model' ? models : efforts;
        body = [ink.muted('Choose ' + picker + ' · session edit'), '', ...values.map((value, i) => i === pickerIndex ? ink.active('› ' + value) : '  ' + value), '', ink.dim('Enter selects · Esc cancels')];
      } else if (layout === 0) {
        const tabs = sections.map((name, i) => i === section ? ink.accent('[' + name + ']') : ink.dim(name)).join('   ');
        body = [tabs, '', ...(section === 0 ? settingRows(width) : section === 1 ? promptRows(width) : fileRows(width))];
      } else if (layout === 1) {
        if (section === 2) body = fileRows(width);
        else if (width >= 94) {
          const half = Math.floor((width - 5) / 2);
          body = fitColumns(settingRows(half), promptRows(width - half - 5), width);
        } else body = [ink.dim('Split view stacks below 98 columns.'), '', ...(section === 1 ? promptRows(width) : settingRows(width))];
      } else {
        if (section === 2) body = fileRows(width);
        else body = [...settingRows(width), '', ink.muted((expanded ? '▾' : '▸') + ' Instructions · ' + (userDefinition ? 'user override' : 'bundled')),
          ...(expanded || section === 1 ? ['', ...promptRows(width).slice(3)] : [...wrap(ink.dim('  ' + (userDefinition ? oldPrompt[0] : bundled[0])), width), ink.dim('  p expands the complete prompt')])];
      }
      const top = [title, nav, '', ink.muted(identity), ''];
      const footer = ['', ...wrap(ink.accent(notice), width).slice(0, 2), '',
        ink.dim(width < 66 ? '1/2/3 layout · Tab page · ↑↓ move' : '1/2/3 layout · Tab section · ↑↓ select/scroll · Enter change'),
        ink.dim(width < 66 ? 'Enter edit · Ctrl+S save · q quit' : 'Ctrl+S save · n fresh session · u bundle update · r reset · q quit')];
      const available = Math.max(1, height - top.length - footer.length);
      scroll = Math.max(0, Math.min(scroll, body.length - available));
      const content = body.slice(scroll, scroll + available);
      while(content.length < available) content.push('');
      return [...top, ...content, ...footer].slice(0, height).map(line => '  ' + truncateToWidth(line, width));
    },
    handleInput(data: string) {
      if (matchesKey(data, 'ctrl+c') || data === 'q') { close(); return; }
      if (picker) {
        const values = picker === 'model' ? models : efforts;
        if(matchesKey(data, 'up')) pickerIndex = Math.max(0, pickerIndex - 1);
        if(matchesKey(data, 'down')) pickerIndex = Math.min(values.length - 1, pickerIndex + 1);
        if(matchesKey(data, 'enter')) { session[picker] = values[pickerIndex]; notice = 'Session edit only. Ctrl+S saves it without rewriting Markdown.'; picker = undefined; }
        if(matchesKey(data, 'escape')) picker = undefined;
      } else if (['1','2','3'].includes(data)) { layout = Number(data) - 1; scroll = 0; }
      else if(matchesKey(data, 'tab')) { section = (section + 1) % 3; scroll = 0; }
      else if(data === 's' || matchesKey(data, 'ctrl+s')) save();
      else if(data === 'r') reset();
      else if(data === 'n') { session = {}; notice = 'Fresh session: only saved model/effort choices remain.'; }
      else if(data === 'u') { updated = true; notice = userDefinition ? 'Bundled update is hidden by the user definition. Use bundled definition to reveal it.' : 'New bundled instructions apply; saved model/effort choices are unchanged.'; }
      else if(data === 'p') { expanded = !expanded; section = layout === 2 ? 0 : 1; scroll = 0; }
      else if(matchesKey(data, 'escape')) { section = 0; scroll = 0; }
      else if(matchesKey(data, 'up') || matchesKey(data, 'down')) {
        const delta = matchesKey(data, 'down') ? 1 : -1;
        if(section === 0) { selected = Math.max(0, Math.min(actions().length - 1, selected + delta)); scroll = Math.max(0, selected * 2 - 3); }
        else scroll = Math.max(0, scroll + delta);
      } else if((matchesKey(data, 'enter') || data === ' ') && section === 0) activate();
      else if((matchesKey(data, 'enter') || data === ' ') && section === 1 && scroll === 0) resetPrompt();
      requestRender();
    },
    invalidate() {},
  };
}

export default function extension(pi: any) {
  pi.registerCommand('agents-preview', {
    description: 'Throwaway TUI layout preview; changes no files',
    async handler(_args: string, ctx: any) {
      let height = 30;
      await ctx.ui.custom((tui: any, _theme: any, _keys: any, done: any) => createPreview(() => tui.requestRender(), () => height, () => done()), {
        overlay: true,
        overlayOptions: {anchor: 'top-left', width: '100%', maxHeight: '100%', margin: 0, visible: (_w: number, h: number) => {height = h; return true;}},
      });
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  let closed = false;
  const close = () => {
    if(closed) return;
    closed = true;
    tui.stop();
    terminal.write('\x1b[?1049l');
    process.exit(0);
  };
  terminal.write('\x1b[?1049h');
  const preview = createPreview(() => tui.requestRender(), () => terminal.rows, close);
  tui.addChild(preview);
  tui.setFocus(preview);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  tui.start();
}
