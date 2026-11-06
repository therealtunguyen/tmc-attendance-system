import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Role } from './iam.service.js';

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
/** How long a password-only session may wait for its MFA code. */
export const MFA_PENDING_TTL_MS = 5 * 60 * 1000;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Privileged roles that must pass MFA (FR-5.2). */
export const MFA_ROLES: readonly Role[] = ['ADM', 'HR'];

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;

const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** Stored as scrypt$<saltB64>$<hashB64>. */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/** Password policy (FR-5.2): returns a message, or null when acceptable. */
export const passwordProblem = (password: string): string | null => {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    return 'Password must contain a letter and a digit';
  }
  return null;
};

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding. */
export const base32Encode = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
};

export const base32Decode = (text: string): Buffer => {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = B32.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
};

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

const STEP_MS = 30_000;
const DIGITS = 6;

const hotp = (key: Buffer, counter: number): string => {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0xf;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
};

/** RFC 6238: SHA-1, 30 s step, 6 digits. */
export const totp = (secret: string, atMs: number): string =>
  hotp(base32Decode(secret), Math.floor(atMs / STEP_MS));

/**
 * Accepts the previous, current and next step to tolerate clock drift. Returns the matched step
 * number (so the caller can refuse a replay), or null.
 */
export const verifyTotp = (secret: string, code: string, nowMs: number): number | null => {
  if (!/^\d{6}$/.test(code)) return null;
  const given = Buffer.from(code);
  const current = Math.floor(nowMs / STEP_MS);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(totp(secret, step * STEP_MS));
    if (timingSafeEqual(expected, given)) matched = step;
  }
  return matched;
};

export const TOTP_ISSUER = 'TMC Attendance';

export const otpauthUri = (username: string, secret: string): string => {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(TOTP_ISSUER)}`;
};

/** Opaque bearer token; only its hash is stored. */
export const newSessionToken = (): string => randomBytes(32).toString('base64url');

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
