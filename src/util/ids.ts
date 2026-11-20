import { createHash, randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

/**
 * Stable key for a booking attempt. Retries — including a worker crash and a
 * replay hours later — must produce the same key, because that is what lets
 * the lab API distinguish "retry" from "second booking".
 */
export function bookingIdempotencyKey(conversationId: string, slotId: string, testId: string): string {
  return createHash('sha256').update(`${conversationId}|${slotId}|${testId}`).digest('hex');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Rough token estimate for the deterministic provider / budgeting. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** 919800000001 → 0001, for logs. Never log a full phone number. */
export function maskPhone(phone: string): string {
  return phone.length <= 4 ? phone : `***${phone.slice(-4)}`;
}
