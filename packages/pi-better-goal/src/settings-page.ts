import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import type { GoalPreferences } from "./preferences.js";

const rows: { key: keyof GoalPreferences; label: string }[] = [
  { key: "autoContinue", label: "Automatic continuation" },
  { key: "conversationalResume", label: "Conversational resume" },
  { key: "pauseOnEscape", label: "Pause on Esc" },
];

export function createGoalSettingsPage(
  theme: Theme,
  handlers: { get(): GoalPreferences; change(key: keyof GoalPreferences, enabled: boolean): Promise<void> },
  requestRender: () => void,
  close: () => void,
): Component & Focusable {
  let row = 0;
  let busy = false;
  let message = "";
  let error = false;
  function change(): void {
    const selected = rows[row]!;
    busy = true;
    message = "Saving...";
    error = false;
    void Promise.resolve().then(() => handlers.change(selected.key, !handlers.get()[selected.key])).then(() => {
      message = "Saved.";
    }, (cause: unknown) => {
      message = cause instanceof Error ? cause.message : String(cause);
      error = true;
    }).finally(() => {
      busy = false;
      requestRender();
    });
  }
  return {
    focused: false,
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.escape)) { close(); return; }
      if (busy) return;
      if (matchesKey(data, Key.up)) row = Math.max(0, row - 1);
      else if (matchesKey(data, Key.down)) row = Math.min(rows.length - 1, row + 1);
      else if (matchesKey(data, Key.enter) || data === " ") change();
      requestRender();
    },
    render(width: number) {
      const w = Math.max(1, Math.floor(width));
      const preferences = handlers.get();
      const lines = [theme.fg("accent", theme.bold("  Goal settings")), ""];
      rows.forEach(({ key, label }, index) => {
        const selected = row === index;
        const title = theme.fg(selected ? "accent" : "text", (selected ? "> " : "  ") + label);
        const value = preferences[key] ? "On" : "Off";
        const active = selected ? theme.inverse(value) : theme.fg("text", value);
        if (w < 40) {
          lines.push(title, "  " + active);
        } else {
          const line = title + " ".repeat(Math.max(1, 30 - visibleWidth(title))) + active;
          lines.push(selected ? theme.bg("selectedBg", theme.bold(line)) : line);
        }
      });
      if (message) lines.push("", theme.fg(error ? "error" : "muted", message));
      lines.push("", theme.fg("dim", "Up/Down Select · Space/Enter Toggle · Esc Back"));
      return lines.map((line) => truncateToWidth(line, w, ""));
    },
  };
}