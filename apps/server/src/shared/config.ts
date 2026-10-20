type Mode = 'mock' | 'http';

const mode = (value: string | undefined): Mode => (value === 'http' ? 'http' : 'mock');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? '',
  tcsMode: mode(process.env.TCS_MODE),
  tcsBaseUrl: process.env.TCS_BASE_URL ?? '',
  hrsMode: mode(process.env.HRS_MODE),
  hrsBaseUrl: process.env.HRS_BASE_URL ?? '',
  qrSigningSecret: process.env.QR_SIGNING_SECRET ?? '',
};
