type Mode = 'mock' | 'http';

const mode = (value: string | undefined): Mode => (value === 'http' ? 'http' : 'mock');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  tcsMode: mode(process.env.TCS_MODE),
  tcsBaseUrl: process.env.TCS_BASE_URL ?? '',
  hrsMode: mode(process.env.HRS_MODE),
  hrsBaseUrl: process.env.HRS_BASE_URL ?? '',
  /** Ed25519 keys as base64 DER, see .env.example. Empty until set. */
  qrKeys: {
    kid: process.env.QR_SIGNING_KID ?? '',
    privateKey: process.env.QR_SIGNING_KEY ?? '',
    previousKid: process.env.QR_PREVIOUS_KID ?? '',
    previousPublicKey: process.env.QR_PREVIOUS_PUBLIC_KEY ?? '',
  },
};
