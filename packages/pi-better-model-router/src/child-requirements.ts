import { candidateSpecs } from "./routing.ts";

export interface ChildModelRequirements {
  providers: string[];
  modelGroups: { provider: string; ids: string[]; prefix?: string }[];
}

// Discovery must remain pure: no extension registration, config reads, or SDK
// initialization. Declare every possible route, regardless of today's prices.
export function childModelRequirements(model: string): ChildModelRequirements | undefined {
  if (model !== "router/deepseek-flash-auto") return undefined;
  return {
    providers: [...new Set(candidateSpecs.map(spec => spec.provider))],
    modelGroups: candidateSpecs.map(({ provider, ids, prefix }) => ({
      provider, ids: [...ids], ...(prefix === undefined ? {} : { prefix }),
    })),
  };
}

export default function (input: { model: string }): ChildModelRequirements | undefined {
  return childModelRequirements(input.model);
}
