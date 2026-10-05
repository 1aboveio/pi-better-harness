import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import type { SettingsLink } from "./registry.ts";

export async function chooseHarnessSetting(ctx: any, links: SettingsLink[], selected?: string): Promise<string | undefined> {
  return ctx.ui.custom((tui: any, theme: Theme, _kb: unknown, done: (id?: string) => void) => {
    const items: SettingItem[] = [
      ...links.map(link => ({ id: `link:${link.id}`, label: link.label, currentValue: link.command, description: "Open package settings", values: [link.command] })),
    ];
    const list = new SettingsList(items, 10, {
      label: (text, active) => theme.fg(active ? "accent" : "text", text),
      value: (text, active) => active ? theme.inverse(text) : theme.fg("muted", text),
      description: text => theme.fg("muted", text), cursor: "> ", hint: text => theme.fg("dim", text),
    }, (id) => done(id), () => done(), { enableSearch: false });

    if (selected) for (let i = 0; i < Math.max(0, items.findIndex(item => item.id === selected)); i++) list.handleInput("\x1b[B");
    const page = new Container();
    page.addChild(new Text(theme.fg("accent", theme.bold("Harness settings")), 0, 0));
    page.addChild(list);
    return { render: (width: number) => page.render(width), invalidate: () => page.invalidate(), handleInput: (data: string) => list.handleInput(data) };
  });
}