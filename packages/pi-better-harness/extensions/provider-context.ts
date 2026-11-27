import * as piAI from "@earendil-works/pi-ai";
import type { Context, Provider } from "@earendil-works/pi-ai";

// Pi 1.6 providers receive a transcript with the system prompt in its first message.
export const providerContext: (context: Context) => Parameters<Provider["streamSimple"]>[1] =
  Reflect.get(piAI, "normalizeContext") ?? ((context: Context) => context);
