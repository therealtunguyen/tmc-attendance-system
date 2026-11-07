type Mode = 'mock' | 'http';

const mode = (value: string | undefined): Mode => (value === 'http' ? 'http' : 'mock');

const mailMode = (value: string | undefined) => (value === 'smtp' ? 'smtp' : 'mock');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  tcsMode: mode(process.env.TCS_MODE),
  tcsBaseUrl: process.env.TCS_BASE_URL ?? '',
  hrsMode: mode(process.env.HRS_MODE),
  hrsBaseUrl: process.env.HRS_BASE_URL ?? '',
  mailMode: mailMode(process.env.MAIL_MODE),
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
};
