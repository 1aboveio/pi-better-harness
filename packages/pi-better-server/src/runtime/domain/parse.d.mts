export function parseRun(id: string, options?: { logPath?: string; states?: Map<any, any>; summaryOnly?: boolean }): { usage: any; toolCalls: string[]; diagnostics: string[] };
export function encodeParseLogState(state: any): any;
export function decodeParseLogState(state: any): any;
export function parseRunDisplay(id: string, options: { logPath?: string; states: Map<any, any>; summaryOnly?: boolean }): { usage: any; tool: string; diagnostics: string[] };
export function readRunTranscript(id: string, options?: { logPath?: string }): any;
