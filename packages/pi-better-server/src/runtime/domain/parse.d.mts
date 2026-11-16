export function parseRun(id: string, options?: { logPath?: string; states?: Map<any, any>; summaryOnly?: boolean }): { finalText: string; usage: any; toolCalls: string[]; diagnostics: string[] };
export function encodeParseLogState(state: any): any;
export function decodeParseLogState(state: any): any;
export function parseRunDisplay(id: string, options: { logPath?: string; states: Map<any, any> }): { usage: any; tool: string };
export function readRunTranscript(id: string, options?: { logPath?: string }): any;
