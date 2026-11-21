/**
 * TypeScript re-export of completion.mjs formatters.
 * The actual logic lives in completion.mjs for ESM test compatibility.
 */
export {
    formatCallbackTrigger,
    formatCallbackQuiet,
    buildCompletionDelivery,
    formatHealthCallbackTrigger,
    buildHealthCallbackDelivery,
} from "./completion.mjs";
