import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signQrToken, verifyQrToken } from './qr-token.js';

const current = { kid: 'k2', ...generateKeyPairSync('ed25519') };
const previous = { kid: 'k1', ...generateKeyPairSync('ed25519') };
const publicKeys = { k2: current.publicKey, k1: previous.publicKey };

const NOW = 1_800_000_000; // seconds
const claims = { sub: 'emp-1', exp: NOW + 60, jti: 'j-1' };

describe('QR token', () => {
  it('verifies a token signed with the current key', () => {
    const token = signQrToken(claims, current.kid, current.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW)).toEqual({ ok: true, claims, kid: 'k2' });
  });

  it('rejects a token whose claims were changed after signing', () => {
    const [h, , s] = signQrToken(claims, current.kid, current.privateKey).split('.');
    const forged = Buffer.from(JSON.stringify({ ...claims, sub: 'emp-2' })).toString('base64url');
    expect(verifyQrToken(`${h}.${forged}.${s}`, publicKeys, NOW)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  it.each([
    ['an unknown kid', () => signQrToken(claims, 'k0', current.privateKey)],
    ['a key that does not match its kid', () => signQrToken(claims, 'k1', current.privateKey)],
    ['garbage', () => 'not-a-token'],
    ['an empty string', () => ''],
    ['bad JSON', () => 'e30.%%%.AAAA'],
    ['a null header', () => 'bnVsbA.e30.AAAA'],
  ])('rejects %s', (_name, make) => {
    expect(verifyQrToken(make(), publicKeys, NOW)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  it('accepts a token signed with the previous key, so keys rotate without downtime', () => {
    const token = signQrToken(claims, previous.kid, previous.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW)).toMatchObject({ ok: true, kid: 'k1' });
  });

  it('accepts up to 10 s after exp and rejects after that', () => {
    const token = signQrToken(claims, current.kid, current.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW + 70)).toMatchObject({ ok: true });
    expect(verifyQrToken(token, publicKeys, NOW + 71)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('rejects a token whose exp is beyond one TTL plus tolerance (edge clock behind)', () => {
    const token = signQrToken({ ...claims, exp: NOW + 71 }, current.kid, current.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW)).toEqual({ ok: false, reason: 'EXPIRED' });
  });
});
