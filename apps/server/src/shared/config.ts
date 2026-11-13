import { HEARTBEAT_CHECK_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from './contracts/edge.js';

type Mode = 'mock' | 'http';

const mode = (value: string | undefined): Mode => (value === 'http' ? 'http' : 'mock');

const positiveMs = (key: string, fallback: number): number => {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647)
    throw new Error(`${key} must be a positive millisecond integer`);
  return value;
};

/** Unset means mock. Anything else but mock or smtp stops the server: a typo must not silently mock mail. */
export const parseMailMode = (value: string | undefined): 'mock' | 'smtp' => {
  const mode = (value ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'mock') return 'mock';
  if (mode === 'smtp') return 'smtp';
  throw new Error(`MAIL_MODE must be mock or smtp, not "${value}"`);
};

/** Comma-separated email list from env. Unset or blank = none. A malformed address stops the server (a typo must not silently drop alerts). */
export const parseEmailList = (value: string | undefined, key: string): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(item)) {
        throw new Error(`${key} has an invalid email address: "${item}"`);
      }
      return item;
    });

/** Env var as a positive integer, or the fallback when unset. A bad value stops the server: NaN would silently disable a rate limit. */
export const positiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer, not "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n))
    throw new Error(`${name} must be a safe positive integer, not "${raw}"`);
  return n;
};

/**
 * TRUST_PROXY for Express `trust proxy`. Unset or blank = false. 'true'/'false' = boolean, digits =
 * hop count (a numeric string would be read as an IP), anything else ('loopback', a CIDR list) passes
 * through as a string. A negative number stops the server.
 */
export const parseTrustProxy = (value: string | undefined): boolean | number | string => {
  const raw = (value ?? '').trim();
  if (raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (!Number.isSafeInteger(hops)) throw new Error(`TRUST_PROXY hop count too large: "${raw}"`);
    return hops;
  }
  if (/^-\d+$/.test(raw)) {
    throw new Error(
      `TRUST_PROXY must be true, false, a hop count or an address list, not "${raw}"`,
    );
  }
  return raw;
};

/**
 * Comma-separated `edgeId:token` pairs from EDGE_TOKENS (#69).
 * Unset or blank = {} (all /api/edge/* requests fail closed with 401).
 * Malformed entries, duplicate edgeIds, or duplicate tokens stop the server on boot.
 */
export const parseEdgeTokens = (value: string | undefined): Record<string, string> => {
  const tokens: Record<string, string> = {};
  const seenSecrets = new Set<string>();
  for (const [index, raw] of (value ?? '').split(',').entries()) {
    const item = raw.trim();
    if (item === '') continue;
    const sep = item.indexOf(':');
    const edgeId = sep > 0 ? item.slice(0, sep).trim() : '';
    const secret = sep > 0 ? item.slice(sep + 1).trim() : '';
    if (!edgeId || !secret) {
      // Never log `item` — a secret pasted without `edgeId:` would leak into boot logs.
      throw new Error(`EDGE_TOKENS[${index}] must be "edgeId:token"`);
    }
    if (Object.hasOwn(tokens, edgeId)) {
      throw new Error(`EDGE_TOKENS has duplicate edgeId "${edgeId}"`);
    }
    if (seenSecrets.has(secret)) {
      throw new Error(`EDGE_TOKENS has duplicate token for "${edgeId}"`);
    }
    tokens[edgeId] = secret;
    seenSecrets.add(secret);
  }
  return tokens;
};

/** Central override endpoints, not the edge's local TCS_BASE_URL. Missing entries fail closed. */
export const parseTcsBaseUrls = (value: string | undefined): Record<string, string> => {
  const urls = Object.create(null) as Record<string, string>;
  for (const [index, raw] of (value ?? '').split(',').entries()) {
    const item = raw.trim();
    if (!item) continue;
    const sep = item.indexOf(':');
    const factoryId = sep > 0 ? item.slice(0, sep).trim() : '';
    const baseUrl = sep > 0 ? item.slice(sep + 1).trim() : '';
    if (!factoryId || !baseUrl) throw new Error(`TCS_BASE_URLS[${index}] must be "factoryId:url"`);
    if (Object.hasOwn(urls, factoryId))
      throw new Error(`TCS_BASE_URLS has duplicate factoryId "${factoryId}"`);
    try {
      const url = new URL(baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
    } catch {
      throw new Error(
        `TCS_BASE_URLS[${index}] must use an http(s) base URL without credentials, query or fragment`,
      );
    }
    urls[factoryId] = baseUrl.replace(/\/+$/, '');
  }
  return urls;
};

export const config = {
  // Express `trust proxy`: set the hop count behind a reverse proxy (#113 D4).
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  tcsMode: mode(process.env.TCS_MODE),
  tcsBaseUrls: parseTcsBaseUrls(process.env.TCS_BASE_URLS),
  hrsMode: mode(process.env.HRS_MODE),
  hrsBaseUrl: process.env.HRS_BASE_URL ?? '',
  mailMode: parseMailMode(process.env.MAIL_MODE),
  // Who gets EXPORT_FAILED (HR, ADM) and GATE_OFFLINE (ADM) alerts (FR-4.6, FR-2.6).
  alertEmails: {
    hr: parseEmailList(process.env.ALERT_EMAILS_HR, 'ALERT_EMAILS_HR'),
    adm: parseEmailList(process.env.ALERT_EMAILS_ADM, 'ALERT_EMAILS_ADM'),
  },
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'TMC Attendance <no-reply@tmc.local>',
  /** Where employees open the portal; emails link to it (FR-1.3). */
  portalUrl: process.env.PORTAL_URL ?? 'http://localhost:5173',
  /** Ed25519 keys as base64 DER, see .env.example. Empty until set. */
  qrKeys: {
    kid: process.env.QR_SIGNING_KID ?? '',
    privateKey: process.env.QR_SIGNING_KEY ?? '',
    previousKid: process.env.QR_PREVIOUS_KID ?? '',
    previousPublicKey: process.env.QR_PREVIOUS_PUBLIC_KEY ?? '',
  },
  // login and MFA attempts per IP per minute (FR-5.2)
  authRateLimitPerMin: positiveInt('AUTH_RATE_LIMIT_PER_MIN', 10),
  // POST /api/qr/token and GET /api/me/qr calls per user per minute, shared; the portal needs 2
  qrTokenRateLimitPerMin: positiveInt('QR_TOKEN_RATE_LIMIT_PER_MIN', 10),
  heartbeatTimeoutMs: positiveMs('EDGE_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS),
  heartbeatCheckMs: positiveMs('EDGE_HEARTBEAT_CHECK_MS', HEARTBEAT_CHECK_INTERVAL_MS),
  edgeTokens: parseEdgeTokens(process.env.EDGE_TOKENS),
};
