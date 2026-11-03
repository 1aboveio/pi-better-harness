import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI) {
  if (typeof (pi as unknown as { registerVirtualModel?: unknown }).registerVirtualModel !== "function") {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("Model router needs a newer Pi with virtual-model support (tested with Pi 1.4.0). Upgrade Pi to enable DeepSeek Flash Auto.", "warning");
    });
    return;
  }
  const provider = await import("../../node_modules/pi-better-model-router/node_modules/pi-ollama-cloud/index.ts");
  await provider.default(pi);
  const router = await import("../../node_modules/pi-better-model-router/src/index.ts");
  router.default(pi);
}
