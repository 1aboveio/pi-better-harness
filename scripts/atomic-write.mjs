import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Replace a file without exposing a truncated or partially written generation. */
export function writeFileAtomically(target, content) {
  const targetDirectory = dirname(target);
  mkdirSync(targetDirectory, { recursive: true });
  const pending = join(
    targetDirectory,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(pending, content);
    renameSync(pending, target);
  } finally {
    rmSync(pending, { force: true });
  }
}