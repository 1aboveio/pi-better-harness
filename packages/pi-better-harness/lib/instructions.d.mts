export function currentInstructions(agentDir: string): string | undefined;
export function validateInstructionsPrompt(prompt: string): string;
export function manageInstructions(action: "enable" | "sync" | "disable", agentDir?: string): boolean;
export function manageInstructions(action: "sync", agentDir: string, edit: {
  previous: string;
  saveSource(): void;
}): boolean;
