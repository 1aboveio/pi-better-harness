import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { disposeBackgroundWorkNavigator } from "../../navigator/index.ts";
import { ensureBackgroundTasksNavigator, ensureBackgroundTasksNavigatorProvider } from "./navigator-provider.js";
import { registerTools } from "./tools.js";

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  ensureBackgroundTasksNavigatorProvider(pi);
  pi.on("session_start", async (_event, ctx) => {
    ensureBackgroundTasksNavigator(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    disposeBackgroundWorkNavigator(ctx);
  });
  registerTools(pi);
}