import type { Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface MenuItem {
  id: string;
  label: string;
  kind: "toggle" | "choice" | "page" | "editor";
  value?: string;
  description?: string;
}

export interface MenuSection {
  title: string;
  items: MenuItem[];
}

const verbs = { toggle: "toggle", choice: "change", page: "open", editor: "edit" };

export function createSettingsMenu(options: {
  title: string;
  sections: MenuSection[];
  selected?: string;
  theme: Theme;
  height: () => number;
  activate: (item: MenuItem) => void;
  back: () => void;
}) {
  const { theme } = options;
  const rows = options.sections.flatMap(section => section.items.map(item => ({ section, item })));
  const labelWidth = Math.max(0, ...rows.map(({ item }) => visibleWidth(item.label)));
  let cursor = Math.max(0, rows.findIndex(({ item }) => item.id === options.selected));
  let first = 0;
  let feedback = "";

  function renderItem(item: MenuItem, active: boolean, width: number): string[] {
    const value = item.kind === "page" ? [item.value, "›"].filter(Boolean).join(" ")
      : item.kind === "editor" ? "Edit…" : item.value ?? "";
    const link = item.kind === "page" || item.kind === "editor";
    const trailing = active && !link ? theme.inverse(value) : theme.fg(active ? "accent" : "muted", value);
    const label = (active ? "> " : "  ") + theme.fg(active ? "accent" : "text", item.label);
    if (labelWidth + visibleWidth(value) + 4 <= width) {
      return [label + " ".repeat(labelWidth - visibleWidth(item.label) + 2) + trailing];
    }
    return [truncateToWidth(label, width, "…"), truncateToWidth("    " + trailing, width, "…")];
  }

  return {
    report(text: string, error = false) { feedback = theme.fg(error ? "error" : "text", text); },
    invalidate() {},
    handleInput(data: string) {
      const kb = getKeybindings();
      if (kb.matches(data, "tui.select.cancel")) { options.back(); return; }
      const row = rows[cursor];
      if (!row) return;
      if (kb.matches(data, "tui.select.up")) cursor = (cursor + rows.length - 1) % rows.length;
      else if (kb.matches(data, "tui.select.down")) cursor = (cursor + 1) % rows.length;
      else if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "space")) {
        options.activate(row.item);
        return;
      } else return;
      feedback = "";
    },
    render(width: number) {
      const w = Math.max(1, width);
      const title = theme.bold(theme.fg("text", options.title));
      const row = rows[cursor];
      if (!row) return [title, "  No settings available"].map(line => truncateToWidth(line, w));

      // Inline settings share the terminal with the conversation, work panels and Pi footer.
      const height = Math.max(1, Math.floor(options.height() * 2 / 3));
      const lines = rows.map(({ item }, i) => renderItem(item, i === cursor, w));
      const focused = lines[cursor]!;
      if (height < focused.length + 2) return focused.slice(0, height);
      const indent = "  ";
      const wrap = (s: string) => wrapTextWithAnsi(s, Math.max(1, w - indent.length)).map(line => indent + line);
      const help = row.item.description ? wrap(row.item.description) : [];
      const kb = getKeybindings();
      const key = (binding: "tui.select.confirm" | "tui.select.cancel") => {
        const name = kb.getKeys(binding)[0] ?? "";
        return name === "escape" ? "Esc" : name.length > 1 ? name.charAt(0).toUpperCase() + name.slice(1) : name;
      };
      const confirm = key("tui.select.confirm");
      const cancel = key("tui.select.cancel");
      const action = [confirm, confirm === "Space" ? "" : "Space"].filter(Boolean).join("/");
      const hint = wrap([action + " to " + verbs[row.item.kind], cancel && cancel + " back"].filter(Boolean).join(" · "));
      const status = feedback ? wrap(feedback) : [];
      const headerGap = height >= 8 ? [""] : [];
      const minBody = 1 + focused.length;
      const available = height - 1 - headerGap.length;
      const footRoom = Math.max(0, available - minBody - 1);
      const keys = [...status, ...hint.map(line => theme.fg("dim", line))].slice(0, footRoom);
      const helpRoom = Math.min(Math.floor(height / 3), footRoom - keys.length - 1);
      const details = help.slice(0, Math.max(0, helpRoom));
      const footer = [...details, ...(details.length ? [""] : []), ...keys];
      if (footer.length) footer.unshift("");
      const budget = Math.min(16, available - footer.length);

      // Scroll whole rows and repeat the first visible section heading after a scroll.
      let start = cursor;
      let used = 1 + lines[cursor]!.length;
      while (start > first) {
        const cost = lines[start - 1]!.length + (rows[start - 1]!.section === rows[start]!.section ? 0 : 2);
        if (used + cost > budget) break;
        used += cost;
        start--;
      }
      first = start;
      const body: string[] = [];
      let end = first;
      for (; end < rows.length; end++) {
        const { section } = rows[end]!;
        const heading = end === first || rows[end - 1]!.section !== section;
        const gap = heading && body.length > 0;
        const cost = Number(gap) + Number(heading) + lines[end]!.length;
        if (body.length && body.length + cost > budget) break;
        if (gap) body.push("");
        if (heading) body.push(theme.fg("muted", theme.bold(section.title)));
        body.push(...lines[end]!);
      }
      const count = `  ${cursor + 1}/${rows.length}`;
      const showCount = (first > 0 || end < rows.length) && visibleWidth(title + count) <= w;
      return [title + (showCount ? theme.fg("dim", count) : ""), ...headerGap, ...body, ...footer]
        .map(line => truncateToWidth(line, w, "…"));
    },
  };
}
