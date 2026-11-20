import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-hub-signature-256';

/**
 * Meta signs the *raw* request body with the app secret:
 *   X-Hub-Signature-256: sha256=<hex hmac>
 * Verification must use the bytes as received, not a re-serialised object.
 */
export function signBody(raw: Buffer | string, secret: string): string {
  const hmac = createHmac('sha256', secret).update(raw).digest('hex');
  return `sha256=${hmac}`;
}

export function verifySignature(
  raw: Buffer | string | undefined,
  header: string | string[] | undefined,
  secret: string,
): boolean {
  if (!raw || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const given = header.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(given)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
