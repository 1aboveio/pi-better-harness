import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BackgroundActivityProvider, BackgroundProviderSnapshot } from "../../../pi-better-goal/src/types.ts";

export function goalActivityWhenReady(
  provider: BackgroundActivityProvider & Required<Pick<BackgroundActivityProvider, "onActivityChanged">>,
  ctx: ExtensionContext,
  observe: (ctx: ExtensionContext) => Promise<{ status: string; reason?: string }>,
): Promise<BackgroundProviderSnapshot>;
