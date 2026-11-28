import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { controlCopy, linkCopy } from "./copy.ts";
import { createSettingsMenu, type MenuItem, type MenuSection } from "./menu.ts";
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

const groups = [
  { title: "Goals & workflows", ids: ["setting:goal-auto-start", "setting:dynamic-workflow", "setting:outcome-todo", "setting:outcome-todo-ledger", "link:goal"] },
  { title: "Agents & permissions", ids: ["link:subagents", "link:agents", "link:sandbox"] },
  { title: "Background work", ids: ["setting:tool-call-guard", "setting:background-review-interval", CALLBACK_SETTING_ID] },
  { title: "Work display", ids: ["setting:navigator-view", "setting:navigator-sticky", "setting:outcome-todo-display", "setting:tool-output", "setting:tool-animation"] },
  { title: "Supervision", ids: ["setting:supervisor-mode", "supervisor:scenarios"] },
  { title: "Recaps & instructions", ids: ["setting:session-recap", "link:recap-prompt", "instructions:toggle", "link:prompt-manager", "instructions:edit", "setting:native-compaction"] },
];

function groupSettings(items: MenuItem[]): MenuSection[] {
  const remaining = new Map(items.map(item => [item.id, item]));
  const sections = groups.map(({ title, ids }) => ({
    title, items: ids.flatMap(id => {
      const item = remaining.get(id);
      remaining.delete(id);
      return item ? [item] : [];
    }),
  }));
  sections.push({ title: "Extensions", items: [...remaining.values()] });
  return sections.filter(section => section.items.length);
}

function presentControl(control: SettingsControl) {
  const copy = controlCopy.get(control.id);
  const labels = copy?.values;
  const display = (raw: string) => labels && Object.hasOwn(labels, raw) ? labels[raw]! : raw;
  const description = (typeof control.description === "string" && control.description.trim()) || copy?.description;
  const values = control.values.map(display);
  const raw = control.get();
  const item: MenuItem = {
    id: `setting:${control.id}`,
    label: copy?.label ?? control.label,
    kind: values.length === 2 && values.includes("On") && values.includes("Off") ? "toggle" : "choice",
    value: display(raw),
    description: [description ?? `Available values are ${values.join(", ")}.`, copy && "Saved as a user default."].filter(Boolean).join("\n"),
  };
  return { control, item, raw, display };
}

function presentLink(link: SettingsLink): MenuItem {
  const copy = linkCopy.get(link.id);
  return {
    id: `link:${link.id}`,
    label: copy?.label ?? link.label,
    kind: link.id === "recap-prompt" ? "editor" : "page",
    description: [(typeof link.description === "string" && link.description.trim()) || copy?.description, `You can also run ${link.command}.`].filter(Boolean).join("\n"),
  };
}

export async function chooseHarnessSetting(ctx: ExtensionCommandContext, links: SettingsLink[], selected?: string, callbacks?: CallbackSettingsControl, controls: SettingsControl[] = [], navigatorView?: SettingsControl, actions: MenuItem[] = []): Promise<string | undefined> {
  return ctx.ui.custom((tui, theme, _kb, done: (id?: string) => void) => {
    const currentCallback = callbacks?.get();
    let callbackMode = currentCallback?.mode ?? "hold";
    const callbackSetting: MenuItem | undefined = currentCallback && {
      id: CALLBACK_SETTING_ID,
      label: "Completion delivery",
      kind: "choice",
      value: callbackLabels[callbackMode],
      description: callbackDescription(currentCallback.source),
    };
    const entries = (navigatorView ? [...controls, navigatorView] : controls).map(presentControl);
    const sections = groupSettings([
      ...(callbackSetting ? [callbackSetting] : []),
      ...entries.map(({ item }) => item),
      ...links.map(presentLink),
      ...actions,
    ]);
    let changing = false;
    const report = (message: string, error = false) => {
      menu.report(message, error);
      tui.requestRender?.();
    };
    const menu = createSettingsMenu({
      title: "Harness settings", theme, sections, selected, height: () => tui.terminal?.rows ?? 32,
      back: () => done(),
      activate(item) {
        if (item === callbackSetting && callbacks) {
          try {
            const next = callbackMode === "hold" ? "steer" : "hold";
            callbacks.change(next);
            callbackMode = next;
            item.value = callbackLabels[next];
            item.description = callbackDescription("session");
            report("Session setting saved.");
          } catch (error) { report(error instanceof Error ? error.message : String(error), true); }
          return;
        }
        const entry = entries.find(entry => entry.item === item);
        if (!entry) { done(item.id); return; }
        const { control, display } = entry;
        changing = true;
        report("Saving setting...");
        Promise.resolve().then(() => {
          const index = control.values.indexOf(entry.raw);
          return control.change(control.values[(index + 1) % control.values.length]!, ctx);
        }).then(() => {
          entry.raw = control.get();
          item.value = display(entry.raw);
          report("Setting saved.");
        }).catch(error => report(error instanceof Error ? error.message : String(error), true))
          .finally(() => { changing = false; });
      },
    });
    return {
      render: menu.render,
      invalidate: menu.invalidate,
      handleInput(data: string) {
        if (changing) return;
        if (callbacks && matchesKey(data, "ctrl+s")) {
          try { callbacks.save(); report("Callback default saved."); }
          catch (error) { report(error instanceof Error ? error.message : String(error), true); }
          return;
        }
        menu.handleInput(data);
      },
    };
  });
}
