export function parseRun(id: string, options?: { logPath?: string; states?: Map<any, any> }): { usage: any; toolCalls: string[] };
export function parseRunDisplay(id: string, options: { logPath?: string; states: Map<any, any> }): { usage: any; tool: string };
export function readRunTranscript(id: string, options?: { logPath?: string }): any;
