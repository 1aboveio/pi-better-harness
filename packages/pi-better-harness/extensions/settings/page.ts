import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, getKeybindings, setKeybindings, KeybindingsManager, TUI_KEYBINDINGS, matchesKey, type SettingItem } from "@earendil-works/pi-tui";
import type { SettingsLink } from "./registry.ts";

export interface CallbackSettingsControl {
  get(): { mode: "hold" | "steer"; source: "session" | "default" };
  change(mode: "hold" | "steer"): void;
  save(): void;
}

const CALLBACK_SETTING_ID = "callbacks:while-busy";
const callbackLabel = (mode: "hold" | "steer") => mode === "steer" ? "Steer active run" : "Wait until idle";

export async function chooseHarnessSetting(ctx: any, links: SettingsLink[], selected?: string, callbacks?: CallbackSettingsControl): Promise<string | undefined> {
  return ctx.ui.custom((tui: any, theme: Theme, _kb: unknown, done: (id?: string) => void) => {
    let callbackMode = callbacks?.get().mode ?? "hold";
    const callbackSetting: SettingItem | undefined = callbacks ? {
      id: CALLBACK_SETTING_ID,
      label: "Completions while busy",
      currentValue: callbackLabel(callbackMode),
      description: callbacks.get().source === "session" ? "Session setting" : "User default",
      values: ["Wait until idle", "Steer active run"],
    } : undefined;
    const items: SettingItem[] = [
      ...(callbackSetting ? [callbackSetting] : []),
      ...links.map(link => ({ id: `link:${link.id}`, label: link.label, currentValue: link.command, description: "Open package settings", values: [link.command] })),
    ];
    const feedback = new Text("", 0, 0);
    const report = (message: string, error = false) => {
      feedback.setText(theme.fg(error ? "error" : "muted", message));
      tui.requestRender?.();
    };
    const list = new SettingsList(items, 10, {
      label: (text, active) => theme.fg(active ? "accent" : "text", text),
      value: (text, active) => active ? theme.inverse(text) : theme.fg("muted", text),
      description: text => theme.fg("muted", text), cursor: "> ", hint: text => theme.fg("dim", text),
    }, (id, value) => {
      if (id !== CALLBACK_SETTING_ID || !callbacks || !callbackSetting) { done(id); return; }
      try {
        const nextMode = value === "Steer active run" ? "steer" : "hold";
        callbacks.change(nextMode);
        callbackMode = nextMode;
        callbackSetting.description = "Session setting";
        report("Session setting saved.");
      } catch (error) {
        list.updateValue(CALLBACK_SETTING_ID, callbackLabel(callbackMode));
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
    page.addChild(new Text(theme.fg("accent", theme.bold("Harness settings")), 0, 0));
    page.addChild(list);
    if (callbacks) page.addChild(new Text(theme.fg("dim", "Callbacks autosave to this session. Ctrl+S saves the default for future sessions."), 0, 0));
    page.addChild(feedback);
    return {
      render: (width: number) => page.render(width),
      invalidate: () => page.invalidate(),
      handleInput(data: string) {
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