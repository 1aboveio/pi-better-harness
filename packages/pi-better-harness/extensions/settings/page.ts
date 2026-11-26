import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Spacer, Text, getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, matchesKey, type SettingItem } from "@earendil-works/pi-tui";
import { controlCopy, linkCopy } from "./copy.ts";
import type { SettingsControl, SettingsLink } from "./registry.ts";

export interface CallbackSettingsControl {
  get(): { mode: "hold" | "steer"; source: "session" | "default" };
  change(mode: "hold" | "steer"): void;
  save(): void;
}

const CALLBACK_SETTING_ID = "callbacks:while-busy";
const callbackLabels = { hold: "When idle", steer: "During run" };
const callbackDescription = (source: "session" | "default") => [
  "When idle holds background and subagent results until the run ends. During run can deliver them between tool calls.",
  source === "session" ? "Using this session’s setting." : "Using the default.",
  "Changes apply to this session. Ctrl+S saves your default.",
].join("\n");

// Keep each package page beside the controls used for the same task.
const taskOrder = [
  "setting:outcome-todo", "setting:outcome-todo-display", "setting:goal-auto-start", "link:goal", "setting:dynamic-workflow", "setting:outcome-todo-ledger",
  "link:subagents", "link:agents", "link:sandbox",
  "setting:tool-call-guard", "setting:background-review-interval", CALLBACK_SETTING_ID,
  "setting:navigator-view", "setting:navigator-sticky",
  "setting:tool-output", "setting:tool-animation", "setting:session-recap", "link:recap-prompt",
];
const position = new Map(taskOrder.map((id, index) => [id, index]));

function presentControl(control: SettingsControl) {
  const copy = controlCopy.get(control.id);
  const valueLabels = copy?.values;
  const display = (raw: string) => valueLabels && Object.hasOwn(valueLabels, raw) ? valueLabels[raw]! : raw;
  const values = control.values.map(display);
  const description = typeof control.description === "string" && control.description.trim()
    ? control.description : copy?.description;
  const item: SettingItem = {
    id: `setting:${control.id}`,
    label: copy?.label ?? control.label,
    currentValue: display(control.get()),
    description: [description ?? `Available values are ${values.join(", ")}.`, copy && "Saved as a user default."].filter(Boolean).join("\n"),
    values,
  };
  return { control, item, display, values };
}

function presentLink(link: SettingsLink): SettingItem {
  const copy = linkCopy.get(link.id);
  const description = typeof link.description === "string" && link.description.trim()
    ? link.description : copy?.description;
  const action = "Open";
  return {
    id: `link:${link.id}`,
    label: copy?.label ?? link.label,
    currentValue: action,
    description: [description, `You can also run ${link.command}.`].filter(Boolean).join("\n"),
    values: [action],
  };
}

export async function chooseHarnessSetting(ctx: ExtensionCommandContext, links: SettingsLink[], selected?: string, callbacks?: CallbackSettingsControl, controls: SettingsControl[] = [], navigatorView?: SettingsControl, actions: SettingItem[] = []): Promise<string | undefined> {
  return ctx.ui.custom((tui, theme: Theme, _kb, done: (id?: string) => void) => {
    const currentCallback = callbacks?.get();
    let callbackMode = currentCallback?.mode ?? "hold";
    const callbackSetting: SettingItem | undefined = currentCallback && {
      id: CALLBACK_SETTING_ID,
      label: "Completion delivery",
      currentValue: callbackLabels[callbackMode],
      description: callbackDescription(currentCallback.source),
      values: Object.values(callbackLabels),
    };
    const allControls = navigatorView ? [...controls, navigatorView] : [...controls];
    const entries = allControls.map(presentControl);
    const items = [
      ...(callbackSetting ? [callbackSetting] : []),
      ...entries.map(({ item }) => item),
      ...links.map(presentLink),
      ...actions,
    ].sort((a, b) => (position.get(a.id) ?? position.size) - (position.get(b.id) ?? position.size));
    const feedback = new Text("", 2, 0);
    let changing = false;
    const report = (message: string, error = false) => {
      feedback.setText(theme.fg(error ? "error" : "text", message));
      tui.requestRender?.();
    };
    const list = new SettingsList(items, 10, {
      label: (text, active) => theme.fg(active ? "accent" : "text", text),
      value: (text, active) => active ? theme.inverse(text) : theme.fg("muted", text),
      description: text => theme.fg("text", text), cursor: "> ", hint: text => theme.fg("dim", text),
    }, (id, value) => {
      const entry = entries.find(({ item }) => item.id === id);
      if (entry) {
        const previous = entry.display(entry.control.get());
        const next = entry.control.values[entry.values.indexOf(value)]!;
        changing = true;
        report("Saving setting...");
        Promise.resolve().then(() => entry.control.change(next, ctx)).then(() => {
          list.updateValue(id, entry.display(entry.control.get()));
          report("Setting saved.");
        }).catch(error => {
          list.updateValue(id, previous);
          report(error instanceof Error ? error.message : String(error), true);
        }).finally(() => { changing = false; tui.requestRender?.(); });
        return;
      }
      if (id !== CALLBACK_SETTING_ID || !callbacks || !callbackSetting) { done(id); return; }
      try {
        const nextMode = value === callbackLabels.steer ? "steer" : "hold";
        callbacks.change(nextMode);
        callbackMode = nextMode;
        callbackSetting.description = callbackDescription("session");
        report("Session setting saved.");
      } catch (error) {
        list.updateValue(CALLBACK_SETTING_ID, callbackLabels[callbackMode]);
        report(error instanceof Error ? error.message : String(error), true);
      }
    }, () => done(), { enableSearch: false });

    const index = selected ? items.findIndex(item => item.id === selected) : 0;
    if (index > 0) {
      // SettingsList has no public selection setter. Restore synchronously using
      // default navigation, then return the untouched user bindings before input.
      const bindings = getKeybindings();
      try {
        setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
        for (let i = 0; i < index; i++) list.handleInput("\x1b[B");
      } finally { setKeybindings(bindings); }
    }
    const page = new Container();
    page.addChild(new Text(theme.bold(theme.fg("text", "Harness settings")), 0, 0));
    page.addChild(new Spacer(1));
    page.addChild(list);
    page.addChild(feedback);
    return {
      render: (width: number) => page.render(width),
      invalidate: () => page.invalidate(),
      handleInput(data: string) {
        if (changing) return;
        if (callbacks && matchesKey(data, "ctrl+s")) {
          try { callbacks.save(); report("Callback default saved."); }
          catch (error) { report(error instanceof Error ? error.message : String(error), true); }
          return;
        }
        list.handleInput(data);
      },
    };
  });
}
