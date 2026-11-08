import { generateKeyPairSync, sign } from 'node:crypto';
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

  it('denies, not throws, on a non-string token', () => {
    for (const token of [undefined, null, 42, {}]) {
      expect(verifyQrToken(token, publicKeys, NOW)).toEqual({
        ok: false,
        reason: 'INVALID_SIGNATURE',
      });
    }
  });

  it.each([null, 'soon', Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a signed token whose exp is %s',
    (exp) => {
      const token = signQrToken({ ...claims, exp } as never, current.kid, current.privateKey);
      expect(verifyQrToken(token, publicKeys, NOW)).toEqual({
        ok: false,
        reason: 'INVALID_SIGNATURE',
      });
    },
  );

  it('accepts a token signed with the previous key, so keys rotate without downtime', () => {
    const token = signQrToken(claims, previous.kid, previous.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW)).toMatchObject({ ok: true, kid: 'k1' });
  });

  it('accepts up to 10 s after exp and rejects after that', () => {
    const token = signQrToken(claims, current.kid, current.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW + 70)).toMatchObject({ ok: true });
    expect(verifyQrToken(token, publicKeys, NOW + 71)).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('accepts exp exactly one TTL plus tolerance ahead', () => {
    const token = signQrToken({ ...claims, exp: NOW + 70 }, current.kid, current.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW)).toMatchObject({ ok: true });
  });

  const forged = { ok: false, reason: 'INVALID_SIGNATURE' };
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const genuine = () => signQrToken(claims, current.kid, current.privateKey).split('.');

  it('rejects alg none with an empty signature', () => {
    const [, c] = genuine();
    const token = `${part({ alg: 'none', kid: 'k2' })}.${c}.`;
    expect(verifyQrToken(token, publicKeys, NOW)).toEqual(forged);
  });

  it('rejects a validly signed token that declares another alg', () => {
    const input = `${part({ alg: 'HS256', kid: 'k2' })}.${part(claims)}`;
    const signature = sign(null, Buffer.from(input), current.privateKey).toString('base64url');
    expect(verifyQrToken(`${input}.${signature}`, publicKeys, NOW)).toEqual(forged);
  });

  it('rejects a header changed after signing, even to another trusted kid', () => {
    const [, c, s] = genuine();
    const token = `${part({ alg: 'EdDSA', kid: 'k1' })}.${c}.${s}`;
    expect(verifyQrToken(token, publicKeys, NOW)).toEqual(forged);
  });

  it.each([
    ['empty', () => ''],
    ['truncated', (s: string) => s.slice(0, 20)],
    ['with one byte changed', (s: string) => `${s[0] === 'A' ? 'B' : 'A'}${s.slice(1)}`],
  ])('rejects a signature that is %s', (_name, change) => {
    const [h, c, s] = genuine();
    expect(verifyQrToken(`${h}.${c}.${change(s)}`, publicKeys, NOW)).toEqual(forged);
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'rejects kid %s, which is not a key even though every object has it',
    (kid) => {
      const token = signQrToken(claims, kid, current.privateKey);
      expect(verifyQrToken(token, publicKeys, NOW)).toEqual(forged);
    },
  );

  it('rejects a token with too many parts', () => {
    expect(verifyQrToken(`${genuine().join('.')}.x`, publicKeys, NOW)).toEqual(forged);
  });

  it('rejects a token whose exp is beyond one TTL plus tolerance (edge clock behind)', () => {
    const token = signQrToken({ ...claims, exp: NOW + 71 }, current.kid, current.privateKey);
    expect(verifyQrToken(token, publicKeys, NOW)).toEqual({ ok: false, reason: 'EXPIRED' });
  });
});
