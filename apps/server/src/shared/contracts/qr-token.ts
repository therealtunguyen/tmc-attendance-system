// QR token contract (ADR-10). Shared by the server (issues, #17) and the edge agent (verifies, #23).
// Format: compact JWS `base64url(header).base64url(claims).base64url(signature)`, alg EdDSA (Ed25519).
import { sign, verify, type KeyObject } from 'node:crypto';

export const QR_TOKEN_TTL_S = 60;
/** Clock skew allowed on `exp` between server and edge (both on NTP). */
export const QR_EXP_TOLERANCE_S = 10;

/** No personal data (NFR-4). */
export interface QrTokenClaims {
  /** Employee ID. */
  sub: string;
  /** Expiry, Unix seconds. Issue time + QR_TOKEN_TTL_S. */
  exp: number;
  /** Unique token ID; the edge admits each jti once. */
  jti: string;
}

interface QrTokenHeader {
  alg: 'EdDSA';
  /** Which signing key; lets the edge pick the current or previous public key. */
  kid: string;
}

/** Public keys the edge trusts, by kid: the current and the previous key. */
export type QrPublicKeys = Record<string, KeyObject>;

export type QrTokenResult =
  | { ok: true; claims: QrTokenClaims; kid: string }
  | { ok: false; reason: 'INVALID_SIGNATURE' | 'EXPIRED' };

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString());

export const signQrToken = (claims: QrTokenClaims, kid: string, privateKey: KeyObject): string => {
  const header: QrTokenHeader = { alg: 'EdDSA', kid };
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), privateKey).toString('base64url')}`;
};

/** Checks format, signature and expiry only. Revocation, employee status and jti reuse are the caller's job. */
export const verifyQrToken = (
  token: string,
  publicKeys: QrPublicKeys,
  nowS: number,
): QrTokenResult => {
  const invalid = { ok: false, reason: 'INVALID_SIGNATURE' } as const;
  const parts = token.split('.');
  if (parts.length !== 3) return invalid;
  const [h, c, s] = parts;
  let header: Partial<QrTokenHeader>;
  let claims: Partial<QrTokenClaims>;
  try {
    header = decode(h) as Partial<QrTokenHeader>;
    claims = decode(c) as Partial<QrTokenClaims>;
  } catch {
    return invalid;
  }
  const kid = header?.kid;
  if (header?.alg !== 'EdDSA' || typeof kid !== 'string' || !Object.hasOwn(publicKeys, kid)) {
    return invalid;
  }
  if (!verify(null, Buffer.from(`${h}.${c}`), publicKeys[kid], Buffer.from(s, 'base64url'))) {
    return invalid;
  }
  // Signed by us, but still check the shape: a bug in the issuer must not crash the edge.
  if (typeof claims?.sub !== 'string' || typeof claims.jti !== 'string') return invalid;
  if (typeof claims.exp !== 'number') return invalid;
  // ±tolerance: past exp, or further ahead than one fresh token can be (edge clock behind).
  if (nowS > claims.exp + QR_EXP_TOLERANCE_S) return { ok: false, reason: 'EXPIRED' };
  if (claims.exp > nowS + QR_TOKEN_TTL_S + QR_EXP_TOLERANCE_S)
    return { ok: false, reason: 'EXPIRED' };
  return { ok: true, claims: { sub: claims.sub, exp: claims.exp, jti: claims.jti }, kid };
};
