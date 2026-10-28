import { randomUUID } from 'node:crypto';

const MIN_LENGTH = 16;
const MAX_LENGTH = 256;

export function newState(): string {
  return randomUUID();
}

const wellFormed = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= MIN_LENGTH && v.length <= MAX_LENGTH;

/**
 * Constant-time comparison of an issued state with the one returned by the
 * provider. Malformed input is rejected before any byte is compared; the
 * length check leaks only the length, which is public (states are fixed-size).
 */
export function verifyState(expected: unknown, actual: unknown): boolean {
  if (!wellFormed(expected) || !wellFormed(actual)) return false;
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}
