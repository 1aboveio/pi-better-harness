export interface OutcomeTodoPreferences {
  version: 1;
  enabled: boolean;
  display: boolean;
}

export function parseOutcomeTodoPreferences(value: unknown): OutcomeTodoPreferences {
  if (value === undefined) return { version: 1, enabled: false, display: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid outcomeTodo setting.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("Invalid outcomeTodo setting.");
  for (const key of ["enabled", "display"] as const) {
    if (record[key] !== undefined && typeof record[key] !== "boolean") throw new Error(`Invalid outcomeTodo setting: ${key} must be boolean.`);
  }
  return { version: 1, enabled: record.enabled === undefined ? false : record.enabled as boolean,
    display: record.display === undefined ? true : record.display as boolean };
}

export function changeOutcomeTodoPreference(current: unknown, key: "enabled" | "display", value: boolean): OutcomeTodoPreferences {
  const preferences = parseOutcomeTodoPreferences(current);
  if (key !== "enabled" && key !== "display") throw new Error("Invalid outcomeTodo preference.");
  if (typeof value !== "boolean") throw new Error("Invalid outcomeTodo preference value.");
  return { ...preferences, [key]: value };
}