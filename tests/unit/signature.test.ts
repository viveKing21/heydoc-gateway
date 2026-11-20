import { describe, expect, it } from 'vitest';
import { signBody, verifySignature } from '../../src/whatsapp/signature.js';

const secret = 'shh-test-secret';
const raw = Buffer.from(JSON.stringify({ hello: 'world' }));

describe('WhatsApp signature verification', () => {
  it('accepts a signature produced from the exact raw bytes', () => {
    expect(verifySignature(raw, signBody(raw, secret), secret)).toBe(true);
  });

  it('rejects a signature over different bytes', () => {
    const other = Buffer.from(JSON.stringify({ hello: 'world ' }));
    expect(verifySignature(other, signBody(raw, secret), secret)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifySignature(raw, signBody(raw, 'wrong'), secret)).toBe(false);
  });

  it('rejects missing, malformed and non-sha256 headers', () => {
    expect(verifySignature(raw, undefined, secret)).toBe(false);
    expect(verifySignature(raw, 'sha1=abcd', secret)).toBe(false);
    expect(verifySignature(raw, 'sha256=zzzz', secret)).toBe(false);
    expect(verifySignature(raw, 'sha256=' + 'a'.repeat(63), secret)).toBe(false);
    expect(verifySignature(undefined, signBody(raw, secret), secret)).toBe(false);
  });
});
