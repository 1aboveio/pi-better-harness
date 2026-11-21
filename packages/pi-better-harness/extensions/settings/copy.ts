interface SettingCopy {
  label?: string;
  description: string;
  values?: Readonly<Record<string, string>>;
}

// Use stable contribution IDs so existing versions of the extensions get the same help.
export const controlCopy = new Map<string, SettingCopy>([
  ["background-review-interval", {
    label: "Background wait reviews",
    description: "When the session is waiting for a local task with callbacks on, Pi asks the main agent to review it after this long without progress. Each review shows elapsed time and the last check or output.",
  }],
  ["goal-auto-start", {
    description: "Start a Goal automatically when Pi accepts an Outcome with work to do and there is no unfinished Goal.",
  }],
  ["tool-call-guard", {
    label: "Foreground wait guard",
    description: "Blocks recognized shell waits, such as watching CI or following logs. Pi gets a prompt to run them in the background so the session stays responsive.",
  }],
  ["outcome-todo", {
    label: "Outcome and Todo tools",
    description: "Lets Pi record what the session should deliver and track its progress as a checklist.",
  }],
  ["outcome-todo-ledger", {
    label: "Project work ledger",
    description: "Lets sessions attach a saved project checklist and carry its progress across sessions. Use /ledger to list or attach a ledger.",
  }],
  ["outcome-todo-display", {
    label: "Outcome and Todo panel",
    description: "Shows the session objective and checklist in the TUI when Outcome and Todo tools are on.",
  }],
  ["navigator-sticky", {
    label: "Pin work panels",
    description: "Keeps the work panels above the editor as the conversation scrolls. Off lets them scroll with the conversation on supported Pi versions.",
  }],
  ["navigator-view", {
    label: "Navigator layout",
    description: "Tree nests tasks under their agent. Flat list groups rows by work type.",
    values: { tree: "Tree", flatten: "Flat list" },
  }],
  ["tool-output", {
    description: "Normal shows the usual tool transcript. Compact groups completed calls and hides their details until you expand the group.",
    values: { Minimal: "Compact" },
  }],
  ["tool-animation", {
    label: "Tool progress animation",
    description: "Shows an animated shimmer on active tool calls. Turn it off to remove that animation.",
    values: { Shimmer: "On" },
  }],
]);

export const linkCopy = new Map<string, SettingCopy>([
  ["agents", {
    label: "Agent catalog",
    description: "Browse the agents Pi can delegate to and manage their profiles.",
  }],
  ["goal", {
    label: "Goal settings",
    description: "Choose when Goals continue automatically, resume from conversation, or pause on Escape.",
  }],
  ["sandbox", {
    label: "Sandbox settings",
    description: "Review sandbox permissions for what tools can access and where they can run.",
  }],
  ["subagents", {
    label: "Subagent settings",
    description: "Choose how Pi delegates work and set limits for concurrent subagents, timeouts, and progress alerts.",
  }],
]);
