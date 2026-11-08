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

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  tcsMode: mode(process.env.TCS_MODE),
  tcsBaseUrl: process.env.TCS_BASE_URL ?? '',
  hrsMode: mode(process.env.HRS_MODE),
  hrsBaseUrl: process.env.HRS_BASE_URL ?? '',
  mailMode: parseMailMode(process.env.MAIL_MODE),
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
  authRateLimitPerMin: Number(process.env.AUTH_RATE_LIMIT_PER_MIN ?? 10),
  heartbeatTimeoutMs: positiveMs('EDGE_HEARTBEAT_TIMEOUT_MS', HEARTBEAT_TIMEOUT_MS),
  heartbeatCheckMs: positiveMs('EDGE_HEARTBEAT_CHECK_MS', HEARTBEAT_CHECK_INTERVAL_MS),
};
