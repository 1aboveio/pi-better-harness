interface OutcomeTodoPreferences {
  version: 1;
  ledger: boolean;
}

export function parseOutcomeTodoPreferences(value: unknown): OutcomeTodoPreferences {
  if (value === undefined) return { version: 1, ledger: false };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid outcomeTodo setting.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("Invalid outcomeTodo setting.");
  if (record.ledger !== undefined && typeof record.ledger !== "boolean") {
    throw new Error("Invalid outcomeTodo setting: ledger must be boolean.");
  }
  return { version: 1, ledger: record.ledger === true };
}

export function changeLedgerPreference(current: unknown, ledger: boolean): OutcomeTodoPreferences {
  const preferences = parseOutcomeTodoPreferences(current);
  // Preserve fields written by earlier versions when updating their shared settings file.
  return { ...current as Record<string, unknown>, ...preferences, ledger };
}
