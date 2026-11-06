import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashPassword,
  hashToken,
  newSessionToken,
  newTotpSecret,
  otpauthUri,
  passwordProblem,
  totp,
  verifyPassword,
  verifyTotp,
} from './iam.auth.js';

const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('passwords (FR-5.2)', () => {
  it('round-trips and rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse 42');
    expect(stored).toMatch(/^scrypt\$[^$]+\$[^$]+$/);
    expect(await verifyPassword('correct horse 42', stored)).toBe(true);
    expect(await verifyPassword('correct horse 43', stored)).toBe(false);
  });

  it('salts each hash and rejects a malformed stored value', async () => {
    expect(await hashPassword('same password 1')).not.toBe(await hashPassword('same password 1'));
    expect(await verifyPassword('x', 'plain')).toBe(false);
  });

  it('enforces the policy', () => {
    expect(passwordProblem('short1')).toMatch(/12/);
    expect(passwordProblem('onlyletterslong')).toMatch(/digit/);
    expect(passwordProblem('123456789012')).toMatch(/letter/);
    expect(passwordProblem('longenough123')).toBeNull();
  });
});

describe('base32', () => {
  it('matches RFC 4648 vectors without padding', () => {
    const enc = (s: string) => base32Encode(Buffer.from(s));
    expect(enc('f')).toBe('MY');
    expect(enc('fo')).toBe('MZXQ');
    expect(enc('foobar')).toBe('MZXW6YTBOI');
    expect(base32Decode('MZXW6YTBOI').toString()).toBe('foobar');
    expect(base32Decode('mzxq====').toString()).toBe('fo');
  });

  it('round-trips random secrets and rejects bad characters', () => {
    const secret = newTotpSecret();
    expect(secret).toHaveLength(32);
    expect(base32Encode(base32Decode(secret))).toBe(secret);
    expect(() => base32Decode('A1')).toThrow();
  });
});

describe('TOTP (RFC 6238, FR-5.2)', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1234567890, '005924'],
  ])('matches the SHA-1 vector at T=%i', (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('accepts the previous, current and next step only', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    for (const drift of [-1, 0, 1]) {
      expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + drift * 30_000), now)).toBe(
        step + drift,
      );
    }
    for (const drift of [-2, 2]) {
      expect(verifyTotp(RFC_SECRET, totp(RFC_SECRET, now + drift * 30_000), now)).toBeNull();
    }
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345', 59_000)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', 59_000)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '', 59_000)).toBeNull();
  });

  it('builds an otpauth URI with the issuer', () => {
    expect(otpauthUri('a b', 'SECRET')).toBe(
      'otpauth://totp/TMC%20Attendance%3Aa%20b?secret=SECRET&issuer=TMC%20Attendance',
    );
  });
});

describe('session tokens', () => {
  it('are random base64url and hash to sha256 hex', () => {
    const a = newSessionToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toBe(a);
  });
});
