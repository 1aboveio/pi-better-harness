import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';

export interface ParkCheckpoint {
  version: 1;
  sessionId: string;
  sessionFile: string;
  toolCallId: string;
  waitId: string;
  generation: number;
  entryId: string;
  prefixBytes: number;
  prefixSha256: string;
}

/** Proof of a saved tool result, never a request to rewrite native history. */
export function captureParkCheckpoint(input: {
  sessionId: string; sessionFile: string; toolCallId: string; waitId: string; generation: number;
}): ParkCheckpoint {
  if (!input.sessionId || !input.toolCallId || !input.waitId || !Number.isSafeInteger(input.generation) || input.generation < 1) {
    throw new Error('Invalid park checkpoint identity');
  }
  const sessionFile = realpathSync.native(input.sessionFile);
  const size = statSync(sessionFile).size;
  if (size > 64 * 1024 * 1024) throw new Error('Conversation exceeds the supported park-checkpoint size');
  const bytes = readFileSync(sessionFile);
  if (!bytes.length || bytes.at(-1) !== 10) throw new Error('Native session has an incomplete checkpoint write');
  const lines = bytes.toString('utf8').trimEnd().split('\n');
  const records = lines.map(line => JSON.parse(line));
  if (records[0]?.type !== 'session' || records[0]?.id !== input.sessionId) throw new Error('Park checkpoint belongs to another conversation');
  const messages = records.filter(entry => entry.type === 'message');
  const last = messages.at(-1);
  const result = last?.message;
  if (!last?.id || result?.role !== 'toolResult' || result.toolCallId !== input.toolCallId || result.toolName !== 'wait_for_operations' || result.isError) {
    throw new Error('The wait tool result is not the last persisted conversation message');
  }
  const marker = result.details?.operationWait;
  const text = Array.isArray(result.content) ? result.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n') : '';
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { /* Structured details remain authoritative when present. */ }
  const wait = marker ?? parsed?.operationWait;
  if (wait?.waitId !== input.waitId || wait?.generation !== input.generation) throw new Error('Persisted wait result does not match the registered wait generation');
  const request = messages.slice(0, -1).reverse().find(entry => entry.message?.role === 'assistant' &&
    entry.message.content?.some((part: any) => part?.type === 'toolCall' && part.id === input.toolCallId));
  const call = request?.message.content.find((part: any) => part?.type === 'toolCall' && part.id === input.toolCallId);
  if (call?.name !== 'wait_for_operations') throw new Error('No matching native wait tool call precedes its result');
  return { version: 1, ...input, sessionFile, entryId: last.id, prefixBytes: bytes.length,
    prefixSha256: createHash('sha256').update(bytes).digest('hex') };
}

/** Appends are allowed after resume, but replacement/truncation cannot impersonate a checkpoint. */
export function verifyParkCheckpoint(checkpoint: ParkCheckpoint): void {
  if (checkpoint.version !== 1 || !Number.isSafeInteger(checkpoint.prefixBytes) || checkpoint.prefixBytes < 1 || checkpoint.prefixBytes > 64 * 1024 * 1024) {
    throw new Error('Unsupported park checkpoint');
  }
  if (realpathSync.native(checkpoint.sessionFile) !== checkpoint.sessionFile) throw new Error('Park checkpoint path changed');
  const bytes = readFileSync(checkpoint.sessionFile);
  if (bytes.length < checkpoint.prefixBytes || createHash('sha256').update(bytes.subarray(0, checkpoint.prefixBytes)).digest('hex') !== checkpoint.prefixSha256) {
    throw new Error('Saved conversation no longer contains the verified park checkpoint');
  }
}
